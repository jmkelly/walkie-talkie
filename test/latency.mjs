import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'test-results');
const SAMPLE_RATE = 48_000;
const RECORD_MS = 4_500;
const MIC_OPEN_AT_MS = 1_400;
const CLICK_AT_MS = 1_700;
const MIC_CLOSE_AT_MS = 2_400;
const CLICK_FREQ = 2_000;
const CLICK_MS = 60;
const TARGET_MS = 150;
const ESTIMATED_AIR_MS = 2;
const PROBE = process.env.LATENCY_PROBE !== '0';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  throw new Error(message);
}

function sessionEnv() {
  const env = { ...process.env };
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    try {
      const output = execFileSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' });
      for (const line of output.split('\n')) {
        const match = line.match(/^(DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)=(.*)$/);
        if (match) env[match[1]] = match[2];
      }
    } catch {}
  }
  return env;
}

function writeClick(file) {
  const count = Math.round((SAMPLE_RATE * CLICK_MS) / 1000);
  const fade = Math.round(SAMPLE_RATE * 0.005);
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i += 1) {
    const gain = Math.min(1, i / fade, (count - 1 - i) / fade);
    const value = Math.sin((2 * Math.PI * CLICK_FREQ * i) / SAMPLE_RATE) * gain * 0.6;
    data.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([header, data]));
}

function getVolume(target) {
  const output = execFileSync('wpctl', ['get-volume', target], { encoding: 'utf8' });
  const match = output.match(/Volume:\s+([\d.]+)/);
  if (!match) fail(`Could not read volume for ${target} from: ${output.trim()}`);
  return Number(match[1]);
}

function setVolume(target, value) {
  execFileSync('wpctl', ['set-volume', target, String(value)]);
}

function startRecorder(file, channels) {
  const sink = execFileSync('pactl', ['get-default-sink'], { encoding: 'utf8' }).trim();
  const fd = openSync(file, 'w');
  const recorder = spawn(
    'parec',
    [
      `--device=${sink}.monitor`,
      '--format=s16le',
      `--rate=${SAMPLE_RATE}`,
      `--channels=${channels}`,
      '--latency-msec=10',
      '--raw',
    ],
    { stdio: ['ignore', fd, 'pipe'] },
  );
  let stderr = '';
  recorder.stderr.setEncoding('utf8');
  recorder.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return { recorder, fd, stderr: () => stderr };
}

async function stopRecorder({ recorder, fd, stderr }) {
  recorder.kill('SIGTERM');
  await new Promise((resolve) => recorder.once('close', resolve));
  closeSync(fd);
  if (stderr()) console.error(`parec: ${stderr().trim()}`);
}

async function play(file) {
  const player = spawn('paplay', [file], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    player.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`paplay exited with code ${code}`));
    });
    player.once('error', reject);
  });
}

