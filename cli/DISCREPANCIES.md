# Discrepancies: docs vs `@terminal3/t3n-sdk` 5.10.0 vs testnet

Recorded while building the operator CLI on 2026-09-04. "docs" = the ADK pages (quickstart,
set-up-dev-env, create-kv-maps, agent-auth-adk, common-errors, outbound-http-auth-by-user,
what-is-z-namespace, adk-tour). "d.ts" = `node_modules/@terminal3/t3n-sdk/dist/index.d.ts`, which
the task defines as ground truth. Where they disagree the CLI follows the d.ts. Items 1–3 are
blockers or near-blockers; the rest are paper cuts that cost time.

## 1. BLOCKER — testnet's trust manifest is rejected by SDK 5.10.0

- `fetchTrustedManifest("testnet")` (and `resolveTrustAnchor("testnet")`) throw
  `Trust manifest at https://cn-api.sg.testnet.t3n.terminal3.io/api/trust-manifest is malformed.`
- The served document (`GET /api/trust-manifest`, `version: 1787800421`, `signed_at: 2026-08-27T03:13:41Z`)
  has the keys `cluster, version, peer_ids, rtmr3_allowlist, signed_at, signature` — **no `rtmr1_allowlist`**,
  which `SignedTrustManifest` in the d.ts declares as required ("the real rootfs signal").
- Consequences: the quickstart's `new T3nClient({ trustAnchor: await fetchTrustedManifest("testnet"), … })`
  can never be constructed, so **every** documented flow (quickstart, TenantClient, register, agent auth,
  invoke) fails at step one with the current SDK on testnet.
- No verified workaround exists in the SDK: `manifestToTrustAnchor(served)` accepts the document, but the
  `T3nClient` constructor then rejects the projected anchor
  (`trustAnchor … must be either a TrustAnchor ({ expected_peer_ids, rtmr3_allowlist, rtmr1_allowlist })`),
  also with `rtmr1_allowlist: []`. `verifyManifestSignature()` needs the operator key, and
  `OPERATOR_PUBLIC_KEYS` is not exported.
- The SDK really does check RTMR1 against the node's quote: with a non-empty dummy `rtmr1_allowlist: ["00"]` the
  constructor accepts the anchor and `handshake()` then fails at attestation with
  `DKG attestation verification failed … rtmr1_allowlist base64 decode: Invalid padding`. So a real allowlist
  value published by the operator is the only strict-mode fix; nothing client-side can substitute for it.
- What does work: `{ unsafe_trust_server: true }` — handshake completes in ~1 s. The node itself is healthy
  (`/status` → 200). So the fix is on the operator side (publish a manifest with `rtmr1_allowlist`) or in the
  SDK (accept manifests that predate the field, as `manifestToTrustAnchor` already does).
- **Regression bisected (2026-09-04):** `fetchTrustedManifest("testnet")` succeeds on **5.2.0** (returns
  `expected_peer_ids, rtmr3_allowlist, source`) and fails on **5.3.0, 5.4.0, 5.5.0, 5.8.0, 5.10.0** with the same
  "malformed" error. So the breaking change shipped in 5.3.0 (2026-08-28), one day after the manifest was signed.
  The CLI therefore pins **5.2.0** and keeps verified attestation (`T3N_TRUST=manifest`); `unsafe` stays a debug switch.
- **Live confirmation with 5.2.0:** tenant handshake+auth, `contracts.register` (contract_id 879), `maps.create/entrySet`,
  the `agent-auth-update` grant, `screen-vendor` (VIES + GLEIF called from inside the enclave) and `submit-onboarding`
  (placeholders resolved, ERP echo HTTP 200) all succeeded on testnet on 2026-09-04.
- CLI: `T3N_TRUST=manifest` (default, strict) vs `T3N_TRUST=unsafe` (explicit, logged, refused on production);
  `kyb doctor` reports the missing fields.

## 2. Agent grant: contract, casing and deprecation differ

