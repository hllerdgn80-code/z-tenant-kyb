# z-tenant-kyb -- a vendor KYB onboarding agent built on the new T3N ADK docs

*(Google Doc text — mirrors docs/SUBMISSION.md in the repo.)*

## Summary

z-tenant-kyb is a trusted agent for enterprise procurement: it screens a supplier
against the EU VIES VAT register and the GLEIF LEI register inside a T3N TEE contract,
returns a risk-flag summary, and registers the vendor in the tenant's ERP with the
signatory's name resolved from the T3N user profile via `{{profile.*}}` placeholders --
so neither the agent, the contract, nor the caller ever holds the signatory's PII.
Both registers are free and key-less, so the only secret is the tenant's own ERP
endpoint. It ships as a Rust WASM component, an operator CLI on `@terminal3/t3n-sdk`
(with an offline `--dry-run` path), a handover guide for Terminal 3, and a
documentation/SDK bug report. We hand it over to Terminal 3 to host and are happy to
keep maintaining it.

## Links

- Repository (public): https://github.com/hllerdgn80-code/z-tenant-kyb
- README (architecture, functions, privacy model, build/run): `README.md`
- Handover for Terminal 3: `docs/HANDOVER.md`
- Bugs and doc issues found: `docs/BUGS.md`
- Operator CLI: `cli/README.md`

## What was built

1. **TEE contract** (`wit/world.wit`, `src/`): world `z:tenant-kyb@0.1.0` importing
   `tenant-context`, `logging`, `kv-store`, `http`, `http-with-placeholders`; exports
   `screen-vendor` and `submit-onboarding`. 19 native unit tests cover the parsers, the
   PII guard, risk scoring and the ERP body builder. Build: `cargo build --target
   wasm32-wasip2 --release` -> 154 KB component, validated with `wasm-tools`.
2. **PII model**: inline person fields are rejected at parse time; the signatory reaches
   the ERP only through `{{profile.first_name}}` / `{{profile.last_name}}` markers
   (nested e-mail marker opt-in); the ERP response body is never echoed; logs carry
   company identifiers only.
3. **Operator CLI** (`cli/`): `doctor`, `deploy`, `authorize`, `screen`, `onboard`,
   `logs`, `audit`; env vars `T3N_API_KEY`, `AGENT_KEY`, `USER_KEY`,
   `ERP_ONBOARDING_URL`, `ERP_API_KEY`; `deploy`, `authorize`, `screen` and `onboard` have
   `--dry-run` (`logs` and `audit` are read-only).
4. **Docs**: README, handover runbook, bug report, this submission.

## How we used the new docs

We followed the ADK pages in order and built against exactly what they describe:

- **Quickstart** -> `setEnvironment("testnet")`, `loadWasmComponent()`,
  `eth_get_address`, `new T3nClient({ trustAnchor: await fetchTrustedManifest("testnet"),
  wasmComponent, handlers: { EthSign: metamask_sign(...) } })`, `handshake()`,
  `authenticate(createEthAuthInput(address))` -> `did.value`. This is `openSession()` in
  the CLI's `cli/src/client.ts`.
- **Set up dev env** -> `rustup target add wasm32-wasip2`, `TenantClient({ t3n, baseUrl:
  getNodeUrl(), tenantDid })`, `tenant.tenant.me()` (this is `kyb doctor` online mode).
- **What is z-namespace / Create tenant KV maps** -> `maps.create({ tail: "secrets",
  visibility: "private", writers/readers: { only: [contractId] } })` and the
  `z:<tid>:secrets` name built from `hex::encode(tenant_did())` in Rust.
- **Capabilities come from your WIT imports** -> no manifest; we copied the host WIT
  packages from the reference contract and imported only the five interfaces we use.
- **Outbound HTTP is authorized by the user / Agent Auth** -> `agent-auth-update` grant
  with `functions` and `allowedHosts` for the two registers and the ERP host, signed by
  the data owner, agent authenticating with its own key.
- **Common errors** -> the CLI maps the documented `detail` substrings to hints.
- **Reference contract z-tenant-flight** -> structure of `lib.rs` / `generic-input`
  envelope / `http-with-placeholders` usage.

Where the docs and the shipped artefacts disagreed we followed the artefacts (WIT and
`index.d.ts`) and wrote the disagreement down in `docs/BUGS.md`.

## Screenshots

All captured on 2026-09-04 against **testnet** (node `cn-api.sg.testnet.t3n.terminal3.io`) with the tenant key claimed from the ADK community page. Text logs are in `docs/run-logs/`, rendered images in `docs/screenshots/`.

