#!/usr/bin/env bash
# Compare the Chrome Web Store listing with the latest GitHub release and write a shields.io endpoint
# badge (https://shields.io/badges/endpoint-badge), e.g.
#   {"label":"store sync","message":"v3.1.0 in review","color":"orange"}
# Read-only on the store side (API v2 fetchStatus).
#
#   cws-status.sh <latest-release-version> <out.json>
#
# Env: CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN, CWS_PUBLISHER_ID, EXTENSION_ID
#      CWS_API, CWS_TOKEN_URL   overrides, for testing against a mock server
# Exit 0 with no file written when credentials aren't configured.
set -euo pipefail

RELEASE="${1:?usage: cws-status.sh <release-version> <out.json>}"
RELEASE="${RELEASE#v}"
OUT="${2:?usage: cws-status.sh <release-version> <out.json>}"
API="${CWS_API:-https://chromewebstore.googleapis.com}"
TOKEN_URL="${CWS_TOKEN_URL:-https://oauth2.googleapis.com/token}"

for var in CWS_CLIENT_ID CWS_CLIENT_SECRET CWS_REFRESH_TOKEN CWS_PUBLISHER_ID EXTENSION_ID; do
  if [ -z "${!var:-}" ]; then
    echo "::notice::$var is not set — skipping the store status check"
    exit 0
  fi
done

badge() { # message color
  jq -n --arg m "$1" --arg c "$2" '{schemaVersion: 1, label: "store sync", message: $m, color: $c, cacheSeconds: 1800}' >"$OUT"
  echo "Store status: $1"
  {
    echo "### Chrome Web Store vs GitHub release"
    echo
    echo "| | Version | State |"
    echo "|---|---|---|"
    echo "| GitHub release | v${RELEASE} | |"
    echo "| Store, published | v${PUBLISHED:--} | ${PUB_STATE:--} |"
    echo "| Store, submitted | v${SUBMITTED:--} | ${SUB_STATE:--} |"
    echo
    echo "**${1}**"
  } >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
}

token_json=$(curl -sS "$TOKEN_URL" \
  --data-urlencode "client_id=${CWS_CLIENT_ID}" \
  --data-urlencode "client_secret=${CWS_CLIENT_SECRET}" \
  --data-urlencode "refresh_token=${CWS_REFRESH_TOKEN}" \
  --data-urlencode "grant_type=refresh_token")
TOKEN=$(jq -r '.access_token // empty' <<<"$token_json")
if [ -z "$TOKEN" ]; then
  echo "::warning::Could not get an access token: $(jq -c '{error, error_description}' <<<"$token_json")"
  badge "status unavailable" lightgrey
  exit 0
fi
echo "::add-mask::$TOKEN"

status=$(curl -sS -H "Authorization: Bearer ${TOKEN}" \
  "${API}/v2/publishers/${CWS_PUBLISHER_ID}/items/${EXTENSION_ID}:fetchStatus")
if [ -n "$(jq -r '.error.message // empty' <<<"$status")" ]; then
  echo "::warning::fetchStatus failed: $(jq -r '.error.message' <<<"$status")"
  badge "status unavailable" lightgrey
  exit 0
fi

PUBLISHED=$(jq -r '.publishedItemRevisionStatus.distributionChannels[0].crxVersion // empty' <<<"$status")
PUB_STATE=$(jq -r '.publishedItemRevisionStatus.state // empty' <<<"$status")
SUBMITTED=$(jq -r '.submittedItemRevisionStatus.distributionChannels[0].crxVersion // empty' <<<"$status")
SUB_STATE=$(jq -r '.submittedItemRevisionStatus.state // empty' <<<"$status")

if [ "$PUBLISHED" = "$RELEASE" ]; then
  badge "v${RELEASE} live" brightgreen
elif [ "$SUBMITTED" = "$RELEASE" ]; then
  case "$SUB_STATE" in
    PENDING_REVIEW) badge "v${RELEASE} in review" orange ;;
    STAGED)         badge "v${RELEASE} approved, not published" yellow ;;
    REJECTED)       badge "v${RELEASE} rejected" red ;;
    CANCELLED)      badge "v${RELEASE} review cancelled" red ;;
    *)              badge "v${RELEASE} ${SUB_STATE:-submitted}" orange ;;
  esac
else
  badge "v${RELEASE} not submitted (store v${PUBLISHED:-?})" red
fi
