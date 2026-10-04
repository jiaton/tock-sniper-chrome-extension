#!/usr/bin/env bash
# What's the Chrome Web Store version missing compared to GitHub? Public data only, no credentials:
# store version (shields.io), store review status (the README badge's JSON), latest release and commits
# (GitHub API, unauthenticated: 60 requests/hour).
#
#   scripts/version-diff.sh            # store vs latest release, plus unreleased commits on main
#   scripts/version-diff.sh --all      # also list every commit message, not just the first 15
#
# Needs curl and jq.
set -euo pipefail

REPO="jiaton/tock-sniper-chrome-extension"
ITEM="ppgobdppcdhckikdbajbhlmohfmhpioo"
LIMIT=15
[ "${1:-}" = "--all" ] && LIMIT=100000

get() { curl -fsSL --max-time 20 -H "Accept: application/vnd.github+json" "$@"; }

store=$(get "https://img.shields.io/chrome-web-store/v/${ITEM}.json" | jq -r '.value // .message' | sed 's/^v//')
sync=$(get "https://raw.githubusercontent.com/${REPO}/badges/store-status.json" 2>/dev/null | jq -r '.message // empty' || true)
latest=$(get "https://api.github.com/repos/${REPO}/releases/latest" | jq -r '.tag_name' | sed 's/^v//')

# Print the commits in base...head (oldest first), at most $LIMIT of them
commits() {
  local json n
  json=$(get "https://api.github.com/repos/${REPO}/compare/$1...$2")
  n=$(jq -r '.ahead_by' <<<"$json")
  jq -r --argjson limit "$LIMIT" '.commits[-$limit:][] | "  • " + (.commit.message | split("\n")[0])' <<<"$json"
  local shown=$(( n < LIMIT ? n : LIMIT ))
  [ "$n" -le "$shown" ] || echo "  … and $((n - shown)) earlier (run with --all, or open the link)"
}

echo "Chrome Web Store:   v${store}${sync:+   (store sync: ${sync})}"
echo "Latest release:     v${latest}"
echo

if [ "$store" = "$latest" ]; then
  echo "✅ The store has the latest release."
else
  ahead=$(get "https://api.github.com/repos/${REPO}/compare/v${store}...v${latest}" | jq -r '.ahead_by')
  echo "⏳ The store is behind: v${latest} has ${ahead} commit(s) not in v${store}:"
  commits "v${store}" "v${latest}"
  echo "  https://github.com/${REPO}/compare/v${store}...v${latest}"
  echo
  echo "To use v${latest} now: download tock-sniper-ext.zip from https://github.com/${REPO}/releases/latest,"
  echo "unzip it and load it via chrome://extensions → Developer mode → Load unpacked."
fi

unreleased=$(get "https://api.github.com/repos/${REPO}/compare/v${latest}...main" | jq -r '.ahead_by')
if [ "$unreleased" -gt 0 ]; then
  echo
  echo "🛠  main has ${unreleased} commit(s) not released yet (clone the repo to try them):"
  commits "v${latest}" main
  echo "  https://github.com/${REPO}/compare/v${latest}...main"
fi
