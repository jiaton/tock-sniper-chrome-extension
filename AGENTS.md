# Tock Sniper — Chrome Extension

## Purpose
Auto-grab reservations on Tock (exploretock.com) the instant slots drop. Works with any Tock restaurant.

## Architecture

### Data Flow
```
popup.js (config UI)
    │
    ├── Saves config to chrome.storage.local
    │   { url, partySize, partyPolicy, releaseTime, prefTimes, snipeMode, experienceId, expSource, dates, targets[],
    │     monitor: { enabled, intervalSec, hours, flexMinutes }, notify: { telegram: { enabled, token, chatId } } }
    │
    └── On "Arm": builds targets[] (date-major: every time of date 1, then date 2 — in the order added),
                  opens ONE API tab (?_tidx=api) for all API targets + one DOM tab per DOM target (?_tidx=N)
                  Each target has: { date, time, experienceId, mode, url, searchUrl }

chrome.storage.local (shared)
    │
    └── config.targets[N] — full target list, indexed by _tidx

content.js (per tab)
    │
    ├── First load: reads _tidx from URL → config.targets[_tidx], or for _tidx=api every API target
    │   (myTarget = the top one with group: count). Saves to sessionStorage (survives reload)
    │
    ├── After reload: reads from sessionStorage (no race, no shared state)
    │
    └── At release time: executes myTarget.mode ("api" or "dom")
```

### Target Assignment
- **API**: one tab (`?_tidx=api`) handles every API target, by priority (`apiTargets(config)`). One tab means one
  request budget: Cloudflare 429s after ~50 requests in ~0.6s per client, and N tabs bursting separately sent N×42.
- **API lease**: only one API tab per armed run sends anything. Each API tab asks `background.js`
  (`tockSniper:apiLease`) before its countdown and on every monitor check; the first to ask holds it (by tab
  ID — reloads and checkout keep it). Others show "💤 Standby" and take over within ~2s if the holder is
  closed. Arm stores a new `armId`; tabs claim it into their sessionStorage target, so tabs left from an
  earlier Arm (or pre-3.2 per-target API tabs) get `stale` and send nothing. DOM tabs never send API requests.
- **DOM**: one tab per target via `?_tidx=N` (it clicks the page, so one date/time per tab)
- **Priority** = the order dates and times were added in the popup (chips are numbered); date-major
- Content script reads `_tidx` once, looks up its target(s), saves to sessionStorage
- After reload (DOM mode), target is restored from sessionStorage
- No race conditions, no shared counters

### Snipe Modes
| Mode | Tabs | Behavior |
|------|-------------------|----------|
| ⚡ API Direct | 1 for all | No reload. Sends are shared by all targets, weighted by priority 1/rank (2 targets 67/33%, 4 → 48/24/16/12%; smooth weighted round-robin); a target leaves the rotation once sold out. ~42 `PUT /api/ticket/group/lock` sends centered on the release time (5ms apart within ±40ms, sparser outward, T-100ms … T+3s), plus offerings ≤ every 50ms until an experience is listed. First lock success wins; stops on sold-out or 429. A tab starting after T+3s sends once, only if offerings + calendar show a table for the party. |
| 🖱️ DOM Click | 1 per target | Reloads 800ms before release, clicks through the booking dialog. Retries (reload) up to 3× within 10s if the page shows no availability. |
| 🔥 Both | 1 + 1 per target | One API tab for all targets plus a DOM tab per target. They run in parallel, independently. |

### Tab Lifecycle
```
API mode:  load page → wait → offerings + lock burst (release-10ms) → navigate to /checkout
DOM mode:  load page → wait → reload at release-800ms → dialog auto-opens → pick slot → Book → checkout
           (no availability / "couldn't find this reservation" → reload or switch to /search, ≤3×)
```

