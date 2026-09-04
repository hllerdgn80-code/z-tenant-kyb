# Handover: hosting and maintaining z-tenant-kyb

This document is for Terminal 3. The bounty asks for an agent that Terminal 3 can
distribute or host; **we hand z-tenant-kyb over to Terminal 3 to host under its own
tenant**, and we are happy to keep maintaining it (see "Contact and maintenance" at the
end). Everything below is what an operator needs to run it without reading the source.

## 1. What you are taking over

| Piece | Location | Notes |
|---|---|---|
| TEE contract | `src/`, `wit/`, `Cargo.toml` | Rust -> `wasm32-wasip2` component, 2 exported functions, 19 native tests |
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
- **Node-side**: `log_max_entries` quota > 0 if you want `contracts.logs` to return
  anything (logs are off by default according to the SDK types).

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
the ERP. Note: the SDK also exposes typed helpers (`agentAuthUpdate`, `updateAgentAuth`,
and the newer `updateMemberDelegation`) that emit the contract's snake_case wire; see
`docs/BUGS.md` item 2 for why we mention this.

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

## 6. Known limitations

- **VIES flakiness.** Member-state backends go down often. The contract reports this as
  `risk_flags: ["VAT_CHECK_UNAVAILABLE"]` with `vat.error = "VIES MS_UNAVAILABLE"` (or
  an HTTP code) instead of failing, so callers should retry later rather than treat it
  as invalid.
- **GLEIF name search takes the first match** (`page[size]=1`, exact `entity.legalName`
  filter). Supply `lei` for a deterministic lookup; a wrong first match surfaces as
  `NAME_MISMATCH` / `COUNTRY_MISMATCH`.
- **Nested e-mail marker is opt-in.** `{{profile.verified_contacts.email.value}}` is used
  by the reference contract, but the host WIT shipped in `wit/deps` says nested markers
  are rejected with `placeholder-denied`. `submit-onboarding` sends it only when
  `include_email: true`. If your node accepts it, the CLI can default it on.
- **VIES member codes only.** `country_code` must be an EU code, `EL` (Greece) or `XI`
  (Northern Ireland); non-EU vendors get a parse error, not a screening.
- **One ERP per tenant.** The endpoint is a single secret; multi-ERP routing would need a
  key per ERP and a selector in the input.
- **Testnet compatibility.** On 2026-09-04 testnet's trust manifest lacked the
  `rtmr1_allowlist` field that SDK 5.10.0 requires, so under the default `T3N_TRUST=manifest`
  every session command fails at `fetchTrustedManifest`. Under `T3N_TRUST=unsafe` we verified
  with unclaimed keys that `handshake` + `authenticate`, `kyb audit`, and the execute dispatch
  (contract-id validation, request_id `6d25b431-8e2e-41cf-a0f3-5c05f37c4c6b`) all work; `deploy`
  and `logs` were blocked only by credits (`InsufficientCredit`, HTTP 403, request_id
  `fe3d0e55-16ec-4636-b99f-ed8e4eea7ff3`), which a claimed key or `kyb deploy --claim` resolves.
  The CLI surfaces the node's `detail` string verbatim and offers `--dry-run`; details in
  `cli/DISCREPANCIES.md` #1 and #8.

## 7. Contact and maintenance

We hand the contract, CLI and documentation over to Terminal 3 to host, distribute and
operate under a Terminal 3 tenant. We are happy to keep maintaining it (register
additions, ERP body variants, doc fixes) via pull requests on the public repository:
<https://github.com/hllerdgn80-code/z-tenant-kyb>. License: MIT.
