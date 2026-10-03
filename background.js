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
    // Clear claimed targets so tabs can claim fresh; a new run notifies afresh.
    chrome.storage.local.set({ claimedDates: {}, tockNextIdx: 0, tockClockSync: null, notifySent: {} });
    chrome.alarms.create("tock-keepalive", { periodInMinutes: 0.5 });
  }
  if (changes.sniping?.newValue === false) {
    chrome.storage.local.set({ claimedDates: {}, tockNextIdx: 0, tockClockSync: null, notifySent: {} });
    chrome.alarms.clear("tock-keepalive");
  }
});

// ─── Telegram notifications ────────────────────────────────────────────────
// Content scripts and the popup send { type: "tockSniper:notify", text } here, so the bot token
// (config.notify.telegram, entered in the popup) never reaches the Tock page. `override`
// ({ token, chatId }) is used by the popup's "Send test" before the settings are enabled.
async function sendTelegram(text, override) {
  const { config } = await chrome.storage.local.get("config");
  const tg = override || config?.notify?.telegram;
  if (!override && !tg?.enabled) return { ok: false, skipped: true };
  if (!tg?.token || !tg?.chatId) return { ok: false, error: "Bot token and chat ID are required" };
  if (!/^\d+:[\w-]+$/.test(tg.token)) return { ok: false, error: "Bot token looks wrong (expected 123456:ABC…)" };
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "tockSniper:notify") return;
  notifyQueue = notifyQueue.then(() => handleNotify(msg)).then(sendResponse, (err) => sendResponse({ ok: false, error: err.message }));
  return true; // async response
});