- docs (agent-auth-adk): the data owner runs
  `userClient.execute({ contract_id: "tee:user/contracts", contract_version, function_name: "agent-auth-update", input: { agents: [{ agentDid, scripts: [{ scriptName, versionReq, functions, allowedHosts }] }] } })`
  — camelCase input, on `tee:user/contracts`.
- d.ts: `toAgentAuthUpdateWire()` says the contract's wire is **snake_case** (`agent_did`, `script_name`,
  `version_req`, `allowed_hosts`) and the typed helpers `updateAgentAuth()` / `agentAuthUpdate()` dispatch on
  **`tee:authorisations/contracts`**, not `tee:user/contracts`. Both helpers are `@deprecated` in favour of
  `updateMemberDelegation(BoundGrant)` (`grantee`, `contract_id`, `functions`, `scopes`, `allowed_hosts`,
  `version_req`), which no docs page mentions.
- Risk: the docs' raw call sends camelCase to a strict deserialiser ("Invalid action request: missing field"
  400s per the d.ts) — likely to fail as written.
- CLI: `updateAgentAuth(agentDid, grant)` (typed, read-merge-write, keeps other grants).

## 3. Agent invocation payload is under-specified in the docs

- docs: `agent.executeAndDecode({ contract_id: "z:<tid>:<tail>", function_name, input })`.
- d.ts (`executeUserContract` / `InvokeRequest`): the server deserialises **strictly** into
  `contract_id`, `contract_version` (SemVer — the literal `"latest"` is not accepted; `getContractVersion()` resolves it),
  `function_name`, optional `pii_did`, `input`. `contract_version` is missing from the docs' example.
- `pii_did` is also missing from the docs, yet outbound-http-auth-by-user says egress is resolved from the
  **subject user's** grant on a delegated call, and `http-with-placeholders` needs a user context. Without
  `pii_did` the agent's call is a self call → `egress_denied` / `PlaceholderNoUserContext`.
- CLI: sends `contract_version = CONTRACT_VERSION` and `pii_did = <data owner DID>`.

## 4. Two different things are called "API key"

- quickstart / agent-auth: `eth_get_address(T3N_API_KEY)` → the key is a 64-hex secp256k1 private key.
- d.ts `invoke()` / `discoverWhoami()` / `InvokeOptions.apiKey`: "the agent's opaque API key (`t3n_key_<…>`)",
  relayed in `X-T3N-Api-Key`; `eth_get_address("t3n_key_…")` throws `Invalid Ethereum private key`.
- The claim page is not in the local docs, so which shape it issues is unknown until a key is claimed.
- CLI: classifies each key (`eth-private-key` | `t3n-api-key`) and routes `screen`/`onboard`/`authorize` accordingly.

## 5. Environment names

- SDK README: environments are `sandbox | production`, example `fetchTrustedManifest("sandbox", { baseUrl })`.
- quickstart: `setEnvironment("testnet")`; d.ts `Environment = "sandbox" | "testnet" | "production"`;
  `NODE_URLS` maps **sandbox and testnet to the same host** (`cn-api.sg.testnet.t3n.terminal3.io`).
- `fetchTrustedManifest("sandbox")` fails identically to item 1.

## 6. Seeding secrets: raw control call vs typed helper

- docs (create-kv-maps note): `tenant.executeControl("map-entry-set", …)` with an undocumented input shape
  (`map_name`? `name`? `tail`?).
- d.ts: `tenant.maps.entrySet(tail, key, value)` — a typed wrapper for exactly that op; `entryGet` and
  `getStatus` exist too and "require the paired contract-side 1.24.0-or-later registration".
- The JS bundle is obfuscated (`/* t3n-sdk-obfuscated */`), so the wire field names cannot be confirmed
  locally. CLI uses `maps.entrySet`.

## 7. Map creation order and ACL

- docs: create the `secrets` map first with `readers/writers: { only: [contractId] }`, then register — but
  `contract_id` only exists after `contracts.register()` returns it (`ContractRegisterResult.contract_id`).