1. `kyb doctor` — toolchain, WASM component check, VIES/GLEIF reachability, node `/status`, trust-manifest field check (warns: `rtmr1_allowlist` missing), tenant/agent/user sessions authenticated, tenant admitted — `15 ok, 2 warn, 0 failed`.
2. `cargo test --target x86_64-apple-darwin --lib` — all native tests pass; `cargo build --target wasm32-wasip2 --release` — 154 KB (157,768 byte) component; `wasm-tools component wit` — the five `host:*` imports and the `z:tenant-kyb/contracts@0.1.0` export.
3. `kyb deploy` — `registered z:07974b90…:kyb @ 0.1.0 → contract_id 879`, private `secrets` map created with `{ only: [879] }` ACL, `erp_onboarding_url` seeded.
4. `kyb authorize` — `agent-auth-update` grant for `screen-vendor`, `submit-onboarding`, allowedHosts `ec.europa.eu, api.gleif.org, httpbin.org`. (First attempt with a separate, unfunded user identity: `InsufficientCredit … available=0` — see bugs.)
5. `kyb screen --country IE --vat 6388047V --name "Google Ireland Limited"` — executed inside the enclave: VIES `valid=true`, GLEIF LEI `YYPPRNO5HB304LHFVG31`, `risk_flags: []`.
6. `kyb screen --country DE --vat 000000000 --name "Nonexistent GmbH"` — `risk_flags: ["VAT_INVALID", "LEI_NOT_FOUND"]`.
7. `kyb onboard --vendor-id V-GOOGLE-IE --screening-ref scr-2026-09-04-001` — `{{profile.first_name}}`/`{{profile.last_name}}` resolved host-side, ERP POST → `status: submitted, http_code: 200, erp_reference: Root=1-…` (the ERP echo body is never returned to the caller).
8. `kyb logs` — contract log lines from inside the TEE (no PII), `kyb audit` — audit read as the agent.
9. The repository itself is public and needs no screenshot to verify — open
   https://github.com/hllerdgn80-code/z-tenant-kyb and the `docs/` folder is the
   source of every image above (`docs/screenshots/`, rendered from `docs/run-logs/`).

## Bugs and doc issues faced (short)

Full list with file/line evidence and suggested fix text in `docs/BUGS.md`. Headlines:

0. **SDK ≥ 5.3.0 cannot open a session on testnet** — `fetchTrustedManifest("testnet")` rejects the served trust manifest (version 1787800421, signed 2026-08-27) because it has no `rtmr1_allowlist`. Bisected: 5.2.0 works, 5.3.0 / 5.4.0 / 5.5.0 / 5.8.0 / 5.10.0 fail with the same "malformed" error. Every documented flow (quickstart onward) fails at step one on the latest SDK; our CLI pins 5.2.0 and keeps verified attestation. Fix: publish `rtmr1_allowlist` in the testnet manifest, or let the SDK accept manifests that predate the field (as `manifestToTrustAnchor` already does). Details: `cli/DISCREPANCIES.md` #1.
0b. **Separate agent/user identities start with 0 credits and the claim page issues one key per Google account** — the docs say "get the agent its own key from the claim page", but the page is Google-SSO only and rate-limited to one signup per e-mail, so a second identity cannot be funded without a second Google account or a manual top-up (`InsufficientCredit … required=10000000000 available=0`, request_id `d0198fc4-b543-4cbf-a25c-41c3ff0cb600`). We used the documented self-grant path for the demo.

1. The reference contract and the placeholder guide use the nested marker
   `{{profile.verified_contacts.email.value}}`, but the host WIT shipped with it says
   nested markers are rejected with `placeholder-denied`. We made the e-mail opt-in.
2. Environment naming is inconsistent: the quickstart says `"testnet"` and "defaults to
   testnet"; the SDK README says `"sandbox" | "production"`; the SDK types accept all
   three and map `sandbox` and `testnet` to the same node URL.
3. The Agent Auth page shows a raw `execute` call with camelCase grant fields, while the
   SDK types say the contract's wire is snake_case and the SDK provides (deprecated)
   typed helpers for it.
4. "Common errors" says `T3nClient` takes no `baseUrl`; `T3nClientConfig.baseUrl` exists
   in the SDK types and the SDK README uses it. The page also lacks the typed
   `http-with-placeholders` errors.
5. The docs never say that a `wasm32-wasip2` component also imports `wasi:cli/*`,
   `wasi:io/*`, `wasi:clocks/*` and whether the node links them.
6. Three different claim-page URLs / sign-in methods across the docs, the SDK README and
   the bounty comments (Google-only SSO reported by others; not verified by us).
7. Smaller: `map-entry-set` via `executeControl` vs the typed `maps.entrySet`;
   `getAuditEvents` exists in the types though listed as unverified; SDK version history.

## Maintenance and handover

We hand z-tenant-kyb over to Terminal 3 to host and distribute under its own tenant;
`docs/HANDOVER.md` is the runbook (prerequisites, secrets, grant flow, deploy/rotate/
upgrade/logs, limitations). We are happy to keep maintaining it through pull requests.
The design keeps maintenance boring on purpose: no third-party API keys, pure functions
with fixture tests for every parser, one secret to change to point at a real ERP.

## Time to submit

Started 2026-09-04 ~19:40 (Europe/Istanbul) by reading the refreshed docs (quickstart → walkthrough → tips → reference); contract, CLI, live testnet run, docs and bug report were finished the same evening (~4 hours), submitted 2026-09-04 (same day the refreshed docs were read). Work was done with an AI coding assistant driving the ADK docs (llms.txt + .md pages) end to end.

## Social

X thread tagging @terminal3io and @SuperteamEarn:
https://x.com/Hllerdgn80/status/2095961225007886445 (text in `docs/X_POST.md`).
