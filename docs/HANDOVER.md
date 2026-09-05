# Handover: hosting and maintaining z-tenant-kyb

This document is for Terminal 3. The bounty asks for an agent that Terminal 3 can
distribute or host; **we hand z-tenant-kyb over to Terminal 3 to host under its own
tenant**, and we are happy to keep maintaining it (see "Contact and maintenance" at the
end). Everything below is what an operator needs to run it without reading the source.

## 1. What you are taking over

| Piece | Location | Notes |
|---|---|---|
| TEE contract | `src/`, `wit/`, `Cargo.toml` | Rust -> `wasm32-wasip2` component, 2 exported functions, 24 native tests |
| Operator CLI | `cli/` | TypeScript on `@terminal3/t3n-sdk`; `--dry-run` on every command that sends a request (`deploy`, `authorize`, `screen`, `onboard`) |
| Docs | `README.md`, `docs/` | this file, bug report, submission text |

Exported functions (WIT `z:tenant-kyb/contracts@0.1.0`): `screen-vendor` (VIES + GLEIF,
company data only) and `submit-onboarding` (ERP POST with `{{profile.*}}` markers).
Full I/O tables are in the README.

## 2. Prerequisites

- **Tenant identity**: a T3N API key with test credits (claim page; key shown once).
  This is the identity that owns `z:<tid>:kyb` and `z:<tid>:secrets`.
- **Agent identity**: a second key with its own DID and its own credits (metered calls
  are charged to the caller, and an agent DID starts at zero -- ADK "Common errors").
- **Data-owner identity**: the signatory's own key. Their profile must carry `first_name`
  and `last_name` (set through the user flow, e.g. `submitUserInput`), because the ERP
  body references `{{profile.first_name}}` / `{{profile.last_name}}`. If
  `include_email` is used, a verified e-mail is also required.
- **Toolchain**: Rust stable with `rustup target add wasm32-wasip2`; Node >= 20.12 (the CLI
  uses `process.loadEnvFile`; we used Node 26 / npm 11); `wasm-tools` optional.
- **An ERP endpoint** that accepts a JSON POST. For a smoke test any JSON-echoing
  endpoint works (the contract extracts a reference and never returns the echoed body).
- **Node-side**: the SDK types say `contracts.logs` returns nothing until the tenant's
  `log_max_entries` quota is > 0. On testnet our freshly claimed tenant got entries back
  without any change (2026-09-04), so check `kyb logs` before asking for a quota.

## 3. Secrets to seed

Map tail `secrets` (canonical `z:<tid>:secrets`), `visibility: "private"`,
`writers: { only: [contractId] }`, `readers: { only: [contractId] }` (readers must be
explicit -- the KV governor defaults to deny).

| Key | Required | Value |
|---|---|---|
| `erp_onboarding_url` | yes | Full URL for the onboarding POST, e.g. `https://erp.example.com/api/vendors` |
| `erp_api_key` | no | Bearer token sent as `Authorization: Bearer <value>` |

`kyb deploy` creates the map and seeds both from `ERP_ONBOARDING_URL` / `ERP_API_KEY`.
By hand: `tenant.maps.create({...})` then `tenant.maps.entrySet("secrets", key, value)`.
(The docs mention `tenant.executeControl("map-entry-set", ...)` for the same thing but do
not show its input shape -- see `cli/DISCREPANCIES.md` #6; the typed helper is the safe
form.) No other secret exists: VIES and GLEIF are public, key-less APIs.

## 4. User grant flow (who may call what)

Authentication is not authorization. Before the agent can reach the network from inside
the contract, the **data owner** grants it, with their own session:

```
contract_id   tee:user/contracts
function_name agent-auth-update
input.agents[0]
  agentDid     <agent DID read back from the agent session>
  scripts[0]
    scriptName   z:<tid>:kyb
    versionReq   0.1.0            (or a range that covers the deployed version)
    functions    ["screen-vendor", "submit-onboarding"]
    allowedHosts ["ec.europa.eu", "api.gleif.org", "<host of erp_onboarding_url>"]
```