## Files
```
tock-sniper-chrome-extension/
├── manifest.json          # MV3, content scripts on exploretock.com
├── page-hook.js           # MAIN world, document_start: records Tock's own X-Tock-* request headers
├── popup.html             # Config UI: URL (+ "Use this page"), experience ID, party size, release time, date/time chips, mode
├── popup.js               # Builds targets[], opens tabs with _tidx, auto-saves config
├── content.js             # Per-tab snipe logic (API direct or DOM click)
├── background.js          # Keepalive alarm, clears state on arm/disarm, sends Telegram notifications
├── icons/                 # 16, 48, 128px service-bell icons (generated — edit scripts/icon.mjs)
├── .github/workflows/     # build.yml: fresh zip, tag + release v<manifest version>, store upload (cws-publish.sh)
│                          # store-status.yml: every 6h + after builds, store vs latest release → README badge
│                          #   (store-status.json on the `badges` branch, via .github/scripts/cws-status.sh)
├── scripts/               # version-diff.sh (store vs latest release vs main, public data);
│                          # icon.mjs + render-icons.mjs (icons/), store-screenshots.html (store images), demo.html + record-demo.mjs (docs/demo.gif)
├── docs/demo.gif          # README demo (regenerate: node scripts/record-demo.mjs)
├── store/                 # listing.md (store text, permission justifications), screenshots
├── LICENSE                # MIT
└── AGENTS.md              # This file
```

