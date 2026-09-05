# Discrepancies: docs vs `@terminal3/t3n-sdk` (5.10.0 reviewed, 5.2.0 pinned) vs testnet

Recorded while building the operator CLI on 2026-09-04. "docs" = the ADK pages (quickstart,
set-up-dev-env, create-kv-maps, agent-auth-adk, common-errors, outbound-http-auth-by-user,
what-is-z-namespace, adk-tour). "d.ts" = `node_modules/@terminal3/t3n-sdk/dist/index.d.ts` of
**5.10.0**, which the task defines as ground truth; the CLI runs on **5.2.0** (item 1). Where they
disagree the CLI follows the d.ts. This is the short, CLI-facing list; the long form with file/line
evidence, suggested fix text and a status per item is `docs/BUGS.md`:

| here | `docs/BUGS.md` | here | `docs/BUGS.md` |
|---|---|---|---|
| #1 trust manifest | #0 | #7 map ACL order | #12 |
| #2 grant casing | #2 | #8 admission / credits | #0b |
| #3 `pii_did` | #5 | #9 TenantClient config | #4 |
| #4 key shapes | #7 | #10 audit / logs | #10, #13 |
| #5 env names | #3 | #11 placeholders | #1 |
| #6 `map-entry-set` | #9 | #12 environment notes | -- |

## 1. Testnet's trust manifest is rejected by SDK >= 5.3.0 (worked around: pinned 5.2.0)

- `fetchTrustedManifest("testnet")` (and `resolveTrustAnchor("testnet")`) throw
  `Trust manifest at https://cn-api.sg.testnet.t3n.terminal3.io/api/trust-manifest is malformed.`
- The served document (`GET /api/trust-manifest`, `version: 1787800421`, `signed_at: 2026-08-27T03:13:41Z`)
  has the keys `cluster, version, peer_ids, rtmr3_allowlist, signed_at, signature` — **no `rtmr1_allowlist`**,
  which `SignedTrustManifest` in the d.ts declares as required ("the real rootfs signal").
- Consequences on 5.3.0+: the quickstart's `new T3nClient({ trustAnchor: await fetchTrustedManifest("testnet"), … })`
  cannot be constructed, so **every** documented flow (quickstart, TenantClient, register, agent auth,
  invoke) fails at step one with the latest SDK on testnet. On 5.2.0 it works (bisection below).
- No client-side workaround exists on 5.3.0+: `manifestToTrustAnchor(served)` accepts the document, but the
  `T3nClient` constructor then rejects the projected anchor
  (`trustAnchor … must be either a TrustAnchor ({ expected_peer_ids, rtmr3_allowlist, rtmr1_allowlist })`),
  also with `rtmr1_allowlist: []`. `verifyManifestSignature()` needs the operator key, and
  `OPERATOR_PUBLIC_KEYS` is not exported.
- The SDK really does check RTMR1 against the node's quote: with a non-empty dummy `rtmr1_allowlist: ["00"]` the
  constructor accepts the anchor and `handshake()` then fails at attestation with
  `DKG attestation verification failed … rtmr1_allowlist base64 decode: Invalid padding`. So a real allowlist
  value published by the operator is the only strict-mode fix; nothing client-side can substitute for it.
- Before the bisection we confirmed the node itself is healthy: `/status` → 200, and `{ unsafe_trust_server: true }`
  completes a handshake in ~1 s. The fix is on the operator side (publish a manifest with `rtmr1_allowlist`) or in the
  SDK (accept manifests that predate the field, as `manifestToTrustAnchor` already does).
- **Regression bisected (2026-09-04):** `fetchTrustedManifest("testnet")` succeeds on **5.2.0** (returns
  `expected_peer_ids, rtmr3_allowlist, source`) and fails on **5.3.0, 5.4.0, 5.5.0, 5.8.0, 5.10.0** with the same
  "malformed" error. So the breaking change shipped in 5.3.0 (2026-08-28), one day after the manifest was signed.
  The CLI therefore pins **5.2.0** and keeps verified attestation (`T3N_TRUST=manifest`); `unsafe` stays a debug switch.
- **Live confirmation with 5.2.0:** tenant handshake+auth, `contracts.register` (contract_id 879), `maps.create/entrySet`,
  the `agent-auth-update` grant, `screen-vendor` (VIES + GLEIF called from inside the enclave) and `submit-onboarding`
  (placeholders resolved, ERP echo HTTP 200) all succeeded on testnet on 2026-09-04.