function analyzeEnvelope(file, channels) {
  const raw = readFileSync(file);
  const frames = Math.floor(raw.length / (2 * channels));
  if (frames < SAMPLE_RATE) fail(`Recording is too short: ${frames} frames`);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += raw.readInt16LE((i * channels + channel) * 2) / 32768;
    }
    samples[i] = sum / channels;
  }

  const period = SAMPLE_RATE / CLICK_FREQ;
  const cos = [];
  const sin = [];
  for (let i = 0; i < period; i += 1) {
    const phase = (-2 * Math.PI * CLICK_FREQ * i) / SAMPLE_RATE;
    cos.push(Math.cos(phase));
    sin.push(Math.sin(phase));
  }

  const window = 480;
  const prefixI = new Float64Array(frames + 1);
  const prefixQ = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i += 1) {
    const phase = i % period;
    prefixI[i + 1] = prefixI[i] + samples[i] * cos[phase];
    prefixQ[i + 1] = prefixQ[i] + samples[i] * sin[phase];
  }

  const step = 48;
  const times = [];
  const envelope = [];
  for (let start = 0; start + window <= frames; start += step) {
    const i = prefixI[start + window] - prefixI[start];
    const q = prefixQ[start + window] - prefixQ[start];
    times.push(start / SAMPLE_RATE);
    envelope.push(Math.hypot(i, q) / window);
  }

  const sorted = [...envelope].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const peak = Math.max(...envelope);
  const threshold = Math.max(median * 6, peak * 0.05);
  const hits = [];
  for (let i = 0; i < envelope.length; i += 1) {
    if (envelope[i] > threshold) hits.push(i);
  }
  const groups = [];
  for (const index of hits) {
    const last = groups.at(-1);
    if (last && times[index] - times[last.end] < 0.02) last.end = index;
    else groups.push({ start: index, end: index });
  }

  return {
    duration: frames / SAMPLE_RATE,
    median,
    peak,
    threshold,
    groups: groups.map((group) => {
      let best = group.start;
      for (let i = group.start; i <= group.end; i += 1) if (envelope[i] > envelope[best]) best = i;
      return {
        startMs: times[group.start] * 1000,
        peakMs: times[best] * 1000,
        durationMs: (times[group.end] - times[group.start]) * 1000,
        peak: envelope[best],
      };
    }),
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const clickFile = path.join(OUT_DIR, 'latency-click.wav');
  const monitorFile = path.join(OUT_DIR, 'latency-monitor.raw');
  writeClick(clickFile);

  const previousSink = getVolume('@DEFAULT_AUDIO_SINK@');
  const previousSource = getVolume('@DEFAULT_AUDIO_SOURCE@');
  let server = null;
  let browser = null;
  let contextA = null;
  let contextB = null;
  let recorder = null;
  try {
    setVolume('@DEFAULT_AUDIO_SINK@', 0.5);
    setVolume('@DEFAULT_AUDIO_SOURCE@', 0.7);
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const room = 'TEST-2345';
    const env = sessionEnv();
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) fail('No display session found. Run this from the desktop session.');

    browser = await chromium.launch({
      headless: false,
      env,
      args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    });
    const origin = new URL(server.url).origin;
    contextA = await browser.newContext();
    contextB = await browser.newContext();
    await contextA.grantPermissions(['microphone'], { origin });
    await contextB.grantPermissions(['microphone'], { origin });
    const a = await contextA.newPage();
    const b = await contextB.newPage();

    const probeQuery = PROBE ? '&probe=1' : '';
    await a.goto(`${server.url}/?room=${room}${probeQuery}`, { waitUntil: 'load' });
    await a.locator('#start').click();
    await a.waitForFunction(() => document.body.dataset.state === 'waiting', null, { timeout: 15_000 });
    await b.goto(`${server.url}/?room=${room}`, { waitUntil: 'load' });
    await b.locator('#start').click();
    await Promise.all([
      a.waitForFunction(() => document.body.dataset.state === 'live', null, { timeout: 15_000 }),
      b.waitForFunction(() => document.body.dataset.state === 'live', null, { timeout: 15_000 }),
    ]);

    const settings = await a.evaluate(() => window.__walkie.state());
    console.log(`A mic settings: ${JSON.stringify(settings.micSettings)}`);
    const playing = await b.evaluate(async () => {
      const audio = document.getElementById('remote-audio');
      if (audio.paused) await audio.play().catch(() => {});
      return { paused: audio.paused, srcObject: Boolean(audio.srcObject) };
    });
    console.log(`B remote audio: ${JSON.stringify(playing)}`);
    if (!playing.srcObject) fail('B has no remote audio stream');
    if (playing.paused) fail('B is not playing the remote audio');

    recorder = startRecorder(monitorFile, 2);
    await sleep(MIC_OPEN_AT_MS);
    await a.locator('#ptt').click();
    await a.waitForFunction(() => window.__walkie.state().talking === true, null, { timeout: 5_000 });
    await sleep(CLICK_AT_MS - MIC_OPEN_AT_MS);
    await play(clickFile);
    await sleep(MIC_CLOSE_AT_MS - CLICK_AT_MS);
    await a.locator('#ptt').click();
    await a.waitForFunction(() => window.__walkie.state().talking === false, null, { timeout: 5_000 });
    await sleep(RECORD_MS - MIC_CLOSE_AT_MS);
    await stopRecorder(recorder);
    recorder = null;

    const bStats = await b.evaluate(() => window.__walkie.stats());
    console.log(
      `B inbound stats: rtt=${bStats.rttMs} jitter=${bStats.jitterMs} ` +
        `jitterBufferDelay=${bStats.jitterBufferDelayMs} jitterBufferTarget=${bStats.jitterBufferMs}`,
    );

    const result = analyzeEnvelope(monitorFile, 2);
    console.log(
      `Recording ${result.duration.toFixed(2)} s, median ${result.median.toFixed(5)}, peak ${result.peak.toFixed(5)}`,
    );
    for (const group of result.groups) {
      console.log(
        `burst start ${group.startMs.toFixed(1)} ms, peak ${group.peakMs.toFixed(1)} ms, ` +
          `length ${group.durationMs.toFixed(1)} ms, amplitude ${group.peak.toFixed(5)}`,
      );
    }
    const direct = result.groups
      .filter((group) => group.startMs >= CLICK_AT_MS - 200 && group.startMs <= CLICK_AT_MS + 400)
      .sort((a, b) => b.peak - a.peak)[0];
    if (!direct) fail(`No direct click burst in the ${CLICK_AT_MS - 200} to ${CLICK_AT_MS + 400} ms window`);
    const echo = result.groups.find(
      (group) => group.startMs > direct.startMs + 20 && group.peak >= direct.peak * 0.08,
    );
    if (!echo) fail(`No app echo at least 8% of the direct click after ${direct.startMs.toFixed(1)} ms`);

    const measured = echo.startMs - direct.startMs;
    console.log(`Direct click at ${direct.startMs.toFixed(1)} ms, echo at ${echo.startMs.toFixed(1)} ms`);
    console.log(`Loop separation: ${measured.toFixed(1)} ms`);
    console.log(
      `This includes one speaker-to-mic hop. Estimated device mouth-to-ear: about ${(measured - ESTIMATED_AIR_MS).toFixed(1)} ms`,
    );
    if (measured - ESTIMATED_AIR_MS >= TARGET_MS) {
      fail(`Latency ${(measured - ESTIMATED_AIR_MS).toFixed(1)} ms is not below ${TARGET_MS} ms`);
    }
    console.log('PASS');
  } finally {
    setVolume('@DEFAULT_AUDIO_SINK@', previousSink);
    setVolume('@DEFAULT_AUDIO_SOURCE@', previousSource);
    if (recorder) await stopRecorder(recorder).catch(() => {});
    if (contextA) await contextA.close().catch(() => {});
    if (contextB) await contextB.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (server) await server.close();
  }
}

try {
  await main();
  process.exitCode = 0;
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
