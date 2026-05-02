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
  div.querySelector(".remove-btn").addEventListener("click", () => div.remove());
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
  btn.textContent = armed ? "⏹ Disarm All" : `⚡ Arm Sniper (opens ${count} tab${count !== 1 ? "s" : ""})`;
  btn.className = armed ? "active" : "";
}

function showStatus(msg, type) {
  const el = $("#status");
  el.textContent = msg;
  el.className = type;
}

const parseCsv = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

$("#addSlot").addEventListener("click", () => {
  addSlotUI();
  updateButton();
});

$("#startBtn").addEventListener("click", async () => {
  const armed = (await chrome.storage.local.get("sniping")).sniping;
  if (armed) {
    chrome.storage.local.set({ sniping: false });
    return;
  }

  const dates = [...$$(".slot-date")].map((el) => el.value).filter(Boolean);
  if (dates.length === 0) {
    showStatus("Add at least one date", "warn");
    return;
  }

  const config = {
    url: $("#url").value.trim(),
    partySize: parseInt($("#partySize").value) || 2,
    releaseTime: $("#releaseTime").value,
    prefTimes: parseCsv($("#prefTimes").value),
    dates,
  };

  if (!config.url.includes("exploretock.com")) {
    showStatus("Enter a valid Tock URL", "warn");
    return;
  }

  chrome.storage.local.set({ config, sniping: true });
  showStatus(`Armed! Opening ${dates.length} tabs...`, "info");

  // Open one tab per date
  for (const date of dates) {
    chrome.tabs.create({ url: config.url, active: false });
  }
});
