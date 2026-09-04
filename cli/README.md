# z-tenant-kyb operator CLI

Thin, typed command-line tool around `@terminal3/t3n-sdk` **5.2.0** (pinned — see "SDK pin" below) for operating the
`z-tenant-kyb` TEE contract (vendor KYB: key-less EU VIES + GLEIF screening inside the enclave,
and PII-safe ERP onboarding through `{{profile.*}}` placeholders). It is the "distribute / host"
half of the bounty: everything an operator does after `cargo build` lives here.

```
cli/
  src/index.ts          commander entry point — one sub-command per file
  src/env.ts            .env / env-var loading, typed Config, non-secret state file, key classification
  src/client.ts         SDK sessions (tenant / agent / user), trust anchor, agent calls (session or api-key)
  src/errors.ts         one place that turns SDK errors into actionable messages + exit code 1
  src/commands/*.ts     doctor, deploy, authorize, screen, onboard, logs, audit
  DISCREPANCIES.md      where the docs, the SDK's d.ts and testnet disagree (feeds the bug report)
```

No framework beyond the SDK, `commander`, `tsx` and `typescript`. Every network command fails with a
clear, hinted message; every command that writes anything has `--dry-run`; secrets are never printed.

## Quick start

```bash
# 0. build the contract once (repository root)
cargo build --target wasm32-wasip2 --release        # → target/wasm32-wasip2/release/z_tenant_kyb.wasm

# 1. install and configure
cd cli && npm install
cp .env.example .env                                # fill T3N_API_KEY, AGENT_KEY, USER_KEY (see below)

# 2. check everything without touching your keys' identities
npm run kyb -- doctor --offline                     # toolchain + artifact + env only
npm run kyb -- doctor                               # + VIES, GLEIF, node, trust manifest, handshake per key

# 3. operate
npm run kyb -- deploy --dry-run                     # print the plan
npm run kyb -- deploy                               # register contract, create/ACL `secrets`, seed ERP URL
npm run kyb -- authorize                            # data owner grants the agent (functions + egress hosts)
npm run kyb -- screen --country IE --vat 6388047V --name "Google Ireland Limited"
npm run kyb -- onboard --vendor-id V-1001 --screening-ref scr-2026-09-04-1
npm run kyb -- logs                                 # enclave log lines (tenant)
npm run kyb -- audit --as agent                     # host-stamped audit events (guarded)
```

`npm run kyb -- <command>` and `npx tsx src/index.ts <command>` are equivalent.
`npm run typecheck` runs `tsc --noEmit` (strict, NodeNext, exactOptionalPropertyTypes).

## Environment variables

