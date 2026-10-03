#!/usr/bin/env bash
# Upload a zip to the Chrome Web Store and submit it for review (Chrome Web Store API v2).
#
#   cws-publish.sh <zip>
#
# Env (GitHub secrets — see docs/chrome-web-store-ci.md):
#   CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN, CWS_PUBLISHER_ID
#   EXTENSION_ID                 item ID of the store listing
#   CWS_AUTO_PUBLISH=false       upload only (submit manually in the dashboard)
#   CWS_API, CWS_TOKEN_URL       overrides, for testing against a mock server
#
# Skips (exit 0) when credentials aren't configured, so CI keeps working without them.
set -euo pipefail

ZIP="${1:?usage: cws-publish.sh <zip>}"
API="${CWS_API:-https://chromewebstore.googleapis.com}"
TOKEN_URL="${CWS_TOKEN_URL:-https://oauth2.googleapis.com/token}"

for var in CWS_CLIENT_ID CWS_CLIENT_SECRET CWS_REFRESH_TOKEN CWS_PUBLISHER_ID EXTENSION_ID; do
  if [ -z "${!var:-}" ]; then
    echo "::notice::$var is not set — skipping Chrome Web Store upload (see docs/chrome-web-store-ci.md)"
    exit 0
  fi
done

ITEM="publishers/${CWS_PUBLISHER_ID}/items/${EXTENSION_ID}"

# 1. Access token from the long-lived refresh token (never printed)
token_json=$(curl -sS "$TOKEN_URL" \
  --data-urlencode "client_id=${CWS_CLIENT_ID}" \
  --data-urlencode "client_secret=${CWS_CLIENT_SECRET}" \
  --data-urlencode "refresh_token=${CWS_REFRESH_TOKEN}" \
  --data-urlencode "grant_type=refresh_token")
TOKEN=$(jq -r '.access_token // empty' <<<"$token_json")
if [ -z "$TOKEN" ]; then
  echo "::error::Could not get an access token: $(jq -c '{error, error_description}' <<<"$token_json")"
  exit 1
fi
echo "::add-mask::$TOKEN"
AUTH=(-H "Authorization: Bearer ${TOKEN}")

# 2. Upload the package
echo "Uploading $ZIP to ${EXTENSION_ID}…"
upload=$(curl -sS -X POST "${AUTH[@]}" -T "$ZIP" "${API}/upload/v2/${ITEM}:upload")
state=$(jq -r '.uploadState // empty' <<<"$upload")

# Large packages are processed asynchronously: poll fetchStatus
for _ in $(seq 1 60); do
  [ "$state" = "IN_PROGRESS" ] || break
  sleep 5
  state=$(curl -sS "${AUTH[@]}" "${API}/v2/${ITEM}:fetchStatus" | jq -r '.lastAsyncUploadState // empty')
done

if [ "$state" != "SUCCEEDED" ]; then
  echo "::error::Upload failed (uploadState=${state:-none}): $(jq -c . <<<"$upload" 2>/dev/null || echo "$upload")"
  exit 1
fi
echo "Upload succeeded (version $(jq -r '.crxVersion // "?"' <<<"$upload"))"

# 3. Submit for review
if [ "${CWS_AUTO_PUBLISH:-true}" = "false" ]; then
  echo "::notice::CWS_AUTO_PUBLISH=false — uploaded as a draft; submit it in the Developer Dashboard"
  exit 0
fi
publish=$(curl -sS -X POST "${AUTH[@]}" -H "Content-Type: application/json" -d '{}' "${API}/v2/${ITEM}:publish")
pstate=$(jq -r '.state // empty' <<<"$publish")
case "$pstate" in
  PENDING_REVIEW|STAGED|PUBLISHED|PUBLISHED_TO_TESTERS)
    echo "::notice::Chrome Web Store: submitted (state=${pstate})"
    warnings=$(jq -c '.warningInfo // empty' <<<"$publish")
    [ -z "$warnings" ] || echo "::warning::Publish warnings: $warnings"
    ;;
  *)
    echo "::error::Publish failed (state=${pstate:-none}): $(jq -c . <<<"$publish" 2>/dev/null || echo "$publish")"
    exit 1
    ;;
esac
