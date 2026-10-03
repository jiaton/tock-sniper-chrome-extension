const $ = (s) => document.querySelector(s);

// Target dates ("YYYY-MM-DD") and times ("5:00 PM"), kept sorted and de-duplicated
const state = { dates: [], times: [] };
let armedState = false;
let savedTimer = null;
const clampParty = (n) => Math.min(20, Math.max(1, n));
const TELEGRAM_PERMISSION = { origins: ["https://api.telegram.org/*"] }; // optional host permission

const EXP_SOURCE_HINTS = {
  hybrid: "Locks with your ID from the first request; switches if Tock lists a different experience at release.",
  manual: "Locks with your ID only. No offerings lookups — fastest, but fails if the ID is stale.",
  auto: "Ignores your ID; waits for Tock's experience list at release. Costs one round trip (~150ms).",
};

const SNIPE_MODE_HINTS = {
  api: "One tab sends lock requests for every date × time at release, by priority. No page reload.",
  dom: "One tab per date × time: reloads just before release and clicks through the booking dialog.",
  both: "One API tab for all targets plus a DOM tab per date × time; they run independently.",
};

const radioValue = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
const setRadio = (name, value) => {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
};

// ── Time helpers ──
function displayTimeToParam(time) {
  const trimmed = time.trim();
  const twentyFour = trimmed.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (twentyFour) return `${twentyFour[1].padStart(2, "0")}:${twentyFour[2]}`;

  const twelve = trimmed.match(/^(\d{1,2})(?::([0-5]\d))?\s*([AP])\.?M\.?$/i);
  if (!twelve) return "";

  let hour = parseInt(twelve[1], 10);
  const minute = twelve[2] || "00";
  const meridiem = twelve[3].toUpperCase();
  if (meridiem === "A" && hour === 12) hour = 0;
  if (meridiem === "P" && hour !== 12) hour += 12;
  return `${String(hour).padStart(2, "0")}:${minute}`;
}

function paramTimeToDisplay(time) {
  const match = time?.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return "";
  let hour = parseInt(match[1], 10);
  const minute = match[2];
  const meridiem = hour >= 12 ? "PM" : "AM";
  hour = hour % 12 || 12;
  return `${hour}:${minute} ${meridiem}`;
}

function formatDateChip(date) {
  const d = new Date(`${date}T12:00:00`);
  if (isNaN(d)) return date;
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// ── Chips ──
function renderChips(container, items, label, onRemove, emptyText) {
  container.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("span");
    empty.className = "empty";
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }
  items.forEach((item, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    // Order added = priority (API mode tries dates first, then times, in this order)
    if (items.length > 1) {
      const rank = document.createElement("span");
      rank.className = "rank";
      rank.textContent = `${i + 1}`;
      chip.appendChild(rank);
    }
    chip.appendChild(document.createTextNode(label(item)));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.title = "Remove";
    remove.textContent = "✕";
    remove.addEventListener("click", () => onRemove(item));
    chip.appendChild(remove);
    container.appendChild(chip);
  });
}

function renderTargets() {
  renderChips($("#dateChips"), state.dates, formatDateChip, (d) => {
    state.dates = state.dates.filter((x) => x !== d);
    renderTargets(); saveConfig();
  }, "No dates yet");
  renderChips($("#timeChips"), state.times, (t) => t, (t) => {
    state.times = state.times.filter((x) => x !== t);
    renderTargets(); saveConfig();
  }, "No times yet");
  updateButton();
}

function addDate(date) {
  if (!date || state.dates.includes(date)) return false;
  state.dates = [...state.dates, date]; // order added = priority
  return true;
}

function addTime(time) {
  const param = displayTimeToParam(time);
  const display = paramTimeToDisplay(param);
  if (!display || state.times.includes(display)) return false;
  state.times = [...state.times, display]; // order added = priority
  return true;
}

function getNextFriSatSun() {
  const now = new Date();
  const dates = [];
  // Find next Friday (or the one after if today is Friday past release)
  let d = new Date(now);
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  // That Friday + 7 days = next week's Fri/Sat/Sun
  const nextFri = new Date(d);
  nextFri.setDate(nextFri.getDate() + 7);
  for (let i = 0; i < 3; i++) {
    const dt = new Date(nextFri);
    dt.setDate(dt.getDate() + i);
    dates.push(dt.toISOString().split("T")[0]);
  }
  return dates;
}