Read from `cli/.env` (via `process.loadEnvFile`) or the real environment; real variables win.

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `T3N_API_KEY` | — | deploy, logs, audit `--as tenant`, doctor | Tenant (contract owner) key from the [claim page](https://go.terminal3.io/adk-community). Shown once. |
| `AGENT_KEY` | — | authorize, screen, onboard, audit, doctor | The agent's **own** key (second claim; its credits are separate). Never reuse `T3N_API_KEY`. |
| `USER_KEY` | — | authorize, audit `--as user`, doctor | The data owner: signs the grant; their profile fills `{{profile.*}}`. |
| `ERP_ONBOARDING_URL` | — (`--dry-run` / `doctor` only: `https://httpbin.org/post`) | deploy, authorize | Where `submit-onboarding` POSTs. Seeded into `z:<tid>:secrets`; its host is added to the grant. A live `deploy` / `authorize` refuses to run without it. |
| `ERP_API_KEY` | — | deploy | Optional bearer the contract sends to the ERP. Seeded, never printed. `deploy` refuses it next to an httpbin.org URL (the token would be sent to a public echo service). |
| `T3N_ENV` | `testnet` | all | `sandbox` \| `testnet` \| `production` → `setEnvironment()`. |
| `T3N_TRUST` | `manifest` | all sessions | `manifest` (verified operator manifest) \| `unsafe` (no attestation check; refused on production). See below. |
| `CONTRACT_TAIL` | `kyb` | all | Map/contract tail → `z:<tid>:kyb`. |
| `CONTRACT_VERSION` | `0.1.0` | deploy, authorize, screen, onboard | Must match `CONTRACT_VERSION` in `src/lib.rs`; bump both to redeploy. |
| `SCRIPT_NAME` | from state file | authorize, screen, onboard | `z:<tid>:<tail>` override. |
| `USER_DID` | from state file | screen, onboard | Default `pii_did` (the data owner of a delegated call). |
| `WASM_PATH` | `../target/wasm32-wasip2/release/z_tenant_kyb.wasm` | doctor, deploy | Artifact location, relative to `cli/`. |

Key formats: the quickstart treats the API key as a 64-hex secp256k1 private key
(`eth_get_address(key)`), while the SDK's `invoke()` path relays an opaque `t3n_key_…` token. The CLI
classifies each key; a `t3n_key_…` `AGENT_KEY` routes `screen`/`onboard` through the stateless
`invoke()` path and `authorize` resolves its DID via `discoverWhoami()`. Tenant and user keys must
be private keys (the session flow needs them).

## Commands

### `doctor [--offline] [--timeout <ms>]`
Toolchain (Node ≥ 20.12, SDK version), WASM artifact (exists, size, is a **component**, layer 1),
env vars (masked, with key kind), then online: VIES (`IE6388047V → valid=true`), GLEIF (`SAP SE` → LEI),
node `/status`, the served **trust manifest vs the fields SDK >= 5.3.0 requires**, and handshake +
authenticate for every configured key (tenant additionally calls `tenant.me()`). Exit 1 on any failure.

### `deploy [--dry-run] [--claim] [--contract-id <n>]`
1. tenant session → tenant DID read back from the session (never derived)
2. `contracts.register({ tail, version, wasm })` → `z:<tid>:kyb` + numeric `contract_id`.
   A same-version re-run is a no-op ("not higher than current version") and reuses the id
   from `cli/.kyb-state.json` or `--contract-id`.
3. `maps.getStatus("secrets")` → `maps.create({ visibility: "private", writers/readers: { only: [contract_id] } })`
   if absent, otherwise `maps.update()` to keep the ACL on the current id. "already exists" is tolerated.
4. `maps.entrySet("secrets", "erp_onboarding_url", …)` and optionally `erp_api_key` (the owner can always
   write its own map through the control plane, whatever the ACL says).
5. writes `cli/.kyb-state.json` (tenant DID, script name, contract id, version — no secrets).
`--claim` calls `tenant.claim()` first (testnet self-admit) for a key that is not a tenant yet.

### `authorize [--dry-run] [--agent-did <did>] [--script <name>] [--host <h...>]`
As the data owner (`USER_KEY`), grants the agent `screen-vendor` + `submit-onboarding` on the script
with `allowedHosts = ["ec.europa.eu", "api.gleif.org", <ERP host>]` and `versionReq = CONTRACT_VERSION`,
via the SDK's `updateAgentAuth()` (read-merge-write, other grants survive). The agent DID is read from
the agent's own session unless `--agent-did` is given. Records `agentDid`/`userDid` in the state file so
`screen`/`onboard` default `pii_did` to the user. `--dry-run` prints the grant and its snake_case wire.

### `screen --country DE --vat 143593636 [--lei …] [--name …] [--on-behalf-of <did>] [--dry-run]`
Agent call of `screen-vendor`. Output: `{ vat: {valid, name, …}, lei: {found, registration_status, …}, risk_flags: [...] }`.
Person-level fields are rejected by the contract by design. A good demo vendor today:
`--country IE --vat 6388047V --name "Google Ireland Limited"` (VIES `valid=true`, GLEIF `ISSUED/ACTIVE`, no flags).

### `onboard --vendor-id <id> --screening-ref <ref> [--include-email] [--notes …] [--on-behalf-of <did>] [--dry-run]`
Agent call of `submit-onboarding`: the contract POSTs to the seeded ERP URL with the signatory as
`{{profile.first_name}}` / `{{profile.last_name}}` markers that the host resolves from the data owner's
profile — so `pii_did` (`--on-behalf-of` / `USER_DID`) is required for the placeholders to resolve.
`--include-email` adds the nested `{{profile.verified_contacts.email.value}}` marker (opt-in because
the host WIT says nested markers may be rejected). Output: `{ status, erp_reference, http_code }` only —
the ERP echo body never comes back.

### `logs [--limit <n>] [--since <seq>] [--level info|debug|error]`
`tenant.contracts.logs("kyb")` — the enclave's `logging::info/error` ring. Empty until the cluster
operator sets the tenant quota `log_max_entries > 0`.

### `audit [--as tenant|agent|user] [--pii-did <did>] [--limit <n>] [--cursor <hex>]`
`t3n.getAuditEvents()` (`audit.get-mine`). The docs call this unverified, so the CLI checks the method
exists at runtime before calling it.

## Every call is delegated: `pii_did`, grants and egress

Outbound HTTP is authorised by the **subject user's** grant, not by the contract: `screen` and `onboard`
therefore send `pii_did = <data owner DID>` (from `--on-behalf-of`, `USER_DID`, or the state file written by
`authorize`). Without it the call is a self call — the agent would need a self-grant, and `submit-onboarding`
has no profile to substitute (`PlaceholderNoUserContext`).

## `T3N_TRUST` — attestation pinning

The quickstart pins the node's attestation with `fetchTrustedManifest(env)`. **On 2026-09-04 testnet served a
manifest without `rtmr1_allowlist`**, which SDK >= 5.3.0 rejects (`Trust manifest at …/api/trust-manifest is malformed`) — verified on 5.3.0, 5.4.0, 5.5.0, 5.8.0 and 5.10.0, while 5.2.0 accepts it, so the CLI pins 5.2.0,
so every session command fails under the default `T3N_TRUST=manifest`. `kyb doctor` shows exactly which
fields are missing. Until the manifest or the SDK is fixed, `T3N_TRUST=unsafe` (= `{ unsafe_trust_server: true }`)
is the only way through; it disables attestation verification, prints one warning per run, and is
refused when `T3N_ENV=production`. Details and evidence in `DISCREPANCIES.md` #1.

## Handover notes

- **Redeploy a new build**: bump `CONTRACT_VERSION` in `src/lib.rs` and in `cli/.env` (both), `cargo build`,
  `kyb deploy`. Register is monotonic per version; the map ACL is re-synced to the new contract id automatically.
  Then `kyb authorize` again if `versionReq` should follow the new version.
- **Change the ERP**: edit `ERP_ONBOARDING_URL` (+ `ERP_API_KEY`), run `kyb deploy` (re-seeds; idempotent) and
  `kyb authorize` (the ERP host is on the grant).
- **Add an egress host**: `kyb authorize --host new.example.com`; the register hosts are constants in `src/env.ts`.
- **State file** `cli/.kyb-state.json`: non-secret cache (tenant DID, script name, contract id, agent/user DID).
  Delete it to start clean; `deploy`/`authorize` rebuild it.
- **Errors**: `src/errors.ts` maps known `detail` substrings from `common-errors.md` and the SDK d.ts to hints and
  prints `request_id` when the node returns one — quote it when reporting.
- **SDK pin**: `package.json` pins `@terminal3/t3n-sdk` **5.2.0**, the last release whose `fetchTrustedManifest()` accepts the testnet manifest (no `rtmr1_allowlist`). Upgrade to >= 5.3.0 as soon as the node publishes `rtmr1_allowlist`; `doctor` warns when the installed SDK is not the pinned one. The SDK bundle is obfuscated, so wire
  shapes can only be checked against `dist/index.d.ts`; re-read `DISCREPANCIES.md` after an upgrade.
- **Verified offline** (no keys): typecheck, `doctor --offline`, `doctor` (VIES/GLEIF/node/manifest reachability),
  all `--dry-run` paths, every "missing key / missing state" error path.
- **Verified against testnet on 2026-09-04 under `T3N_TRUST=unsafe`, with arbitrary (unclaimed) secp256k1 keys**:
  `handshake` + `authenticate` issue a DID per key (three DIDs in one `doctor` run); `kyb audit --as agent` works
  end-to-end (`{"batches":[],"next_cursor":null}`); `kyb screen` reaches the node's execute dispatch, which validates
  the contract id (`-32601 tenant contract z:0000…:kyb not registered`, request_id `6d25b431-8e2e-41cf-a0f3-5c05f37c4c6b`;
  `--script z:deadbeef:kyb` → `-32602 z: <tid> must be 40 lowercase hex chars, got 8`, request_id `13978ad5-…`).
- **Blocked by credits, not by authentication**: `deploy` and `logs` stop at `tenant.me()` /
  `contracts.logs` with `InsufficientCredit (account=<tenant DID>, required=10000000000, available=0)` (HTTP 403,
  request_id `fe3d0e55-16ec-4636-b99f-ed8e4eea7ff3`). A key from the claim page, or `kyb deploy --claim`
  (`tenant.claim()`), is needed for anything metered. Under the default `T3N_TRUST=manifest` every session command
  still fails at `fetchTrustedManifest` (item #1).
- **Not verified**: `deploy`, `authorize`, `onboard` and `logs` with a credited key — their request shapes follow the
  SDK d.ts (see `DISCREPANCIES.md` for where that differs from the docs).
