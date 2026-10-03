// Records scripts/demo.html into docs/demo.gif (README demo).
// Needs: Google Chrome, ffmpeg, Node 22+ (built-in WebSocket). Run from the repo root:
//   node scripts/record-demo.mjs
// Serves the repo on a local port, drives the demo frame by frame over the Chrome DevTools Protocol
// (window.demoStep advances a virtual clock, so timing doesn't depend on render speed), then builds a
// palette-optimized GIF with ffmpeg.

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "docs", "demo.gif");
const FPS = 15;
const WIDTH = 960, HEIGHT = 600;
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".css": "text/css" };
const server = createServer((req, res) => {
  const path = join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!path.startsWith(ROOT)) return res.writeHead(403).end();
  let body;
  try { body = readFileSync(path); } catch { return res.writeHead(404).end(); }
  res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" }).end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const profile = mkdtempSync(join(tmpdir(), "demo-chrome-"));
const frames = mkdtempSync(join(tmpdir(), "demo-frames-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  `--window-size=${WIDTH},${HEIGHT}`, "--hide-scrollbars", "--force-device-scale-factor=1", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl = await new Promise((res, rej) => {
  let buf = "";
  chrome.stderr.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); });
  chrome.on("exit", () => rej(new Error("Chrome exited:\n" + buf)));
});

// Minimal CDP client
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  await page("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await page("Page.navigate", { url: `http://127.0.0.1:${port}/scripts/demo.html` });
  const evaluate = async (expression) => {
    const r = await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  for (let i = 0; i < 100 && !(await evaluate("typeof window.demoReady !== 'undefined'")); i++) await new Promise((r) => setTimeout(r, 100));
  await evaluate("window.demoReady");
  const duration = await evaluate("window.demoDuration");

  const count = Math.ceil(duration / (1000 / FPS));
  for (let i = 0; i < count; i++) {
    await evaluate(`window.demoStep(${1000 / FPS})`);
    const { data } = await page("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(frames, `f${String(i).padStart(4, "0")}.png`), Buffer.from(data, "base64"));
    if (i % 30 === 0) process.stdout.write(`frame ${i}/${count}\r`);
  }
  console.log(`captured ${count} frames`);

  mkdirSync(join(ROOT, "docs"), { recursive: true });
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(frames, "f%04d.png"),
    "-vf", "split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
    "-loop", "0", OUT]);
  console.log(`wrote ${OUT} (${(statSync(OUT).size / 1024 / 1024).toFixed(2)} MB)`);
} finally {
  ws.close();
  const exited = new Promise((r) => chrome.once("exit", r));
  chrome.kill();
  await exited; // Chrome keeps writing its profile until it's gone
  server.close();
  if (process.env.KEEP_FRAMES) console.log(`frames kept in ${frames}`);
  else rmSync(frames, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
