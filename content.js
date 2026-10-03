// Tock Sniper — content script
// Simple logic:
// - Before release time: show countdown (DOM mode reloads at release - RELOAD_LEAD_MS)
// - After release time (including after reload): immediately snipe

let myDate = null;
let myTarget = null;
let overlay = null;
// DOM mode reload lead. After a reload, Tock requests availability ~1.2–1.5s later (measured
// 2026-10-02), so reloading 800ms early lands that request ~400–700ms after release.
const RELOAD_LEAD_MS = 800;
// If the reloaded page still shows no availability (data fetched too early, or a stale experience
// ID), reload again — up to DOM_MAX_RETRIES times within DOM_RETRY_WINDOW_MS after release.
const DOM_MAX_RETRIES = 3;
const DOM_RETRY_WINDOW_MS = 10000;
const DOM_UNAVAILABLE_TEXT = /couldn't find this reservation|has sold out all reservations/i;
// API burst: start 10ms early, fire a request every 10ms WITHOUT waiting for the
// previous one (concurrent), keep going for a short window after release.
// API burst pacing, centered on the release time T: densest at T, sparser further away.
// Tock/Cloudflare answered HTTP 429 after ~50 requests in ~0.6s (2026-10-02); this schedule sends ~41.
// Each row: from this offset (ms, relative to T) on, one request (not awaiting responses) every `every` ms.
const API_SCHEDULE = [
  { from: -100, every: 20 },  // T-100 … T-40   ~3
  { from: -40, every: 5 },    // T-40  … T+40   ~16
  { from: 40, every: 15 },    // T+40  … T+100  ~4
  { from: 100, every: 50 },   // T+100 … T+500  ~8
  { from: 500, every: 250 },  // T+500 … T+3s   ~10
];
const API_BURST_AFTER_MS = 3000;    // burst ends at T+3s; a tab starting later sends a single request
const API_MAX_429 = 1;              // stop at the first 429: more requests only extend the block
const OFFERINGS_MIN_GAP_MS = 50;    // offerings rides along with lock sends, but at most every 50ms
// "Someone else just selected this" (410) for requests sent this long after release means the slot is gone
const SOLD_OUT_GRACE_MS = 500;
const SOLD_OUT_STREAK = 3;
const FALLBACK_BUILD_NUMBER = "servingstack-2026-09-30RC03-00";
// Monitor (opt-in, config.monitor): after a failed snipe, poll offerings until an experience is listed,
// then read the calendar and lock only when it shows seats. Lock 429s were still being returned ~28 min after a burst (2026-10-02) while
// offerings kept answering, so lock is only tried once the venue lists experiences.
const MONITOR_429_BACKOFF_MS = 10 * 60 * 1000;
// Once open, each check also reads the calendar (seats per time) and locks only a time that has a
// table for the party: the target time, else the closest one within ±flexMinutes (config.monitor).
const MONITOR_DEFAULT_FLEX_MIN = 60;

