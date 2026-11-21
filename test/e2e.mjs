import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_START_TIMEOUT_MS = 10_000;
const LIVE_TIMEOUT_MS = 15_000;
const WAITING_TIMEOUT_MS = 5_000;
const AUDIO_TIMEOUT_MS = 5_000;
const RTT_TIMEOUT_MS = 5_000;
const MIC_LEVEL_TIMEOUT_MS = 3_000;
const STEP_TIMEOUT_MS = 10_000;

const CHROMIUM_ARGS = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  throw new Error(message);
}

function firstLine(error) {
  return String(error?.message ?? error).split('\n')[0];
}

function formatValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return String(value);
}

function formatStats(stats) {
  if (!stats || typeof stats !== 'object') return String(stats);
  const keys = [
    'rttMs',
    'jitterMs',
    'packetsLost',
    'bytesReceived',
    'bitrateKbps',
    'jitterBufferMs',
    'localLevel',
    'remoteLevel',
  ];
  return keys.map((key) => `${key}=${formatValue(stats[key])}`).join(' ');
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/index.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;

    const settle = (action) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };

    timer = setTimeout(() => {
      settle(() => {
        child.kill('SIGKILL');
        reject(
          new Error(
            `server did not print "listening on <url>" within ${SERVER_START_TIMEOUT_MS} ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
      });
    }, SERVER_START_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/listening on\s+(https?:\/\/\S+)/);
      if (match) {
        settle(() => resolve({ child, url: match[1] }));
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.once('error', (error) => {
      settle(() => reject(new Error(`failed to spawn server: ${error.message}`)));
    });

    child.once('exit', (code, signal) => {
      settle(() =>
        reject(
          new Error(
            `server exited before it printed "listening on <url>" (code ${code}, signal ${signal})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        ),
      );
    });
  });
}

async function stopServer(child) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    child.stdout?.destroy();
    child.stderr?.destroy();
    return;
  }
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 3_000);
  let waitTimer;
  await Promise.race([
    exited,
    new Promise((resolve) => {
      waitTimer = setTimeout(resolve, 5_000);
    }),
  ]);
  clearTimeout(killTimer);
  clearTimeout(waitTimer);
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function launchBrowser() {
  const options = { headless: true, args: CHROMIUM_ARGS, timeout: 30_000 };
  const explicit = process.env.PLAYWRIGHT_CHROMIUM;
  if (explicit) {
    return chromium.launch({ ...options, executablePath: explicit });
  }
  try {
    return await chromium.launch(options);
  } catch (primaryError) {
    const fallback = '/usr/bin/chromium';
    if (!existsSync(fallback)) {
      throw new Error(`could not launch Playwright Chromium: ${firstLine(primaryError)}`);
    }
    try {
      return await chromium.launch({ ...options, executablePath: fallback });
    } catch (fallbackError) {
      throw new Error(
        `could not launch Playwright Chromium (${firstLine(primaryError)}) or ${fallback} (${firstLine(fallbackError)})`,
      );
    }
  }
}

function normalizeBaseUrl(raw) {
  const url = new URL(raw);
  // Chromium does not reliably load a page bound to 0.0.0.0, so use loopback.
  if (url.hostname === '0.0.0.0' || url.hostname === '::' || url.hostname === '[::]') {
    url.hostname = '127.0.0.1';
  }
  return url.href.replace(/\/$/, '');
}

async function openContext(browser, label, origin) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  context.setDefaultTimeout(STEP_TIMEOUT_MS);
  await context.grantPermissions(['microphone'], { origin });
  // Record what the page asks the browser to speak. Headless Chromium has no
  // system voices, so the utterances are the observable proof.
  await context.addInitScript(() => {
    window.__spoken = [];
    window.__spokenSettings = [];
    const synth = window.speechSynthesis;
    if (!synth || typeof synth.speak !== 'function') return;
    const speak = synth.speak.bind(synth);
    synth.speak = (utterance) => {
      const text = String(utterance?.text ?? '');
      window.__spoken.push(text);
      window.__spokenSettings.push({
        text,
        pitch: utterance?.pitch,
        rate: utterance?.rate,
      });
      try {
        speak(utterance);
      } catch {}
    };
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error(`[${label}] page error: ${firstLine(error)}`));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`[${label}] console error: ${message.text()}`);
  });
  return { context, page };
}

