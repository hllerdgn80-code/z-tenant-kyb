#!/usr/bin/env bash
# Version drift check. The contract version is written in four places and must agree:
#   Cargo.toml        [package] version
#   src/lib.rs        pub const CONTRACT_VERSION
#   wit/world.wit     package z:tenant-kyb@<version>
#   cli/src/env.ts    CONTRACT_VERSION default  (optional("CONTRACT_VERSION") ?? "<version>")
# Usage: bash scripts/check-versions.sh   (from any directory). Exit 1 and name the odd one out on drift.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo=$(sed -n 's/^version = "\([^"]*\)".*/\1/p' Cargo.toml | head -n 1)
lib=$(sed -n 's/^pub const CONTRACT_VERSION: &str = "\([^"]*\)";.*/\1/p' src/lib.rs | head -n 1)
wit=$(sed -n 's/^package z:tenant-kyb@\([^;]*\);.*/\1/p' wit/world.wit | head -n 1)
cli=$(sed -n 's/.*optional("CONTRACT_VERSION") ?? "\([^"]*\)".*/\1/p' cli/src/env.ts | head -n 1)

status=0
for pair in "Cargo.toml=$cargo" "src/lib.rs=$lib" "wit/world.wit=$wit" "cli/src/env.ts=$cli"; do
  file=${pair%%=*}
  v=${pair#*=}
  printf '  %-16s %s\n' "$file" "${v:-<none>}"
  [ -n "$v" ] || status=1
done

if [ "$status" -eq 0 ] && [ "$cargo" = "$lib" ] && [ "$cargo" = "$wit" ] && [ "$cargo" = "$cli" ]; then
  echo "check-versions: OK - all four say $cargo"
else
  echo "check-versions: FAIL - the four versions above must be identical (bump them together)" >&2
  exit 1
fi