`kyb authorize` does this with `USER_KEY`. Without the grant the contract still runs but
the outbound call fails inside the enclave (`egress-denied` / `host/http.egress_denied`).
The same mechanism scopes `submit-onboarding`: the placeholders resolve from the
**calling user's** profile, so the person who grants is the person whose name lands in
the ERP.

How the grant is sent: `kyb authorize` uses the SDK's typed helper `updateAgentAuth()`
(read-merge-write; `toAgentAuthUpdateWire` turns the camelCase document above into the
contract's snake_case wire `agent_did` / `script_name` / `version_req` / `functions` /
`allowed_hosts`). That path worked live on 2026-09-04 (`docs/run-logs/authorize.txt`);
the raw camelCase `execute` snippet from the Agent Auth page was not tried -- see
`docs/BUGS.md` item 2. `kyb authorize --dry-run` prints both forms. (The newer
`updateMemberDelegation` helper exists too; we did not use it.)

The `generic-input` envelope's `user-profile` field plays no part in this: it is always
`None` on this path (see the comment in `wit/world.wit`) and the contract reads only
`input`. The signatory's data exists only host-side, after placeholder substitution.

To **revoke**, re-issue the grant without the agent (the document is the new state).

## 5. Runbook

### Deploy (first time or after a code change)

```bash
cargo test --target <host-triple> --lib
cargo build --target wasm32-wasip2 --release
cd cli && npx tsx src/index.ts doctor
npx tsx src/index.ts deploy            # contracts.register, then maps.create/update (idempotent), then seed secrets
npx tsx src/index.ts authorize         # data-owner grant
npx tsx src/index.ts screen --country IE --vat 6388047V --name "Google Ireland Limited"
```

`deploy --dry-run` prints the register/seed payloads (secrets masked) without a network
call; use it to review before touching a live tenant.

### Rotate the ERP key

1. `export ERP_API_KEY=<new>`; run `kyb deploy` again (map create is idempotent; the
   entry is overwritten), or call `tenant.maps.entrySet("secrets", "erp_api_key", ...)`.
2. No contract change and no re-grant needed; the contract reads the map on every call.
3. To move to a different ERP host, also update the grant's `allowedHosts`.

### Upgrade the contract version

1. Bump `CONTRACT_VERSION` (`src/lib.rs`), `version` (`Cargo.toml`) and the package
   version in `wit/world.wit` together; rebuild; run tests.
2. `kyb deploy` registers the new version. The node rejects a version that is not higher
   than the current one (`version <x> is not higher than current version <y>`).
3. Re-check the `secrets` map ACL still names the right contract (`tenant.maps.update`)
   and that the users' grants' `versionReq` cover the new version; re-run `authorize`
   if you pinned an exact version.

### Read logs and audit

- `kyb logs` -> `tenant.contracts.logs("kyb", { minLevel, limit, sinceSeq })`. Entries
  contain country+VAT, validity, GLEIF status, vendor/screening ids -- no person data.
- `kyb audit` -> `T3nClient.getAuditEvents()` for the agent's own trail.

### Disable in an emergency

`tenant.contracts.disable("kyb")` (SDK `TenantContractsNamespace.disable`), or revoke
the agent grant. Re-enable with `enable`.

## 6. What was and was not exercised on testnet (2026-09-04)

