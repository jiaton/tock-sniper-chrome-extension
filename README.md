# 🎯 Tock Sniper

Auto-grab reservations on [Tock](https://www.exploretock.com) the instant they drop.

> **Unofficial.** Tock Sniper is an independent open-source project. It is not affiliated with, endorsed by,
> or sponsored by Tock, Resy, or American Express. "Tock" is used only to describe the site this extension
> works with.

[Chrome Web Store](https://chromewebstore.google.com/detail/tock-sniper/ppgobdppcdhckikdbajbhlmohfmhpioo) · [Releases](../../releases)

## How It Works

1. **Set your target** — restaurant URL (or open the restaurant and click **Use this page**), party size, dates and times
2. **Set the release time** — prefilled from the page when it says when reservations open
3. **Arm the sniper** — opens one tab per date × time (two with **Both** mode)
4. **At release** each tab races, in its mode:
   - **⚡ API** — sends Tock's lock request directly, densest right at the release moment (5ms apart within ±40ms, ~42 requests over 3s), then jumps to checkout
   - **🖱️ DOM** — reloads 800ms early and clicks through the booking dialog; reloads again if the page shows no availability
5. **Complete payment** on whichever tab reaches checkout ✅

## Features

- **API direct locking** — no page reload; first successful lock wins
- **Experience ID auto-detect** — reads Tock's experience list at release, so a stale/seasonal ID is corrected (or pick **Manual only** for the fastest path)
- **Rate-limit aware** — stops at the first 429 and on sold-out (410) responses; a tab opened long after release sends a single attempt instead of a burst
- **Monitor** *(optional)* — if nothing gets booked (release delayed, sold out), keeps checking whether the restaurant has opened and locks the slot when it does
- **Telegram notifications** *(optional)* — when a slot is locked, bookings open, or monitoring starts/ends (once per restaurant, not per tab)
- **Use this page** — fills the URL, lists the page's experience IDs, and offers to prefill the release time
- **Live overlay** — draggable status window with countdown, request counts and errors

## Install

### From Chrome Web Store
[Tock Sniper on the Chrome Web Store](https://chromewebstore.google.com/detail/tock-sniper/ppgobdppcdhckikdbajbhlmohfmhpioo)

### Manual / Developer
1. Clone this repo (or download the zip from [Releases](../../releases))
2. Go to `chrome://extensions`
3. Enable "Developer mode"
4. Click "Load unpacked" → select this folder

After updating, click the reload icon on the extension card and reload any open Tock tabs.

## Usage

1. Click the extension icon
2. Enter the Tock restaurant URL (e.g. `https://www.exploretock.com/restaurant-name`), or open the restaurant page and click **Use this page**
3. Experience ID: pick one from the detected list, type it, or leave it empty and choose **Auto only**
4. Set party size and release time
5. Add target dates and times
6. Choose a mode (**API** recommended) and, optionally, open **Monitor & notifications**
7. Click **Arm Sniper**
8. Complete payment on whichever tab reaches checkout first ✅

### Telegram notifications
Create a bot with [@BotFather](https://t.me/BotFather), get your chat ID (e.g. from [@userinfobot](https://t.me/userinfobot)),
enter both under **Monitor & notifications**, and click **Send test**. Chrome asks once for permission to reach
`api.telegram.org` — it's optional and only requested when you switch Telegram on. The token is stored only in
your browser.

## How Tock Releases Work

Most Tock restaurants release reservations on a schedule (e.g. every Friday at a set time). The page usually says
when ("New reservations will be released on …"). Some restaurants instead release at random to their Notify waitlist —
no tool can race those.

## Use responsibly

- **Check Tock's Terms of Service** before using this. Automated booking may be against them, and Tock can
  rate-limit or restrict accounts — lock requests were observed to stay rate-limited for ~30 minutes after a burst.
- It books only for you, with your own logged-in session, and **never pays** — you complete checkout yourself.
  Don't use it to resell reservations.
- It talks to Tock's private web API, which can change at any time and break things without notice.
- **Use at your own risk.** No warranty — see the license.

## Privacy

No analytics, no developer server. Settings (including an optional Telegram bot token) live in
`chrome.storage.local` in your browser. The extension talks only to exploretock.com (your own session) and,
if you enable it, api.telegram.org (your own bot).

## License

[MIT](LICENSE)
