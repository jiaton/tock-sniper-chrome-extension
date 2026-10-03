#!/usr/bin/env bash
# Upload a zip to the Chrome Web Store and submit it for review.
# Uses Chrome Web Store API v2; falls back to v1.1 when v2 denies access (e.g. a wrong or missing
# CWS_PUBLISHER_ID — v1.1 doesn't need one).
#
#   cws-publish.sh <zip>
#
# Env (GitHub secrets — see docs/chrome-web-store-ci.md):
#   CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN, CWS_PUBLISHER_ID (optional: v1.1 without it)
#   EXTENSION_ID                 item ID of the store listing
#   CWS_AUTO_PUBLISH=false       upload only (submit manually in the dashboard)
#   CWS_API, CWS_API_V1, CWS_TOKEN_URL   overrides, for testing against a mock server
#
# Skips (exit 0) when credentials aren't configured, so CI keeps working without them.
set -euo pipefail

ZIP="${1:?usage: cws-publish.sh <zip>}"
API="${CWS_API:-https://chromewebstore.googleapis.com}"
API_V1="${CWS_API_V1:-https://www.googleapis.com}"
TOKEN_URL="${CWS_TOKEN_URL:-https://oauth2.googleapis.com/token}"

for var in CWS_CLIENT_ID CWS_CLIENT_SECRET CWS_REFRESH_TOKEN EXTENSION_ID; do
  if [ -z "${!var:-}" ]; then
    echo "::notice::$var is not set — skipping Chrome Web Store upload (see docs/chrome-web-store-ci.md)"
    exit 0
  fi
done


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

# 2. Pick the API: v2 if it lets us see the item (read-only probe), else v1.1
use_v2=false
if [ -n "${CWS_PUBLISHER_ID:-}" ]; then
  ITEM="publishers/${CWS_PUBLISHER_ID}/items/${EXTENSION_ID}"
  probe=$(curl -sS "${AUTH[@]}" "${API}/v2/${ITEM}:fetchStatus")
  if [ -n "$(jq -r '.itemId // empty' <<<"$probe")" ]; then
    use_v2=true
  else
    echo "::warning::API v2 can't access the item ($(jq -r '.error.message // "no itemId"' <<<"$probe")) — check CWS_PUBLISHER_ID; falling back to API v1.1"
  fi
fi

if $use_v2; then
  upload_url="${API}/upload/v2/${ITEM}:upload";      upload_method=POST
  status_url="${API}/v2/${ITEM}:fetchStatus";        status_field=lastAsyncUploadState
  publish_url="${API}/v2/${ITEM}:publish"
  OK_UPLOAD=SUCCEEDED; FAILED_UPLOAD=FAILED
else
  V1_HEADER=(-H "x-goog-api-version: 2")
  AUTH+=("${V1_HEADER[@]}")
  upload_url="${API_V1}/upload/chromewebstore/v1.1/items/${EXTENSION_ID}"; upload_method=PUT
  status_url="${API_V1}/chromewebstore/v1.1/items/${EXTENSION_ID}?projection=DRAFT"; status_field=uploadState
  publish_url="${API_V1}/chromewebstore/v1.1/items/${EXTENSION_ID}/publish"
  OK_UPLOAD=SUCCESS; FAILED_UPLOAD=FAILURE
fi

# 3. Upload the package
echo "Uploading $ZIP to ${EXTENSION_ID} (API $($use_v2 && echo v2 || echo v1.1))…"
upload=$(curl -sS -X "$upload_method" "${AUTH[@]}" -T "$ZIP" "$upload_url")
state=$(jq -r '.uploadState // empty' <<<"$upload")

# Large packages are processed asynchronously: poll the status
for _ in $(seq 1 60); do
  [ "$state" = "IN_PROGRESS" ] || break
  sleep 5
  state=$(curl -sS "${AUTH[@]}" "$status_url" | jq -r ".${status_field} // empty")
done

if [ "$state" != "$OK_UPLOAD" ]; then
  echo "::error::Upload failed (uploadState=${state:-none}): $(jq -c . <<<"$upload" 2>/dev/null || echo "$upload")"
  exit 1
fi
echo "Upload succeeded (version $(jq -r '.crxVersion // "?"' <<<"$upload"))"

# 4. Submit for review
if [ "${CWS_AUTO_PUBLISH:-true}" = "false" ]; then
  echo "::notice::CWS_AUTO_PUBLISH=false — uploaded as a draft; submit it in the Developer Dashboard"
  exit 0
fi
if $use_v2; then
  publish=$(curl -sS -X POST "${AUTH[@]}" -H "Content-Type: application/json" -d '{}' "$publish_url")
  pstate=$(jq -r '.state // empty' <<<"$publish")
  case "$pstate" in
    PENDING_REVIEW|STAGED|PUBLISHED|PUBLISHED_TO_TESTERS) ok=true ;;
    *) ok=false ;;
  esac
  warnings=$(jq -c '.warningInfo // empty' <<<"$publish")
else
  publish=$(curl -sS -X POST "${AUTH[@]}" -H "Content-Length: 0" "$publish_url")
  pstate=$(jq -r '(.status // []) | join(",")' <<<"$publish")
  [ "$pstate" = "OK" ] && ok=true || ok=false
  warnings=$(jq -c '.statusDetail // empty' <<<"$publish")
fi
if $ok; then
  echo "::notice::Chrome Web Store: submitted (state=${pstate})"
  [ -z "$warnings" ] || [ "$warnings" = '[""]' ] || echo "Publish details: $warnings"
else
  echo "::error::Publish failed (state=${pstate:-none}): $(jq -c . <<<"$publish" 2>/dev/null || echo "$publish")"
  exit 1
fi
