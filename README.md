# 🎯 Tock Sniper

Auto-grab reservations on [Tock](https://www.exploretock.com) the instant they drop.

## How It Works

1. **Set your target** — paste the restaurant URL, set party size, preferred times, and target dates
2. **Set the release time** — when new reservations go live
3. **Arm the sniper** — opens one tab per target date
4. **Sit back** — each tab auto-reloads at the exact release time and races through:
   - Clicks "Book now"
   - Selects your date on the calendar
   - Picks your preferred time slot (falls back to latest available)
   - Handles seating area selection
   - Lands on checkout

## Features

- **Multi-date sniping** — one tab per date, all fire simultaneously
- **Precise timing** — reloads 100ms before release for maximum speed
- **Preferred times** — tries your preferred times in order, falls back to latest available
- **Live overlay** — floating status window shows countdown, progress, and errors
- **Party size** — auto-adjusts guest count before booking
- **One-shot** — no polling, no background noise

## Install

### From Chrome Web Store
*(Coming soon)*

### Manual / Developer
1. Clone this repo
2. Go to `chrome://extensions`
3. Enable "Developer mode"
4. Click "Load unpacked" → select this folder

## Usage

1. Click the extension icon
2. Enter the Tock restaurant URL (e.g. `https://www.exploretock.com/restaurant-name`)
3. Set the release time (when new reservations drop)
4. Set party size and preferred times
5. Add target dates (defaults to next Fri/Sat/Sun)
6. Click **Arm Sniper**
7. Complete payment on whichever tab reaches checkout first ✅

## How Tock Releases Work

Most Tock restaurants release reservations on a weekly schedule (e.g. every Friday at a specific time for the following week). The release time is usually shown on the restaurant's page when all slots are sold out.

## License

MIT
