// Rasterizes scripts/icon.mjs into icons/icon{16,48,128}.png with headless Chrome (exact pixel sizes,
// transparent background). Run from the repo root:
//   node scripts/render-icons.mjs            # writes icons/
//   node scripts/render-icons.mjs --out DIR  # writes DIR/ instead (e.g. to preview)
// Needs Google Chrome and Node 22+ (built-in WebSocket).

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { svg } from "./icon.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const outArg = process.argv.indexOf("--out");
const OUT = outArg > 0 ? resolve(process.argv[outArg + 1]) : join(ROOT, "icons");
const SIZES = [16, 48, 128];
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const profile = mkdtempSync(join(tmpdir(), "icons-chrome-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl = await new Promise((res, rej) => {
  let buf = "";
  chrome.stderr.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); });
  chrome.on("exit", () => rej(new Error("Chrome exited:\n" + buf)));
});

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  mkdirSync(OUT, { recursive: true });
  for (const size of SIZES) {
    // Draw the SVG onto a canvas of exactly size×size and read back a PNG
    const expression = `(async () => {
      const img = new Image();
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(${JSON.stringify(svg(size))});
      await img.decode();
      const c = document.createElement("canvas"); c.width = c.height = ${size};
      c.getContext("2d").drawImage(img, 0, 0, ${size}, ${size});
      return c.toDataURL("image/png");
    })()`;
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    const file = join(OUT, `icon${size}.png`);
    writeFileSync(file, Buffer.from(r.result.value.split(",")[1], "base64"));
    console.log("wrote", file);
  }
} finally {
  ws.close();
  const exited = new Promise((r) => chrome.once("exit", r));
  chrome.kill();
  await exited;
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
