// Tock Sniper — content script
// Simple logic:
// - Before release time: show countdown, reload at release - 75ms
// - After release time (including after reload): immediately snipe

let myDate = null;
let myTarget = null;
let overlay = null;
let clockOffsetMs = 0;
let clockSyncedAtPerf = 0;
let clockSyncedAtServerMs = 0;
const RELOAD_LEAD_MS = 75;
const CLOCK_SYNC_SKIP_WINDOW_MS = 5000;
const CLOCK_SYNC_TTL_MS = 5 * 60 * 1000;
const CLOCK_SYNC_KEY = "tockClockSync";
const CLOCK_SYNC_INTERVAL_MS = 30000;
const FINAL_CALIBRATION_AT_MS = 15000;
const CLOCK_SYNC_TIMEOUT_MS = 1200;
const FINAL_CALIBRATION_SAMPLES = 3;

function createOverlay() {
  overlay = document.createElement("div");
  overlay.id = "tock-sniper-overlay";
  overlay.innerHTML = `
    <style>
      #tock-sniper-overlay {
        position: fixed; top: 12px; right: 12px; z-index: 999999;
        width: 320px; max-height: 400px; background: #1a1a2e; color: #eee;
        border-radius: 10px; font: 13px/1.5 -apple-system, sans-serif;
        box-shadow: 0 4px 24px rgba(0,0,0,0.4); overflow: hidden;
      }
      #tock-sniper-overlay .ts-header {
        padding: 8px 12px; background: #16213e; font-weight: 700; font-size: 14px;
        display: flex; justify-content: space-between; align-items: center;
      }
      #tock-sniper-overlay .ts-header span { opacity: 0.65; font-size: 11px; text-align: right; }
      #tock-sniper-overlay .ts-clock {
        padding: 6px 12px; background: #101629; color: #b5d4ff; font-variant-numeric: tabular-nums;
        display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; font-size: 11px;
      }
      #tock-sniper-overlay .ts-clock strong { color: #fff; font-weight: 700; display: block; }
      #tock-sniper-overlay .ts-log {
        padding: 8px 12px; max-height: 300px; overflow-y: auto; font-size: 12px;
      }
      #tock-sniper-overlay .ts-entry { padding: 3px 0; border-bottom: 1px solid #ffffff10; }
      #tock-sniper-overlay .ts-entry.error { color: #ff6b6b; }
      #tock-sniper-overlay .ts-entry.success { color: #51cf66; }
      #tock-sniper-overlay .ts-entry.info { color: #74c0fc; }
      #tock-sniper-overlay .ts-entry .ts-time { opacity: 0.4; margin-right: 6px; }
      #tock-sniper-overlay .ts-status {
        padding: 6px 12px; font-size: 13px; font-weight: 600; text-align: center;
      }
      #tock-sniper-overlay .ts-status.waiting { background: #1971c2; }
      #tock-sniper-overlay .ts-status.running { background: #e67700; }
      #tock-sniper-overlay .ts-status.success { background: #2f9e44; }
      #tock-sniper-overlay .ts-status.error { background: #c92a2a; }
    </style>
    <div class="ts-header">🎯 Tock Sniper <span id="ts-date"></span></div>
    <div class="ts-clock">
      <div>Local<strong id="ts-local">--:--:--.---</strong></div>
      <div>Server (est.)<strong id="ts-now">--:--:--.---</strong></div>
      <div>Countdown<strong id="ts-countdown">--:--.---</strong></div>
    </div>
    <div class="ts-status waiting" id="ts-status">Initializing...</div>
    <div class="ts-log" id="ts-log"></div>
  `;
  document.body.appendChild(overlay);
}

function setStatus(text, type = "waiting") {
  const el = document.getElementById("ts-status");
  if (el) { el.textContent = text; el.className = `ts-status ${type}`; }
}