// The 16-px service-bell icon (scripts/icon.mjs), inlined: an <img> of the extension's own PNG would
// need web_accessible_resources, which would expose it to every site.
const BELL_ICON_SVG = `<svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
  <defs><linearGradient id="ts-bell-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb547"/><stop offset="1" stop-color="#f2621f"/></linearGradient></defs>
  <rect width="16" height="16" rx="3.5" fill="url(#ts-bell-bg)"/>
  <rect x="7" y="2" width="2" height="2" rx=".6" fill="#fff"/>
  <path d="M3 10 A5 5.5 0 0 1 13 10 Z" fill="#fff"/>
  <rect x="2" y="11" width="12" height="2" rx="1" fill="#fff"/>
</svg>`;

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
        cursor: grab; user-select: none; touch-action: none;
      }
      #tock-sniper-overlay.ts-dragging { opacity: 0.92; }
      #tock-sniper-overlay.ts-dragging .ts-header { cursor: grabbing; }
      #tock-sniper-overlay .ts-title { display: flex; align-items: center; gap: 7px; }
      #tock-sniper-overlay .ts-title svg { flex: none; }
      #tock-sniper-overlay #ts-date { opacity: 0.65; font-size: 11px; text-align: right; }
      #tock-sniper-overlay .ts-clock {
        padding: 6px 12px; background: #101629; color: #b5d4ff; font-variant-numeric: tabular-nums;
        display: grid; grid-template-columns: 1fr 1fr; gap: 6px; font-size: 11px;
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
    <div class="ts-header" title="Drag to move · double-click to reset"><span class="ts-title">${BELL_ICON_SVG}Tock Sniper</span><span id="ts-date"></span></div>
    <div class="ts-clock">
      <div>Local<strong id="ts-local">--:--:--.---</strong></div>
      <div>Countdown<strong id="ts-countdown">--:--.---</strong></div>
    </div>
    <div class="ts-status waiting" id="ts-status">Initializing...</div>
    <div class="ts-log" id="ts-log"></div>
  `;
  document.body.appendChild(overlay);
  makeOverlayDraggable(overlay, overlay.querySelector(".ts-header"));
}

// Drag the overlay by its header. The position is remembered (localStorage) so it survives the
// DOM-mode reload and applies to every Tock tab; double-click the header to go back to top-right.
const OVERLAY_POS_KEY = "tockSniperOverlayPos";

function placeOverlay(el, left, top) {
  const maxLeft = Math.max(0, window.innerWidth - el.offsetWidth);
  const maxTop = Math.max(0, window.innerHeight - 40); // keep at least the header on screen
  el.style.left = `${Math.min(Math.max(0, left), maxLeft)}px`;
  el.style.top = `${Math.min(Math.max(0, top), maxTop)}px`;
  el.style.right = "auto";
}

function makeOverlayDraggable(el, handle) {
  try {
    const saved = JSON.parse(localStorage.getItem(OVERLAY_POS_KEY) || "null");
    if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) placeOverlay(el, saved.left, saved.top);
  } catch {}

  let start = null;
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const rect = el.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, moved: false };
    handle.setPointerCapture(e.pointerId);
    el.classList.add("ts-dragging");
  });
  handle.addEventListener("pointermove", (e) => {
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < 3) return; // a click, not a drag
    start.moved = true;
    placeOverlay(el, start.left + dx, start.top + dy);
  });
  const end = () => {
    if (!start) return;
    const { moved } = start;
    start = null;
    el.classList.remove("ts-dragging");
    if (!moved) return;
    try {
      localStorage.setItem(OVERLAY_POS_KEY, JSON.stringify({ left: parseFloat(el.style.left), top: parseFloat(el.style.top) }));
    } catch {}
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  handle.addEventListener("dblclick", () => {
    el.style.left = el.style.right = el.style.top = "";
    try { localStorage.removeItem(OVERLAY_POS_KEY); } catch {}
  });
  // Keep it on screen when the window shrinks
  window.addEventListener("resize", () => {
    if (el.style.left) placeOverlay(el, parseFloat(el.style.left), parseFloat(el.style.top));
  });
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
  while (logEl.childElementCount > 300) logEl.firstElementChild.remove(); // long monitor runs
  logEl.scrollTop = logEl.scrollHeight;
}

const log = (msg, type = "info") => {
  const prefix = myDate ? `[${myDate}]` : "[TockSniper]";
  console.log(`${prefix} ${msg}`);
  addLog(msg, type);
  persistLog(msg, type);
};

// Every overlay line is also kept in chrome.storage.local (activityLog, via background.js) so it
// survives reloads/closed tabs and can be exported from the popup. Never throws.
function persistLog(msg, type) {
  try {
    chrome.runtime.sendMessage({
      type: "tockSniper:log",
      entry: { t: Date.now(), venue: location.pathname.split("/")[1] || "", target: myTarget ? targetLabel(myTarget) : "", level: type, msg },
    }).catch(() => {});
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => Date.now();

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
  const countdownEl = document.getElementById("ts-countdown");
  if (localEl) localEl.textContent = formatClock(Date.now());
  if (countdownEl) countdownEl.textContent = releaseMs ? formatCountdown(releaseMs - nowMs()) : "--:--.---";
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

// Absolute send times for a burst around releaseMs, following API_SCHEDULE. Times already in the
// past are dropped; if the burst is already underway, the first send is "now".
function buildFireTimes(releaseMs, now = Date.now()) {
  const intervalAt = (offset) => {
    let every = API_SCHEDULE[0].every;
    for (const row of API_SCHEDULE) if (offset >= row.from) every = row.every;
    return every;
  };
  const times = [];
  for (let off = API_SCHEDULE[0].from; off <= API_BURST_AFTER_MS; off += intervalAt(off)) {
    if (releaseMs + off >= now) times.push(releaseMs + off);
  }
  if (now > releaseMs + API_SCHEDULE[0].from && now <= releaseMs + API_BURST_AFTER_MS) times.unshift(now);
  return times;
}

// Wait until an absolute time with sub-ms precision: browsers clamp timers to ~4ms, so coarse
// setTimeout first, then MessageChannel yields (not clamped) for the last stretch.
const preciseChannel = new MessageChannel();
const preciseWaiters = [];
preciseChannel.port1.onmessage = () => preciseWaiters.shift()?.();
const yieldPrecise = () => new Promise((r) => { preciseWaiters.push(r); preciseChannel.port2.postMessage(0); });
// Timers can fire 10ms+ late on a busy page, so the coarse sleep stops 25ms short.
async function waitUntil(t) {
  while (Date.now() < t) {
    const left = t - Date.now();
    if (left > 30) await sleep(left - 25);
    else await yieldPrecise();
  }
}

function getConfig() {
  return new Promise((r) => chrome.storage.local.get("config", (d) => r(d.config || {})));
}

async function run() {
  const { sniping } = await chrome.storage.local.get("sniping");
  if (!sniping) return;

  const config = await getConfig();
  if (!config.dates?.length && !config.targets?.length) return;

  // Pick target for this tab: use _tidx from URL (set by popup) or restore from sessionStorage after reload.
  const storedTarget = sessionStorage.getItem("tockSniperTarget");
  myTarget = storedTarget ? JSON.parse(storedTarget) : null;

  if (!myTarget) {
    const targets = config.targets || config.dates.map((date) => ({ date, time: "", mode: "api" }));
    const url = new URL(location.href);
    const tidx = url.searchParams.get("_tidx");
    if (tidx !== null) {
      myTarget = targets[parseInt(tidx, 10)] || targets[0];
    } else {
      // Fallback: use URL date/time to find matching target
      const urlTarget = targetFromUrl();
      myTarget = targets.find((t) => t.date === urlTarget.date) || targets[0];
    }
  }

  const urlTarget = targetFromUrl();
  if (urlTarget.time && !myTarget.time) myTarget.time = urlTarget.time;
  myTarget.hasUrlDate = urlTarget.date === myTarget.date;
  myDate = myTarget.date;
  sessionStorage.setItem("tockSniperTarget", JSON.stringify(myTarget));
  sessionStorage.setItem("tockSniperDate", myDate);

  createOverlay();
  const modeLabel = myTarget.mode === "api" ? "⚡API" : "🖱️DOM";
  document.getElementById("ts-date").textContent = `${targetLabel(myTarget)} [${modeLabel}]`;
  document.title = `🛎️ ${targetLabel(myTarget)} ${modeLabel} | ${document.title}`;
  const releaseMs = config.releaseTime ? new Date(config.releaseTime).getTime() : 0;

  if (location.href.includes("/checkout/")) {
    document.title = `✅ ${targetLabel(myTarget)} — CHECKOUT`;
    setStatus("🛒 CHECKOUT — Complete payment!", "success");
    // Show API lock result from before navigation
    const lockResult = sessionStorage.getItem("tockLockResult");
    if (lockResult) {
      const r = JSON.parse(lockResult);
      if (r.ok) {
        log(`🔒 Lock succeeded (attempt ${r.attempt}): ${r.summary}`, "success");
      } else {
        log(`🔒 Lock failed: ${r.summary}`, "error");
      }
    } else {
      log("On checkout (no lock result stored — may be from DOM mode)", "info");
    }
    // Verify there's actually a booking — check for error states after page settles
    setTimeout(() => {
      const body = document.body?.textContent || "";
      if (body.includes("no longer available") || body.includes("session has expired") || body.includes("unable to")) {
        setStatus("⚠️ Checkout page but no valid booking", "error");
        log("⚠️ Page says slot unavailable or session expired", "error");
      }
    }, 2000);
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

  // FUTURE release time → countdown then fire
  const delay = releaseMs - RELOAD_LEAD_MS - nowMs();
  const releaseStr = new Date(config.releaseTime).toLocaleTimeString();
  const needsReload = (myTarget.mode || "api") === "dom";
  // DOM only: too late to reload before release → click through right at release.
  // API mode always goes through snipeApi, which follows its own schedule around release.
  if (needsReload && delay <= 0) {
    const waitMs = Math.max(0, releaseMs - nowMs());
    setStatus(`⏰ Release in ${formatCountdown(waitMs)}`, "waiting");
    log(`Inside lead window; waiting ${formatCountdown(waitMs)} to snipe`);
    setTimeout(async () => {
      setStatus("🎯 Sniping NOW!", "running");
      log("GO — sniping immediately!");
      await snipe(config);
      clearInterval(clockInterval);
    }, waitMs);
    return;
  }

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
      setStatus("🔄 RELOADING!", "running");
      log("⚡ Reloading NOW!");
      location.reload();
    }, Math.max(0, delay));
  } else {
    // API mode: wake up shortly before the burst; snipeApi spins until the first
    // API_SCHEDULE offset, then bursts offerings + lock requests around release.
    const fireDelay = Math.max(0, releaseMs - API_SCHEDULE[0].from - 200 - nowMs());
    setStatus(`⏰ API fires at ${releaseStr}`, "waiting");
    log(`Waiting ${formatCountdown(fireDelay)} — burst runs ${-API_SCHEDULE[0].from}ms before to ${API_BURST_AFTER_MS}ms after release, densest at release`);

    const countdownInterval = setInterval(() => {
      const remaining = releaseMs - nowMs();
      if (remaining <= 0) { clearInterval(countdownInterval); return; }
      setStatus(`⏰ API in ${formatCountdown(remaining)}`, "waiting");
    }, 50);

    setTimeout(async () => {
      clearInterval(countdownInterval);
      clearInterval(clockInterval);
      setStatus("🎯 Sniping NOW!", "running");
      log("GO — sniping!");
      await snipe(config);
    }, fireDelay);
  }
}

async function snipe(config) {
  const mode = myTarget.mode || "api";
  if (mode === "api") {
    const success = await snipeApi(config);
    if (!success) {
      const reason = JSON.parse(sessionStorage.getItem("tockLockResult") || "{}").summary || "check manually";
      setStatus(`⚠️ API: ${reason}`, "error");
      if (config.monitor?.enabled) await monitorLoop(config, reason);
    }
    return;
  }
  await snipeDom(config);
}

// ─── Notifications (Telegram via background.js) ────────────────────────────

const restaurantName = () => (document.title || "").split(" - ")[0].replace(/^[^\w\p{L}]+\s*/u, "").trim() || location.pathname.split("/")[1];
const bookingLabel = (config) => {
  const when = config.timeParam ? `${myDate} ${timeParamToDisplay(config.timeParam)}` : targetLabel(myTarget);
  return `${restaurantName()} · ${when} · ${config.partySize || 2} guests`;
};
// All API targets of this run (restaurant-level messages are sent once, so they list every target)
const allTargetsLabel = (config) => {
  const targets = (config.targets || []).filter((t) => (t.mode || "api") === "api").map(targetLabel);
  return [...new Set(targets.length ? targets : [targetLabel(myTarget)])].join(", ");
};

// Never throws: a failed notification must not affect booking. `text` may be a function (built lazily).
// `kind` ("monitoring" | "opened" | "ended") makes it once per restaurant per armed run (deduped in
// background.js across tabs); omit it for per-target messages like a successful lock.
function notify(text, kind = "") {
  try {
    if (typeof text === "function") text = text();
    const dedupeKey = kind ? `${location.pathname.split("/")[1]}:${kind}` : undefined;
    chrome.runtime.sendMessage({ type: "tockSniper:notify", text, dedupeKey }).then((r) => {
      if (r && !r.ok && !r.skipped) log(`📨 Telegram failed: ${r.error}`, "error");
    }, () => {});
  } catch {}
}

// ─── Monitor ───────────────────────────────────────────────────────────────

async function monitorLoop(config, lastReason = "") {
  const m = config.monitor || {};
  const intervalMs = Math.min(600, Math.max(10, m.intervalSec || 20)) * 1000;
  const until = Date.now() + Math.min(48, Math.max(0.1, m.hours || 6)) * 3600e3;
  const headers = getTockHeaders();
  const partySize = config.partySize || 2;
  const manualId = config.expSource === "auto" ? null : extractExperienceId(config);

  log(`👀 Monitoring every ~${intervalMs / 1000}s until ${new Date(until).toLocaleTimeString()} — offerings only until an experience is listed`);
  notify(`👀 Tock Sniper is monitoring ${restaurantName()} for ${partySize} guests\nTargets: ${allTargetsLabel(config)}\nLast attempt: ${lastReason || "no slot"}`, "monitoring");

  const flexMinutes = Math.max(0, m.flexMinutes ?? MONITOR_DEFAULT_FLEX_MIN);
  const targetTime = myTarget.timeParam || displayTimeToParam24(myTarget.time || "");
  log(`👀 Target ${myDate} ${targetTime || "?"} for ${partySize}${flexMinutes ? ` — also takes the closest open time within ±${flexMinutes} min` : " — exact time only"}`);

  // A listed experience is NOT availability: sold-out venues keep listing theirs. Seats come from
  // the calendar; "seats" = some time on the target date has a table for the party.
  let checks = 0;
  let seatsNotified = false;
  let listed = "";         // experiences last logged as listed
  let warned = "";         // party-size warning last logged
  let lastMsg = "";
  let lastAvail = null;    // logged when the open times change
  const note = (msg, type = "info") => { if (msg !== lastMsg) log(msg, type); lastMsg = msg; };

  while (Date.now() < until) {
    if (!(await chrome.storage.local.get("sniping")).sniping) {
      log("⏹ Disarmed — monitoring stopped");
      return;
    }
    checks++;
    let wait = intervalMs * (0.8 + Math.random() * 0.4); // jitter
    try {
      const experiences = await fetchOfferings(headers);
      if (!experiences.length) {
        if (listed) log("📋 No experiences listed any more");
        listed = "";
        note("👀 No experience listed yet");
        setStatus(`👀 Monitoring — nothing listed yet (check ${checks})`, "waiting");
      } else {
        const names = formatExperiences(experiences);
        if (names !== listed) log(`📋 Listed: ${names}`);
        listed = names;
        const exp = pickExperience(experiences, partySize, manualId);
        const sizeWarning = exp.partySizes.length && !exp.partySizes.includes(partySize)
          ? `⚠️ ${exp.name} is listed for ${partyRange(exp.partySizes)} — ${partySize} guests can't book it unless that changes` : "";
        if (sizeWarning && sizeWarning !== warned) log(sizeWarning, "error");
        warned = sizeWarning;

        // Which times actually have a table for this party? (null: calendar unavailable → just try the target)
        let openTimes = null;
        try {
          const slots = await fetchCalendar(headers);
          openTimes = openTimesFor(slots, partySize, myDate, [exp.id]);
          const avail = formatOpenTimes(openTimes);
          if (avail !== lastAvail) {
            const others = Object.keys(openTimesFor(slots, partySize, null, [exp.id])).filter((k) => !k.startsWith(myDate));
            const otherDates = [...new Set(others.map((k) => k.split(" ")[0]))];
            const wasSeats = lastAvail && !lastAvail.startsWith("error:");
            const sizes = tableSizes(slots, myDate, [exp.id]);
            log(avail
              ? `🔓 Seats ${myDate}, ${partySize} guests: ${avail}`
              : `${wasSeats ? "🈵 Seats gone" : "🈵 No seats"} — ${myDate}, ${partySize} guests${sizes ? ` (tables that day seat ${sizes})` : " (no tables that day)"}${otherDates.length ? ` · other dates with seats: ${otherDates.slice(0, 8).join(", ")}${otherDates.length > 8 ? "…" : ""}` : ""}`,
            avail ? "success" : "info");
            lastAvail = avail;
          }
        } catch (err) {
          if (err.status === 429) throw err;
          const avail = `error: ${err.message}`;
          if (avail !== lastAvail) log(`📅 Calendar unavailable (${err.message}) — trying the target time`, "error");
          lastAvail = avail;
        }

        const time = openTimes ? pickTime(openTimes, targetTime, flexMinutes) : targetTime;
        if (openTimes && Object.keys(openTimes).length && !seatsNotified) {
          seatsNotified = true;
          notify(() => `🔓 Seats at ${restaurantName()} — ${myDate}, ${partySize} guests: ${formatOpenTimes(openTimes)}\nTrying to lock: ${allTargetsLabel(config)}…`, "opened");
        }
        if (!time) {
          note(`👀 No table for ${partySize} at ${myDate} ${targetTime}${flexMinutes ? ` ±${flexMinutes} min` : ""} — not sending a lock`);
          setStatus(`👀 Monitoring — no seats (check ${checks})`, "waiting");
        } else {
          if (time !== targetTime) log(`🔀 ${targetTime} not available — trying ${time} instead`);
          const ok = await snipeApi({ ...config, experienceId: exp.id, expSource: "manual", releaseTime: null, quiet: true, timeParam: time });
          if (ok) return;
          const reason = JSON.parse(sessionStorage.getItem("tockLockResult") || "{}").summary || "no slot";
          if (/429/.test(reason)) wait = MONITOR_429_BACKOFF_MS;
          note(`👀 Lock ${myDate} ${time} failed: ${reason}`);
          setStatus(`👀 Monitoring — lock failed (check ${checks})`, "waiting");
        }
      }
    } catch (err) {
      if (err.status === 429) wait = MONITOR_429_BACKOFF_MS;
      // 400 "Reservations are currently unavailable": the venue switched online booking off
      note(/currently unavailable/i.test(err.message) ? `🔒 Booking switched off: ${err.message}` : `👀 Check failed: ${err.message}`, "error");
    }
    if (wait === MONITOR_429_BACKOFF_MS) {
      note(`⏸️ Rate limited — next check in ${MONITOR_429_BACKOFF_MS / 60000} min`, "error");
      setStatus(`⏸️ Rate limited — waiting ${MONITOR_429_BACKOFF_MS / 60000} min`, "error");
    }
    await sleep(Math.max(0, Math.min(wait, until - Date.now())));
  }
  log("⏹ Monitoring window ended");
  setStatus("⏹ Monitoring ended — nothing booked", "error");
  notify(`⏹ Monitoring ended for ${restaurantName()} — nothing booked.\nTargets: ${allTargetsLabel(config)}`, "ended");
}