// ── Init ──
// format for datetime-local: YYYY-MM-DDTHH:MM:SS
const toDatetimeLocal = (d) =>
  d.toLocaleString("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).replace(" ", "T");

function defaultReleaseTime() {
  const d = new Date();
  d.setHours(19, 45, 0, 0);
  return toDatetimeLocal(d);
}

// ── Detect from the open Tock page ──
// Hours offset from UTC for the abbreviations Tock prints after the release time
const TZ_OFFSETS = { UTC: 0, GMT: 0, PST: -8, PDT: -7, MST: -7, MDT: -6, CST: -6, CDT: -5, EST: -5, EDT: -4, AKST: -9, AKDT: -8, HST: -10 };

// Wall-clock time in an IANA zone → Date (two passes settle DST edges)
function zonedWallTime(wall, zone) {
  const target = Date.UTC(wall.getFullYear(), wall.getMonth(), wall.getDate(), wall.getHours(), wall.getMinutes());
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
    guess += target - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  }
  return new Date(guess);
}

// { date: "October 3, 2026", time: "3:00 AM", tz: "UTC" } → Date
// { date: "October 15, 2026", time: "10:00 AM", source: "restaurant", zone: "America/Los_Angeles" } → Date
function parseRelease(release) {
  const wall = new Date(`${release.date} ${release.time}`); // parsed as browser-local wall time
  if (isNaN(wall)) return null;
  if (release.source === "restaurant") return release.zone ? zonedWallTime(wall, release.zone) : wall;
  if (!release.tz) return wall;
  const localAbbr = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
    .formatToParts(wall).find((p) => p.type === "timeZoneName")?.value;
  const offset = TZ_OFFSETS[release.tz];
  // Same zone as the browser, or an abbreviation we can't map: take the wall time as local
  if (localAbbr === release.tz || offset === undefined) return wall;
  return new Date(Date.UTC(wall.getFullYear(), wall.getMonth(), wall.getDate(), wall.getHours(), wall.getMinutes()) - offset * 3600e3);
}

function cleanTockUrl(raw) {
  const url = new URL(raw);
  [...url.searchParams.keys()]
    .filter((k) => k.startsWith("tock_") || k === "_tidx")
    .forEach((k) => url.searchParams.delete(k));
  return url.toString();
}

let activeTockTab = null;
let detectedRelease = null;
let lastPageInfo = null;

async function initActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https:\/\/www\.exploretock\.com\//.test(tab.url)) return;
  activeTockTab = tab;
  $("#useTab").hidden = false;
}

function renderExperienceSuggestions(info) {
  lastPageInfo = info;
  const box = $("#expSuggestions");
  box.replaceChildren();
  box.hidden = false;
  if (!info.experiences.length) {
    const empty = document.createElement("span");
    empty.className = "empty";
    empty.textContent = info.offeringsError
      ? `Couldn't list experiences (${info.offeringsError})`
      : "No experiences listed on this page yet — probably not released.";
    box.appendChild(empty);
    return;
  }
  const current = parseInt($("#experienceId").value) || null;
  info.experiences.forEach((e) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip pick" + (e.id === current ? " selected" : "");
    chip.title = e.name;
    chip.textContent = `${e.id}`;
    const meta = document.createElement("span");
    meta.className = "meta";
    const [lo, hi] = [Math.min(...e.partySizes), Math.max(...e.partySizes)];
    const sizes = !e.partySizes.length ? "" : lo === hi ? ` · ${lo} only` : ` · ${lo}–${hi}`;
    // The listed party sizes (offerings): flag experiences the current party size can't book
    const party = parseInt($("#partySize").value) || 2;
    if (e.partySizes.length && !e.partySizes.includes(party)) {
      chip.classList.add("nofit");
      chip.title += ` — not bookable for ${party} guests (listed for ${lo === hi ? lo : `${lo}–${hi}`})`;
    }
    meta.textContent = `${e.name.length > 28 ? e.name.slice(0, 27) + "…" : e.name}${sizes}`;
    chip.appendChild(meta);
    chip.addEventListener("click", () => {
      $("#experienceId").value = e.id;
      saveConfig();
      renderExperienceSuggestions(info);
    });
    box.appendChild(chip);
  });
}

