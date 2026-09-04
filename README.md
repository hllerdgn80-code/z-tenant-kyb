# z-tenant-kyb

Vendor KYB (Know Your Business) onboarding agent for T3N tenants. A Rust TEE contract
(WASM component) plus a small operator CLI that lets a procurement team screen a supplier
against two public company registers and register it in their ERP -- without the agent,
the contract, or the tenant's own servers ever holding the signatory's personal data.

Built for the Superteam Earn bounty "Try out new docs to build a trusted agent with T3N".
Repo: <https://github.com/hllerdgn80-code/z-tenant-kyb>

## Why this is useful

Enterprise procurement onboards suppliers every day. The check itself is boring but
regulated: is the VAT number real, is the legal entity active, does the name match, who
signs. Today that data sits in spreadsheets and e-mail. This contract moves it into a TEE:

- **Screening uses only free, key-less public registers** -- EU VIES (VAT) and GLEIF
  (LEI). No third-party API key to buy, rotate or leak.
- **The signatory's identity is never an input.** The ERP request carries
  `{{profile.first_name}}` / `{{profile.last_name}}` markers that the T3N host resolves
  inside the enclave from the calling user's verified profile. The signatory's plaintext
  PII never enters WASM memory, the logs, or the caller's response. (What `screen-vendor`
  does return is the registers' data about the *company* -- VIES `name` / `address`;
  for a sole trader that is a natural person's name and business address, so treat the
  response like any other register extract.)
- **Person-level key names are rejected at parse time.** Any key that normalises to a
  well-known person field (`firstName`, `date_of_birth`, `passportNo`, `iban`, ...) or
  contains `email`, `phone`, `passport`, `birth` or `iban`, anywhere in the input, is an
  error. Only key names are checked -- values are not inspected -- so keep `notes`,
  `vendor_id` and `screening_ref` free of personal data.
- **The ERP secret lives in the tenant's sealed `z:<tid>:secrets` map**, seeded by the
  operator, readable only by this contract.

## Architecture

```
                 operator laptop                              T3N cluster (TDX enclave)
 +---------------------------------+                +---------------------------------------+
 | kyb CLI (TypeScript, tsx)       |                |  z:<tid>:kyb   (this contract, WASM)  |
 |  doctor / deploy / authorize    |   tenant SDK   |                                       |
 |  screen / onboard / logs / audit| -------------> |  screen-vendor ----http---------------+---> ec.europa.eu  (VIES)
 |                                 |                |     |  company ids only               |     api.gleif.org (GLEIF)
 |  T3N_API_KEY  (tenant)          |                |     v                                 |
 |  AGENT_KEY    (agent DID)       |                |  risk_flags[] -> caller               |
 |  USER_KEY     (data owner)      |                |                                       |
 +---------------------------------+                |  submit-onboarding                    |
                                                    |     reads z:<tid>:secrets             |
   data owner grants the agent                      |       erp_onboarding_url, erp_api_key |
   (agent-auth-update):                             |     body = { signatory: {             |
     scriptName  z:<tid>:kyb                        |       first_name: {{profile.first_name}},
     functions   [screen-vendor, submit-onboarding] |       last_name:  {{profile.last_name}} } }
     allowedHosts[ec.europa.eu, api.gleif.org, <erp>]|     ---http-with-placeholders-------+---> ERP endpoint
                                                    |       host substitutes PII here,      |
                                                    |       contract only sees the markers  |
                                                    +---------------------------------------+
```

Two host HTTP interfaces are used on purpose: plain `http` for the register lookups (no
PII can be in the request by construction) and `http-with-placeholders` for the single
call that needs the signatory's name.

## Contract functions

Both functions take the standard `generic-input` envelope (`input` = UTF-8 JSON bytes) and
return UTF-8 JSON bytes or an error string. See `wit/world.wit`.

| Function | Input (JSON) | Output (JSON) | Errors (string) |
|---|---|---|---|
| `screen-vendor` | `country_code` (VIES member: EU alpha-2, `EL` for Greece, `XI` for N. Ireland), `vat_number` (spaces/dots/dashes and a country prefix are stripped; 2-15 chars after cleaning), `lei?` (20 alphanumerics), `legal_name?` | `contract_version`, `country_code`, `vat_number`, `vat { checked, valid, name, address, request_date, error }`, `lei { checked, found, lei, legal_name, entity_status, registration_status, country, error }`, `risk_flags[]`, `screened_at` (cluster seconds) | missing input, bad JSON, non-object, inline PII field, non-VIES country, bad VAT length, bad LEI shape |
| `submit-onboarding` | `vendor_id` (1-128 chars), `screening_ref` (1-256 chars; the reference you keep for the screen-vendor result), `include_email?` (bool, default false), `notes?` (trimmed to 1000 chars) | `status: "submitted"`, `erp_reference`, `http_code` | missing input, inline PII field, `erp_onboarding_url` not seeded, typed `http-with-placeholders` errors (egress denied, placeholder denied/unknown, no user context, upstream), `ERP onboarding failed: HTTP <code>` for non-2xx |

