#!/usr/bin/env bash
# What's the Chrome Web Store version missing compared to the latest GitHub release?
#
#   scripts/version-diff.sh              # terminal report (also lists unreleased commits on main)
#   scripts/version-diff.sh --markdown   # README block (store-status.yml writes it between the
#                                        # <!-- store-diff:start/end --> markers in README.md)
#
# Public data by default: store version from shields.io, review status from the badge JSON on the
# `badges` branch, releases and commits from the GitHub API (unauthenticated: 60 requests/hour).
# Env overrides (CI): STORE_VERSION (e.g. from the store API), STORE_SYNC (badge message),
# GH_TOKEN (GitHub API auth). Needs curl and jq.
set -euo pipefail

REPO="jiaton/tock-sniper-chrome-extension"
ITEM="ppgobdppcdhckikdbajbhlmohfmhpioo"
MODE="${1:-}"
MAX=12
# Commits that don't change the extension for users
SKIP='^(CI|Docs|README|Add README|Add store listing|Merge )'

auth=()
[ -n "${GH_TOKEN:-}" ] && auth=(-H "Authorization: Bearer ${GH_TOKEN}")
get() { curl -fsSL --max-time 20 -H "Accept: application/vnd.github+json" ${auth[@]+"${auth[@]}"} "$@"; }

store="${STORE_VERSION:-$(get "https://img.shields.io/chrome-web-store/v/${ITEM}.json" | jq -r '.value // .message')}"
store="${store#v}"
sync="${STORE_SYNC-$(get "https://raw.githubusercontent.com/${REPO}/badges/store-status.json" 2>/dev/null | jq -r '.message // empty' || true)}"
latest=$(get "https://api.github.com/repos/${REPO}/releases/latest" | jq -r '.tag_name')
latest="${latest#v}"

# User-facing commit subjects in base...head, oldest first
changes() {
  get "https://api.github.com/repos/${REPO}/compare/$1...$2" \
    | jq -r --arg skip "$SKIP" '.commits[] | .commit.message | split("\n")[0] | select(test($skip) | not)'
}

if [ "$MODE" = "--markdown" ]; then
  if [ "$store" = "$latest" ]; then
    echo "✅ **The Chrome Web Store has the latest release, v${latest}.**"
  else
    list=()  # (no mapfile: macOS ships bash 3.2)
    while IFS= read -r line; do list+=("$line"); done < <(changes "v${store}" "v${latest}")
    echo "⏳ **Chrome Web Store: v${store} · latest release: v${latest}**${sync:+ (${sync})}"
    echo
    echo "<details><summary>Not in the store version yet (${#list[@]} change$([ ${#list[@]} -ne 1 ] && echo s))</summary>"
    echo
    start=$(( ${#list[@]} > MAX ? ${#list[@]} - MAX : 0 ))
    for (( i = start; i < ${#list[@]}; i++ )); do echo "- ${list[$i]}"; done
    [ ${#list[@]} -le $MAX ] || echo "- … and $(( ${#list[@]} - MAX )) earlier"
    echo
    echo "[Full comparison](https://github.com/${REPO}/compare/v${store}...v${latest}) · get v${latest} now: [manual install](#manual--developer)"
    echo
    echo "</details>"
  fi
  exit 0
fi

echo "Chrome Web Store:   v${store}${sync:+   (store sync: ${sync})}"
echo "Latest release:     v${latest}"
echo
if [ "$store" = "$latest" ]; then
  echo "✅ The store has the latest release."
else
  echo "⏳ The store is behind. In v${latest}, not in v${store}:"
  changes "v${store}" "v${latest}" | sed 's/^/  • /'
  echo "  https://github.com/${REPO}/compare/v${store}...v${latest}"
fi
unreleased=$(changes "v${latest}" main)
if [ -n "$unreleased" ]; then
  echo
  echo "🛠  On main, not released yet:"
  sed 's/^/  • /' <<<"$unreleased"
fi
