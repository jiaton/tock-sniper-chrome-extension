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
        display: grid; grid-template-columns: 1fr 1fr 0.8fr; gap: 6px; font-size: 11px;
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
      <div>Current<strong id="ts-now">--:--:--.---</strong></div>
      <div>Countdown<strong id="ts-countdown">--:--.---</strong></div>
      <div>Offset<strong id="ts-offset">--ms</strong></div>
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
  const nowEl = document.getElementById("ts-now");
  const countdownEl = document.getElementById("ts-countdown");
  const offsetEl = document.getElementById("ts-offset");
  if (nowEl) nowEl.textContent = formatClock(nowMs());
  if (countdownEl) countdownEl.textContent = releaseMs ? formatCountdown(releaseMs - nowMs()) : "--:--.---";
  if (offsetEl) offsetEl.textContent = `${Math.round(clockOffsetMs)}ms`;
}

async function syncServerClock(reason = "sync") {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CLOCK_SYNC_TIMEOUT_MS);
  try {
    const res = await fetch(location.href, {
      method: "HEAD",
      cache: "no-store",
      credentials: "include",
      signal: controller.signal,
    });
    const serverDate = res.headers.get("date");
    if (!serverDate) throw new Error("missing Date header");

    const finishedAt = Date.now();
    const midpoint = startedAt + (finishedAt - startedAt) / 2;
    clockOffsetMs = new Date(serverDate).getTime() - midpoint;
    const sync = {
      offsetMs: clockOffsetMs,
      sampledAt: finishedAt,
      rttMs: finishedAt - startedAt,
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
}

async function snipe(config) {
  // Step 1: Find "Book now" — retry up to 15s
  let bookLink = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    bookLink = [...document.querySelectorAll("a")].find(
      (a) => a.textContent.trim() === "Book now"
    );
    if (bookLink) break;
    await sleep(200);
  }
  if (!bookLink) {
    setStatus("❌ No slots found", "error");
    log("No 'Book now' link after 15s", "error");
    return;
  }
  log("🎉 Clicking Book now...");
  bookLink.click();

  // Step 2: Wait for dialog
  let dialog = null;
  const dlgDeadline = Date.now() + 5000;
  while (Date.now() < dlgDeadline) {
    dialog = document.querySelector('[role="dialog"]');
    if (dialog) break;
    await sleep(100);
  }
  if (!dialog) { setStatus("❌ Dialog failed", "error"); log("Dialog didn't open", "error"); return; }
  log("📋 Dialog opened");
  await sleep(myTarget.hasUrlDate ? 100 : 500);

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