- CLI: `T3N_TRUST=manifest` (default, strict) vs `T3N_TRUST=unsafe` (explicit, logged, refused on production);
  `kyb doctor` reports the missing fields and warns when the installed SDK differs from the pin. Upgrade condition:
  move to the latest SDK once the node publishes `rtmr1_allowlist`.

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
  `pii_did` the agent's call is a self call; the expected failure is `egress_denied` / `PlaceholderNoUserContext`
  (expected from the WIT / d.ts, not observed — our live run always sent `pii_did`).
- CLI: sends `contract_version = CONTRACT_VERSION` and `pii_did = <data owner DID>`. Live, `pii_did` equalled the
  caller's own DID (one identity for all roles); a `pii_did` of another user is untested (`docs/HANDOVER.md` section 6).

## 4. Two different things are called "API key"

- quickstart / agent-auth: `eth_get_address(T3N_API_KEY)` → the key is a 64-hex secp256k1 private key.
- d.ts `invoke()` / `discoverWhoami()` / `InvokeOptions.apiKey`: "the agent's opaque API key (`t3n_key_<…>`)",
  relayed in `X-T3N-Api-Key`; `eth_get_address("t3n_key_…")` throws `Invalid Ethereum private key`.
- The claim page is not in the local docs. Observed 2026-09-04: the key it issued is a 0x-prefixed 64-hex private key
  (`doctor`: "66 chars, eth-private-key"), i.e. the quickstart's shape; when a `t3n_key_…` token is issued is still unknown.
- CLI: classifies each key (`eth-private-key` | `t3n-api-key`) and routes `screen`/`onboard`/`authorize` accordingly.

## 5. Environment names

- SDK README: environments are `sandbox | production`, example `fetchTrustedManifest("sandbox", { baseUrl })`.
- quickstart: `setEnvironment("testnet")`; d.ts `Environment = "sandbox" | "testnet" | "production"`;
  `NODE_URLS` maps **sandbox and testnet to the same host** (`cn-api.sg.testnet.t3n.terminal3.io`).
- `fetchTrustedManifest("sandbox")` fails identically to item 1 on SDK >= 5.3.0.

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
  plus a separate org-scoped `getActivityLog`. CLI guards with a runtime `typeof` check. Live: it works and returned
  `{"batches":[],"next_cursor":null}` on a self-call (`docs/run-logs/audit.txt`).
- `contracts.logs()` returns nothing unless the tenant quota `log_max_entries` is non-zero — only the d.ts says so.
  Live: our freshly claimed testnet tenant got 10 entries back without any quota change (`docs/run-logs/logs.txt`).

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
- Verified against testnet without keys: `/status` 200; manifest shape (item 1); on 5.10.0 the handshake is refused
  with the projected manifest anchor and with a dummy `rtmr1_allowlist`.
- Verified live on testnet, 2026-09-04, SDK 5.2.0, `T3N_TRUST=manifest`, claimed tenant key (logs in
  `docs/run-logs/`): `doctor`; `deploy` (`contracts.register` → contract_id 879, `maps.create` + `entrySet`);
  `authorize` (`updateAgentAuth`); `screen` (VIES + GLEIF from inside the enclave, a valid and an invalid vendor);
  `onboard` (placeholders resolved, echo ERP HTTP 200); `logs` (10 entries); `audit` (empty batch list).
- Verified only up to the node's validation, with unclaimed keys earlier the same day: the execute dispatch checks
  the contract id (`-32601 tenant contract z:0000…:kyb not registered`, request_id
  `6d25b431-8e2e-41cf-a0f3-5c05f37c4c6b`; `-32602 z: <tid> must be 40 lowercase hex chars, got 8`), and `tenant.me()`
  on an unclaimed key is `InsufficientCredit` (item 8).
- Assumed, not exercised: the delegated path with three distinct identities (agent DID != data-owner DID,
  `pii_did` = the owner, placeholders from another profile); the no-grant failure (`egress_denied` /
  `PlaceholderNoUserContext`); the nested e-mail marker; an `erp_api_key` bearer; a real ERP. See
  `docs/HANDOVER.md` section 6.