function renderReleaseSuggestion() {
  const box = $("#releaseSuggest");
  if (!detectedRelease) { box.hidden = true; return; }
  const when = parseRelease(detectedRelease);
  if (!when) { box.hidden = true; return; }
  const value = toDatetimeLocal(when);
  const matches = $("#releaseTime").value && new Date($("#releaseTime").value).getTime() === when.getTime();
  box.hidden = false;
  box.classList.toggle("done", matches);
  $("#releaseSuggestTime").textContent = (matches ? "✓ Matches the page: " : "Page release: ") +
    when.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const zoneNote = detectedRelease.source !== "restaurant" ? ""
    : detectedRelease.zone ? ` · zone guessed from ${detectedRelease.state}: ${detectedRelease.zone.split("/")[1].replace("_", " ")} time`
    : " · no zone given — assumed your local time";
  $("#releaseSuggestSrc").textContent = `“${detectedRelease.text.replace(/^.*?released on /i, "")}”${zoneNote}`;
  $("#releasePrefill").hidden = matches;
  $("#releasePrefill").onclick = () => {
    $("#releaseTime").value = value;
    saveConfig();
    renderReleaseSuggestion();
  };
}

async function useActiveTab() {
  if (!activeTockTab) return;
  $("#url").value = cleanTockUrl(activeTockTab.url);
  syncFieldsFromUrl();
  saveConfig();
  $("#urlHint").textContent = "Reading the page…";
  try {
    const info = await chrome.tabs.sendMessage(activeTockTab.id, { type: "tockSniper:pageInfo" });
    if (!info || info.error) throw new Error(info?.error || "no response");
    if (!$("#experienceId").value && info.currentExperienceId) {
      $("#experienceId").value = info.currentExperienceId;
      saveConfig();
    }
    renderExperienceSuggestions(info);
    detectedRelease = info.release;
    renderReleaseSuggestion();
    const found = [
      info.experiences.length ? `${info.experiences.length} experience${info.experiences.length > 1 ? "s" : ""}` : "",
      info.release ? "release time" : "",
    ].filter(Boolean).join(" and ");
    $("#urlHint").textContent = found ? `Found ${found} on the page.` : "Nothing to prefill on this page.";
  } catch {
    $("#urlHint").textContent = "URL filled. Reload the Tock tab to also detect experiences and release time.";
  }
}

chrome.storage.local.get(["config", "sniping", "status"], (d) => {
  if (d.config) {
    $("#url").value = d.config.url || "";
    $("#partySize").value = d.config.partySize || 2;
    $("#releaseTime").value = d.config.releaseTime || defaultReleaseTime();
    setRadio("snipeMode", d.config.snipeMode || "api");
    setRadio("expSource", d.config.expSource || "hybrid");
    $("#experienceId").value = d.config.experienceId || "";
    const mon = d.config.monitor || {};
    $("#monitorEnabled").checked = !!mon.enabled;
    $("#monitorInterval").value = mon.intervalSec || 20;
    $("#monitorHours").value = mon.hours || 6;
    $("#monitorFlex").value = String(mon.flexMinutes ?? 60);
    const tg = d.config.notify?.telegram || {};
    $("#tgEnabled").checked = !!tg.enabled;
    $("#tgToken").value = tg.token || "";
    $("#tgChatId").value = tg.chatId || "";
    (d.config.dates || []).forEach(addDate);
    (d.config.prefTimes || []).forEach(addTime);
    // Auto-parse experience ID from URL if not already saved
    if (!d.config.experienceId && d.config.url) {
      const expMatch = d.config.url.match(/\/experience\/(\d+)/);
      if (expMatch) {
        $("#experienceId").value = expMatch[1];
        saveConfig();
      }
    }
  } else {
    $("#releaseTime").value = defaultReleaseTime();
  }
  if (!d.config?.dates?.length) getNextFriSatSun().forEach(addDate);
  $("#dateInput").value = state.dates[0] || "";
  updateHints();
  updateExtras();
  // Enabled earlier but the optional permission is missing (e.g. removed in chrome://extensions)
  if ($("#tgEnabled").checked) {
    chrome.permissions.contains(TELEGRAM_PERMISSION).then((ok) => {
      if (!ok) showTgResult("Permission missing — switch Telegram off and on again.", "err");
    }, () => {});
  }
  renderTargets();
  updateButton(d.sniping);
  initActiveTab();
  if (d.status) showStatus(d.status.msg, d.status.type);
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.status) showStatus(changes.status.newValue.msg, changes.status.newValue.type);
  if (changes.sniping) updateButton(changes.sniping.newValue);
});