- d.ts: `readers` is optional but "omitting it is a footgun" (deny-all + `console.warn`); docs say REQUIRED.
- `maps.create` on an existing map: docs say `MapAlreadyExists`, common-errors says `map already exists`.
- CLI: register → getStatus → create or `maps.update` ACL → seed; matches `/already exists/i`.

## 8. Tenant admission is undocumented

- d.ts: `tenant.claim()` is typed `Promise<unknown>` (`index.d.ts:6346`); the result type
  `TenantSelfAdmitResult { status: "admitted" | "already-admitted", granted_credits }` exists at `:6077` but is not
  wired to the method ("testnet self-admit"); `tenant.me()` is `Promise<unknown>` too and "throws if something's wrong".
  Observed 2026-09-04: `tenant.me()` for an unclaimed key throws `InsufficientCredit (required=10000000000, available=0)`
  with HTTP 403 (request_id `fe3d0e55-16ec-4636-b99f-ed8e4eea7ff3`), i.e. admission is metered before it is checked.
- No docs page says a freshly claimed key may need `claim()` before `register`. CLI: `deploy --claim`,
  and `doctor` hints at it when `tenant.me()` fails.

## 9. `TenantClient` config

- set-up-dev-env: `{ t3n, baseUrl: getNodeUrl(), tenantDid }`; other pages: `{ t3n, tenantDid, environment }`;
  common-errors: "always pass `baseUrl`". d.ts: every field optional, validated per operation.
- Two naming conventions for the same request: `tenant.contracts.execute(tail, { version, functionName, input })`
  (camelCase) vs the session path's `{ contract_version, function_name }` (snake_case).
- CLI passes `t3n`, `baseUrl`, `tenantDid`, `environment`.

## 10. Audit / logs

- agent-auth: `getAuditEvents` "unverified". d.ts declares it (`audit.get-mine`, sealed, `{ pii_did?, limit?, cursor? }`)
  plus a separate org-scoped `getActivityLog`. CLI guards with a runtime `typeof` check.
- `contracts.logs()` returns nothing unless the tenant quota `log_max_entries` is non-zero — only the d.ts says so.

## 11. Placeholders

- docs' flagship example uses a nested marker (`{{profile.verified_contacts.email.value}}`); the host WIT for
  `http-with-placeholders` says nested markers are rejected with `placeholder-denied`. The contract makes the
  email marker opt-in (`--include-email`).

## 12. Environment notes (not T3N bugs, but they bite the docs' examples)

- VIES reported the SAP SE number `DE143593636` as `valid: false` (`name: "---"`) on 2026-09-04 while the
  service status showed DE available; `IE6388047V` (Google Ireland Limited) returned `valid: true` with a name.
  `doctor` probes the Irish number. German answers never include a name, so `NAME_MISMATCH` cannot be
  evaluated for DE vendors without `--lei`.
- Under npm 11, `esbuild`'s postinstall is skipped by the new install-scripts gate (warning only; `tsx` still runs).

## Verified vs assumed

- Verified offline: SDK loads under Node 26.7; `loadWasmComponent()` with no arguments; all exports used by the
  CLI exist at runtime; `toAgentAuthUpdateWire` output; `eth_get_address` rejects `t3n_key_…`.
- Verified against testnet: `/status` 200; manifest shape (item 1); handshake with `unsafe_trust_server`; handshake
  refused with the projected manifest anchor and with a dummy `rtmr1_allowlist`.
- Verified against testnet with arbitrary (unclaimed) secp256k1 keys under `unsafe_trust_server`: `authenticate`
  (a DID per key), `getAuditEvents` (`{"batches":[],"next_cursor":null}`), and the execute dispatch up to contract-id
  validation (`-32601 tenant contract z:0000…:kyb not registered`, request_id `6d25b431-8e2e-41cf-a0f3-5c05f37c4c6b`;
  `-32602 z: <tid> must be 40 lowercase hex chars, got 8`, request_id `13978ad5-…`).
- Blocked by credits only: `tenant.me()` / `contracts.logs` → `InsufficientCredit` (item 8).
- Not verified (needs a credited key): `register`, maps, `updateAgentAuth`, a contract call that actually runs.