async function waitForBodyState(page, expected, timeoutMs, label) {
  try {
    await page.waitForFunction(
      (state) => document.body?.dataset?.state === state,
      expected,
      { timeout: timeoutMs, polling: 100 },
    );
  } catch {
    const snapshot = await page
      .evaluate(() => ({
        state: document.body?.dataset?.state ?? '(missing)',
        status: document.querySelector('#status')?.textContent?.trim() ?? '',
      }))
      .catch(() => ({ state: '(page closed)', status: '' }));
    const status = snapshot.status ? ` (status: "${snapshot.status}")` : '';
    fail(
      `${label}: expected body[data-state="${expected}"] within ${timeoutMs} ms, saw "${snapshot.state}"${status}`,
    );
  }
}

async function readRoomCode(page, label) {
  let code;
  try {
    code = (await page.locator('#room-code').textContent({ timeout: STEP_TIMEOUT_MS }))?.trim();
  } catch (error) {
    fail(`${label}: could not read #room-code: ${firstLine(error)}`);
  }
  if (!code) fail(`${label}: #room-code is empty`);
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) {
    fail(`${label}: #room-code "${code}" does not match /^[A-Z2-9]{4}-[A-Z2-9]{4}$/`);
  }
  return code;
}

async function waitForDebugApi(page, label) {
  try {
    await page.waitForFunction(() => Boolean(window.__walkie), { timeout: STEP_TIMEOUT_MS });
  } catch {
    fail(`${label}: window.__walkie did not appear within ${STEP_TIMEOUT_MS} ms`);
  }
}

async function readStats(page, label) {
  let result;
  try {
    result = await page.evaluate(async () => {
      const api = window.__walkie;
      if (!api || typeof api.stats !== 'function') return { missing: true };
      try {
        return await api.stats();
      } catch (error) {
        return { statsError: String(error) };
      }
    });
  } catch (error) {
    fail(`${label}: could not evaluate window.__walkie.stats(): ${firstLine(error)}`);
  }
  if (!result || result.missing) fail(`${label}: window.__walkie.stats() is not available`);
  if (result.statsError) fail(`${label}: window.__walkie.stats() threw: ${result.statsError}`);
  return result;
}

async function clickTalk(page, label) {
  try {
    await page.locator('#ptt').click({ timeout: STEP_TIMEOUT_MS });
  } catch (error) {
    fail(`${label}: could not click #ptt: ${firstLine(error)}`);
  }
}

async function waitForTyping(page, visible, label) {
  try {
    await page
      .locator('#typing')
      .waitFor({ state: visible ? 'visible' : 'hidden', timeout: STEP_TIMEOUT_MS });
  } catch {
    fail(
      `${label}: typing indicator did not become ${visible ? 'visible' : 'hidden'} within ${STEP_TIMEOUT_MS} ms`,
    );
  }
}

async function sendChat(page, text, label) {
  try {
    await page.locator('#chat-input').fill(text);
    await page.locator('#chat-input').press('Enter');
  } catch (error) {
    fail(`${label}: could not send chat message: ${firstLine(error)}`);
  }
}

async function waitForMessage(page, text, from, label) {
  try {
    await page
      .locator(`.message[data-from="${from}"] .message-text`)
      .filter({ hasText: text })
      .first()
      .waitFor({ timeout: STEP_TIMEOUT_MS });
  } catch {
    const seen = await page
      .evaluate(() => [...document.querySelectorAll('.message-text')].map((node) => node.textContent))
      .catch(() => []);
    fail(
      `${label}: did not see ${from} message "${text}" within ${STEP_TIMEOUT_MS} ms; saw ${JSON.stringify(seen)}`,
    );
  }
}

async function waitForSpoken(page, text, label) {
  try {
    await page.waitForFunction(
      (want) => Array.isArray(window.__spoken) && window.__spoken.some((line) => line.includes(want)),
      text,
      { timeout: STEP_TIMEOUT_MS, polling: 100 },
    );
  } catch {
    const spoken = await page.evaluate(() => window.__spoken ?? null).catch(() => null);
    fail(
      `${label}: did not speak "${text}" within ${STEP_TIMEOUT_MS} ms; spoke ${JSON.stringify(spoken)}`,
    );
  }
}