function updateButton(armed = armedState) {
  armedState = armed;
  const btn = $("#startBtn");
  const mode = radioValue("snipeMode");
  const combos = Math.max(1, state.dates.length) * Math.max(1, state.times.length);
  const domTabs = mode === "api" ? 0 : combos;
  const tabCount = domTabs + (mode === "dom" ? 0 : 1);
  btn.textContent = armed ? "⏹ Disarm All" : "⚡ Arm Sniper";
  btn.className = armed ? "active" : "";
  const parts = [mode !== "dom" && `1 API tab for ${combos} target${combos !== 1 ? "s" : ""}`, domTabs && `${domTabs} DOM tab${domTabs !== 1 ? "s" : ""}`].filter(Boolean);
  $("#tabSummary").textContent = armed
    ? "Sniping — tabs are counting down."
    : `Opens ${tabCount} tab${tabCount !== 1 ? "s" : ""}: ${parts.join(" + ")}`;
}

function updateHints() {
  $("#expSourceHint").textContent = EXP_SOURCE_HINTS[radioValue("expSource")] || "";
  $("#snipeModeHint").textContent = SNIPE_MODE_HINTS[radioValue("snipeMode")] || "";
}

function showStatus(msg, type) {
  const el = $("#status");
  el.textContent = msg;
  el.className = type;
}

function parseTockUrl(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith("exploretock.com")) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Booking-dialog URL. With an experience ID: /<restaurant>/experience/<id>?date&size&time — the dialog
// then lists only that experience (Tock fills in the slug). Without one: /<restaurant>/search?…,
// where Tock picks the experience. Both auto-open the dialog for the given date.
function buildTargetUrl(baseUrl, date, partySize, targetTime, experienceId = null) {
  const url = new URL(baseUrl);
  const restaurant = url.pathname.split("/").filter(Boolean)[0] || "";
  url.pathname = experienceId ? `/${restaurant}/experience/${experienceId}` : `/${restaurant}/search`;
  url.search = "";
  url.searchParams.set("date", date);
  url.searchParams.set("size", String(partySize));
  const timeParam = displayTimeToParam(targetTime || "");
  if (timeParam) url.searchParams.set("time", timeParam);
  return url.toString();
}

function buildTargets(config) {
  const base = parseTockUrl(config.url);
  if (!base) return [];

  const urlDate = base.searchParams.get("date");
  const urlTime = paramTimeToDisplay(base.searchParams.get("time"));
  const dates = config.dates.length ? config.dates : [urlDate].filter(Boolean);
  const times = config.prefTimes.length ? config.prefTimes : [urlTime].filter(Boolean);

  // Extract experience ID from original URL or use saved config value
  const expMatch = base.pathname.match(/\/experience\/(\d+)/);
  const experienceId = config.experienceId || (expMatch ? parseInt(expMatch[1], 10) : null);

  // Determine modes: "both" → one api + one dom target per date/time
  const modes = config.snipeMode === "both" ? ["api", "dom"] : [config.snipeMode || "api"];

  return dates.flatMap((date) => {
    const dateTimes = times.length ? times : [""];
    return dateTimes.flatMap((time) => {
      const normalizedTime = paramTimeToDisplay(displayTimeToParam(time)) || time;
      const searchUrl = buildTargetUrl(config.url, date, config.partySize, normalizedTime);
      // "auto" ignores the manual ID, so don't pin the page to it either
      const pageExperienceId = config.expSource === "auto" ? null : experienceId;
      return modes.map((mode) => ({
        date,
        time: normalizedTime,
        experienceId,
        mode,
        url: pageExperienceId ? buildTargetUrl(config.url, date, config.partySize, normalizedTime, pageExperienceId) : searchUrl,
        searchUrl, // DOM fallback when the experience page says "couldn't find this reservation"
      }));
    });
  });
}

function syncFieldsFromUrl() {
  const parsed = parseTockUrl($("#url").value.trim());
  if (!parsed) return;

  const urlDate = parsed.searchParams.get("date");
  const urlSize = parsed.searchParams.get("size");
  const urlTime = paramTimeToDisplay(parsed.searchParams.get("time"));

  // Extract experience ID from URL path
  const expMatch = parsed.pathname.match(/\/experience\/(\d+)/);
  if (expMatch) $("#experienceId").value = expMatch[1];

  if (urlSize) $("#partySize").value = urlSize;
  if (urlTime && !state.times.length) addTime(urlTime);
  if (urlDate && !state.dates.includes(urlDate)) state.dates = [urlDate];
  renderTargets();
}

