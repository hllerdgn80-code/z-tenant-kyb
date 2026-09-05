# z-tenant-kyb developer shortcuts. Needs `just` (https://github.com/casey/just); every recipe body is
# plain shell, so without `just` copy the lines out and run them from the repo root.
#   just test            native unit tests on this machine's host triple (from `rustc -vV`)
#   just build           release wasm32-wasip2 component + wasm-tools validate
#   just wit             print the built component's WIT
#   just cli-typecheck   tsc --noEmit in cli/
#   just cli-test        vitest unit tests in cli/
#   just doctor          offline `kyb doctor` (no keys, no network)
#   just versions        Cargo.toml = src/lib.rs = wit/world.wit = CLI default (scripts/check-versions.sh)
#   just all             everything above, in CI order

set shell := ["bash", "-euo", "pipefail", "-c"]

wasm := "target/wasm32-wasip2/release/z_tenant_kyb.wasm"

default:
    @just --list

# Native unit tests (parsers, PII guard, risk scoring) on the host triple, not the wasm default target.
test:
    cargo test --target "$(rustc -vV | sed -n 's/^host: //p')" --lib

# Release wasm32-wasip2 component, validated.
build:
    cargo build --target wasm32-wasip2 --release
    wasm-tools validate {{wasm}}
    ls -l {{wasm}}

# Print the built component's WIT (imports + the contracts export).
wit: build
    wasm-tools component wit {{wasm}}

# TypeScript typecheck of the operator CLI (includes the test files).
cli-typecheck:
    cd cli && npm run typecheck

# CLI unit tests (vitest): key classification, redaction, ERP host guard, error hints.
cli-test:
    cd cli && npm test

# Offline doctor: SDK present, component readable, config sane; every network check skipped.
doctor:
    cd cli && npm run -s kyb -- doctor --offline

# The version string must be identical in Cargo.toml, src/lib.rs, wit/world.wit and cli/src/env.ts.
versions:
    bash scripts/check-versions.sh

# Everything, in the order CI runs it.
all: versions test build cli-typecheck cli-test doctor