Lookup order in `screen-vendor`: VIES first; then GLEIF by `lei` if given, otherwise by
`legal_name` if given, otherwise by the name VIES returned. If none of those exist the LEI
block comes back `checked: false`.

### Risk flags

| Flag | Meaning |
|---|---|
| `VAT_CHECK_UNAVAILABLE` | VIES returned a transport error, a non-200, or a `userError` other than VALID/INVALID (e.g. `MS_UNAVAILABLE`). Retry later; the VAT was not judged. |
| `VAT_INVALID` | VIES answered and the VAT number is not valid. |
| `LEI_CHECK_UNAVAILABLE` | GLEIF transport/HTTP/parse error. |
| `LEI_NOT_FOUND` | GLEIF answered 404 or an empty list. |
| `LEI_NOT_ISSUED` | LEI exists but `registration.status` is not `ISSUED` (LAPSED, RETIRED, ...). |
| `ENTITY_NOT_ACTIVE` | LEI record's `entity.status` is not `ACTIVE`. |
| `COUNTRY_MISMATCH` | GLEIF legal-address country differs from the VIES country (EL->GR and XI->GB are mapped). |
| `NAME_MISMATCH` | Claimed name (input or VIES name) does not match the GLEIF name, or the input name does not match the VIES name, after suffix/case normalisation. |

An empty `risk_flags` array means both registers answered and everything agreed.

### ERP request body (what your ERP receives)

```json
{
  "source": "t3n:z-tenant-kyb",
  "contract_version": "0.1.0",
  "vendor_id": "V-1",
  "screening_ref": "scr-9",
  "signatory": {
    "first_name": "{{profile.first_name}}",
    "last_name": "{{profile.last_name}}",
    "role": "authorised_signatory",
    "email": "{{profile.verified_contacts.email.value}}"
  },
  "notes": null,
  "submitted_at": 1700000000
}
```

The `email` line is present only when `include_email: true` (see Maintenance notes for
why). Markers are replaced by the host before the request leaves the enclave. Headers:
`Accept: application/json` and, if `erp_api_key` is set, `Authorization: Bearer <key>`.

## Privacy model

1. **PII guard on input (key names only).** `common::parse_input` walks the whole JSON
   tree (objects and arrays). A key is rejected when its normalised form (lower-case with
   `_`, `-`, spaces and dots removed, so `firstName` == `first_name`) is in `PII_KEYS`
   (first/last/given/family/middle/full/signatory name, mobile, date of birth, SSN,
   national id, home address) or contains one of `PII_FRAGMENTS` (`email`, `phone`,
   `passport`, `birth`, `iban`); `include_email` is the one allow-listed flag. The error
   names the offending path (`signatory.email`). Values are never inspected: a free-text
   `notes` field can still carry personal data if the caller puts it there, so the guard
   is a seatbelt against misrouted fields, not a content filter.
2. **Placeholders, not values.** The signatory's identity reaches the ERP only through
   `{{profile.*}}` markers resolved by `host:interfaces/http-with-placeholders`. The
   contract's own tests assert the body contains only unresolved markers.
3. **No echo of the ERP body.** The ERP response may contain the resolved name. The
   contract extracts a reference (`id`, `reference`, `erp_reference`, `ticket`,
   `request_id`, or an `X-Amzn-Trace-Id` echo header) and otherwise returns `http-<code>`.
   On non-2xx only the status code is logged and returned.
4. **Logs carry company identifiers only** (country + VAT number, validity, GLEIF status,
   vendor id, screening ref, the `include_email` bool). A test asserts that the
   `screen-vendor` output never contains a PII key.
5. **Secrets map.** `erp_onboarding_url` (required) and `erp_api_key` (optional) are read
   from `z:<tid>:secrets` via `kv-store::get`; the map name is built from
   `tenant-context::tenant-did()` (hex-encoded). The contract never writes to it.
6. **Egress is user-granted.** The data owner's `agent-auth-update` grant lists the
   allowed hosts; without it the outbound call is denied inside the enclave.
7. **What the CLI prints.** No command prints key material (`describeSecret` masks, and
   `redact()` scrubs every configured secret from error output). The one deliberate
   exception is `kyb audit`, which prints your *own* host-stamped audit trail; its
   events carry action/target details by design.