// ─── API Direct Snipe ───────────────────────────────────────────────────────

function extractTockMeta() {
  // Extract x-tock-scope from page's meta/scripts or cookies
  const scripts = document.querySelectorAll("script");
  let businessId = null, businessGroupId = null;
  for (const s of scripts) {
    const text = s.textContent;
    const bm = text.match(/"businessId"\s*:\s*"?(\d+)"?/);
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

let cachedBuildNumber = null;
function getBuildNumber() {
  if (cachedBuildNumber) return cachedBuildNumber;
  const m = document.documentElement.outerHTML.match(/servingstack-20\d\d-\d\d-\d\dRC\d+-\d+/);
  cachedBuildNumber = m ? m[0] : FALLBACK_BUILD_NUMBER;
  return cachedBuildNumber;
}

// Headers Tock's own frontend sent (session, auth JWT, CSRF, fingerprint…), recorded by page-hook.js
function getCapturedTockHeaders() {
  try {
    return JSON.parse(document.documentElement.dataset.tockSniperHeaders || "{}");
  } catch {
    return {};
  }
}

function getFingerprint() {
  try {
    const raw = localStorage.getItem("fingerprint");
    return raw ? JSON.parse(raw) : "";
  } catch {
    return "";
  }
}

function getTockHeaders() {
  const captured = getCapturedTockHeaders();
  const meta = extractTockMeta();
  const headers = {
    "x-tock-scope": JSON.stringify({
      businessId: meta.businessId || "",
      businessGroupId: meta.businessGroupId || "",
      site: "EXPLORETOCK",
    }),
    "x-tock-build-number": getBuildNumber(),
    "x-tock-fingerprint": getFingerprint(),
    ...captured,
    "accept": "application/octet-stream",
    "content-type": "application/octet-stream",
    "x-tock-stream-format": "proto2",
    "x-tock-path": location.pathname,
  };
  for (const k of Object.keys(headers)) if (!headers[k]) delete headers[k];
  return headers;
}

function describeHeaders(headers) {
  const has = (k) => (headers[k] ? "✓" : "✗");
  return `session ${has("x-tock-session")} auth ${has("x-tock-authorization")} csrf ${has("x-tock-csrf-token")} fp ${has("x-tock-fingerprint")} build ${headers["x-tock-build-number"] || "?"}`;
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

function decodeVarintFrom(data, pos) {
  let result = 0, shift = 0;
  while (pos < data.length) {
    const b = data[pos++];
    result |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return [result, pos];
}

function decodeProtoStrings(data) {
  // Extract all readable strings from a proto2 binary response
  const strings = [];
  let pos = 0;
  while (pos < data.length) {
    let tag;
    [tag, pos] = decodeVarintFrom(data, pos);
    const wireType = tag & 0x7;
    if (wireType === 0) {
      [, pos] = decodeVarintFrom(data, pos);
    } else if (wireType === 2) {
      let len;
      [len, pos] = decodeVarintFrom(data, pos);
      if (pos + len > data.length) break;
      const chunk = data.slice(pos, pos + len);
      pos += len;
      try {
        const s = new TextDecoder().decode(chunk);
        if (/^[\x20-\x7e]{2,}$/.test(s)) { strings.push(s); continue; }
      } catch {}
      // Recurse into nested messages
      strings.push(...decodeProtoStrings(chunk));
    } else if (wireType === 5) { pos += 4; }
    else if (wireType === 1) { pos += 8; }
    else break;
  }
  return strings;
}

function decodeFields(data) {
  // Shallow proto decode: { fieldNum: [value, ...] } (varints as numbers, length-delimited as bytes)
  const fields = {};
  let pos = 0;
  while (pos < data.length) {
    let tag;
    [tag, pos] = decodeVarintFrom(data, pos);
    const field = Math.floor(tag / 8), wireType = tag & 7;
    let value;
    if (wireType === 0) [value, pos] = decodeVarintFrom(data, pos);
    else if (wireType === 2) {
      let len;
      [len, pos] = decodeVarintFrom(data, pos);
      value = data.slice(pos, pos + len);
      pos += len;
    } else if (wireType === 5) { value = data.slice(pos, pos + 4); pos += 4; }
    else if (wireType === 1) { value = data.slice(pos, pos + 8); pos += 8; }
    else break;
    (fields[field] ||= []).push(value);
  }
  return fields;
}

// POST /api/consumer/offerings
// Request: ConsumerCalendarRequest (MessageSet ext 60331), empty.
// Response: envelope f1 → f1 → ConsumerOfferings (ext 60249) → f1 repeated Offering
//   Offering: f1 id (= experience ID), f3 name, f5 slug, f7 repeated partySize
function buildOfferingsRequest() {
  return new Uint8Array(encodeLengthDelimited(60331, []));
}

function parseOfferings(data) {
  const text = (bytes) => (bytes ? new TextDecoder().decode(bytes) : "");
  const outer = decodeFields(data)[1]?.[0];
  const inner = outer && decodeFields(outer)[1]?.[0];
  const offerings = inner && decodeFields(inner)[60249]?.[0];
  if (!offerings) return null;
  return (decodeFields(offerings)[1] || []).map((bytes) => {
    const o = decodeFields(bytes);
    return {
      id: o[1]?.[0],
      name: text(o[3]?.[0]),
      slug: text(o[5]?.[0]),
      partySizes: o[7] || [],
    };
  });
}

async function fetchOfferings(headers) {
  const res = await fetch("/api/consumer/offerings", {
    method: "POST",
    headers,
    body: buildOfferingsRequest(),
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw Object.assign(new Error(`offerings HTTP ${res.status}`), { status: res.status });
  const data = new Uint8Array(await res.arrayBuffer());
  const err = parseTockError(data);
  if (err) throw Object.assign(new Error(`offerings ${err.status} ${err.message}`), { status: err.status });
  return parseOfferings(data) || [];
}

// POST /api/consumer/calendar/full/v2 — same empty ConsumerCalendarRequest as offerings (~10KB+).
// Response: envelope f1 → f1 → ConsumerFullCalendarV2 (ext 60686)
//   f1 map<businessDay, TicketGroupByDate { f1 map<date, TicketGroupList { f2 repeated CalendarTicketGroup }> }>
//   CalendarTicketGroup: f1 date, f3 time "HH:MM", f4 numTickets, f5 availableTickets,
//     f9 minPurchaseSize, f19 maxPurchaseSize, f13 repeated { f1 ticketTypeId (= experience ID) }
// One group per bookable table/counter configuration, so a time can appear several times.
async function fetchCalendar(headers) {
  const res = await fetch("/api/consumer/calendar/full/v2", {
    method: "POST",
    headers,
    body: buildOfferingsRequest(),
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw Object.assign(new Error(`calendar HTTP ${res.status}`), { status: res.status });
  const data = new Uint8Array(await res.arrayBuffer());
  const err = parseTockError(data);
  if (err) throw Object.assign(new Error(`calendar ${err.status} ${err.message}`), { status: err.status });
  return parseCalendar(data);
}

function parseCalendar(data) {
  const text = (bytes) => (bytes ? new TextDecoder().decode(bytes) : "");
  const outer = decodeFields(data)[1]?.[0];
  const inner = outer && decodeFields(outer)[1]?.[0];
  const cal = inner && decodeFields(inner)[60686]?.[0];
  if (!cal) return [];
  const slots = [];
  for (const dayEntry of decodeFields(cal)[1] || []) {
    const day = decodeFields(dayEntry);
    const byDate = day[2]?.[0] ? decodeFields(day[2][0]) : {};
    for (const dateEntry of byDate[1] || []) {
      const d = decodeFields(dateEntry);
      const list = d[2]?.[0] ? decodeFields(d[2][0]) : {};
      for (const groupBytes of list[2] || []) {
        const g = decodeFields(groupBytes);
        slots.push({
          date: text(g[1]?.[0]) || text(d[1]?.[0]) || text(day[1]?.[0]),
          time: text(g[3]?.[0]),
          available: g[5]?.[0] ?? 0,
          min: g[9]?.[0] || 1,
          max: g[19]?.[0] || Infinity,
          expIds: (g[13] || []).map((p) => decodeFields(p)[1]?.[0]).filter(Boolean),
        });
      }
    }
  }
  return slots;
}

// Bookable times for a party: { "HH:MM": number of matching tables/groups }, optionally limited to
// one date and a set of experience IDs (groups that don't list one are kept).
function openTimesFor(slots, partySize, date = null, expIds = null) {
  const times = {};
  for (const s of slots) {
    if (date && s.date !== date) continue;
    if (s.available < partySize || s.min > partySize || s.max < partySize) continue;
    if (expIds && s.expIds.length && !s.expIds.some((id) => expIds.includes(id))) continue;
    const key = date ? s.time : `${s.date} ${s.time}`;
    times[key] = (times[key] || 0) + 1;
  }
  return times;
}

const toMinutes = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

// The target time if it's open, else the closest open time within ±flexMinutes (earlier wins ties).
function pickTime(openTimes, target, flexMinutes) {
  if (openTimes[target]) return target;
  let best = null, bestDiff = Infinity;
  for (const t of Object.keys(openTimes)) {
    const diff = Math.abs(toMinutes(t) - toMinutes(target));
    if (diff <= flexMinutes && (diff < bestDiff || (diff === bestDiff && t < best))) { best = t; bestDiff = diff; }
  }
  return best;
}

function formatOpenTimes(openTimes) {
  return Object.keys(openTimes).sort().map((t) => (openTimes[t] > 1 ? `${t}×${openTimes[t]}` : t)).join(", ");
}

function pickExperience(experiences, partySize, preferredId) {
  if (!experiences.length) return null;
  const preferred = experiences.find((e) => e.id === preferredId);
  if (preferred) return preferred;
  const fits = (e) => !e.partySizes.length || e.partySizes.includes(partySize);
  return experiences.find(fits) || experiences[0];
}

// "1–6 guests" from the listed party sizes
function partyRange(sizes) {
  if (!sizes.length) return "? guests";
  const lo = Math.min(...sizes), hi = Math.max(...sizes);
  return lo === hi ? `${lo} guest${lo > 1 ? "s" : ""} only` : `${lo}–${hi} guests`;
}

function formatExperiences(experiences) {
  return experiences.map((e) => `${e.id} ${e.name} (${partyRange(e.partySizes)})`).join("; ");
}

// Table sizes the calendar has on a date, e.g. "1, 2, 4–6" (whether or not they're free)
function tableSizes(slots, date, expIds) {
  const sizes = new Set();
  for (const s of slots) {
    if (s.date !== date || (s.expIds.length && !s.expIds.some((id) => expIds.includes(id)))) continue;
    sizes.add(s.min === s.max || s.max === Infinity ? `${s.min}${s.max === Infinity ? "+" : ""}` : `${s.min}–${s.max}`);
  }
  return [...sizes].sort((a, b) => parseInt(a) - parseInt(b)).join(", ");
}

// Tock answers errors with HTTP 200 and a top-level f2 error message:
//   f2 { f1 code (e.g. 2002 bad request, 3000 unavailable), f2 message, f5 http-like status (400/410/429…) }
// Success responses carry f1 instead.
function parseTockError(data) {
  const err = decodeFields(data)[2]?.[0];
  if (!err) return null;
  const e = decodeFields(err);
  const message = e[2]?.[0] ? decodeProtoStrings(err).join(" ") || "" : "";
  return { code: e[1]?.[0] ?? 0, status: e[5]?.[0] ?? 0, message };
}

function summarizeLockResponse(data) {
  const strings = decodeProtoStrings(data);
  const parts = [];
  const dt = strings.find(s => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s));
  if (dt) parts.push(dt);
  const name = strings.find(s => s.length > 3 && !/^\d{4}-/.test(s) && !/^[A-Z]{3}$/.test(s));
  if (name) parts.push(name);
  const error = strings.find(s => /error|unavailable|sold|full|invalid|not found/i.test(s));
  if (error) parts.push(`⚠️ ${error}`);
  if (!parts.length) return strings.slice(0, 3).join(", ") || `${data.length}B binary`;
  return parts.join(" | ");
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

function extractExperienceId(config) {
  // From config (user-verified in popup)
  if (config?.experienceId) return config.experienceId;
  // From target (stored from original URL)
  if (myTarget?.experienceId) return myTarget.experienceId;
  // From URL path: /experience/296772/...
  const m = location.pathname.match(/\/experience\/(\d+)/);
  if (m) return parseInt(m[1], 10);
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
  const partySize = config.partySize || 2;
  // config.timeParam: the monitor may pick a nearby open time instead of the target's
  const timeParam = config.timeParam || myTarget.timeParam || displayTimeToParam24(myTarget.time || "");
  if (!timeParam) {
    log("❌ API: No target time", "error");
    return false;
  }
  const datetime = `${myDate}T${timeParam}`;
  const headers = getTockHeaders();
  const say = config.quiet ? () => {} : log; // monitor attempts stay quiet except for results
  say(`🔑 Headers: ${describeHeaders(headers)}`);
  if (!headers["x-tock-session"]) log("⚠️ No x-tock-session captured — lock may be rejected", "error");

  // Experience ID: manual value is the starting point; the offerings burst at release
  // replaces it with whatever Tock actually lists.
  // expSource: "hybrid" (manual ID + offerings correction), "manual" (no offerings), "auto" (offerings only)
  const expSource = config.expSource || "hybrid";
  const manualId = expSource === "auto" ? null : extractExperienceId(config);
  if (expSource === "manual" && !manualId) {
    log("❌ API: Manual ID mode but no experience ID", "error");
    return false;
  }
  let experienceId = manualId;
  let body = experienceId ? buildLockRequest(partySize, datetime, experienceId) : null;
  say(`🚀 API lock: ${datetime}, ${partySize} guests, exp ${experienceId || "(waiting for offerings)"} [${expSource}]`);

  // Burst: concurrent offerings + lock requests following API_SCHEDULE around the release time,
  // until API_BURST_AFTER_MS after it. First lock success wins. Stops early on sold-out
  // (410 streak after release) or rate limiting (429). Local clock (NTP).
  const releaseMs = config.releaseTime ? new Date(config.releaseTime).getTime() : Date.now();
  const endMs = releaseMs + API_BURST_AFTER_MS;
  // Started after the burst window (tab opened late, or no release time): one attempt, no burst
  const singleShot = Date.now() > endMs || !config.releaseTime;

  let attempt = 0;
  let done = false;

  const useExperience = (exp, source) => {
    if (!exp || exp.id === experienceId) return;
    experienceId = exp.id;
    body = buildLockRequest(partySize, datetime, experienceId);
    log(`🎟️ Experience from ${source}: ${exp.id} ${exp.name}`, "success");
  };

  let resolveWin;
  const won = new Promise((r) => { resolveWin = r; });
  let stopReason = "";
  const stop = (reason) => {
    if (done) return;
    done = true;
    stopReason = reason;
    resolveWin(false);
  };

  // Request accounting: shown live in the status bar and summarized at the end
  const startedAt = Date.now();
  const stats = { lockSent: 0, offeringsSent: 0, byStatus: {} };
  const countStatus = (key) => { stats.byStatus[key] = (stats.byStatus[key] || 0) + 1; };
  const statsLine = () => {
    const parts = Object.entries(stats.byStatus).map(([k, v]) => `${k}×${v}`).join(" ");
    const offers = stats.offeringsSent ? `, ${stats.offeringsSent} offerings` : "";
    return `${stats.lockSent} lock${offers}${parts ? ` → ${parts}` : ""}`;
  };
  const showProgress = () => { if (!done) setStatus(`🎯 Sniping… ${statsLine()}`, "running"); };

  let count429 = 0;
  const on429 = () => {
    if (++count429 < API_MAX_429 || done) return false;
    say(`⚠️ Rate limited (429) — stopping`, "error");
    stop("rate limited (429)");
    return true;
  };

  let soldOutStreak = 0;

  let lastLockMsg = "";
  const fireOne = async (n) => {
    if (!body) return; // no experience ID yet
    const sentAt = Date.now();
    stats.lockSent++;
    try {
      const res = await fetch("/api/ticket/group/lock", {
        method: "PUT",
        headers,
        body,
        credentials: "include",
      });
      if (done) return;
      const resData = new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
      const tockErr = res.ok ? parseTockError(resData) : null;
      if (done) return;

      if (res.ok && !tockErr) {
        done = true;
        resolveWin(true); // first: nothing below may keep the caller waiting
        const summary = summarizeLockResponse(resData);
        log(`✅ API lock success! Attempt ${n}: ${summary}`, "success");
        setStatus("🛒 Slot locked! Loading checkout...", "success");
        sessionStorage.setItem("tockLockResult", JSON.stringify({ ok: true, attempt: n, summary }));
        const bizSlug = location.pathname.split("/")[1];
        notify(() => `🎉 Locked ${bookingLabel(config)}!\nComplete checkout within ~10 min in the browser.\n${location.origin}/${bizSlug}`);
        location.href = `/${bizSlug}/checkout/confirm-purchase`;
        return;
      }

      const status = tockErr ? tockErr.status : res.status;
      countStatus(status);
      showProgress();
      if (status === 429 && on429()) return;
      // 410 is expected right at release (slots not open yet); only trust it well after release
      if (status === 410 && sentAt >= releaseMs + SOLD_OUT_GRACE_MS) {
        if (++soldOutStreak >= SOLD_OUT_STREAK) {
          log(`🈵 Sold out — ${soldOutStreak} consecutive 410s after release: ${tockErr?.message || ""}`, "error");
          stop("sold out (410)");
          return;
        }
      } else if (status !== 410) {
        soldOutStreak = 0;
      }
      // Log only when the failure changes, so a 300-request burst doesn't flood the overlay
      const msg = tockErr ? `${tockErr.status} ${tockErr.message}` : `HTTP ${res.status}`;
      if (msg !== lastLockMsg) say(`⏳ #${n}: ${msg}`);
      lastLockMsg = msg;
    } catch (err) {
      countStatus("err");
      if (!done) say(`⏳ #${n}: ${err.message}`);
    }
  };

  // Offerings burst (same cadence as lock): stops at the first non-empty experience list.
  let offeringsFound = expSource === "manual"; // manual: never query offerings
  let lastOfferingsMsg = "";
  const fireOfferings = async () => {
    stats.offeringsSent++;
    try {
      const experiences = await fetchOfferings(headers);
      if (done || offeringsFound) return;
      if (!experiences.length) {
        if (lastOfferingsMsg !== "empty") log("📋 Offerings: none listed yet");
        lastOfferingsMsg = "empty";
        return;
      }
      offeringsFound = true;
      log(`📋 Offerings: ${formatExperiences(experiences)}`);
      useExperience(pickExperience(experiences, partySize, manualId), "offerings");
    } catch (err) {
      if (done || offeringsFound) return;
      if (err.status === 429 && on429()) return;
      if (err.message !== lastOfferingsMsg) log(`📋 ${err.message}`);
      lastOfferingsMsg = err.message;
    }
  };

  if (singleShot) {
    say("⏱️ Past the release window — single attempt, no burst");
    if (!offeringsFound) await fireOfferings();
    if (body) await fireOne(++attempt);
    stop(body ? "single attempt" : "no experience ID");
  } else {
    // Send at precomputed absolute times: densest around release (see API_SCHEDULE)
    const fireTimes = buildFireTimes(releaseMs);
    log(`🗓️ ${fireTimes.length} sends planned, ${-API_SCHEDULE[0].from}ms before to ${API_BURST_AFTER_MS}ms after release`);
    let lastOfferingsAt = -Infinity;
    for (const t of fireTimes) {
      await waitUntil(t);
      if (done) break;
      // Offerings counts against the same rate limit, so it doesn't need the lock's density
      if (!offeringsFound && Date.now() - lastOfferingsAt >= OFFERINGS_MIN_GAP_MS) {
        lastOfferingsAt = Date.now();
        fireOfferings();
      }
      if (body) fireOne(++attempt);
    }
    // Let in-flight responses land (a success may still arrive), then give up
    if (!done) await Promise.race([won, sleep(2000)]);
    stop("time window ended");
  }

  const ok = await won;
  say(`📊 Sent ${statsLine()} in ${Date.now() - startedAt}ms${stopReason ? ` — stopped: ${stopReason}` : ""}`);
  if (ok) {
    await sleep(5000);
    return true;
  }

  const failure = !experienceId ? "No experience ID — offerings never listed one"
    : stopReason === "time window ended" ? "API lock failed after all attempts"
    : stopReason === "single attempt" ? `Single attempt failed (${Object.keys(stats.byStatus).join(", ") || "no response"})`
    : `Stopped: ${stopReason}`;
  say(`❌ ${failure}`, "error");
  sessionStorage.setItem("tockLockResult", JSON.stringify({ ok: false, summary: failure }));
  return false;
}

// ─── DOM Click Snipe (original method) ──────────────────────────────────────

// Reload (or switch to the /search URL) and try again, if still within the retry budget/window.
function domRetry(config, reason) {
  const releaseMs = config.releaseTime ? new Date(config.releaseTime).getTime() : 0;
  const retries = parseInt(sessionStorage.getItem("tockDomRetries") || "0", 10);
  if (!releaseMs || Date.now() > releaseMs + DOM_RETRY_WINDOW_MS || retries >= DOM_MAX_RETRIES) return false;
  sessionStorage.setItem("tockDomRetries", String(retries + 1));
  // Experience URL with an unknown/stale ID → fall back to the restaurant's /search URL
  const toSearch = /couldn't find/i.test(reason) && myTarget.searchUrl && !location.pathname.endsWith("/search");
  log(`🔁 Retry ${retries + 1}/${DOM_MAX_RETRIES}: ${reason} — ${toSearch ? "switching to /search" : "reloading"}`, "error");
  setStatus(`🔁 Retry ${retries + 1}/${DOM_MAX_RETRIES}…`, "running");
  if (toSearch) location.href = myTarget.searchUrl;
  else location.reload();
  return true;
}

async function snipeDom(config) {
  const fail = (status, message) => {
    if (domRetry(config, message)) return;
    setStatus(status, "error");
    log(message, "error");
  };

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
    if (!bookLink) return fail("❌ No slots found", "No 'Book now' link after 15s");
    log("🎉 Clicking Book now...");
    bookLink.click();

    const dlgDeadline2 = Date.now() + 5000;
    while (Date.now() < dlgDeadline2) {
      dialog = document.querySelector('[role="dialog"]');
      if (dialog) break;
      await sleep(50);
    }
    if (!dialog) return fail("❌ Dialog failed", "Dialog didn't open");
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
      // aria-label is "YYYY-MM-DD" or "YYYY-MM-DD, no availability"
      const dateBtn = dialog.querySelector(`button[aria-label^="${myDate}"]`);
      if (dateBtn) {
        if (dateBtn.disabled || /no availability/i.test(dateBtn.getAttribute("aria-label"))) {
          return fail(`❌ ${myDate} sold out`, `${myDate} is disabled/sold out`);
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
    if (!dateFound) return fail("❌ Date not found", `Could not find ${myDate} on calendar`);
  }

  // Step 4: Wait for time slots. Bail out early (→ retry) when Tock says the date is sold out or
  // the experience can't be found, instead of waiting out the full 10s.
  // The signal must hold for 250ms so a dialog still loading its data isn't mistaken for sold out.
  let bookBtns = [];
  let unavailableSince = 0;
  const slotDeadline = Date.now() + 10000;
  while (Date.now() < slotDeadline) {
    bookBtns = [...dialog.querySelectorAll("button")].filter(
      (b) => b.textContent.trim() === "Book" && !b.disabled
    );
    if (bookBtns.length > 0) break;
    const unavailable = dialog.innerText.match(DOM_UNAVAILABLE_TEXT)?.[0]
      || (/no availability/i.test(dialog.querySelector(`button[aria-label^="${myDate}"]`)?.getAttribute("aria-label") || "") && `${myDate}: no availability`);
    if (!unavailable) unavailableSince = 0;
    else if (!unavailableSince) unavailableSince = Date.now();
    else if (Date.now() - unavailableSince >= 250) return fail("❌ No availability", `Tock: "${unavailable}"`);
    await sleep(50);
  }
  if (bookBtns.length === 0) return fail("❌ No time slots", "No available time slots");

  // Step 5: Adjust party size
  const guestP = [...dialog.querySelectorAll("p")].find((p) => /\d+\s*guest/.test(p.textContent));
  if (guestP) {
    const current = parseInt(guestP.textContent) || 2;
    const target = config.partySize || 2;
    if (current !== target) {
      log(`👥 ${current} → ${target} guests`);
      // aria-label is e.g. "More guests, current party size is 2"
      const btn = dialog.querySelector(`button[aria-label^="${current < target ? "More" : "Fewer"} guests"]`);
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
    notify(() => `🎉 Reached checkout: ${restaurantName()} · ${myDate} ${chosen.time} · ${config.partySize || 2} guests\nComplete payment in the browser.`);
  } else {
    setStatus("⚠️ Check manually", "error");
    log("Didn't reach checkout — check manually", "error");
  }
}


// ─── Popup "Use this page" support ──────────────────────────────────────────

// Release-time text on the page, two kinds:
// 1. Tock's own: "New reservations will be released on October 3, 2026 at 3:00 AM UTC." — rendered in
//    the browser's time zone (with its abbreviation).
// 2. Written by the restaurant, e.g. "Reservations for November 2026 will be released on Thursday,
//    October 15, 2026 at 10am." — no zone; presumably the restaurant's local time, which we guess
//    from the US state in the page title ("Lazy Bear - San Francisco, CA | Tock").
// The popup converts either to a datetime-local value.
const US_STATE_ZONES = {
  "America/Los_Angeles": ["CA", "WA", "OR", "NV"],
  "America/Phoenix": ["AZ"],
  "America/Denver": ["CO", "UT", "NM", "MT", "WY", "ID"],
  "America/Chicago": ["TX", "IL", "MN", "WI", "MO", "LA", "OK", "KS", "NE", "IA", "AR", "MS", "AL", "TN", "SD", "ND"],
  "America/New_York": ["NY", "NJ", "PA", "MA", "CT", "RI", "VT", "NH", "ME", "DE", "MD", "DC", "VA", "WV", "NC", "SC", "GA", "FL", "OH", "MI", "IN", "KY"],
  "America/Anchorage": ["AK"],
  "Pacific/Honolulu": ["HI"],
};

function guessRestaurantZone() {
  const state = document.title.match(/,\s*([A-Z]{2})\s*\|\s*Tock\s*$/)?.[1];
  const zone = Object.entries(US_STATE_ZONES).find(([, states]) => states.includes(state))?.[0] || null;
  return { state: state || null, zone };
}

function detectRelease() {
  const text = document.body?.innerText || "";
  const tock = text.match(/New reservations will be released on ([A-Z][a-z]+ \d{1,2}, \d{4}) at (\d{1,2}:\d{2}\s*[AP]M)(?:\s+([A-Z]{2,5}))?/);
  if (tock) return { text: tock[0], date: tock[1], time: tock[2], tz: tock[3] || "", source: "tock" };
  const custom = text.match(/will be released on (?:[A-Z][a-z]+day,?\s+)?([A-Z][a-z]+ \d{1,2},? \d{4}),? at (\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i);
  if (!custom) return null;
  const time = `${custom[2]}:${custom[3] || "00"} ${custom[4].toUpperCase()}M`;
  return { text: custom[0], date: custom[1], time, tz: "", source: "restaurant", ...guessRestaurantZone() };
}

function detectExperiencesFromDom() {
  const found = new Map();
  for (const a of document.querySelectorAll('a[href*="/experience/"]')) {
    const m = a.getAttribute("href").match(/\/experience\/(\d+)(?:\/([^/?#]+))?/);
    if (!m) continue;
    const id = parseInt(m[1], 10);
    if (!found.has(id)) found.set(id, { id, name: (m[2] || "").replace(/-/g, " "), partySizes: [] });
  }
  return [...found.values()];
}

async function getPageInfo() {
  const experiences = new Map(detectExperiencesFromDom().map((e) => [e.id, e]));
  let offeringsError = null;
  try {
    // Offerings has the real names and party sizes, and lists experiences the page doesn't link
    for (const e of await fetchOfferings(getTockHeaders())) experiences.set(e.id, e);
  } catch (err) {
    offeringsError = err.message;
  }
  const pathMatch = location.pathname.match(/\/experience\/(\d+)/);
  return {
    url: location.href,
    currentExperienceId: pathMatch ? parseInt(pathMatch[1], 10) : null,
    experiences: [...experiences.values()],
    release: detectRelease(),
    offeringsError,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "tockSniper:pageInfo") return;
  getPageInfo().then(sendResponse, (err) => sendResponse({ error: err.message }));
  return true; // async response
});

run();
