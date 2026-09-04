# z-tenant-kyb -- a vendor KYB onboarding agent built on the new T3N ADK docs

*(Paste into the public Google Doc. Replace the bracketed placeholders.)*

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

*(Attach in this order; each caption tells the judge what to look for.)*

- [ ] `npx tsx src/index.ts doctor` -- toolchain + env check, secrets masked
- [ ] `cargo test --target x86_64-apple-darwin --lib` -- `19 passed; 0 failed`
- [ ] `cargo build --target wasm32-wasip2 --release` + `ls -la target/wasm32-wasip2/release/z_tenant_kyb.wasm` (~154 KB)
- [ ] `wasm-tools component wit target/wasm32-wasip2/release/z_tenant_kyb.wasm` -- the five `host:*` imports and the `z:tenant-kyb/contracts@0.1.0` export
- [ ] If testnet accepted the SDK: `kyb deploy` (contract_id / name), `kyb authorize`, `kyb screen --country IE --vat 6388047V --name "Google Ireland Limited"` output with `risk_flags: []`, `kyb onboard` output, `kyb logs`
- [ ] Otherwise: `kyb deploy --dry-run` and `kyb screen --dry-run` output, plus the exact error text from the live attempt with its `request_id` as evidence for the bug report -- we have `InsufficientCredit` on `tenant.me()` (request_id `fe3d0e55-16ec-4636-b99f-ed8e4eea7ff3`) and the execute dispatch reaching contract-id validation (request_id `6d25b431-8e2e-41cf-a0f3-5c05f37c4c6b`) under `T3N_TRUST=unsafe`
- [ ] The GitHub repo page showing the public visibility and the docs folder

## Bugs and doc issues faced (short)

Full list with file/line evidence and suggested fix text in `docs/BUGS.md`. Headlines:

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

Started [DATE/TIME], submitted [DATE/TIME] -- about [N] hours from reading the
quickstart to this document, including the bug write-up. The contract and tests were
finished first; the remaining time went into the CLI's dry-run path and the docs.

## Social

X thread tagging @terminal3io and @SuperteamEarn: [LINK] (text in `docs/X_POST.md`).
