# Chrome Web Store auto-upload (CI)

On every push to `main` that bumps `manifest.json`'s `version`, `.github/workflows/build.yml` builds the zip,
creates the GitHub release, and then runs `.github/scripts/cws-publish.sh`, which uploads the zip to the
store listing and submits it for review (Chrome Web Store API v2).

Until the four secrets below exist, that step just prints a notice and skips — CI never fails because of it.

> The API only replaces the **package**. Store listing text, screenshots and the Privacy practices tab
> (permission justifications, data usage) are still edited in the Developer Dashboard — do that first
> whenever a release adds permissions. See `store/listing.md`.

## One-time setup (~10 minutes)

Use the Google account that owns the store item.

1. **Enable the API.** In [Google Cloud console](https://console.cloud.google.com/) create (or pick) a
   project, then *APIs & Services → Library → "Chrome Web Store API" → Enable*.

2. **OAuth consent screen.** *APIs & Services → OAuth consent screen*: user type **External**, fill in the
   app name and your email. Then **publish the app ("In production")**. While it is in *Testing*, refresh
   tokens expire after 7 days and CI would start failing a week later. An unverified app is fine for
   your own use — Google shows an "unverified app" warning once, when you authorize it.

3. **OAuth client.** *APIs & Services → Credentials → Create credentials → OAuth client ID*:
   - Application type: **Web application**
   - Authorized redirect URI: `https://developers.google.com/oauthplayground`

   Note the **client ID** and **client secret**.

4. **Refresh token.** Open the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground):
   - ⚙️ (top right) → tick **Use your own OAuth credentials** → paste the client ID and secret
   - Step 1: type the scope `https://www.googleapis.com/auth/chromewebstore` → **Authorize APIs** → sign in
   - Step 2: **Exchange authorization code for tokens** → copy the **refresh token**

5. **Publisher ID.** [Developer Dashboard](https://chrome.google.com/webstore/devconsole) → *Account*
   (it's shown on the account/publisher page). Used by API v2. If it's missing or v2 denies access, the
   script logs a warning and falls back to API v1.1, which only needs the item ID.

6. **Add the secrets** (each command prompts for the value, so it never lands in your shell history —
   don't paste them anywhere else):

   ```bash
   gh secret set CWS_CLIENT_ID --repo jiaton/tock-sniper-chrome-extension
   gh secret set CWS_CLIENT_SECRET --repo jiaton/tock-sniper-chrome-extension
   gh secret set CWS_REFRESH_TOKEN --repo jiaton/tock-sniper-chrome-extension
   gh secret set CWS_PUBLISHER_ID --repo jiaton/tock-sniper-chrome-extension
   ```

   Or via *GitHub → Settings → Secrets and variables → Actions → New repository secret*.

## Options

- **Upload as a draft only** (submit manually in the dashboard):
  `gh variable set CWS_AUTO_PUBLISH --body false --repo jiaton/tock-sniper-chrome-extension`
- **Retry an upload** for a version whose tag already exists (e.g. the token had expired):
  *Actions → Build Extension ZIP → Run workflow →* tick **Upload this version to the Chrome Web Store**.

## Releasing

1. Bump `"version"` in `manifest.json` (it must be higher than the store's current version).
2. Push to `main`. CI creates the `v<version>` release, uploads it and submits it for review.
3. Watch the run's log: `::notice::Chrome Web Store: submitted (state=PENDING_REVIEW)` means it's in review.

## Store sync badge

`.github/workflows/store-status.yml` runs every 6 hours, after every build, and on demand (*Actions → Store
status → Run workflow*). It compares the store item (API v2 `fetchStatus`, read-only) with the latest GitHub
release and writes `store-status.json` to the `badges` branch, which the README's "store sync" badge reads:

| Badge | Meaning |
|---|---|
| `v3.1.0 live` (green) | The store serves the latest release |
| `v3.1.0 in review` (orange) | Submitted, waiting for review |
| `v3.1.0 approved, not published` (yellow) | Approved but staged (deferred publishing) |
| `v3.1.0 not submitted (store v2.1.0)` (red) | The store is behind and nothing is in review — check the upload step |
| `v3.1.0 rejected` / `review cancelled` (red) | See the Developer Dashboard |
| `status unavailable` (grey) | Token or API error — see the run's log |

The run's summary page also shows the published and submitted versions side by side.

## Troubleshooting

| Log message | Fix |
|---|---|
| `API v2 can't access the item … falling back to API v1.1` | Upload still works (v1.1). To use v2, fix `CWS_PUBLISHER_ID` (dashboard → Account → Publisher ID) |
| `invalid_grant … expired or revoked` | Refresh token expired (app still in *Testing*?) — publish the consent screen, redo step 4, update `CWS_REFRESH_TOKEN` |
| `version … must be greater than` | Bump `manifest.json`'s version |
| `uploadState=FAILED` | The package was rejected on upload — check the zip in the GitHub release |
| `state=REJECTED` / other publish error | Open the item in the Developer Dashboard for the reason |
