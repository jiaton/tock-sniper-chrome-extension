# Chrome Web Store listing — Tock Sniper v3.1.0

Copy-paste text for the developer dashboard. Keep it in sync with `manifest.json`.

## Short description (manifest `description`, ≤132 chars)

Auto-grab Tock reservations the instant they drop. Set target dates, preferred times, and release time.

## Detailed description

```
Auto-grab Tock reservations the instant they drop.

Tock Sniper books reservations on exploretock.com the moment new slots are released.

HOW IT WORKS:
1. Open the restaurant on Tock and click "Use this page" (or paste the URL)
2. Pick the experience, party size, target dates and times
3. Set the release time — prefilled when the page says when reservations open
4. Click "Arm Sniper" — opens one tab per date × time
5. At release, each tab races to lock your slot and jumps to checkout
6. Complete payment on whichever tab reaches checkout first

FEATURES:
• API mode — locks the slot directly, with requests concentrated around the exact release moment
• DOM mode — reloads just before release and clicks through the booking dialog, retrying if the page isn't ready yet
• Experience ID auto-detect — finds the current menu/experience at release, even if it changed
• Rate-limit aware — stops on sold-out or rate-limited responses instead of hammering the site
• Monitor (optional) — if a release is delayed or sold out, keeps checking, sees which times still have a table for your party, and books your time or the closest open one
• Telegram notifications (optional) — get a message when a slot is locked or bookings open
• Release time detection — reads "reservations will be released on…" from the page
• Live overlay — draggable status window with countdown, progress, and errors

Works with any restaurant on exploretock.com. You still need to complete payment manually.
Your settings and Telegram credentials are stored only in your browser.
```

## Privacy practices tab

### Single purpose

```
Tock Sniper helps the user book a restaurant reservation on exploretock.com at the moment it is released. It performs, at the exact release time, the booking steps the user would otherwise do by hand on the restaurant's Tock page (selecting the date, time and party size and holding the slot), then leaves the user on Tock's checkout page to pay. Optional extras serve the same purpose: re-checking a restaurant whose release is delayed, and notifying the user via their own Telegram bot when a slot is held.
```

### Permission justifications

**storage**
```
Saves the user's settings locally (restaurant URL, experience ID, party size, release time, target dates and times, snipe mode, and the optional monitor and Telegram settings), an activity log of what the extension did (exportable and clearable from the popup) and the armed/disarmed state shared between the popup, the background service worker and the restaurant tabs. Nothing is synced or sent to the developer.
```

**alarms**
```
While the sniper is armed, a 30-second alarm keeps the background service worker alive and clears the armed state's bookkeeping when the user disarms. The alarm is removed as soon as the sniper is disarmed.
```

**activeTab**
```
Used only when the user clicks the toolbar icon while viewing a restaurant on exploretock.com: the "Use this page" button reads that tab's URL and asks the extension's own content script on that page for the listed experience IDs and the announced release time, to prefill the form. No other tab is accessed.
```

**Host permission: https://www.exploretock.com/\* (content scripts)**
```
The extension's purpose is booking on exploretock.com, so its content scripts run only there. content.js shows the countdown/status overlay and, at the release time, either sends Tock's own booking request on the user's behalf (using the user's existing session) or clicks through Tock's booking dialog. page-hook.js runs in the page's main world and records the request headers Tock's own page attaches to its API calls (session, CSRF and build headers), so the extension's booking request is made the same way the site's own button would make it. No data from these pages is sent anywhere except back to exploretock.com.
```

**Optional host permission: https://api.telegram.org/\*** (`optional_host_permissions` — not requested at install or update)
```
Requested at runtime, only when the user switches on Telegram notifications or presses "Send test" in the popup, and only then. With the user's own bot token and chat ID, the background service worker sends short status messages (slot held, bookings opened, monitoring started/ended) to that chat through the Telegram Bot API. Users who never enable Telegram never grant or use this permission.
```

### Remote code

```
No, I am not using remote code. All JavaScript is packaged with the extension; nothing is downloaded or evaluated at runtime.
```

### Data usage

Suggested disclosures (adjust if your interpretation differs):

- **Authentication information** — ✅ *only if the Telegram option is counted*: the user's own Telegram bot token is stored locally and sent only to api.telegram.org to deliver the user's notifications.
- **Website content** — ✅ the extension reads exploretock.com pages (experience list, release-time text) to prefill the form; used only locally.
- Everything else (personally identifiable info, health, financial/payment, personal communications, location, web history, user activity) — not collected.

Certifications (all true for this extension):
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

## Screenshots

`store/screenshot1.png` … `store/screenshot5.png` (1280×800), generated from the real popup and overlay
code by `scripts/store-screenshots.html` — see the comment at the top of that file to regenerate.
