const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ── Slot management ──
function addSlotUI(date = "") {
  const div = document.createElement("div");
  div.className = "slot";
  div.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <span class="slot-header">Target Date</span>
      <button class="remove-btn" title="Remove">✕</button>
    </div>
    <input type="date" class="slot-date" value="${date}" />
  `;
  div.querySelector(".remove-btn").addEventListener("click", () => { div.remove(); updateButton(); saveConfig(); });
  div.querySelector(".slot-date").addEventListener("input", saveConfig);
  $("#slots").appendChild(div);
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
function defaultReleaseTime() {
  const d = new Date();
  d.setHours(19, 45, 0, 0);
  // format for datetime-local: YYYY-MM-DDTHH:MM:SS
  return d.toLocaleString("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).replace(" ", "T");
}

chrome.storage.local.get(["config", "sniping", "status"], (d) => {
  if (d.config) {
    $("#url").value = d.config.url || "";
    $("#partySize").value = d.config.partySize || 2;
    $("#releaseTime").value = d.config.releaseTime || defaultReleaseTime();
    $("#prefTimes").value = (d.config.prefTimes || []).join(", ");
    $("#snipeMode").value = d.config.snipeMode || "api";
    (d.config.dates || []).forEach((dt) => addSlotUI(dt));
  } else {
    $("#releaseTime").value = defaultReleaseTime();
  }
  if (!d.config?.dates?.length) {
    getNextFriSatSun().forEach((dt) => addSlotUI(dt));
  }
  updateButton(d.sniping);
  if (d.status) showStatus(d.status.msg, d.status.type);
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.status) showStatus(changes.status.newValue.msg, changes.status.newValue.type);
  if (changes.sniping) updateButton(changes.sniping.newValue);
});

function updateButton(armed) {
  const btn = $("#startBtn");
  const count = $$(".slot-date").length;
  const timeCount = Math.max(1, parseCsv($("#prefTimes").value || "").length);
  const tabCount = Math.max(1, count) * timeCount;
  btn.textContent = armed ? "⏹ Disarm All" : `⚡ Arm Sniper (opens ${tabCount} tab${tabCount !== 1 ? "s" : ""})`;
  btn.className = armed ? "active" : "";
}

function showStatus(msg, type) {
  const el = $("#status");
  el.textContent = msg;
  el.className = type;
}

const parseCsv = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

function parseTockUrl(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith("exploretock.com")) return null;
    return parsed;
  } catch {
    return null;
  }
}

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

function buildTargetUrl(baseUrl, date, partySize, targetTime) {
  const url = new URL(baseUrl);
  // Ensure path ends with /search so Tock auto-opens the booking dialog
  const path = url.pathname.replace(/\/search\/?$/, "").replace(/\/$/, "");
  url.pathname = path + "/search";
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

  // Extract experience ID from original URL
  const expMatch = base.pathname.match(/\/experience\/(\d+)/);
  const experienceId = expMatch ? parseInt(expMatch[1], 10) : null;

  return dates.flatMap((date) => {
    const dateTimes = times.length ? times : [""];
    return dateTimes.map((time) => {
      const normalizedTime = paramTimeToDisplay(displayTimeToParam(time)) || time;
      return {
        date,
        time: normalizedTime,
        experienceId,
        url: buildTargetUrl(config.url, date, config.partySize, normalizedTime),
      };
    });
  });
}

function syncFieldsFromUrl() {
  const parsed = parseTockUrl($("#url").value.trim());
  if (!parsed) return;

  const urlDate = parsed.searchParams.get("date");
  const urlSize = parsed.searchParams.get("size");
  const urlTime = paramTimeToDisplay(parsed.searchParams.get("time"));

  if (urlSize) $("#partySize").value = urlSize;
  if (urlTime && !$("#prefTimes").value.trim()) $("#prefTimes").value = urlTime;
  if (urlDate) {
    const dateInputs = [...$$(".slot-date")];
    if (dateInputs.length === 0) addSlotUI(urlDate);
    else if (dateInputs.every((input) => input.value !== urlDate)) {
      dateInputs.forEach((input, idx) => {
        if (idx === 0) input.value = urlDate;
        else input.closest(".slot")?.remove();
      });
    }
  }
  updateButton();
}

$("#addSlot").addEventListener("click", () => {
  addSlotUI();
  updateButton();
  saveConfig();
});

$("#url").addEventListener("change", () => { syncFieldsFromUrl(); saveConfig(); });
$("#url").addEventListener("blur", () => { syncFieldsFromUrl(); saveConfig(); });
$("#prefTimes").addEventListener("input", () => { updateButton(); saveConfig(); });
$("#partySize").addEventListener("input", saveConfig);
$("#releaseTime").addEventListener("input", saveConfig);
$("#snipeMode").addEventListener("change", saveConfig);

function saveConfig() {
  const dates = [...$$(".slot-date")].map((el) => el.value).filter(Boolean);
  const config = {
    url: $("#url").value.trim(),
    partySize: parseInt($("#partySize").value) || 2,
    releaseTime: $("#releaseTime").value,
    prefTimes: parseCsv($("#prefTimes").value),
    snipeMode: $("#snipeMode").value,
    dates,
  };
  chrome.storage.local.set({ config });
}

$("#startBtn").addEventListener("click", async () => {
  const armed = (await chrome.storage.local.get("sniping")).sniping;
  if (armed) {
    chrome.storage.local.set({ sniping: false });
    return;
  }

  const dates = [...$$(".slot-date")].map((el) => el.value).filter(Boolean);
  const config = {
    url: $("#url").value.trim(),
    partySize: parseInt($("#partySize").value) || 2,
    releaseTime: $("#releaseTime").value,
    prefTimes: parseCsv($("#prefTimes").value),
    snipeMode: $("#snipeMode").value,
    dates,
  };

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

  chrome.storage.local.set({ config, sniping: true });
  showStatus(`Armed! Opening ${targets.length} tabs...`, "info");

  // Open one tab per date/time target.
  for (const target of targets) {
    chrome.tabs.create({ url: target.url, active: false });
  }
});
