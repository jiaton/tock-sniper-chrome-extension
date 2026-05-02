// Tock Sniper — content script
// Simple logic:
// - Before release time: show countdown, reload at release - 100ms
// - After release time (including after reload): immediately snipe

let myDate = null;
let overlay = null;

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
      #tock-sniper-overlay .ts-header span { opacity: 0.5; font-size: 11px; }
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
  const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
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

function getConfig() {
  return new Promise((r) => chrome.storage.local.get("config", (d) => r(d.config || {})));
}

async function run() {
  const { sniping } = await chrome.storage.local.get("sniping");
  if (!sniping) return;

  const config = await getConfig();
  if (!config.dates?.length) return;

  // Pick date for this tab from sessionStorage (survives reload) or claim a new one
  myDate = sessionStorage.getItem("tockSniperDate");
  if (!myDate) {
    const idx = parseInt(sessionStorage.getItem("tockSniperIdx") ?? "-1");
    if (idx >= 0) {
      myDate = config.dates[idx];
    } else {
      // Claim next unclaimed index via storage
      const { tockNextIdx = 0 } = await chrome.storage.local.get("tockNextIdx");
      myDate = config.dates[tockNextIdx % config.dates.length];
      await chrome.storage.local.set({ tockNextIdx: tockNextIdx + 1 });
      sessionStorage.setItem("tockSniperIdx", String(tockNextIdx % config.dates.length));
    }
    sessionStorage.setItem("tockSniperDate", myDate);
  }

  createOverlay();
  document.getElementById("ts-date").textContent = myDate;
  document.title = `🎯 ${myDate} | ${document.title}`;

  if (location.href.includes("/checkout/")) {
    document.title = `✅ ${myDate} — CHECKOUT`;
    setStatus("🛒 CHECKOUT — Complete payment!", "success");
    log("Already on checkout!", "success");
    return;
  }

  const releaseMs = config.releaseTime ? new Date(config.releaseTime).getTime() : 0;

  // PAST release time (or no release time set) → snipe immediately
  if (!releaseMs || Date.now() >= releaseMs) {
    setStatus("🎯 Sniping NOW!", "running");
    log("GO — sniping immediately!");
    await snipe(config);
    return;
  }

  // FUTURE release time → countdown then reload
  const delay = releaseMs - 100 - Date.now();
  const releaseStr = new Date(config.releaseTime).toLocaleTimeString();
  setStatus(`⏰ Reload at ${releaseStr}`, "waiting");
  log(`Waiting ${Math.round(delay / 1000)}s — reload 100ms before release`);

  const countdownInterval = setInterval(() => {
    const remaining = releaseMs - 100 - Date.now();
    if (remaining <= 0) { clearInterval(countdownInterval); return; }
    setStatus(`⏰ Reload in ${Math.ceil(remaining / 1000)}s`, "waiting");
  }, 1000);

  setTimeout(() => {
    clearInterval(countdownInterval);
    setStatus("🔄 RELOADING!", "running");
    log("⚡ Reloading NOW!");
    location.reload();
  }, delay);
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
  await sleep(500);

  // Step 3: Select date — retry up to 10s, navigate months if needed
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
  for (const pref of (config.prefTimes || [])) {
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
    document.title = `✅ ${myDate} ${chosen.time} — CHECKOUT`;
    setStatus(`🛒 GOT IT! ${chosen.time} — CHECKOUT`, "success");
    log(`🛒 Got ${chosen.time}! Complete checkout now.`, "success");
  } else {
    setStatus("⚠️ Check manually", "error");
    log("Didn't reach checkout — check manually", "error");
  }
}

run();
