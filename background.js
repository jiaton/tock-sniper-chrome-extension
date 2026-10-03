// Background service worker — keepalive + cleanup

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "tock-keepalive") return;
  const { sniping, config } = await chrome.storage.local.get(["sniping", "config"]);
  if (!sniping || !config?.url) {
    chrome.alarms.clear("tock-keepalive");
    return;
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.sniping?.newValue === true) {
    // Clear claimed targets so tabs can claim fresh; a new run notifies afresh. A new armId makes tabs
    // left over from an earlier run stand down (see the API lease below).
    chrome.storage.local.set({ claimedDates: {}, tockNextIdx: 0, tockClockSync: null, notifySent: {}, apiLeader: null, armId: Date.now() });
    chrome.alarms.create("tock-keepalive", { periodInMinutes: 0.5 });
  }
  if (changes.sniping?.newValue === false) {
    chrome.storage.local.set({ claimedDates: {}, tockNextIdx: 0, tockClockSync: null, notifySent: {}, apiLeader: null });
    chrome.alarms.clear("tock-keepalive");
  }
});

// ─── Telegram notifications ────────────────────────────────────────────────
// Content scripts and the popup send { type: "tockSniper:notify", text } here, so the bot token
// (config.notify.telegram, entered in the popup) never reaches the Tock page. api.telegram.org is an
// optional host permission, so updating users aren't asked for it unless they turn Telegram on. `override`
// ({ token, chatId }) is used by the popup's "Send test" before the settings are enabled.
const TELEGRAM_ORIGIN = "https://api.telegram.org/*";

async function sendTelegram(text, override) {
  const { config } = await chrome.storage.local.get("config");
  const tg = override || config?.notify?.telegram;
  if (!override && !tg?.enabled) return { ok: false, skipped: true };
  if (!tg?.token || !tg?.chatId) return { ok: false, error: "Bot token and chat ID are required" };
  if (!/^\d+:[\w-]+$/.test(tg.token)) return { ok: false, error: "Bot token looks wrong (expected 123456:ABC…)" };
  // Optional permission, granted from the popup when Telegram is switched on
  if (!(await chrome.permissions.contains({ origins: [TELEGRAM_ORIGIN] }))) {
    return { ok: false, error: "Telegram permission not granted — switch notifications off and on again in the popup" };
  }
  const res = await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: tg.chatId, text, disable_web_page_preview: true }),
  });
  const data = await res.json().catch(() => ({}));
  return data.ok ? { ok: true } : { ok: false, error: data.description || `HTTP ${res.status}` };
}

// `dedupeKey` (e.g. "fui-hui-hua-san-francisco:opened"): sent at most once per armed run, however many
// tabs ask. Messages are handled one at a time so two tabs asking together can't both get through.
// The record (notifySent) is cleared on every Arm/Disarm.
let notifyQueue = Promise.resolve();

async function handleNotify(msg) {
  if (msg.dedupeKey) {
    const { notifySent = {} } = await chrome.storage.local.get("notifySent");
    if (notifySent[msg.dedupeKey]) return { ok: false, skipped: true, duplicate: true };
    await chrome.storage.local.set({ notifySent: { ...notifySent, [msg.dedupeKey]: Date.now() } });
  }
  return sendTelegram(msg.text, msg.override);
}

// ─── API lease ─────────────────────────────────────────────────────────────
// Only one tab may send API requests (Tock rate-limits per client): the first API tab of the current
// armed run to ask holds the lease (by tab ID, so reloads and the checkout page keep it); other API tabs
// stand by and take over if that tab is closed. Tabs from an earlier run (stale armId) never get it.
let leaseQueue = Promise.resolve();

async function handleLease(msg, sender) {
  const tabId = sender.tab?.id;
  const { sniping, armId, apiLeader } = await chrome.storage.local.get(["sniping", "armId", "apiLeader"]);
  if (!sniping) return { leader: false, disarmed: true };
  if ((msg.armId ?? null) !== (armId ?? null)) return { leader: false, stale: true };
  if (apiLeader && apiLeader.tabId !== tabId) {
    const alive = await chrome.tabs.get(apiLeader.tabId).then(() => true, () => false);
    if (alive) return { leader: false };
  }
  if (apiLeader?.tabId !== tabId) await chrome.storage.local.set({ apiLeader: { tabId, at: Date.now() } });
  return { leader: true };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  leaseQueue = leaseQueue.then(async () => {
    const { apiLeader } = await chrome.storage.local.get("apiLeader");
    if (apiLeader?.tabId === tabId) await chrome.storage.local.set({ apiLeader: null });
  }).catch(() => {});
});

// ─── Activity log ──────────────────────────────────────────────────────────
// Content scripts send every overlay line ({ type: "tockSniper:log", entry }); kept across runs (newest
// ACTIVITY_LOG_MAX) in chrome.storage.local.activityLog for the popup's export. Lines are batched and
// written one batch at a time, so tabs logging together don't overwrite each other.
const ACTIVITY_LOG_MAX = 5000;
let pendingLog = [];
let logFlush = null;

function appendLog(entry) {
  pendingLog.push(entry);
  logFlush ||= (async () => {
    try {
      while (pendingLog.length) {
        const batch = pendingLog;
        pendingLog = [];
        const { activityLog = [] } = await chrome.storage.local.get("activityLog");
        await chrome.storage.local.set({ activityLog: activityLog.concat(batch).slice(-ACTIVITY_LOG_MAX) });
      }
    } finally {
      logFlush = null;
    }
  })();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "tockSniper:apiLease") {
    leaseQueue = leaseQueue.then(() => handleLease(msg, _sender)).then(sendResponse, (err) => sendResponse({ leader: false, error: err.message }));
    return true;
  }
  if (msg?.type === "tockSniper:log") {
    if (msg.entry) appendLog(msg.entry);
    return;
  }
  if (msg?.type !== "tockSniper:notify") return;
  notifyQueue = notifyQueue.then(() => handleNotify(msg)).then(sendResponse, (err) => sendResponse({ ok: false, error: err.message }));
  return true; // async response
});
