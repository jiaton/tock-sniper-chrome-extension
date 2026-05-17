# Tock Sniper — Chrome Extension

## Purpose
Auto-grab reservations on Tock (exploretock.com) the instant slots drop. Works with any Tock restaurant.

## Architecture

### Data Flow
```
popup.js (config UI)
    │
    ├── Saves config to chrome.storage.local
    │   { url, partySize, releaseTime, prefTimes, snipeMode, experienceId, dates, targets[] }
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
| ⚡ API Direct | 1 | No reload. Fires `PUT /api/ticket/group/lock` at release. Retries 5× over 1s. |
| 🖱️ DOM Click | 1 | Reloads 75ms before release. Clicks through booking dialog UI. |
| 🔥 Both | 2 | Opens separate API + DOM tabs. They run in parallel, independently. |

### Tab Lifecycle
```
API mode:  load page → wait → fire lock request → navigate to /checkout
DOM mode:  load page → wait → reload at release-75ms → click dialog → checkout
```

## Files
```
tock-sniper-ext/
├── manifest.json          # MV3, content script on exploretock.com
├── popup.html             # Config UI: URL, experience ID, party size, release time, dates, mode
├── popup.js               # Builds targets[], opens tabs with _tidx, auto-saves config
├── content.js             # Per-tab snipe logic (API direct or DOM click)
├── background.js          # Keepalive alarm, clears state on arm/disarm
├── icons/                 # 16, 48, 128px icons
├── .github/workflows/     # CI: builds zip, auto-tags from manifest version
└── AGENTS.md              # This file
```

## Content Script Flow
1. **On load**: claim target via `_tidx` URL param, show overlay with countdown
2. **Before release**: clock sync (HEAD request for Date header), calibration samples
3. **At release time** (per `myTarget.mode`):
   - **API**: fires `PUT /api/ticket/group/lock` (30 bytes protobuf), retries 5× / 250ms, navigates to checkout on success
   - **DOM**: reloads at release - 75ms, waits for dialog auto-open (from /search URL), picks time slot, clicks Book

## Key DOM Selectors (for DOM mode)
| Element | Selector |
|---------|----------|
| Booking dialog | `[role="dialog"]` |
| Calendar date button | `button[aria-label="YYYY-MM-DD"]` |
| Next month button | `button[aria-label="Go to next month"]` |
| Time slot "Book" button | `button` with text "Book" (not disabled) |
| Party size text | `<p>` matching `/\d+\s*guest/` |
| More/fewer guests | `button[aria-label="More guests"]` / `button[aria-label="Fewer guests"]` |
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
x-tock-build-number: <from page, e.g. 2026-05-08RC12-00>
```
Session, fingerprint, and cookies are sent automatically via `credentials: "include"`.

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
On success, the slot is held for ~10 minutes. Retried 5× every 250ms to cover timing uncertainty.

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
| `/api/consumer/offerings` | POST | Get experience metadata, available dates/times |
| `/api/consumer/calendar/full/v2` | POST | Full calendar availability (3.6MB) |
| `/api/ticket/locks` | GET | Check current locks for session |
| `/api/ticket/price/consumer` | POST | Calculate price, finalize cart |

### Protobuf Wire Format
Messages use varint-encoded tags: `(field_number << 3) | wire_type`
- Wire 0 = varint, Wire 2 = length-delimited (strings, nested messages)
- High field numbers (60020, 60051, 60602) are used as message type envelopes

## URL Generation
Popup generates `/search` URLs so Tock auto-opens the booking dialog:
```
https://www.exploretock.com/<restaurant>/search?date=2026-05-23&size=2&time=20%3A00&_tidx=0
```
- `/search` path → dialog auto-opens (no "Book now" click needed)
- `_tidx=N` → deterministic target assignment for the content script

## Usage
1. Click extension icon
2. Paste Tock restaurant URL (experience ID auto-parsed)
3. Set release time, party size, preferred times, target dates
4. Select snipe mode (API / DOM / Both)
5. Click "Arm Sniper" — opens tabs
6. Tabs fire at release time (API locks slot instantly, DOM clicks through UI)
7. Complete payment on whichever tab reaches checkout first ✅