## Capability set = WIT imports

There is no manifest. The contract's capabilities are exactly the imports in
`wit/world.wit`:

| Import | Used by | Purpose |
|---|---|---|
| `host:tenant/tenant-context@1.0.0` | both | `tenant-did()` for the secrets map name, `cluster-timestamp-secs()` |
| `host:interfaces/logging@2.1.0` | both | `info` / `error` lines (no PII) |
| `host:interfaces/kv-store@2.1.0` | `submit-onboarding` | `get` on `z:<tid>:secrets` |
| `host:interfaces/http@2.1.0` | `screen-vendor` | VIES + GLEIF lookups |
| `host:interfaces/http-with-placeholders@2.1.0` | `submit-onboarding` | ERP POST with `{{profile.*}}` markers |

The compiled component additionally imports `wasi:io/*`, `wasi:clocks/monotonic-clock`
and `wasi:cli/*` at `0.2.9`. These come from the Rust standard library on the
`wasm32-wasip2` target (the reference contract `z-tenant-flight` is built the same way),
not from anything the contract calls. Whether the node links or stubs them is not stated
in the ADK docs -- see `docs/BUGS.md`.

## Build and test

Toolchain used: Rust 1.98 with the `wasm32-wasip2` target, `wasm-tools` 1.258,
Node 26 / npm 11 for the CLI. `.cargo/config.toml` sets the default build target to
`wasm32-wasip2`, so native tests must name the host target explicitly.

```bash
rustup target add wasm32-wasip2
cargo install wasm-tools            # optional, for inspection

# 19 native unit tests (parsers, PII guard, risk scoring, body building)
cargo test --target x86_64-apple-darwin --lib          # macOS Intel/Rosetta
# cargo test --target aarch64-apple-darwin --lib       # macOS Apple Silicon
# cargo test --target x86_64-unknown-linux-gnu --lib   # Linux

# WASM component (~154 KB)
cargo build --target wasm32-wasip2 --release
ls -la target/wasm32-wasip2/release/z_tenant_kyb.wasm

# Inspect the component's imports/exports
wasm-tools validate target/wasm32-wasip2/release/z_tenant_kyb.wasm
wasm-tools component wit target/wasm32-wasip2/release/z_tenant_kyb.wasm

# Optional lint: src/lib.rs enables clippy::style warnings, which only fire when clippy is installed
rustup component add clippy && cargo clippy --target x86_64-apple-darwin --lib
```

Everything network-facing is behind `#[cfg(target_arch = "wasm32")]`; the pure parts
(`parse_request`, `parse_vies`, `parse_gleif`, `risk_flags`, `build_erp_body`,
`extract_reference`) are what the native tests cover.

## Deploy and run (CLI)

The operator CLI lives in `cli/` -- see [`cli/README.md`](cli/README.md) for the exact
flags. It wraps `@terminal3/t3n-sdk` and follows the ADK quickstart flow
(`setEnvironment` -> `loadWasmComponent` -> `T3nClient` + `fetchTrustedManifest` ->
`handshake` -> `authenticate` -> `TenantClient`).

| Command | What it does |
|---|---|
| `doctor` | Checks toolchain, env vars (masked), the built `.wasm`, SDK version; online it also probes VIES, GLEIF, the node and the served trust manifest and opens a session per configured key. `--offline` skips every network check. |
| `deploy` | Registers the WASM as `z:<tid>:kyb` at `CONTRACT_VERSION` (default `0.1.0`; must equal `CONTRACT_VERSION` in `src/lib.rs`), then creates the `secrets` map (readers/writers = the returned contract id) and seeds `erp_onboarding_url` / `erp_api_key`. Refuses to run live without `ERP_ONBOARDING_URL`. |
| `authorize` | As the data owner (`USER_KEY`), grants the agent DID `screen-vendor` + `submit-onboarding` on `z:<tid>:kyb` with `allowedHosts` = `ec.europa.eu`, `api.gleif.org`, and the ERP host. |
| `screen` | As the agent (`AGENT_KEY`), calls `screen-vendor` and prints the JSON result. |
| `onboard` | As the agent, calls `submit-onboarding` with a `vendor_id` and `screening_ref`. |
| `logs` | Reads the contract's log ring via `contracts.logs`. |
| `audit` | Reads the caller's audit trail via `getAuditEvents`. |

Environment variables (never printed by the CLI):

