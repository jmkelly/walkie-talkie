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

async function clickStart(page, label) {
  try {
    await page.locator('#start').click({ timeout: STEP_TIMEOUT_MS });
  } catch (error) {
    fail(`${label}: could not click #start: ${firstLine(error)}`);
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
    await a.page.goto(`${baseUrl}/`, { waitUntil: 'load', timeout: LIVE_TIMEOUT_MS });
    await clickStart(a.page, 'A');
    await waitForBodyState(a.page, 'waiting', LIVE_TIMEOUT_MS, 'A after #start');
    const roomCode = await readRoomCode(a.page, 'A');
    if (!(await a.page.locator('#chat-input').isDisabled())) {
      fail('A: the chat input should be disabled while waiting for a peer');
    }
    console.log(`room ${roomCode}: A is waiting`);

    const b = await openContext(browser, 'B', origin);
    await b.page.goto(`${baseUrl}/?room=${encodeURIComponent(roomCode)}`, {
      waitUntil: 'load',
      timeout: LIVE_TIMEOUT_MS,
    });
    await clickStart(b.page, 'B');
    await Promise.all([
      waitForBodyState(a.page, 'live', LIVE_TIMEOUT_MS, 'A with B'),
      waitForBodyState(b.page, 'live', LIVE_TIMEOUT_MS, 'B with A'),
    ]);
    console.log('A and B are live');

    await waitForDebugApi(a.page, 'A');
    await waitForDebugApi(b.page, 'B');

    const chatHello = 'Hi! Can you hear me?';
    const chatReply = 'Loud and clear.';
    await sendChat(a.page, chatHello, 'A');
    await waitForMessage(a.page, chatHello, 'self', 'A');
    await waitForMessage(b.page, chatHello, 'peer', 'B');
    await sendChat(b.page, chatReply, 'B');
    await waitForMessage(b.page, chatReply, 'self', 'B');
    await waitForMessage(a.page, chatReply, 'peer', 'A');
    console.log('A and B exchanged chat messages');

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
    await clickStart(c.page, 'C');
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