function addLog(msg, type = "info") {
  const logEl = document.getElementById("ts-log");
  if (!logEl) return;
  const time = formatClock(nowMs());
  const entry = document.createElement("div");
  entry.className = `ts-entry ${type}`;
  entry.innerHTML = `<span class="ts-time">${time}</span>${msg}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

const log = (msg, type = "info") => {
  const prefix = myDate ? `[${myDate}]` : "[TockSniper]";
  console.log(`${prefix} ${msg}`);
  addLog(msg, type);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => (
  clockSyncedAtServerMs
    ? clockSyncedAtServerMs + performance.now() - clockSyncedAtPerf
    : Date.now() + clockOffsetMs
);

function setClockSync(sync) {
  clockOffsetMs = sync.offsetMs;
  clockSyncedAtPerf = performance.now();
  clockSyncedAtServerMs = Date.now() + clockOffsetMs;
}

function formatClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function formatCountdown(ms) {
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);
  const minutes = Math.floor(abs / 60000);
  const seconds = Math.floor((abs % 60000) / 1000);
  const millis = Math.floor(abs % 1000);
  return `${sign}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function updateClock(releaseMs = 0) {
  const localEl = document.getElementById("ts-local");
  const nowEl = document.getElementById("ts-now");
  const countdownEl = document.getElementById("ts-countdown");
  if (localEl) localEl.textContent = formatClock(Date.now());
  if (nowEl) nowEl.textContent = formatClock(nowMs());
  if (countdownEl) countdownEl.textContent = releaseMs ? formatCountdown(releaseMs - nowMs()) : "--:--.---";
}

async function syncServerClock(reason = "sync") {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CLOCK_SYNC_TIMEOUT_MS);
  try {
    // Use Tock's own API endpoint for accurate backend time measurement.
    // The Date header from Cloudflare can differ from Tock's backend clock.
    // A lightweight HEAD to the page still goes through Cloudflare → Tock,
    // and the Date header reflects when Cloudflare received the response.
    // This is the closest we can get without parsing proto timestamps.
    const res = await fetch(location.href, {
      method: "HEAD",
      cache: "no-store",
      credentials: "include",
      signal: controller.signal,
    });
    const serverDate = res.headers.get("date");
    if (!serverDate) throw new Error("missing Date header");

    const finishedAt = Date.now();
    const rttMs = finishedAt - startedAt;
    // NTP-style: server stamped the response midway through the round trip
    const midpoint = startedAt + rttMs / 2;
    clockOffsetMs = new Date(serverDate).getTime() - midpoint;
    const sync = {
      offsetMs: clockOffsetMs,
      sampledAt: finishedAt,
      rttMs,
    };
    const { best, replaced } = await saveBestClockSync(sync);
    const suffix = replaced ? "" : `; kept best RTT ${best.rttMs}ms`;
    log(`Clock ${reason}: sample ${Math.round(sync.offsetMs)}ms, RTT ${sync.rttMs}ms${suffix}`);
    return true;
  } catch (err) {
    if (err.name !== "AbortError") {
      log(`Clock ${reason} unavailable; using best known clock (${err.message})`, "error");
    }
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function saveBestClockSync(sync) {
  let current = await readCachedClockSync();
  if (current && Date.now() - current.sampledAt > CLOCK_SYNC_TTL_MS) current = null;
  const shouldReplace = !current || sync.rttMs <= (current.rttMs ?? Infinity);
  const best = shouldReplace ? sync : current;
  setClockSync(best);
  sessionStorage.setItem(CLOCK_SYNC_KEY, JSON.stringify(best));
  await chrome.storage.local.set({ [CLOCK_SYNC_KEY]: best });
  return { best, replaced: shouldReplace };
}

async function readCachedClockSync() {
  const rawSessionSync = sessionStorage.getItem(CLOCK_SYNC_KEY);
  let sessionSync = null;
  try {
    sessionSync = rawSessionSync ? JSON.parse(rawSessionSync) : null;
  } catch {
    sessionStorage.removeItem(CLOCK_SYNC_KEY);
  }
  const { [CLOCK_SYNC_KEY]: storedSync } = await chrome.storage.local.get(CLOCK_SYNC_KEY);
  return sessionSync || storedSync || null;
}

async function useCachedClockSync() {
  const sync = await readCachedClockSync();

  if (!sync || typeof sync.offsetMs !== "number") return false;
  if (Date.now() - sync.sampledAt > CLOCK_SYNC_TTL_MS) return false;

  setClockSync(sync);
  sessionStorage.setItem(CLOCK_SYNC_KEY, JSON.stringify(sync));
  log(`Clock sync cached: ${Math.round(clockOffsetMs)}ms vs local, RTT ${sync.rttMs ?? "?"}ms`);
  return true;
}

async function prepareClock(releaseMs) {
  if (await useCachedClockSync()) return;

  const localRemaining = releaseMs ? releaseMs - Date.now() : Infinity;
  if (releaseMs && localRemaining <= CLOCK_SYNC_SKIP_WINDOW_MS) {
    log(`Skipping clock sync inside final ${CLOCK_SYNC_SKIP_WINDOW_MS}ms window`);
    return;
  }

  await syncServerClock("initial");
}

function scheduleClockCalibration(releaseMs) {
  if (!releaseMs) return () => {};

  const timers = [];
  const runIfSafe = (reason) => {
    if (releaseMs - nowMs() <= CLOCK_SYNC_SKIP_WINDOW_MS) return;
    syncServerClock(reason);
  };

  const intervalId = setInterval(() => runIfSafe("refresh"), CLOCK_SYNC_INTERVAL_MS);
  timers.push(() => clearInterval(intervalId));

  const finalDelay = releaseMs - FINAL_CALIBRATION_AT_MS - nowMs();
  if (finalDelay > 0) {
    const finalTimer = setTimeout(async () => {
      log(`Final clock calibration: ${FINAL_CALIBRATION_SAMPLES} samples`);
      for (let i = 0; i < FINAL_CALIBRATION_SAMPLES; i++) {
        if (releaseMs - nowMs() <= CLOCK_SYNC_SKIP_WINDOW_MS) break;
        await syncServerClock(`final ${i + 1}/${FINAL_CALIBRATION_SAMPLES}`);
        await sleep(150);
      }
      log("Clock calibration frozen for final window");
    }, finalDelay);
    timers.push(() => clearTimeout(finalTimer));
  }

  const freezeDelay = releaseMs - CLOCK_SYNC_SKIP_WINDOW_MS - nowMs();
  if (freezeDelay > 0) {
    const freezeTimer = setTimeout(() => {
      timers.forEach((clear) => clear());
      log("Clock calibration frozen");
    }, freezeDelay);
    timers.push(() => clearTimeout(freezeTimer));
  }

  return () => timers.forEach((clear) => clear());
}

function targetFromUrl() {
  const url = new URL(location.href);
  const date = url.searchParams.get("date");
  const timeParam = url.searchParams.get("time");
  return {
    date,
    timeParam,
    time: timeParamToDisplay(timeParam),
    hasUrlDate: Boolean(date),
  };
}

function timeParamToDisplay(timeParam) {
  const match = timeParam?.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return "";
  let hour = parseInt(match[1], 10);
  const minute = match[2];
  const meridiem = hour >= 12 ? "PM" : "AM";
  hour = hour % 12 || 12;
  return `${hour}:${minute} ${meridiem}`;
}

function targetLabel(target) {
  return [target.date, target.time].filter(Boolean).join(" ");
}

function getConfig() {
  return new Promise((r) => chrome.storage.local.get("config", (d) => r(d.config || {})));
}

async function run() {
  const { sniping } = await chrome.storage.local.get("sniping");
  if (!sniping) return;

  const config = await getConfig();
  if (!config.dates?.length && !config.targets?.length) return;

  // Pick target for this tab from URL/sessionStorage (survives reload) or claim a new one.
  const urlTarget = targetFromUrl();
  const storedTarget = sessionStorage.getItem("tockSniperTarget");
  myTarget = storedTarget ? JSON.parse(storedTarget) : null;

  if (!myTarget && urlTarget.date) {
    myTarget = urlTarget;
  }

  if (!myTarget) {
    const targets = config.targets || config.dates.map((date) => ({ date, time: "" }));
    const idx = parseInt(sessionStorage.getItem("tockSniperIdx") ?? "-1", 10);
    if (idx >= 0) {
      myTarget = targets[idx];
    } else {
      // Claim next unclaimed index via storage
      const { tockNextIdx = 0 } = await chrome.storage.local.get("tockNextIdx");
      myTarget = targets[tockNextIdx % targets.length];
      await chrome.storage.local.set({ tockNextIdx: tockNextIdx + 1 });
      sessionStorage.setItem("tockSniperIdx", String(tockNextIdx % targets.length));
    }
  }
  if (urlTarget.time && !myTarget.time) myTarget.time = urlTarget.time;
  myTarget.hasUrlDate = urlTarget.date === myTarget.date;
  myDate = myTarget.date;
  sessionStorage.setItem("tockSniperTarget", JSON.stringify(myTarget));
  sessionStorage.setItem("tockSniperDate", myDate);

  createOverlay();
  document.getElementById("ts-date").textContent = targetLabel(myTarget);
  document.title = `🎯 ${targetLabel(myTarget)} | ${document.title}`;
  const releaseMs = config.releaseTime ? new Date(config.releaseTime).getTime() : 0;
  await prepareClock(releaseMs);

  if (location.href.includes("/checkout/")) {
    document.title = `✅ ${targetLabel(myTarget)} — CHECKOUT`;
    setStatus("🛒 CHECKOUT — Complete payment!", "success");
    log("Already on checkout!", "success");
    return;
  }

  // PAST release time (or no release time set) → snipe immediately
  updateClock(releaseMs);
  const clockInterval = setInterval(() => updateClock(releaseMs), 50);

  if (!releaseMs || nowMs() >= releaseMs) {
    setStatus("🎯 Sniping NOW!", "running");
    log("GO — sniping immediately!");
    await snipe(config);
    clearInterval(clockInterval);
    return;
  }

  // FUTURE release time → countdown then reload
  const stopClockCalibration = scheduleClockCalibration(releaseMs);
  const delay = releaseMs - RELOAD_LEAD_MS - nowMs();
  const releaseStr = new Date(config.releaseTime).toLocaleTimeString();
  if (delay <= 0) {
    stopClockCalibration();
    const waitMs = Math.max(0, releaseMs - nowMs());
    setStatus(`⏰ Release in ${formatCountdown(waitMs)}`, "waiting");
    log(`Inside reload lead window; waiting ${formatCountdown(waitMs)} to snipe`);
    setTimeout(async () => {
      setStatus("🎯 Sniping NOW!", "running");
      log("GO — sniping immediately!");
      await snipe(config);
      clearInterval(clockInterval);
    }, waitMs);
    return;
  }

  const mode = config.snipeMode || "api";
  const needsReload = mode === "dom";

  if (needsReload) {
    setStatus(`⏰ Reload at ${releaseStr}`, "waiting");
    log(`Waiting ${formatCountdown(delay)} — reload ${RELOAD_LEAD_MS}ms before release`);

    const countdownInterval = setInterval(() => {
      const remaining = releaseMs - RELOAD_LEAD_MS - nowMs();
      if (remaining <= 0) { clearInterval(countdownInterval); return; }
      setStatus(`⏰ Reload in ${formatCountdown(remaining)}`, "waiting");
    }, 50);

    setTimeout(() => {
      clearInterval(countdownInterval);
      clearInterval(clockInterval);
      stopClockCalibration();
      setStatus("🔄 RELOADING!", "running");
      log("⚡ Reloading NOW!");
      location.reload();
    }, Math.max(0, delay));
  } else {
    // API/both mode: fire directly at release time, no reload needed
    // Start 500ms early to cover clock sync uncertainty (Date header has 1s resolution)
    const API_EARLY_MS = 500;
    const fireDelay = Math.max(0, releaseMs - API_EARLY_MS - nowMs());
    setStatus(`⏰ API fires at ${releaseStr}`, "waiting");
    log(`Waiting ${formatCountdown(fireDelay)} — API fires ~500ms before release (covers clock drift)`);

    const countdownInterval = setInterval(() => {
      const remaining = releaseMs - nowMs();
      if (remaining <= 0) { clearInterval(countdownInterval); return; }
      setStatus(`⏰ API in ${formatCountdown(remaining)}`, "waiting");
    }, 50);

    setTimeout(async () => {
      clearInterval(countdownInterval);
      clearInterval(clockInterval);
      stopClockCalibration();
      setStatus("🎯 Sniping NOW!", "running");
      log("GO — sniping immediately!");
      await snipe(config);
    }, fireDelay);
  }
}

async function snipe(config) {
  const mode = config.snipeMode || "api";
  if (mode === "api" || mode === "both") {
    const success = await snipeApi(config);
    if (success) return;
    if (mode === "api") {
      setStatus("⚠️ API failed — check manually", "error");
      return;
    }
    log("API snipe failed, falling back to DOM...", "error");
  }
  await snipeDom(config);
}

// ─── API Direct Snipe ───────────────────────────────────────────────────────

function extractTockMeta() {
  // Extract x-tock-scope from page's meta/scripts or cookies
  const scripts = document.querySelectorAll("script");
  let businessId = null, businessGroupId = null;
  for (const s of scripts) {
    const text = s.textContent;
    const bm = text.match(/"businessId"\s*:\s*(\d+)/);
    const gm = text.match(/"businessGroupId"\s*:\s*"?(\d+)"?/);
    if (bm) businessId = bm[1];
    if (gm) businessGroupId = gm[1];
    if (businessId && businessGroupId) break;
  }
  // Fallback: parse from existing fetch headers via performance entries
  if (!businessId) {
    const meta = document.querySelector('meta[name="tock:business_id"]');
    if (meta) businessId = meta.content;
  }
  return { businessId, businessGroupId };
}

function getTockHeaders(config) {
  const meta = extractTockMeta();
  const scope = JSON.stringify({
    businessId: meta.businessId || "",
    businessGroupId: meta.businessGroupId || "",
    site: "EXPLORETOCK",
  });
  // Session from cookie
  const sessionMatch = document.cookie.match(/JSESSIONID=([^;]+)/);
  const session = sessionMatch ? sessionMatch[1] : "";
  // x-tock-session from page state (stored by Tock's JS)
  const tockSession = sessionStorage.getItem("tock-session") ||
    document.cookie.split(";").map(c => c.trim()).find(c => c.startsWith("tock_session="))?.split("=")[1] || "";

  return {
    "accept": "application/octet-stream",
    "content-type": "application/octet-stream",
    "x-tock-stream-format": "proto2",
    "x-tock-scope": scope,
    "x-tock-path": new URL(location.href).pathname,
    "x-tock-build-number": "2026-05-08RC12-00",
  };
}

function encodeVarint(value) {
  const bytes = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return bytes;
}

function encodeLengthDelimited(fieldNum, data) {
  const tag = encodeVarint((fieldNum << 3) | 2);
  const len = encodeVarint(data.length);
  return [...tag, ...len, ...data];
}

function encodeVarintField(fieldNum, value) {
  const tag = encodeVarint((fieldNum << 3) | 0);
  const val = encodeVarint(value);
  return [...tag, ...val];
}

function encodeStringField(fieldNum, str) {
  const encoded = new TextEncoder().encode(str);
  return encodeLengthDelimited(fieldNum, [...encoded]);
}

function buildLockRequest(partySize, datetime, experienceId) {
  // PUT /api/ticket/group/lock
  // Wrapper: field 60051, wire type 2 (length-delimited)
  // Inner: f1=partySize, f2=datetime, f3=experienceId, f6=0
  const inner = [
    ...encodeVarintField(1, partySize),
    ...encodeStringField(2, datetime),
    ...encodeVarintField(3, experienceId),
    ...encodeVarintField(6, 0),
  ];
  return new Uint8Array(encodeLengthDelimited(60051, inner));
}

function extractExperienceId() {
  // From URL path: /experience/296772/...
  const m = location.pathname.match(/\/experience\/(\d+)/);
  if (m) return parseInt(m[1], 10);
  // From config target (stored from original URL)
  if (myTarget?.experienceId) return myTarget.experienceId;
  // From page content
  const scripts = document.querySelectorAll("script");
  for (const s of scripts) {
    const em = s.textContent.match(/"experienceId"\s*:\s*(\d+)/);
    if (em) return parseInt(em[1], 10);
  }
  return null;
}

function displayTimeToParam24(time) {
  const trimmed = time.trim();
  const m24 = trimmed.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (m24) return `${m24[1].padStart(2, "0")}:${m24[2]}`;
  const m12 = trimmed.match(/^(\d{1,2})(?::([0-5]\d))?\s*([AP])\.?M\.?$/i);
  if (!m12) return "";
  let hour = parseInt(m12[1], 10);
  const minute = m12[2] || "00";
  const mer = m12[3].toUpperCase();
  if (mer === "A" && hour === 12) hour = 0;
  if (mer === "P" && hour !== 12) hour += 12;
  return `${String(hour).padStart(2, "0")}:${minute}`;
}

async function snipeApi(config) {
  const experienceId = extractExperienceId();
  if (!experienceId) {
    log("❌ API: Can't find experience ID", "error");
    return false;
  }

  const partySize = config.partySize || 2;
  const timeParam = myTarget.timeParam || displayTimeToParam24(myTarget.time || "");
  if (!timeParam) {
    log("❌ API: No target time", "error");
    return false;
  }
  const datetime = `${myDate}T${timeParam}`;
  const headers = getTockHeaders(config);
  const body = buildLockRequest(partySize, datetime, experienceId);

  log(`🚀 API lock: ${datetime}, ${partySize} guests, exp ${experienceId}`);
  log(`📦 Lock request: ${body.length} bytes`);

  // Fire multiple attempts: covers clock uncertainty between local and server time.
  // Keep low — multiple tabs fire in parallel (e.g. 4 tabs × 5 = 20 total requests).
  const MAX_ATTEMPTS = 5;
  const RETRY_INTERVAL_MS = 250;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch("/api/ticket/group/lock", {
        method: "PUT",
        headers,
        body,
        credentials: "include",
      });

      if (res.ok) {
        const resData = new Uint8Array(await res.arrayBuffer());
        log(`✅ API lock success! Attempt ${attempt}, ${resData.length}B`, "success");
        setStatus("🛒 Slot locked! Loading checkout...", "success");
        const bizSlug = location.pathname.split("/")[1];
        location.href = `/${bizSlug}/checkout/confirm-purchase`;
        await sleep(5000);
        return true;
      }

      const status = res.status;
      const text = await res.text().catch(() => "");
      // 409/423 = slot not yet available or conflict — worth retrying
      // 400 = bad request — probably won't change, but retry a few times
      // 429 = rate limited — stop
      if (status === 429) {
        log(`⚠️ Rate limited on attempt ${attempt}, stopping`, "error");
        break;
      }
      log(`⏳ Attempt ${attempt}/${MAX_ATTEMPTS}: ${status} — retrying...`);
    } catch (err) {
      log(`⏳ Attempt ${attempt}/${MAX_ATTEMPTS}: ${err.message} — retrying...`);
    }

    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_INTERVAL_MS);
  }

  log("❌ API lock failed after all attempts", "error");
  return false;
}