function readConfig() {
  return {
    url: $("#url").value.trim(),
    partySize: clampParty(parseInt($("#partySize").value) || 2),
    releaseTime: $("#releaseTime").value,
    prefTimes: [...state.times],
    snipeMode: radioValue("snipeMode"),
    experienceId: parseInt($("#experienceId").value) || null,
    expSource: radioValue("expSource"),
    dates: [...state.dates],
    monitor: {
      enabled: $("#monitorEnabled").checked,
      intervalSec: Math.min(600, Math.max(10, parseInt($("#monitorInterval").value) || 20)),
      hours: Math.min(48, Math.max(0.1, parseFloat($("#monitorHours").value) || 6)),
      flexMinutes: parseInt($("#monitorFlex").value, 10) || 0,
    },
    notify: {
      telegram: {
        enabled: $("#tgEnabled").checked,
        token: $("#tgToken").value.trim(),
        chatId: $("#tgChatId").value.trim(),
      },
    },
  };
}

function updateExtras() {
  const mon = $("#monitorEnabled").checked, tg = $("#tgEnabled").checked;
  $("#monitorFields").setAttribute("aria-disabled", String(!mon));
  $("#tgFields").setAttribute("aria-disabled", String(!tg));
  $("#extrasBadge").textContent = [mon && "monitor", tg && "telegram"].filter(Boolean).join(" + ") || "off";
}

function saveConfig() {
  chrome.storage.local.set({ config: readConfig() }, () => {
    const el = $("#saved");
    el.classList.add("show");
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => el.classList.remove("show"), 1200);
  });
}

// ── Events ──
function stepParty(delta) {
  $("#partySize").value = clampParty((parseInt($("#partySize").value) || 2) + delta);
  saveConfig();
  if (lastPageInfo) renderExperienceSuggestions(lastPageInfo);
}
$("#partyMinus").addEventListener("click", () => stepParty(-1));
$("#partyPlus").addEventListener("click", () => stepParty(1));

$("#addDate").addEventListener("click", () => {
  if (addDate($("#dateInput").value)) { renderTargets(); saveConfig(); }
});
$("#dateInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#addDate").click(); });
$("#addTime").addEventListener("click", () => {
  if (addTime($("#timeInput").value)) { renderTargets(); saveConfig(); }
});
$("#timeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#addTime").click(); });

$("#url").addEventListener("input", () => { syncFieldsFromUrl(); saveConfig(); });
$("#useTab").addEventListener("click", useActiveTab);
$("#monitorEnabled").addEventListener("change", () => { updateExtras(); saveConfig(); });
$("#monitorFlex").addEventListener("change", saveConfig);