**Exercised**, with SDK 5.2.0 and verified attestation (`T3N_TRUST=manifest`), logs in
`docs/run-logs/`: `doctor` (15 ok / 2 warn), `deploy` (register -> contract_id 879,
private `secrets` map with `{ only: [879] }`, `erp_onboarding_url` seeded), `authorize`
(grant accepted), `screen` for a valid vendor (`IE6388047V`, no flags) and an invalid one
(`DE000000000`, `VAT_INVALID` + `LEI_NOT_FOUND`), `onboard` (placeholders resolved
host-side, echo endpoint HTTP 200, `erp_reference` taken from the echo's trace-id header),
`logs` (10 entries) and `audit`.

**Not exercised -- read before hosting.** All three roles were the *same* identity:
tenant DID = agent DID = data-owner DID = `did:t3n:07974b90cb13c1e659db9a9bbb74ea825e2f63c0`.
The grant was a self-grant and `pii_did` was set to the caller's own DID, because
separately generated identities start with zero credits (`docs/BUGS.md` #0b). Therefore:

- The **delegated path** is untested: agent DID != data-owner DID, `pii_did` set to the
  owner, placeholders resolved from *another* profile, egress authorised by the owner's
  grant rather than the caller's own.
- The **no-grant failure mode** was not observed. Expected from the WIT and the SDK
  types: `screen-vendor` fails with `host/http.egress_denied`; `submit-onboarding` with
  `egress-denied`, or with `placeholder-no-user-context` (`PlaceholderNoUserContext` in
  `src/onboard.rs`) when no user context is bound.
- `kyb audit` returned `{"batches":[],"next_cursor":null}` on this self-call; what the
  trail looks like for a delegated call (`pii_did` of another user) is unknown.
- Not tried: `include_email: true` (nested marker), an `erp_api_key` bearer (the demo
  endpoint had none), a real ERP, revocation, and a contract-version bump.

First thing to do under a Terminal 3 tenant: repeat section 5 with three funded
identities and confirm `onboard` lands the *data owner's* name, not the agent's.

## 7. Known limitations

- **VIES flakiness.** Member-state backends go down often. The contract reports this as
  `risk_flags: ["VAT_CHECK_UNAVAILABLE"]` with `vat.error = "VIES MS_UNAVAILABLE"` (or
  an HTTP code) instead of failing, so callers should retry later rather than treat it
  as invalid.
- **GLEIF name search picks the best of five hits** (`page[size]=5`, exact
  `entity.legalName` filter; `screen::parse_gleif_matching` prefers the record whose
  normalised name equals the searched name, else the first). Supply `lei` for a
  deterministic lookup; a wrong pick surfaces as `NAME_MISMATCH` / `COUNTRY_MISMATCH`.
- **Register throttling is its own flag.** HTTP 429 from VIES/GLEIF yields
  `VIES_RATE_LIMITED` / `GLEIF_RATE_LIMITED` instead of `*_CHECK_UNAVAILABLE`.
- **Nested e-mail marker is opt-in.** `{{profile.verified_contacts.email.value}}` is used
  by the reference contract, but the host WIT shipped in `wit/deps` says nested markers
  are rejected with `placeholder-denied`. `submit-onboarding` sends it only when
  `include_email: true`. If your node accepts it, the CLI can default it on.
- **VIES member codes only.** `country_code` must be an EU code, `EL` (Greece) or `XI`
  (Northern Ireland); non-EU vendors get a parse error, not a screening.
- **One ERP per tenant.** The endpoint is a single secret; multi-ERP routing would need a
  key per ERP and a selector in the input.
- **SDK pin.** The CLI pins `@terminal3/t3n-sdk` 5.2.0: testnet's trust manifest
  (version 1787800421, signed 2026-08-27) has no `rtmr1_allowlist`, which 5.3.0 and later
  require, so on those versions `fetchTrustedManifest` fails and no session can be opened
  with verified attestation. With 5.2.0 everything in section 6 ran live under the default
  `T3N_TRUST=manifest`. Upgrade condition: when the node publishes `rtmr1_allowlist`,
  move to the latest SDK (`doctor` shows the manifest fields and warns when the installed
  SDK is not the pinned one). `T3N_TRUST=unsafe` is a debug switch only and is refused on
  production. Details: `docs/BUGS.md` #0, `cli/DISCREPANCIES.md` #1.

## 8. Contact and maintenance

We hand the contract, CLI and documentation over to Terminal 3 to host, distribute and
operate under a Terminal 3 tenant. We are happy to keep maintaining it (register
additions, ERP body variants, doc fixes) via pull requests on the public repository:
<https://github.com/hllerdgn80-code/z-tenant-kyb>. License: MIT.