// ─── DOM Click Snipe (original method) ──────────────────────────────────────

async function snipeDom(config) {
  // Step 1: Wait for dialog — if URL has date/time params, Tock auto-opens it
  // Only click "Book now" as fallback if dialog doesn't appear
  let dialog = null;
  const dlgDeadline = Date.now() + (myTarget.hasUrlDate ? 3000 : 1000);
  while (Date.now() < dlgDeadline) {
    dialog = document.querySelector('[role="dialog"]');
    if (dialog) break;
    await sleep(50);
  }

  if (!dialog) {
    // Fallback: click "Book now" manually
    let bookLink = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      bookLink = [...document.querySelectorAll("a")].find(
        (a) => a.textContent.trim() === "Book now"
      );
      if (bookLink) break;
      await sleep(50);
    }
    if (!bookLink) {
      setStatus("❌ No slots found", "error");
      log("No 'Book now' link after 15s", "error");
      return;
    }
    log("🎉 Clicking Book now...");
    bookLink.click();

    const dlgDeadline2 = Date.now() + 5000;
    while (Date.now() < dlgDeadline2) {
      dialog = document.querySelector('[role="dialog"]');
      if (dialog) break;
      await sleep(50);
    }
    if (!dialog) { setStatus("❌ Dialog failed", "error"); log("Dialog didn't open", "error"); return; }
    log("📋 Dialog opened");
    await sleep(myTarget.hasUrlDate ? 100 : 500);
  } else {
    log("📋 Dialog auto-opened from URL");
  }

  // Step 3: Select date — retry up to 10s, navigate months if needed
  if (myTarget.hasUrlDate) {
    log(`📅 URL date active: ${myDate}`);
  } else {
    let dateFound = false;
    const dateDeadline = Date.now() + 10000;
    while (Date.now() < dateDeadline) {
      const dateBtn = dialog.querySelector(`button[aria-label="${myDate}"]`);
      if (dateBtn) {
        if (dateBtn.disabled) {
          setStatus(`❌ ${myDate} sold out`, "error");
          log(`${myDate} is disabled/sold out`, "error");
          return;
        }
        log(`📅 Clicking date: ${myDate}`);
        dateBtn.click();
        dateFound = true;
        break;
      }
      const nextBtn = dialog.querySelector('button[aria-label="Go to next month"]');
      if (nextBtn && !nextBtn.disabled) {
        log("📅 Next month...");
        nextBtn.click();
        await sleep(600);
      } else {
        await sleep(300);
      }
    }
    if (!dateFound) {
      setStatus("❌ Date not found", "error");
      log(`Could not find ${myDate} on calendar`, "error");
      return;
    }
  }

  // Step 4: Wait for time slots
  let bookBtns = [];
  const slotDeadline = Date.now() + 10000;
  while (Date.now() < slotDeadline) {
    bookBtns = [...dialog.querySelectorAll("button")].filter(
      (b) => b.textContent.trim() === "Book" && !b.disabled
    );
    if (bookBtns.length > 0) break;
    await sleep(300);
  }
  if (bookBtns.length === 0) {
    setStatus("❌ No time slots", "error");
    log("No available time slots", "error");
    return;
  }

  // Step 5: Adjust party size
  const guestP = [...dialog.querySelectorAll("p")].find((p) => /\d+\s*guest/.test(p.textContent));
  if (guestP) {
    const current = parseInt(guestP.textContent) || 2;
    const target = config.partySize || 2;
    if (current !== target) {
      log(`👥 ${current} → ${target} guests`);
      const btn = dialog.querySelector(`button[aria-label="${current < target ? "More" : "Fewer"} guests"]`);
      if (btn) {
        for (let i = 0; i < Math.abs(target - current); i++) { btn.click(); await sleep(150); }
        await sleep(300);
      }
    }
  }

  // Step 6: Pick preferred time
  const slots = bookBtns.map((btn) => {
    for (let el = btn.parentElement; el && el !== dialog; el = el.parentElement) {
      const m = el.textContent.match(/\d{1,2}:\d{2}\s*[AP]M/);
      if (m) return { time: m[0], btn };
    }
    return { time: "unknown", btn };
  });

  log(`🕐 Slots: ${slots.map((s) => s.time).join(", ")}`);

  let chosen = slots[slots.length - 1];
  const preferredTimes = [myTarget.time, ...(config.prefTimes || [])].filter(Boolean);
  for (const pref of preferredTimes) {
    const match = slots.find((s) => s.time.includes(pref));
    if (match) { log(`🎯 Matched: ${match.time}`); chosen = match; break; }
  }

  log(`✅ Booking: ${chosen.time}`, "success");
  setStatus(`✅ Clicking ${chosen.time}...`, "running");
  chosen.btn.click();

  // Step 7: Handle seating area if it appears
  await sleep(500);
  const seatingBtn = [...dialog.querySelectorAll("button")].find(
    (b) => ["Bar", "Dining Room", "Patio", "Main Dining", "Counter", "Terrace", "Garden"]
      .some((s) => b.textContent.trim().startsWith(s)) && !b.disabled
  );
  if (seatingBtn) {
    log(`🪑 Selecting: ${seatingBtn.textContent.trim()}`);
    seatingBtn.click();
  }

  // Step 8: Check for checkout
  await sleep(3000);
  if (location.href.includes("/checkout/")) {
    document.title = `✅ ${targetLabel(myTarget)} ${chosen.time} — CHECKOUT`;
    setStatus(`🛒 GOT IT! ${chosen.time} — CHECKOUT`, "success");
    log(`🛒 Got ${chosen.time}! Complete checkout now.`, "success");
  } else {
    setStatus("⚠️ Check manually", "error");
    log("Didn't reach checkout — check manually", "error");
  }
}

run();