async function spokenSettingsFor(page, text) {
  return page.evaluate((want) => {
    const lines = Array.isArray(window.__spokenSettings) ? window.__spokenSettings : [];
    const found = lines.filter((line) => String(line.text ?? '').includes(want));
    return found.length ? found[found.length - 1] : null;
  }, text);
}

function pitchMatches(settings, expected) {
  return Boolean(settings) && Math.abs(Number(settings.pitch) - expected) <= 0.01;
}

async function sizePage(page, width, height) {
  await page.evaluate(({ width, height }) => {
    const viewport = window.__fakeViewport;
    if (!viewport) return;
    viewport.width = width;
    viewport.height = height;
    viewport.scale = 1;
    viewport.offsetTop = 0;
    viewport.offsetLeft = 0;
    viewport.pageTop = 0;
    viewport.pageLeft = 0;
    viewport.dispatchEvent(new Event("resize"));
  }, { width, height });
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(150);
}

async function moveKeyboard(page, from, to) {
  const steps = 12;
  for (let step = 0; step <= steps; step += 1) {
    const height = Math.round(from + ((to - from) * step) / steps);
    await page.evaluate((height) => {
      window.__fakeViewport.height = height;
      window.__fakeViewport.dispatchEvent(new Event("resize"));
    }, height);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(200);
}

async function startKeyboardProbe(page) {
  await page.evaluate(() => {
    window.__keyboardFrames = [];
    const sample = () => {
      window.__keyboardFrames.push({
        stage: getComputedStyle(document.querySelector(".stage")).display,
        appHeight: Math.round(document.querySelector(".app").getBoundingClientRect().height),
      });
      window.__keyboardRaf = requestAnimationFrame(sample);
    };
    sample();
  });
}

async function stopKeyboardProbe(page) {
  return page.evaluate(() => {
    cancelAnimationFrame(window.__keyboardRaf);
    return window.__keyboardFrames;
  });
}

function checkKeyboardAnimation(frames, opening, label, scenario) {
  if (frames.length === 0) {
    fail(`${label}: ${scenario.name} keyboard probe sampled no frames`);
  }
  const stages = [];
  for (const frame of frames) {
    if (stages[stages.length - 1] !== frame.stage) stages.push(frame.stage);
  }
  if (opening) {
    if (stages[0] === "none") {
      fail(`${label}: ${scenario.name} status rail was already hidden before the keyboard opened`);
    }
    if (stages[stages.length - 1] !== "none") {
      fail(`${label}: ${scenario.name} status rail stayed visible with the keyboard open`);
    }
  } else {
    if (stages[0] !== "none") {
      fail(`${label}: ${scenario.name} status rail was visible while the keyboard was open`);
    }
    if (stages[stages.length - 1] === "none") {
      fail(`${label}: ${scenario.name} status rail stayed hidden after the keyboard closed`);
    }
  }
  if (stages.length > 2) {
    fail(
      `${label}: ${scenario.name} status rail flickered during the keyboard transition (${stages.join(" -> ")})`,
    );
  }
  for (let i = 1; i < frames.length; i += 1) {
    const delta = frames[i].appHeight - frames[i - 1].appHeight;
    if (opening && delta > 2) {
      fail(
        `${label}: ${scenario.name} shell grew from ${frames[i - 1].appHeight}px to ${frames[i].appHeight}px while the keyboard opened`,
      );
    }
    if (!opening && delta < -2) {
      fail(
        `${label}: ${scenario.name} shell shrank from ${frames[i - 1].appHeight}px to ${frames[i].appHeight}px while the keyboard closed`,
      );
    }
  }
}

async function measureLayout(page) {
  return page.evaluate(() => {
    const box = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        display: getComputedStyle(element).display,
      };
    };
    const messages = document.querySelector("#messages");
    const latest = messages?.querySelector(".message:last-of-type");
    const log = messages?.getBoundingClientRect();
    const latestRect = latest?.getBoundingClientRect();
    return {
      keyboard: document.documentElement.dataset.keyboard ?? "",
      app: box(".app"),
      stage: box(".stage"),
      composer: box(".composer"),
      messages: box("#messages"),
      typing: box("#typing"),
      ptt: box("#ptt"),
      viewportHeight: Math.round(window.visualViewport?.height ?? window.innerHeight),
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      latestInLog:
        !log ||
        !latestRect ||
        (latestRect.top >= log.top - 1 && latestRect.bottom <= log.bottom + 1),
    };
  });
}

