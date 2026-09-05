#!/usr/bin/env bash
# SDK bisection probe (docs/BUGS.md #0, cli/DISCREPANCIES.md #1): for each @terminal3/t3n-sdk version,
# install it alone in a temp dir and ask fetchTrustedManifest(<env>) for the verified trust anchor.
# Usage:  bash sdk-probe/run.sh [version ...]          default versions: 5.2.0 5.3.0 5.10.0
#         T3N_ENV=sandbox bash sdk-probe/run.sh 5.2.0   env defaults to testnet
# Needs node >= 20 and npm; network for the installs and one GET per version. Nothing is written into
# the repo (temp dirs are removed on exit). Exit status 1 if any version printed FAIL.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
env="${T3N_ENV:-testnet}"
[ "$#" -gt 0 ] || set -- 5.2.0 5.3.0 5.10.0

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failed=0
for v in "$@"; do
  dir="$work/sdk-$v"
  mkdir -p "$dir"
  printf '{ "name": "sdk-probe", "private": true }\n' > "$dir/package.json"
  echo "== @terminal3/t3n-sdk@$v: installing ..."
  (cd "$dir" && npm install --no-audit --no-fund --no-package-lock --loglevel=error "@terminal3/t3n-sdk@$v" > /dev/null)
  cp "$here/probe.mjs" "$dir/probe.mjs"
  node "$dir/probe.mjs" "$env" || failed=1
done
exit "$failed"
