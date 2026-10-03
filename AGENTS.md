# Tock Sniper — Chrome Extension

## Purpose
Auto-grab reservations on Tock (exploretock.com) the instant slots drop. Works with any Tock restaurant.

## Architecture

### Data Flow
```
popup.js (config UI)
    │
    ├── Saves config to chrome.storage.local
    │   { url, partySize, releaseTime, prefTimes, snipeMode, experienceId, expSource, dates, targets[],
    │     monitor: { enabled, intervalSec, hours }, notify: { telegram: { enabled, token, chatId } } }
    │
    └── On "Arm": builds targets[], opens one tab per target with ?_tidx=N
                  Each target has: { date, time, experienceId, mode, url }

chrome.storage.local (shared)
    │
    └── config.targets[N] — full target list, indexed by _tidx

content.js (per tab)
    │
    ├── First load: reads _tidx from URL → gets config.targets[_tidx]
    │   Saves to sessionStorage (survives reload)
    │
    ├── After reload: reads from sessionStorage (no race, no shared state)
    │
    └── At release time: executes myTarget.mode ("api" or "dom")
```

### Target Assignment
- Popup assigns each tab a **deterministic index** via `?_tidx=N` in the URL
- Content script reads `_tidx` once, looks up `config.targets[N]`, saves to sessionStorage
- After reload (DOM mode), target is restored from sessionStorage
- No race conditions, no shared counters

### Snipe Modes
| Mode | Tabs per date/time | Behavior |
|------|-------------------|----------|
| ⚡ API Direct | 1 | No reload. ~42 `PUT /api/ticket/group/lock` sends centered on the release time (5ms apart within ±40ms, sparser outward, T-100ms … T+3s), plus offerings ≤ every 50ms until an experience is listed. First lock success wins; stops on sold-out or 429. A tab starting after T+3s sends once. |
| 🖱️ DOM Click | 1 | Reloads 800ms before release, clicks through the booking dialog. Retries (reload) up to 3× within 10s if the page shows no availability. |
| 🔥 Both | 2 | Opens separate API + DOM tabs. They run in parallel, independently. |

### Tab Lifecycle
```
API mode:  load page → wait → offerings + lock burst (release-10ms) → navigate to /checkout
DOM mode:  load page → wait → reload at release-800ms → dialog auto-opens → pick slot → Book → checkout
           (no availability / "couldn't find this reservation" → reload or switch to /search, ≤3×)
```

## Files
```
tock-sniper-ext/
├── manifest.json          # MV3, content scripts on exploretock.com
├── page-hook.js           # MAIN world, document_start: records Tock's own X-Tock-* request headers
├── popup.html             # Config UI: URL (+ "Use this page"), experience ID, party size, release time, date/time chips, mode
├── popup.js               # Builds targets[], opens tabs with _tidx, auto-saves config
├── content.js             # Per-tab snipe logic (API direct or DOM click)
├── background.js          # Keepalive alarm, clears state on arm/disarm, sends Telegram notifications
├── icons/                 # 16, 48, 128px service-bell icons (generated — edit scripts/icon.mjs)
├── .github/workflows/     # CI: builds a fresh zip, tags + releases v<manifest version> on push to main
├── scripts/               # icon.mjs + render-icons.mjs (icons/), store-screenshots.html (store images), demo.html + record-demo.mjs (docs/demo.gif)
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
     Browsers clamp timers to ~4ms, so `waitUntil()` sleeps coarsely to 25ms before each send and then yields via `MessageChannel` for sub-ms precision. Offerings (until the first non-empty list) ride along at most every 50ms. A tab that starts after T+3s (or has no release time) sends a single lock (plus one offerings if it needs the ID). Navigates to checkout on the first lock without an in-body error. Stops early on:
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
| `/api/consumer/calendar/full/v2` | POST | Full calendar availability (3.6MB) |
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
  over), keep checking every `intervalSec` (±20% jitter) for `hours`. Each check polls offerings only;
  once the venue lists experiences, it also tries one lock (listed experience, preferring the manual ID).
  Success → checkout. A 429 pauses 10 min (lock 429s persisted ~28 min after a burst on 2026-10-02 while
  offerings kept working). Stops on Disarm. Hidden tabs get timer-throttled by Chrome (≥1 min between checks).
- **Telegram** (`config.notify.telegram`): content scripts send `{type: "tockSniper:notify", text}` to
  `background.js`, which POSTs `https://api.telegram.org/bot<token>/sendMessage`, so the token never reaches
  the page. `api.telegram.org` is an `optional_host_permissions` entry — requested by the popup only when
  Telegram is switched on or "Send test" is pressed (user gesture), so updates don't trigger a new
  permission warning (Chrome would otherwise disable the extension until users accept it). Sent on: lock success / DOM checkout (per target), and once per
  restaurant per armed run for monitor start, bookings opened, monitor end (`dedupeKey`
  `<restaurant>:<kind>`; background.js serializes notify messages and records them in `notifySent`,
  cleared on Arm/Disarm). The popup's "Send test" passes `override: {token, chatId}`. Notification failures never
  block booking. The token is stored in `chrome.storage.local` only — never commit one.

## Usage
1. Click extension icon
2. Paste the Tock restaurant URL, or open the restaurant page and click "Use this page" (picks up experience IDs and release time)
3. Set release time, party size, preferred times, target dates
4. Select snipe mode (API / DOM / Both)
5. Click "Arm Sniper" — opens tabs
6. Tabs fire at release time (API locks slot instantly, DOM clicks through UI)
7. Complete payment on whichever tab reaches checkout first ✅