function assertFrameStable(
  before,
  after,
  label,
  context,
  names = ["app", "composer", "messages", "ptt"],
) {
  for (const name of names) {
    for (const edge of ["top", "bottom", "height"]) {
      if (Math.abs(after[name][edge] - before[name][edge]) > 1) {
        fail(
          `${label}: ${context} moved ${name}.${edge} from ${before[name][edge]} to ${after[name][edge]}`,
        );
      }
    }
  }
}

async function checkKeyboardLayout(page, label) {
  const scenarios = [
    { name: "iPhone portrait", width: 390, height: 844, keyboard: 508, messages: 200 },
    { name: "iPad portrait", width: 768, height: 1024, keyboard: 560, messages: 160 },
    { name: "iPad landscape", width: 1024, height: 768, keyboard: 430, messages: 160 },
  ];

  for (const scenario of scenarios) {
    await sizePage(page, scenario.width, scenario.height);

    const font = await page.evaluate(
      () => getComputedStyle(document.querySelector("#chat-input")).fontSize,
    );
    if (parseFloat(font) < 16) {
      fail(`${label}: #chat-input is ${font}; iOS zooms the page for fields under 16px`);
    }

    for (let i = 1; i <= 8; i += 1) {
      await sendChat(page, `${scenario.name} keyboard check ${i}.`, label);
    }
    await page.waitForTimeout(250);

    // iOS keeps the layout viewport at full height when the keyboard opens and
    // only shrinks the visual viewport. Chromium cannot shrink one without the
    // other, so the page runs with a fake visual viewport and we animate only
    // that, the way the keyboard does. iPad in landscape uses the wide layout,
    // where the keyboard used to cover the composer and Safari panned the
    // page on every keystroke.
    const fakeViewport = await page.evaluate(() => window.visualViewport === window.__fakeViewport);
    if (!fakeViewport) fail(`${label}: the fake visual viewport was not installed`);

    await page.locator("#chat-input").focus();
    await startKeyboardProbe(page);
    await moveKeyboard(page, scenario.height, scenario.keyboard);
    checkKeyboardAnimation(await stopKeyboardProbe(page), true, label, scenario);
    const open = await measureLayout(page);

    if (open.keyboard !== "open") {
      fail(`${label}: ${scenario.name} keyboard did not open (state "${open.keyboard}")`);
    }
    if (Math.abs(open.app.height - scenario.keyboard) > 1) {
      fail(
        `${label}: ${scenario.name} shell is ${open.app.height}px, expected ${scenario.keyboard}px`,
      );
    }
    if (open.app.top < -1 || open.app.bottom > scenario.keyboard + 1) {
      fail(
        `${label}: ${scenario.name} shell spans ${open.app.top}..${open.app.bottom}, outside the ${scenario.keyboard}px visible area`,
      );
    }
    if (open.stage.display !== "none") {
      fail(`${label}: ${scenario.name} status rail still takes room above the keyboard`);
    }
    if (open.messages.height < scenario.messages) {
      fail(
        `${label}: ${scenario.name} message log shrank to ${open.messages.height}px, expected at least ${scenario.messages}px`,
      );
    }
    if (open.composer.bottom > scenario.keyboard + 1) {
      fail(`${label}: ${scenario.name} composer is under the keyboard (${open.composer.bottom}px)`);
    }
    if (open.ptt.bottom > scenario.keyboard + 1 || open.ptt.height < 40) {
      fail(`${label}: ${scenario.name} Talk key is not usable above the keyboard`);
    }
    if (open.scrollWidth > open.innerWidth + 1) {
      fail(`${label}: ${scenario.name} page overflows horizontally`);
    }
    if (!open.latestInLog) {
      fail(`${label}: ${scenario.name} newest message is not inside the visible message log`);
    }

    const beforeTyping = await measureLayout(page);
    for (const character of "stays still") {
      await page.keyboard.type(character);
      // Safari pans the visual viewport to keep the caret in view. The shell
      // must not chase that pan by resizing or moving.
      await page.evaluate(() => window.__fakeViewport.dispatchEvent(new Event("scroll")));
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(120);
    const whileTyping = await measureLayout(page);
    if (whileTyping.keyboard !== "open") {
      fail(`${label}: ${scenario.name} keyboard mode flickered while typing`);
    }
    assertFrameStable(beforeTyping, whileTyping, label, `${scenario.name} typing`);
    if (whileTyping.scrollWidth > whileTyping.innerWidth + 1) {
      fail(`${label}: ${scenario.name} page overflowed while typing`);
    }
    await page.locator("#chat-input").fill("");

    await startKeyboardProbe(page);
    await moveKeyboard(page, scenario.keyboard, scenario.height);
    checkKeyboardAnimation(await stopKeyboardProbe(page), false, label, scenario);
    const closed = await measureLayout(page);

    if (closed.keyboard !== "") {
      fail(`${label}: ${scenario.name} keyboard mode did not close`);
    }
    if (closed.stage.display === "none") {
      fail(`${label}: ${scenario.name} status rail stayed hidden after the keyboard closed`);
    }
    if (closed.app.height <= scenario.keyboard + 100) {
      fail(`${label}: ${scenario.name} full layout did not come back`);
    }
    if (closed.app.top < -1 || closed.app.bottom > scenario.height + 1) {
      fail(`${label}: ${scenario.name} shell does not fit after the keyboard closed`);
    }
    if (closed.scrollWidth > closed.innerWidth + 1) {
      fail(`${label}: ${scenario.name} page overflows horizontally after the keyboard closed`);
    }
    if (!closed.latestInLog) {
      fail(`${label}: ${scenario.name} newest message is not inside the log after the keyboard closed`);
    }

    console.log(`${label}: ${scenario.name} keyboard keeps the composer and log still`);
  }

  await sizePage(page, 1280, 720);
}

async function readState(page, label) {
  let state;
  try {
    state = await page.evaluate(() => window.__walkie?.state?.() ?? null);
  } catch (error) {
    fail(`${label}: could not read window.__walkie.state(): ${firstLine(error)}`);
  }
  if (!state) fail(`${label}: window.__walkie.state() is not available`);
  return state;
}

async function waitForTalking(page, expected, timeoutMs, label) {
  try {
    await page.waitForFunction(
      (want) => Boolean(window.__walkie?.state?.().talking) === want,
      expected,
      { timeout: timeoutMs, polling: 100 },
    );
  } catch {
    const state = await readState(page, label).catch(() => ({ talking: 'unknown' }));
    fail(`${label}: talking stayed ${String(state.talking)} waiting for ${expected} within ${timeoutMs} ms`);
  }
}

async function waitForLocalLevel(page, direction, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let level = null;
  while (Date.now() < deadline) {
    const stats = await readStats(page, label);
    if (typeof stats.localLevel === 'number' && Number.isFinite(stats.localLevel)) {
      level = stats.localLevel;
      if (direction === 'up' && level > 0.01) return level;
      if (direction === 'down' && level <= 0.005) return level;
    }
    await sleep(100);
  }
  fail(
    `${label}: localLevel stayed at ${formatValue(level)} waiting to go ${direction} within ${timeoutMs} ms`,
  );
}

async function checkSpaceToggle(page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.body.focus();
  });

  await page.keyboard.press('Space');
  await waitForTalking(page, true, MIC_LEVEL_TIMEOUT_MS, 'Space on');
  const openLevel = await waitForLocalLevel(page, 'up', MIC_LEVEL_TIMEOUT_MS, 'Space on');

  await page.keyboard.press('Space');
  await waitForTalking(page, false, MIC_LEVEL_TIMEOUT_MS, 'Space off');
  await waitForLocalLevel(page, 'down', MIC_LEVEL_TIMEOUT_MS, 'Space off');

  console.log(`Space key toggled the mic open at localLevel ${openLevel.toFixed(2)} and closed it again.`);
}

