# Tock Sniper — Chrome Extension

## Purpose
Auto-grab reservations on Tock (exploretock.com) the instant slots drop. Works with any Tock restaurant.

## Architecture: Multi-Tab Sniping
- Popup opens **one tab per target date/time pair**
- If the Tock URL includes `date`, `size`, and `time`, tabs open with those query params already set
- Each tab independently: waits for release time → reloads → clicks "Book now" → uses URL-selected date when available → picks target time → reaches checkout
- Tab title shows status: 🎯 = waiting, ✅ = checkout reached

## Files
```
tock-sniper-ext/
├── manifest.json      # MV3, content script on exploretock.com
├── popup.html         # Config UI: URL, party size, release time, dates
├── popup.js           # Multi-date config, opens N tabs on arm
├── content.js         # Core logic — auto-reload, date selection, time slot picking
├── background.js      # Keepalive alarm, clears state on arm/disarm
├── icons/             # 16, 48, 128px icons
└── AGENTS.md          # This file
```

## Key DOM Selectors (verified on live Tock)
| Element | Selector |
|---------|----------|
| "Book now" link | `a` with `textContent === "Book now"` |
| Booking dialog | `[role="dialog"]` |
| Calendar date button | `button[aria-label="YYYY-MM-DD"]` |
| Next month button | `button[aria-label="Go to next month"]` |
| Time slot "Book" button | `button` with text "Book" (not disabled) |
| Party size text | `<p>` matching `/\d+\s*guest/` |
| More/fewer guests | `button[aria-label="More guests"]` / `button[aria-label="Fewer guests"]` |
| Checkout page | URL contains `/checkout/` |

## Content Script Flow
1. **Before release time**: estimate exploretock.com clock offset, keep the lowest-RTT sample, show millisecond countdown overlay, freeze calibration in the final 5s
2. **At release time** (mode-dependent):
   - **API mode**: fires `PUT /api/ticket/group/lock` directly (no reload), retries 5× over 1s
   - **DOM mode**: reloads at release - 75ms, then clicks through UI
   - **Both mode**: tries API first, falls back to DOM on failure

## Snipe Modes
| Mode | Speed | Method |
|------|-------|--------|
| ⚡ API Direct | ~50ms | Sends protobuf lock request, navigates to checkout |
| 🖱️ DOM Click | ~2s | Waits for dialog, clicks Book button |
| 🔥 Both | ~50ms + fallback | API first, DOM if API fails |

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
x-tock-session: <from cookie/page>
x-tock-fingerprint: <from page>
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
On success, the slot is held for ~10 minutes.

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

## Usage
1. Click extension icon
2. Enter the Tock restaurant URL
3. Set release time, party size, preferred times, and target dates
4. Click "Arm Sniper" — opens tabs
5. Tabs auto-reload at release time and race through booking
6. Complete payment on whichever tab reaches checkout
