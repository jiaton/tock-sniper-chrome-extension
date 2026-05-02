# Tock Sniper — Chrome Extension

## Purpose
Auto-grab reservations on Tock (exploretock.com) the instant slots drop. Works with any Tock restaurant.

## Architecture: Multi-Tab Sniping
- Popup opens **one tab per target date**
- Each tab independently: waits for release time → reloads → clicks "Book now" → selects date → picks preferred time → reaches checkout
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
1. **Before release time**: show countdown overlay, reload at release - 100ms
2. **After release time**: snipe immediately
   - Find "Book now" link (retry up to 15s)
   - Click → dialog opens → select date on calendar (navigate months if needed)
   - Wait for time slots → adjust party size → pick preferred time → click "Book"
   - Handle seating area selection if prompted
   - Check for checkout

## Usage
1. Click extension icon
2. Enter the Tock restaurant URL
3. Set release time, party size, preferred times, and target dates
4. Click "Arm Sniper" — opens tabs
5. Tabs auto-reload at release time and race through booking
6. Complete payment on whichever tab reaches checkout
