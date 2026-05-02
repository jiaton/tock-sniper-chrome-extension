# Tock Sniper — Chrome Extension

## Purpose
Auto-grab reservations on Tock (exploretock.com) the instant slots drop. Built for **Fù Huì Huá 馥薈華** (https://www.exploretock.com/fui-hui-hua-san-francisco).

## Release Schedule
- **Every Friday at 7:45 PM PDT** — releases next week's Friday, Saturday, and Sunday
- Each day has seatings around 5:00 PM and 8:00 PM
- Preferred: 8:00 PM, fallback: 5:00 PM, last resort: latest available

## Architecture: Multi-Tab Sniping
- Popup opens **one tab per target date** (e.g. 3 tabs for Fri/Sat/Sun)
- Each tab's content script **claims one date** via `chrome.storage.local` (first-come)
- All tabs watch simultaneously with MutationObserver
- Each tab independently: clicks "Book now" → selects its claimed date → picks preferred time → lands on checkout
- Tab title shows claimed date (e.g. "🎯 2026-04-24 | Fù Huì Huá")
- On success: title changes to "✅ 2026-04-24 8:00 PM — CHECKOUT"

## Files
```
tock-sniper-ext/
├── manifest.json      # MV3, content script on exploretock.com
├── popup.html         # Config UI: URL, party size, times, date slots
├── popup.js           # Multi-date config, opens N tabs on arm
├── content.js         # Core logic — MutationObserver, date claiming, month navigation
├── background.js      # Keepalive alarm, clears claimed dates on arm/disarm
├── icon.png           # 48x48 red circle
└── AGENTS.md          # This file
```

## Key DOM Selectors (verified live)
| Element | Selector |
|---------|----------|
| "Book now" link | `a` with `textContent === "Book now"` |
| Booking dialog | `[role="dialog"]` |
| Calendar date button | `[data-testid="consumer-calendar-day"][aria-label="YYYY-MM-DD"]` |
| Selected date | `.ConsumerCalendar-day.is-selected` |
| Next month button | `button[aria-label="Go to next month"]` |
| Time slot "Book" button | `[data-testid="booking-card-button"]` |
| Party size text | `<p>` containing "guest" |
| More/fewer guests | `button[aria-label="More guests"]` / `button[aria-label="Fewer guests"]` |
| Sold out button | `button[disabled]` with text "Sold out" |
| Checkout page | URL contains `/checkout/` |

## Date Claiming Protocol
1. On start, background.js clears `claimedDates` in storage
2. Each tab calls `claimDate(dates)` — iterates the date list, claims first unclaimed
3. Claim is stored as `{ tabId: "YYYY-MM-DD" }` in `chrome.storage.local.claimedDates`
4. On stop/disarm, all claims are cleared

## Content Script Flow
1. **No dialog**: detect "Book now" link → click it
2. **Dialog open, date not selected**: find date button on calendar → navigate months if needed → click date
3. **Dialog open, date selected, slots visible**: adjust party size → pick preferred time → click "Book"
4. **Checkout page**: stop, update title to success

## Install
1. `chrome://extensions` → Enable Developer mode
2. "Load unpacked" → select this directory

## Usage
1. Click extension icon
2. Dates auto-populate to next Fri/Sat/Sun
3. Set party size and preferred times (default: "8:00 PM, 5:00 PM")
4. Click "Arm Sniper" — opens 3 tabs
5. At 7:44 PM, manually refresh all 3 tabs (Cmd+Shift+R each)
6. At 7:45 PM when slots drop, each tab auto-clicks through in ~2 seconds
7. Check which tab(s) reached checkout, complete payment

## TODO
- [ ] Test on actual Fù Huì Huá release
- [ ] Handle calendar month navigation edge cases
- [ ] Add sound notification on checkout reached
- [ ] Auto-refresh at release time instead of manual refresh