// ── Activity log (every overlay line from all tabs, kept by background.js) ──
const pad2 = (n) => String(n).padStart(2, "0");
function formatLogTime(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}
async function showLogInfo() {
  const { activityLog = [] } = await chrome.storage.local.get("activityLog");
  $("#logInfo").textContent = activityLog.length ? `${activityLog.length} lines since ${formatLogTime(activityLog[0].t).slice(5, 16)}` : "No log yet";
}
$("#logExport").addEventListener("click", async () => {
  const { activityLog = [] } = await chrome.storage.local.get("activityLog");
  if (!activityLog.length) return showLogInfo();
  const text = activityLog.map((e) => `${formatLogTime(e.t)}  ${e.level === "error" ? "!" : " "} [${[e.venue, e.target].filter(Boolean).join(" · ")}] ${e.msg}`).join("\n") + "\n";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = `tock-sniper-log-${formatLogTime(Date.now()).slice(0, 16).replace(/[-: ]/g, "")}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$("#logClear").addEventListener("click", async () => {
  await chrome.storage.local.remove("activityLog");
  showLogInfo();
});
$("#extras").addEventListener("toggle", () => { if ($("#extras").open) showLogInfo(); });

// api.telegram.org is an optional host permission: asked for only when Telegram is switched on
// (or "Send test" is pressed) — both are user gestures, which chrome.permissions.request needs.
const requestTelegramPermission = () => chrome.permissions.request(TELEGRAM_PERMISSION).catch(() => false);

function showTgResult(text, cls = "") {
  $("#tgTestResult").className = cls;
  $("#tgTestResult").textContent = text;
}

$("#tgEnabled").addEventListener("change", async (e) => {
  updateExtras();
  saveConfig();
  if (!e.target.checked) return;
  if (await requestTelegramPermission()) {
    showTgResult("");
    return;
  }
  e.target.checked = false;
  updateExtras();
  saveConfig();
  showTgResult("Permission to reach api.telegram.org wasn't granted.", "err");
});
["#monitorInterval", "#monitorHours", "#tgToken", "#tgChatId"].forEach((id) => $(id).addEventListener("input", saveConfig));
// Show the clamped value once the field is left (readConfig clamps what gets saved)
["#monitorInterval", "#monitorHours"].forEach((id) => $(id).addEventListener("change", () => {
  const { intervalSec, hours } = readConfig().monitor;
  $("#monitorInterval").value = intervalSec;
  $("#monitorHours").value = hours;
}));
$("#tgTest").addEventListener("click", async () => {
  const out = $("#tgTestResult");
  if (!(await requestTelegramPermission())) {
    showTgResult("Permission to reach api.telegram.org wasn't granted.", "err");
    return;
  }
  out.className = "";
  out.textContent = "Sending…";
  try {
    const r = await chrome.runtime.sendMessage({
      type: "tockSniper:notify",
      text: "✅ Tock Sniper test notification",
      override: { token: $("#tgToken").value.trim(), chatId: $("#tgChatId").value.trim() },
    });
    out.className = r?.ok ? "ok" : "err";
    out.textContent = r?.ok ? "Sent ✓" : `Failed: ${r?.error || "no response"}`;
  } catch (err) {
    out.className = "err";
    out.textContent = `Failed: ${err.message}`;
  }
});
$("#partySize").addEventListener("input", () => { saveConfig(); if (lastPageInfo) renderExperienceSuggestions(lastPageInfo); });
$("#releaseTime").addEventListener("input", () => { saveConfig(); renderReleaseSuggestion(); });
$("#experienceId").addEventListener("input", (e) => {
  const digits = e.target.value.replace(/\D/g, "");
  if (digits !== e.target.value) e.target.value = digits; // IDs are plain integers
  saveConfig();
  if (lastPageInfo) renderExperienceSuggestions(lastPageInfo);
});
document.querySelectorAll('input[name="snipeMode"], input[name="expSource"]').forEach((el) =>
  el.addEventListener("change", () => { updateHints(); updateButton(); saveConfig(); })
);

$("#startBtn").addEventListener("click", async () => {
  const armed = (await chrome.storage.local.get("sniping")).sniping;
  if (armed) {
    chrome.storage.local.set({ sniping: false });
    return;
  }

  const config = readConfig();

  const parsedUrl = parseTockUrl(config.url);
  if (!parsedUrl) {
    showStatus("Enter a valid Tock URL", "warn");
    return;
  }

  if (!config.dates.length && parsedUrl.searchParams.get("date")) {
    config.dates = [parsedUrl.searchParams.get("date")];
  }
  if (!config.prefTimes.length && parsedUrl.searchParams.get("time")) {
    config.prefTimes = [paramTimeToDisplay(parsedUrl.searchParams.get("time"))];
  }

  const targets = buildTargets(config);
  if (!targets.length) {
    showStatus("Add a date or use a URL with a date", "warn");
    return;
  }
  config.targets = targets;
  if (config.expSource === "manual" && !config.experienceId && targets.some((t) => t.mode === "api" && !t.experienceId)) {
    showStatus("Manual ID only needs an Experience ID", "warn");
    return;
  }

  chrome.storage.local.set({ config, sniping: true });
  // API: one tab (_tidx=api) handles every API target by priority, so more targets don't multiply the
  // requests (Tock rate-limits per client). DOM: one tab per target (_tidx=<index>), it clicks the page.
  const tabs = [];
  const firstApi = targets.find((t) => t.mode === "api");
  if (firstApi) tabs.push({ url: firstApi.url, tidx: "api" });
  targets.forEach((t, i) => { if (t.mode === "dom") tabs.push({ url: t.url, tidx: String(i) }); });
  showStatus(`Armed! Opening ${tabs.length} tab${tabs.length !== 1 ? "s" : ""}...`, "info");
  for (const tab of tabs) {
    const url = new URL(tab.url);
    url.searchParams.set("_tidx", tab.tidx);
    chrome.tabs.create({ url: url.toString(), active: false });
  }
});
