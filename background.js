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
    // Clear claimed dates so tabs can claim fresh
    chrome.storage.local.set({ claimedDates: {} });
    chrome.alarms.create("tock-keepalive", { periodInMinutes: 0.5 });
  }
  if (changes.sniping?.newValue === false) {
    chrome.storage.local.set({ claimedDates: {} });
    chrome.alarms.clear("tock-keepalive");
  }
});