async function main() {
  let serverChild = null;
  let browser = null;
  try {
    const started = await startServer();
    serverChild = started.child;
    const baseUrl = normalizeBaseUrl(started.url);
    const origin = new URL(baseUrl).origin;
    console.log(`server listening at ${baseUrl}`);

    browser = await launchBrowser();

    const a = await openContext(browser, 'A', origin);
    // A real iPhone shrinks only the visual viewport when the keyboard opens.
    // Keep a controllable stand-in so the keyboard layout can be checked.
    await a.page.addInitScript(() => {
      const fake = new EventTarget();
      Object.assign(fake, {
        width: window.innerWidth,
        height: window.innerHeight,
        scale: 1,
        offsetTop: 0,
        offsetLeft: 0,
        pageTop: 0,
        pageLeft: 0,
      });
      Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
      window.__fakeViewport = fake;
    });
    await a.page.goto(`${baseUrl}/`, { waitUntil: 'load', timeout: LIVE_TIMEOUT_MS });
    await waitForBodyState(a.page, 'waiting', LIVE_TIMEOUT_MS, 'A after load');
    const roomCode = await readRoomCode(a.page, 'A');
    if (!(await a.page.locator('#chat-input').isDisabled())) {
      fail('A: the chat input should be disabled while waiting for a peer');
    }
    const qrPath = await a.page.locator('#qr-code path').getAttribute('d');
    if (!(await a.page.locator('#share-qr').isVisible()) || !qrPath) {
      fail('A: the share section should show a rendered QR code while waiting');
    }
    await a.page.setViewportSize({ width: 390, height: 700 });
    await a.page.waitForTimeout(150);
    const shortLayout = await a.page.evaluate(() => {
      const visible = (selector) => {
        const element = document.querySelector(selector);
        if (!element || getComputedStyle(element).display === 'none') return false;
        return element.getBoundingClientRect().height > 0;
      };
      return {
        qr: visible('#share-qr') && visible('#qr-code'),
        messages: visible('#messages'),
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });
    if (!shortLayout.qr || !shortLayout.messages || shortLayout.overflow) {
      fail(`A: short viewport lost content: ${JSON.stringify(shortLayout)}`);
    }
    console.log('A: the QR and message log stay visible at 390x700');
    await a.page.setViewportSize({ width: 1280, height: 720 });
    console.log(`room ${roomCode}: A is waiting with a QR code`);

    const b = await openContext(browser, 'B', origin);
    await b.page.goto(`${baseUrl}/?room=${encodeURIComponent(roomCode)}`, {
      waitUntil: 'load',
      timeout: LIVE_TIMEOUT_MS,
    });
    await Promise.all([
      waitForBodyState(a.page, 'live', LIVE_TIMEOUT_MS, 'A with B'),
      waitForBodyState(b.page, 'live', LIVE_TIMEOUT_MS, 'B with A'),
    ]);
    console.log('A and B are live');

    await waitForDebugApi(a.page, 'A');
    await waitForDebugApi(b.page, 'B');

    const chatHello = 'Hi! Can you hear me?';
    const chatReply = 'Loud and clear.';
    const aBeforeTyping = await measureLayout(a.page);
    await a.page.locator('#chat-input').fill(chatHello);
    const aWhileTyping = await measureLayout(a.page);
    assertFrameStable(aBeforeTyping, aWhileTyping, 'A', 'typing in the composer');

    const bBeforeTyping = await measureLayout(b.page);
    await waitForTyping(b.page, true, 'B while A types');
    const bWhileTyping = await measureLayout(b.page);
    assertFrameStable(bBeforeTyping, bWhileTyping, 'B', 'the typing indicator', [
      'app',
      'composer',
      'ptt',
    ]);
    if (bWhileTyping.typing.bottom > bWhileTyping.composer.top + 1) {
      fail('B: the typing indicator overlaps the composer');
    }

    await a.page.locator('#chat-input').press('Enter');
    await waitForMessage(a.page, chatHello, 'self', 'A');
    await waitForMessage(b.page, chatHello, 'peer', 'B');
    await waitForTyping(b.page, false, 'B after A sent');
    const bAfterTyping = await measureLayout(b.page);
    assertFrameStable(bBeforeTyping, bAfterTyping, 'B', 'clearing the typing indicator', [
      'app',
      'composer',
      'ptt',
    ]);
    await sendChat(b.page, chatReply, 'B');
    await waitForMessage(b.page, chatReply, 'self', 'B');
    await waitForMessage(a.page, chatReply, 'peer', 'A');
    console.log('A and B exchanged chat messages with a typing indicator');

    const speakToggle = a.page.locator('#speak-toggle');
    if (!(await speakToggle.isVisible())) {
      fail('A: the read-aloud setting is not visible');
    }
    if ((await speakToggle.getAttribute('aria-pressed')) !== 'false') {
      fail('A: read aloud should start off');
    }
    await speakToggle.click();
    await a.page.waitForFunction(() => window.__walkie?.state?.().readAloud === true, null, {
      timeout: STEP_TIMEOUT_MS,
      polling: 100,
    });
    if ((await speakToggle.getAttribute('aria-pressed')) !== 'true') {
      fail('A: the read-aloud button did not report its pressed state');
    }
    const storedReadAloud = await a.page.evaluate(() =>
      localStorage.getItem('walkie-talkie:read-aloud'),
    );
    if (storedReadAloud !== '1') {
      fail(`A: the read-aloud setting was not remembered (stored ${String(storedReadAloud)})`);
    }

    const voiceToggle = a.page.locator('#voice-toggle');
    if (!(await voiceToggle.isVisible())) {
      fail('A: the read-aloud voice control is not visible');
    }
    if (await a.page.locator('#voice-menu').isVisible()) {
      fail('A: the read-aloud voice menu should start closed');
    }
    await voiceToggle.click();
    try {
      await a.page.locator('#voice-menu').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    } catch {
      fail('A: the voice menu did not open');
    }
    const voiceValues = await a.page.locator('#voice-options input').evaluateAll((inputs) =>
      inputs.map((input) => ({ value: input.value, checked: input.checked })),
    );
    if (voiceValues.length !== 4) {
      fail(`A: expected four read-aloud voices, found ${voiceValues.length}`);
    }
    const initialVoice = voiceValues.find((voice) => voice.checked);
    if (initialVoice?.value !== 'channel') {
      fail(`A: expected channel as the default voice, got ${String(initialVoice?.value)}`);
    }

    await a.page.locator('#voice-options input[value="deep"]').check();
    await a.page.waitForFunction(() => window.__walkie?.state?.().readAloudVoice === 'deep', null, {
      timeout: STEP_TIMEOUT_MS,
      polling: 100,
    });
    const storedVoice = await a.page.evaluate(() =>
      localStorage.getItem('walkie-talkie:read-aloud-voice'),
    );
    if (storedVoice !== 'deep') {
      fail(`A: the voice choice was not remembered (stored ${String(storedVoice)})`);
    }
    await waitForSpoken(a.page, 'This is the deep voice.', 'A voice preview');
    const preview = await spokenSettingsFor(a.page, 'This is the deep voice.');
    if (!pitchMatches(preview, 0.7)) {
      fail(`A: the deep preview did not use the deep pitch (${JSON.stringify(preview)})`);
    }
    if (!(await a.page.locator('#voice-menu').isVisible())) {
      fail('A: choosing a voice should leave the menu open for auditioning');
    }
    await a.page.keyboard.press('Escape');
    if (await a.page.locator('#voice-menu').isVisible()) {
      fail('A: Escape did not close the voice menu');
    }
    if ((await a.page.evaluate(() => document.activeElement?.id)) !== 'voice-toggle') {
      fail('A: Escape did not return focus to the voice control');
    }
    console.log('A opened the voice menu, chose Deep, heard its preview, and closed it with Escape');

    const spokenText = 'Can you read this out loud?';
    await sendChat(b.page, spokenText, 'B');
    await waitForMessage(a.page, spokenText, 'peer', 'A');
    await waitForSpoken(a.page, spokenText, 'A');
    const spokenWithDeep = await spokenSettingsFor(a.page, spokenText);
    if (!pitchMatches(spokenWithDeep, 0.7)) {
      fail(`A: the spoken message did not use the chosen voice (${JSON.stringify(spokenWithDeep)})`);
    }

    await speakToggle.click();
    if ((await speakToggle.getAttribute('aria-pressed')) !== 'false') {
      fail('A: the read-aloud button did not turn off');
    }
    const spokenBeforeMute = await a.page.evaluate(() => window.__spoken.length);
    const silentText = 'This message should stay silent.';
    await sendChat(b.page, silentText, 'B');
    await waitForMessage(a.page, silentText, 'peer', 'A');
    await sleep(600);
    const spokenAfterMute = await a.page.evaluate(() => window.__spoken.length);
    if (spokenAfterMute !== spokenBeforeMute) {
      fail(
        `A: spoke ${spokenAfterMute - spokenBeforeMute} utterance(s) while read aloud was off: ${JSON.stringify(
          await a.page.evaluate(() => window.__spoken),
        )}`,
      );
    }
    console.log('A read incoming messages aloud while the setting was on and stayed silent when off');

    await checkKeyboardLayout(a.page, 'A');

    const baselineStats = await readStats(b.page, 'B');
    const baselineBytes = Number.isFinite(baselineStats.bytesReceived) ? baselineStats.bytesReceived : 0;
    let micOpen = false;
    let statsB = baselineStats;
    try {
      await clickTalk(a.page, 'A');
      micOpen = true;
      await waitForTalking(a.page, true, MIC_LEVEL_TIMEOUT_MS, 'A after click');
      const deadline = Date.now() + AUDIO_TIMEOUT_MS;
      let flowing = false;
      while (Date.now() < deadline) {
        statsB = await readStats(b.page, 'B');
        const received = Number.isFinite(statsB.bytesReceived) ? statsB.bytesReceived : 0;
        const bitrate = Number.isFinite(statsB.bitrateKbps) ? statsB.bitrateKbps : 0;
        if (received - baselineBytes >= 4_000 && bitrate > 0) {
          flowing = true;
          break;
        }
        await sleep(100);
      }
      if (!flowing) {
        const received = Number.isFinite(statsB.bytesReceived) ? statsB.bytesReceived : 0;
        fail(
          `A toggle: B received ${received - baselineBytes} audio bytes (needs >= 4000) with bitrateKbps=${formatValue(statsB.bitrateKbps)} (needs > 0) within ${AUDIO_TIMEOUT_MS} ms; last B stats ${formatStats(statsB)}`,
        );
      }
    } finally {
      if (micOpen) await clickTalk(a.page, 'A');
    }
    await waitForTalking(a.page, false, MIC_LEVEL_TIMEOUT_MS, 'A after second click');
    const closedLevel = await waitForLocalLevel(a.page, 'down', MIC_LEVEL_TIMEOUT_MS, 'A after second click');
    console.log(`B received ${statsB.bytesReceived - baselineBytes} audio bytes while A held the mic open`);
    console.log(`Latch check: a second click closed the mic at localLevel ${closedLevel.toFixed(2)}`);

    let statsA = await readStats(a.page, 'A');
    const rttDeadline = Date.now() + RTT_TIMEOUT_MS;
    while (Date.now() < rttDeadline) {
      if (typeof statsA.rttMs === 'number' && Number.isFinite(statsA.rttMs)) break;
      await sleep(100);
      statsA = await readStats(a.page, 'A');
    }
    if (typeof statsA.rttMs !== 'number' || !Number.isFinite(statsA.rttMs)) {
      fail(`A: rttMs was not a number within ${RTT_TIMEOUT_MS} ms; last A stats ${formatStats(statsA)}`);
    }
    if (!(statsA.rttMs < 100)) {
      fail(`A: rttMs=${formatValue(statsA.rttMs)} ms is not below 100 ms on loopback`);
    }
    console.log(`A stats (network RTT, not mouth-to-ear): ${formatStats(statsA)}`);
    console.log(`B stats (network RTT, not mouth-to-ear): ${formatStats(statsB)}`);

    await checkSpaceToggle(a.page);

    await b.context.close();
    await waitForBodyState(a.page, 'waiting', WAITING_TIMEOUT_MS, 'A after B closed');
    const stateAfterLeave = await readState(a.page, 'A');
    if (stateAfterLeave.talking) fail('A: the mic stayed open after B left');
    console.log('A returned to waiting after B left with the mic closed');

    const c = await openContext(browser, 'C', origin);
    await c.page.goto(`${baseUrl}/?room=${encodeURIComponent(roomCode)}`, {
      waitUntil: 'load',
      timeout: LIVE_TIMEOUT_MS,
    });
    await Promise.all([
      waitForBodyState(a.page, 'live', LIVE_TIMEOUT_MS, 'A with C'),
      waitForBodyState(c.page, 'live', LIVE_TIMEOUT_MS, 'C with A'),
    ]);
    console.log('A and C are live after B left');

    const screenshotDir = path.join(ROOT, 'test-results');
    await mkdir(screenshotDir, { recursive: true });
    await a.page.screenshot({ path: path.join(screenshotDir, 'e2e-live.png'), fullPage: true });
    console.log(`saved ${path.join('test-results', 'e2e-live.png')}`);

    console.log(`PASS room=${roomCode} ${formatStats(statsA)}`);
  } finally {
    if (browser) {
      await browser.close().catch((error) => {
        console.error(`warning: browser close failed: ${firstLine(error)}`);
      });
    }
    await stopServer(serverChild);
  }
}

try {
  await main();
  process.exitCode = 0;
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