| Variable | Who | Purpose |
|---|---|---|
| `T3N_API_KEY` | tenant | Your tenant key from the claim page (shown once). Used by `deploy`, `logs`. |
| `AGENT_KEY` | agent | A separate key with its own DID and test credits. Used by `screen`, `onboard`, `audit`. |
| `USER_KEY` | data owner | The signatory's own key. Used by `authorize` (signs the grant). |
| `ERP_ONBOARDING_URL` | tenant | Full URL the onboarding POST goes to. Seeded into the secrets map by `deploy`. Required for a live `deploy` / `authorize`; only `--dry-run` and `doctor` fall back to the demo echo `https://httpbin.org/post`. |
| `ERP_API_KEY` | tenant | Optional bearer token for that URL. Seeded by `deploy`, which refuses it together with an httpbin.org URL (the token would go to a public echo service). |

`deploy`, `authorize`, `screen` and `onboard` have `--dry-run`, which builds and prints the
exact request they would send (with secrets masked) without contacting the node; `logs` and
`audit` are read-only and have none. Testnet compatibility with the
latest SDK was uncertain during the bounty window; all network failures are surfaced with
the node's `detail` string and a hint from the ADK "Common errors" page.

Example session:

```bash
export T3N_API_KEY=... AGENT_KEY=... USER_KEY=...
export ERP_ONBOARDING_URL=https://httpbin.org/post     # demo: any JSON-accepting endpoint (leave ERP_API_KEY unset for it)
cd cli && npm install
npx tsx src/index.ts doctor
npx tsx src/index.ts deploy
npx tsx src/index.ts authorize
npx tsx src/index.ts screen --country IE --vat 6388047V --name "Google Ireland Limited"
npx tsx src/index.ts onboard --vendor-id V-1 --screening-ref scr-9
npx tsx src/index.ts logs
```

## Maintenance notes

- **No third-party API keys.** VIES (`ec.europa.eu/taxation_customs/vies/rest-api`) and
  GLEIF (`api.gleif.org/api/v1`) are public and unauthenticated. There is nothing to
  rotate on the screening side. VIES is known to be flaky per member state; that shows up
  as `VAT_CHECK_UNAVAILABLE`, not as an error, so callers can retry.
- **Pointing at a real ERP.** Change only the two secrets: `erp_onboarding_url` (and
  `erp_api_key` if the ERP wants a bearer token). Re-run `deploy` (or
  `tenant.maps.entrySet("secrets", ...)`). Then add the ERP host to the user grant's
  `allowedHosts` (`authorize`). If the ERP wants a different body shape, edit
  `onboard::build_erp_body` -- it is a pure function with a unit test.
- **GLEIF name search takes the first match** (`page[size]=1`). Pass `lei` when you have
  it for an exact lookup.
- **Email marker is opt-in.** The ADK's flagship example uses the nested marker
  `{{profile.verified_contacts.email.value}}`, but the host WIT in `wit/deps` says nested
  markers are rejected with `placeholder-denied`. Until that is settled, pass
  `include_email: true` only if your node accepts it.
- **Version bumps.** Bump `CONTRACT_VERSION` in `src/lib.rs`, `version` in `Cargo.toml`
  and the package version in `wit/world.wit` together; the node refuses a re-register
  whose version is not higher than the deployed one. `contracts.register` returns a
  `contract_id`; the `secrets` map ACL and the user grant (`versionReq`) reference the
  contract, so after a bump re-check both (`tenant.maps.update`, `authorize`) before
  calling `submit-onboarding`.
- **Adding a register.** Add a pure `parse_*` function with a fixture test in
  `screen.rs`, call it from `screen_vendor_wasm`, and extend `risk_flags`. Keep the
  request free of person fields so it stays on plain `http`.
- **Logs are off by default on the node** (`log_max_entries` quota); ask the operator to
  enable them before relying on `logs`.

## Repository layout

```
Cargo.toml / .cargo/config.toml   crate + default target wasm32-wasip2
wit/world.wit                     the contract's world (capability set)
wit/deps/                         host interface packages (copied from the reference contract)
src/lib.rs                        wit-bindgen glue + export
src/common.rs                     PII guard, name normalisation, VAT/LEI helpers
src/screen.rs                     screen-vendor (VIES + GLEIF)
src/onboard.rs                    submit-onboarding (placeholders + secrets)
cli/                              operator CLI (TypeScript)
docs/HANDOVER.md                  how Terminal 3 can host and maintain this
docs/BUGS.md                      documentation / SDK issues found while building
docs/SUBMISSION.md                bounty submission text
docs/X_POST.md                    announcement thread
```

## License

MIT -- see [`LICENSE`](LICENSE). Copyright (c) 2026 the z-tenant-kyb contributors.
