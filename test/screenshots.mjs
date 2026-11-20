import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "screenshots");
const CHROMIUM_ARGS = [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
];
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server/index.js"], {
      cwd: ROOT,
      env: { ...process.env, PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("server did not print its listening URL"));
    }, 10_000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/listening on\s+(https?:\/\/\S+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve({ child, url: match[1] });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, sleep(3_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function makeContext(browser, origin, viewport, deviceScaleFactor) {
  const context = await browser.newContext({ viewport, deviceScaleFactor });
  await context.grantPermissions(["microphone"], { origin });
  return context;
}

async function send(page, text) {
  await page.locator("#chat-input").fill(text);
  await page.locator("#chat-input").press("Enter");
}

async function waitForLocalLevel(page, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const level = await page.evaluate(async () => (await window.__walkie?.stats?.())?.localLevel ?? 0);
    if (level > 0.03) return;
    await sleep(100);
  }
}

async function cleanFrame(page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.waitForTimeout(300);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  let server = null;
  let browser = null;
  try {
    const started = await startServer();
    server = started.child;
    const base = started.url.replace(/\/$/, "");
    const origin = new URL(base).origin;
    browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS, timeout: 30_000 });

    const ca = await makeContext(browser, origin, DESKTOP, 1.5);
    const a = await ca.newPage();
    a.on("pageerror", (error) => console.error(`A page error: ${error.message}`));
    a.on("console", (message) => {
      if (message.type() === "error") console.error(`A console error: ${message.text()}`);
    });
    await a.goto(`${base}/`, { waitUntil: "load" });
    await a.waitForFunction(() => document.body.dataset.state === "waiting");
    await a.waitForTimeout(400);
    await cleanFrame(a);
    await a.screenshot({ path: path.join(OUT, "channel-waiting.png") });

    await a.setViewportSize({ width: 390, height: 700 });
    await a.waitForTimeout(250);
    const shortLayout = await a.evaluate(() => {
      const height = (selector) => document.querySelector(selector)?.getBoundingClientRect().height ?? 0;
      return {
        chatVisible: getComputedStyle(document.querySelector(".chat")).display !== "none" && height("#messages") > 0,
        qrVisible: getComputedStyle(document.querySelector("#share-qr")).display !== "none" && height("#qr-code") > 0,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });
    if (!shortLayout.chatVisible || !shortLayout.qrVisible || shortLayout.overflow) {
      throw new Error(`short viewport layout failed: ${JSON.stringify(shortLayout)}`);
    }
    await cleanFrame(a);
    await a.screenshot({ path: path.join(OUT, "channel-waiting-mobile.png") });
    await a.setViewportSize(DESKTOP);
    await a.waitForTimeout(250);

    const room = (await a.locator("#room-code").textContent()).trim();
    const cb = await makeContext(browser, origin, DESKTOP, 1.5);
    const b = await cb.newPage();
    b.on("pageerror", (error) => console.error(`B page error: ${error.message}`));
    b.on("console", (message) => {
      if (message.type() === "error") console.error(`B console error: ${message.text()}`);
    });
    await b.goto(`${base}/?room=${encodeURIComponent(room)}`, { waitUntil: "load" });
    await Promise.all([
      a.waitForFunction(() => document.body.dataset.state === "live"),
      b.waitForFunction(() => document.body.dataset.state === "live"),
    ]);
    await a.waitForFunction(() => window.__walkie?.state?.().chatEnabled === true);
    await b.waitForFunction(() => window.__walkie?.state?.().chatEnabled === true);

    await send(a, "Ready for the next round?");
    await send(b, "Copy. Give me ten seconds.");
    await send(a, "No rush. I'm on channel.");
    await send(b, "Loud and clear.");
    await a.waitForTimeout(250);

    await a.locator("#ptt").click();
    await a.waitForFunction(() => window.__walkie?.state?.().talking === true);
    await waitForLocalLevel(a);
    await b.locator("#chat-input").fill("One more game?");
    await a.locator("#typing").waitFor({ state: "visible" });
    await cleanFrame(a);
    await a.screenshot({ path: path.join(OUT, "channel-live-desktop.png") });

    await a.locator("#ptt").click();
    await a.waitForFunction(() => window.__walkie?.state?.().talking === false);
    await b.locator("#chat-input").press("Enter");
    await a
      .locator('.message[data-from="peer"] .message-text')
      .filter({ hasText: "One more game?" })
      .waitFor();
    await a.setViewportSize(PHONE);
    await a.waitForTimeout(450);
    await cleanFrame(a);
    await a.screenshot({ path: path.join(OUT, "channel-live-mobile.png") });

    console.log(`saved screenshots to ${path.relative(ROOT, OUT)}/`);
    await ca.close();
    await cb.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
  }
}

try {
  await main();
  process.exitCode = 0;
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