## Content Script Flow
1. **On load**: claim target via `_tidx` URL param, show overlay with countdown
2. **Before release**: countdown using the local clock (`Date.now()`, relies on NTP; no server clock sync)
3. **At release time** (per `myTarget.mode`):
   - **API**: sends (without awaiting responses) lock requests at precomputed times from `API_SCHEDULE`, centered on the release time T:
     | Window | Every | Sends |
     |---|---|---|
     | T-100 … T-40ms | 20ms | 3 |
     | T-40 … T+40ms | 5ms | 16 |
     | T+40 … T+100ms | 15ms | 4 |
     | T+100 … T+500ms | 50ms | 8 |
     | T+500ms … T+3s | 250ms | 11 |
     Browsers clamp timers to ~4ms, so `waitUntil()` sleeps coarsely to 25ms before each send and then yields via `MessageChannel` for sub-ms precision. Offerings (until the first non-empty list) ride along at most every 50ms. A tab that starts after T+3s (or has no release time) makes a single attempt, pre-checked: offerings (unless
     `manual`) + calendar first, and no lock is sent when nothing is listed, the experience's listed party sizes
     exclude the party, or the calendar has no table for the party at the target time (`🛑 No lock sent: …`).
     A failed pre-check request (other than 429) doesn't block the attempt. The burst is never pre-checked
     (the ~150ms wait would miss the release). Navigates to checkout on the first lock without an in-body error. Stops early on:
     - **429** (HTTP status or in-body) — the first one. Observed 2026-10-02: Cloudflare answered HTTP 429 after ~50 lock requests in ~0.6s.
     - **Sold out** — 3 consecutive in-body 410s ("someone else just selected this…") for requests sent ≥ 500ms after release. Earlier 410s are ignored because slots may not be open yet.
     The overlay status shows live counts; a `📊 Sent N lock … → 410×a 429×b` line summarizes the run.
   - **Experience ID source** (`config.expSource`):
     | Value | Behavior | Cost |
     |---|---|---|
     | `hybrid` (default) | Locks with the manual ID from the first request; switches to the offerings pick if it differs | extra offerings requests |
     | `manual` | Manual ID only, no offerings requests | fails if the ID is stale |
     | `auto` | Ignores manual ID; first lock waits for offerings | one round trip (~150ms) |
     Offerings pick: the manual ID if listed, else the first experience allowing the party size.
   - **DOM**: reloads at release - 800ms (Tock requests availability ~1.2–1.5s after a reload, measured 2026-10-02, so that request lands ~400–700ms after release), waits for the dialog to auto-open, picks the time slot, clicks Book. If the dialog shows "has sold out all reservations", the date as "no availability" (held ≥250ms, so a still-loading dialog isn't mistaken), or "couldn't find this reservation" (stale experience ID → switches to the `/search` URL), it retries up to 3× within 10s after release.

## Key DOM Selectors (for DOM mode)
| Element | Selector |
|---------|----------|
| Booking dialog | `[role="dialog"]` |
| Calendar date button | `button[aria-label^="YYYY-MM-DD"]` (label is `YYYY-MM-DD` or `YYYY-MM-DD, no availability`) |
| Next month button | `button[aria-label="Go to next month"]` |
| Time slot "Book" button | `button` with text "Book" (not disabled) |
| Party size text | `<p>` matching `/\d+\s*guest/` |
| More/fewer guests | `button[aria-label^="More guests"]` / `button[aria-label^="Fewer guests"]` (label is e.g. `More guests, current party size is 2`) |
| Checkout page | URL contains `/checkout/` |

## Tock API — Booking Protocol (proto2 over HTTP)

All API calls use `content-type: application/octet-stream` with `x-tock-stream-format: proto2`.
Messages are wrapped in high-field-number envelopes.

### Required Headers
```
content-type: application/octet-stream
accept: application/octet-stream
x-tock-stream-format: proto2
x-tock-scope: {"businessId":"<id>","businessGroupId":"<id>","site":"EXPLORETOCK"}
x-tock-path: <current path>
x-tock-build-number: servingstack-<YYYY-MM-DD>RC<NN>-00   (window.__BUILD_NUMBER__)
x-tock-session: client_…            (set by Tock's frontend at runtime, not in HTML)
x-tock-authorization: <JWT>         (only when logged in)
x-tock-csrf-token: <token>          (when present)
x-tock-fingerprint: <32 hex>        (localStorage "fingerprint", JSON string)
```
Tock's frontend builds these per request; `page-hook.js` hooks `XMLHttpRequest` in the MAIN world at
`document_start` and mirrors every `X-Tock-*` header into `<html data-tock-sniper-headers>`. `content.js`
reuses them (falling back to HTML-derived scope/build and localStorage fingerprint). Cookies go via
`credentials: "include"`. Lock requests have not yet been verified with these headers.

### Booking Flow (3 steps)

#### 1. `PUT /api/ticket/unlock` — Release previous lock
```
Wrapper: field 60602 {
  f2: <ticket_id>    // from previous lock
  f3: <cart_id>      // from previous lock
}
```
Only needed if re-booking. Skipped on first attempt.

#### 2. `PUT /api/ticket/group/lock` — Lock the slot ⚡
```
Wrapper: field 60051 {
  f1: <party_size>           // e.g. 2
  f2: "<date>T<time>"        // e.g. "2026-05-23T20:00"
  f3: <experience_id>        // e.g. 559289
  f6: 0                      // always 0
}
```
**~30 bytes total. This is the only call needed at release time.**

**Errors come back as HTTP 200** with a top-level `f2` error instead of `f1`:
```
f2 { f1: code, f2: message, f4: 0, f5: http-like status }
  2002 / 400  "Bad request: ticketType is unknown: (id = 1)"
  2002 / 400  "Reservations for the same day not available after 6:45 PM."
  3000 / 410  "Unfortunately, someone else just selected this and it is no longer available."
```
So `res.ok` alone does not mean the slot is locked; `parseTockError()` must be checked. Lock requests
are processed (business validation) without a logged-in session. 4 sequential + 4 concurrent requests
to offerings and to lock (2026-10-02) produced no 429.
On success, the slot is held for ~10 minutes. Fired as a concurrent 10ms-interval burst (10ms before release to 3s after) to cover timing uncertainty. `x-tock-build-number` is read from the page at runtime (hardcoded fallback).

#### 3. `POST /api/ticket/price/consumer` — Finalize cart
```
Wrapper: field 60020 {
  f3:  <ticket_id>           // from lock response
  f4:  <experience_id>
  f5:  0
  f6:  { f1:1, f2:1, f3:0 } // quantity
  f31: "<date>T<time>"
  f41: <party_size>
  f42: <cart_id>             // from lock response
  f64: [repeated Order Fee entries from offerings response]
}
```
Handled automatically by Tock's frontend when checkout page loads.

### Other Endpoints
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/consumer/offerings` | POST | Experience list + open dates/times (see below) |
| `/api/consumer/offerings/preview?endDate=` | GET | 403 for consumers |
| `/api/consumer/calendar/full/v2` | POST | Seats per date/time/table size (see below) |
| `/api/ticket/locks` | GET | Check current locks for session |
| `/api/ticket/price/consumer` | POST | Calculate price, finalize cart |

### Offerings (experience ID discovery)
```
Request:  field 60331 {}                     // ConsumerCalendarRequest, empty → bytes da ba 1d 00
Response: f1 { f1 { field 60249 {            // ConsumerOfferings
            f1: repeated Offering { f1 id (= experience ID), f3 name, f5 slug, f7 repeated partySize }
            f3: repeated openDate, f4: repeated openTime, f5: createdAt
          } } }
```
Before a venue releases, the Offering list is empty — the experience ID cannot be known ahead of time.
Experience IDs are per menu/season (e.g. "2026 October Dinner"), so a manually saved ID goes stale.
The full proto schema is embedded as JSON in `/static/servingstack-*/explore.js`.

### Calendar (seats per time)
```
Request:  same empty field 60331 {} as offerings
Response: f1 { f1 { field 60686 {                // ConsumerFullCalendarV2
            f1: map<businessDay, { f1: map<date, { f2: repeated CalendarTicketGroup }> }>
          } } }
CalendarTicketGroup: f1 date, f3 time "HH:MM", f4 numTickets, f5 availableTickets,
                     f9 minPurchaseSize, f19 maxPurchaseSize, f13 repeated { f1 ticketTypeId = experience ID }
```
One group per table/counter configuration, so a time appears several times. A party of N can book a time when
some group has `available ≥ N` and `min ≤ N ≤ max` — this matched Tock's own dialog (YUJI, 2026-10-03).
~12KB for one experience over two weeks; Tock's frontend requests it on every page load.

### Protobuf Wire Format
Messages use varint-encoded tags: `(field_number << 3) | wire_type`
- Wire 0 = varint, Wire 2 = length-delimited (strings, nested messages)
- High field numbers (60020, 60051, 60602) are used as message type envelopes

## URL Generation
Popup generates URLs that make Tock auto-open the booking dialog:
```
https://www.exploretock.com/<restaurant>/experience/<id>?date=2026-05-23&size=2&time=20%3A00&_tidx=0   (experience ID known)
https://www.exploretock.com/<restaurant>/search?date=2026-05-23&size=2&time=20%3A00&_tidx=0            (no ID, or "Auto only")
```
- `/experience/<id>` → dialog lists only that experience; the slug is optional (Tock fills it in). An unknown
  ID shows "We couldn't find this reservation!" — `target.searchUrl` is the DOM-mode fallback.
- `/search` → Tock picks the experience/slot itself (may differ from the one you want when there are several)
- Tock may rewrite `time=` to the nearest available slot
- `_tidx=N` → deterministic target assignment for the content script

## Popup "Use this page"
Shown when the active tab is on exploretock.com (`activeTab` permission). It fills the URL (tracking
params `tock_*` / `_tidx` stripped) and sends `{type: "tockSniper:pageInfo"}` to the tab's content script,
which replies with:
- **experiences**: `/experience/<id>/<slug>` links on the page merged with the offerings list
  (names, party sizes) → clickable ID chips under the Experience ID field
- **release**: two kinds of page text, offered as a "Prefill" for the Release time field:
  - Tock's own `New reservations will be released on <Month D, YYYY> at <h:mm AM/PM> <TZ>` — printed in the
    browser's zone; known abbreviations (UTC, PST/PDT, EST/EDT, …) are converted to local time.
  - Restaurant-written `… will be released on [Weekday,] <Month D, YYYY> at 10am` — no zone; the restaurant's
    zone is guessed from the US state in the page title (`… - San Francisco, CA | Tock` → America/Los_Angeles),
    else browser-local. The prompt says the zone is a guess.
Tabs opened before the extension was (re)loaded have no content script — the popup asks to reload them.

## Monitor & Telegram (popup → "Monitor & notifications", both off by default)
- **Monitor** (`config.monitor`, API tabs): when the release snipe fails (not open yet, sold out, window
  over), keep checking every `intervalSec` (±20% jitter) for `hours`. Each check polls offerings only
  until an experience is listed. **A listed experience is not availability** — sold-out venues keep
  listing theirs (Fù Huì Huá, 2026-10-03: listed, page says "All reservations sold out"). Once listed, each
  check also reads the calendar and logs on change `🔓 Seats <date>, N guests: <times>` or `🈵 No seats`.
  One offerings + one calendar request per check covers every target (`chooseTarget`): it locks the first
  target, by priority, whose exact time has a table for the party; failing that, the closest open time
  within `±flexMinutes` (default 60; 0 = exact only) of each target, again by priority. No seats → no lock
  request. If the calendar can't be read it
  just tries the target time. Offerings answering 400 "Reservations are currently unavailable" is logged
  as `🔒 Booking switched off`. Right after a pre-checked single attempt (e.g. a tab reloaded after release), the first
  check waits one interval (10 min if the pre-check got a 429) unless the pre-check already saw a usable nearby
  time, so a reload costs offerings + calendar once, not twice. Success → checkout. A 429 pauses 10 min (lock 429s persisted ~28 min after a burst on 2026-10-02 while
  offerings kept working). Stops on Disarm. Hidden tabs get timer-throttled by Chrome (≥1 min between checks).
- **Telegram** (`config.notify.telegram`): content scripts send `{type: "tockSniper:notify", text}` to
  `background.js`, which POSTs `https://api.telegram.org/bot<token>/sendMessage`, so the token never reaches
  the page. `api.telegram.org` is an `optional_host_permissions` entry — requested by the popup only when
  Telegram is switched on or "Send test" is pressed (user gesture), so updates don't trigger a new
  permission warning (Chrome would otherwise disable the extension until users accept it). Sent on: lock success / DOM checkout (per target), and once per
  restaurant per armed run for monitor start, seats found (calendar), monitor end (`dedupeKey`
  `<restaurant>:<kind>`; background.js serializes notify messages and records them in `notifySent`,
  cleared on Arm/Disarm). The popup's "Send test" passes `override: {token, chatId}`. Notification failures never
  block booking. The token is stored in `chrome.storage.local` only — never commit one.

## Party-size policy (`config.partyPolicy`, API only)
- `exact` (default, "Whole party only"): locks only for `partySize`.
- `max` ("As many as offered"): some experiences only sell e.g. single seats (Fù Huì Huá's "An Autumn Hunt",
  2026-10-03: partySize [1]). `partySizesToTry()` → full party, then smaller sizes the experience lists. Monitor
  and pre-check use `chooseTargetForParty()`: every target (exact, then ±flex) for the full party first, then
  the next size down. The release burst caps to the largest listed size once offerings arrive. A partial lock
  logs/notifies "Locked 1 of 2 guests — book the other 1 separately (e.g. another account)".

## Activity log
`content.js`'s `log()` also sends every overlay line to `background.js` (`{type: "tockSniper:log", entry: {t, venue,
target, level, msg}}`), which appends it to `chrome.storage.local.activityLog` (newest 5000, batched writes so tabs
don't overwrite each other). Kept across runs and reloads. The popup's "Export log" (Monitor & notifications)
downloads it as a text file; "Clear" deletes it.

## Usage
1. Click extension icon
2. Paste the Tock restaurant URL, or open the restaurant page and click "Use this page" (picks up experience IDs and release time)
3. Set release time, party size, preferred times, target dates
4. Select snipe mode (API / DOM / Both)
5. Click "Arm Sniper" — opens tabs
6. Tabs fire at release time (API locks slot instantly, DOM clicks through UI)
7. Complete payment on whichever tab reaches checkout first ✅
