# Documentation and SDK issues found while building z-tenant-kyb

Scope: the ADK pages we used (local copies of quickstart, set-up-dev-env, adk-tour,
what-is-z-namespace, create-kv-maps, capabilities-from-wit-import, agent-auth-adk,
outbound-http-auth-by-user, common-errors), the reference contract
`Terminal-3/z-tenant-flight` (its README, `wit/`, `src/booking.rs`), and the published
SDK `@terminal3/t3n-sdk@5.10.0` (`dist/index.d.ts`, `README.md`, `package.json`, and the
runtime bundle evaluated locally). Line numbers refer to those files as of 2026-09-04.

Each item states what we could verify ourselves. Items marked *reported by others* come
from the bounty comments and were **not** reproduced by us. Nothing here was run against
a live node unless stated.

Severity: **High** = blocks or silently breaks the documented path; **Medium** =
contradiction that costs real debugging time; **Low** = gap or inconsistency.

---

## 1. Nested placeholder marker: reference contract vs host WIT (High)

**Where**

- `z-tenant-flight/src/booking.rs:80` -- `"email": "{{profile.verified_contacts.email.value}}"`
- `z-tenant-kyb/wit/deps/host-interfaces-2.1.0/package.wit:88-91` (same file the
  reference contract ships) -- `placeholder-denied(string)`: "A placeholder referenced a
  namespace other than `profile`, or used a malformed marker (nested / non-snake-case
  field)."
- `docs/adk-tour.md:31` -- shows only the flat form `{{profile.field}}` as its example
  and says nothing about nesting either way; the page links to a "Placeholders in
  outbound calls" guide (not in our local copy).
- SDK `README.md:172` -- the node "auto-stamps `verified_contacts.email`", i.e. the
  profile *stores* the e-mail nested.

**Problem.** The flagship example templates a three-level nested path, while the host
interface it calls documents nested markers as a `placeholder-denied` error. One of the
two is wrong, and a developer copying the example cannot tell which without a live node.

**Impact on us.** We made the e-mail marker opt-in (`include_email: true`) and only
template `{{profile.first_name}}` / `{{profile.last_name}}` by default.

**Suggested fix.** Publish the list of resolvable `{{profile.<field>}}` names next to
the WIT. If nested paths are supported, change the WIT comment to "dotted paths into
`verified_contacts` are allowed; everything else must be a flat snake_case field". If
they are not, change `booking.rs:80` to a flat alias (e.g. `{{profile.email}}`) and
document that alias.

## 2. Agent Auth page sends camelCase grant fields through a raw `execute` (High, not executed by us)

**Where**

- `docs/agent-auth-adk.md:58-73` -- `userClient.execute({ contract_id: "tee:user/contracts",
  function_name: "agent-auth-update", input: { agents: [{ agentDid, scripts: [{ scriptName,
  versionReq, functions, allowedHosts }] }] } })`.
- SDK `index.d.ts:1856-1866` -- `toAgentAuthUpdateWire`: "Serialise a camelCase policy
  document to the contract's canonical snake_case `agent-auth-update` wire (`agent_did` /
  `script_name` / `version_req` / ... / `allowed_hosts`)" and "`functions` and
  `allowed_hosts` are always emitted -- the contract ... reads an absent `allowed_hosts`
  as deny-all egress."
- SDK `index.d.ts:3918` -- `agentAuthUpdate(input: AgentAuthUpdateInput): Promise<void>`
  (typed, does the conversion) and `index.d.ts:~3897` `updateAgentAuth(agentDid, grant)`;
  both `@deprecated` in favour of `updateMemberDelegation` / `memberDelegationUpdate`.
- `docs/agent-auth-adk.md:93` admits the delegation surface "isn't confirmed or
  documented yet".

**Problem.** If the contract deserialises the snake_case wire strictly (the SDK comment
says the contract "requires explicit functions" and treats absent `allowed_hosts` as
deny-all), the documented camelCase payload would at best be ignored and at worst yield
a grant with deny-all egress -- exactly the `host/http.egress_denied` the page warns
about. We did not run this against a node; the SDK's own comments are the evidence.

**Suggested fix.** Replace the raw snippet with the typed helper the SDK ships (or the
non-deprecated `updateMemberDelegation`) and show the resulting snake_case wire once so
raw callers know the field names. Say explicitly whether `versionReq` is required.

## 3. Environment naming: `testnet` vs `sandbox` (Medium)

**Where**

- `docs/quickstart.md:57` `setEnvironment("testnet")`, `:64`
  `fetchTrustedManifest("testnet")`, `:87` "`setEnvironment("testnet" | "production")`
  ... defaults to `"testnet"`".
- SDK `README.md:112-115` -- "`sandbox` -- the public test network ...
  `setEnvironment("sandbox" | "production")`"; `README.md:49`
  `fetchTrustedManifest("sandbox", { baseUrl: ... })`.
- SDK `index.d.ts:5741` `type Environment = "sandbox" | "testnet" | "production"`;
  `:6025` `type TenantSdkEnvironment` identical; `package.json` `t3n.supportedEnvironments`
  = `["sandbox","testnet","production"]`.
- Runtime (evaluated locally with `node -e 'import("@terminal3/t3n-sdk")...'`):
  `DEFAULT_ENVIRONMENT = "testnet"`, `NODE_URLS.testnet === NODE_URLS.sandbox ===
  https://cn-api.sg.testnet.t3n.terminal3.io`.

**Problem.** Three names for two clusters. The quickstart is internally correct
(`testnet` is the default and is accepted), but the SDK README that npm shows never
mentions `testnet`, and `sandbox` is an undocumented alias of the same URL. A reader who
follows the npm README and the docs in parallel assumes two different networks.

**Suggested fix.** Pick one public name (`testnet`), keep `sandbox` as a documented
alias in the `Environment` type comment, and update SDK `README.md:108-118` to match the
quickstart. Also state in one place that `fetchTrustedManifest(env)` throws when an
environment has no pinned operator key (`index.d.ts:5878-5881`).

## 4. Common errors: "`T3nClient` doesn't take a `baseUrl`" is false (Medium)

**Where**

- `docs/common-errors.md:49` -- "`T3nClient` ... doesn't take a `baseUrl` at all; it's
  always resolved from the active environment."
- SDK `index.d.ts:759-761` -- `interface T3nClientConfig { /** Base URL of the T3n node
  (used if transport not provided) */ baseUrl?: string; ... }`.
- SDK `README.md:46` and `:116-118` -- `new T3nClient({ baseUrl: ..., trustAnchor: ... })`,
  "`baseUrl` takes precedence over the environment default".

**Problem.** The row's advice for `TenantClient` (pass `baseUrl: getNodeUrl()`) is fine
and matches `set-up-dev-env.md:50`; the parenthetical about `T3nClient` contradicts the
types and the README. `TenantClientConfig` (`index.d.ts:6043-6060`) also has
`environment?` and `endpoint?`, neither mentioned in the docs.

**Suggested fix.** Reword the row: "`T3nClient` resolves its node from `setEnvironment()`
unless you pass `baseUrl`; `TenantClient` does not inherit that, so pass `baseUrl:
getNodeUrl()` (or `environment`) explicitly."

## 5. Egress model wording and missing typed placeholder errors (Medium)

**Where**

- `docs/outbound-http-auth-by-user.md:7` -- "Your TEE contract does not declare which
  hosts it may call ... resolved, on every call, from the calling user's authorization
  grant."
- `wit/deps/host-interfaces-2.1.0/package.wit:60-62` -- "Egress is gated by the existing
  per-contract `http_allow_list` (same allowlist plain `http` uses)"; `:85-86`
  `egress-denied`: "Target host is not on the contract's `http_allow_list`."
- `docs/common-errors.md:22` lists only the string form `host/http.egress_denied: host
  '<host>' is not in the authorised_hosts allowlist`.
- `package.wit:84-105` -- `http-with-placeholders` returns a typed variant:
  `egress-denied`, `placeholder-denied`, `placeholder-unknown`,
  `placeholder-no-user-context`, `upstream-error`. None of the four placeholder cases
  appear on the Common errors page. Plain `http` returns `result<response, string>`
  (`package.wit:60`), so its string form is consistent.

**Problem.** Docs say "per-user grant", WIT says "per-contract allowlist", and the error
page gives three different names (`authorised_hosts`, `http_allow_list`,
`allowedHosts`). A developer hitting `placeholder-no-user-context` (e.g. when calling
from a tenant session instead of through a user grant) has nowhere to look it up.

**Suggested fix.** One paragraph: "the host materialises the calling user's grant
(`allowedHosts`) into the contract's per-call `http_allow_list`" -- then add four rows
to Common errors for the `http-with-placeholders` variants with the fix for each
(missing profile field -> user must complete profile; no user context -> call through a
user session / grant; placeholder denied -> only `profile.*`, flat snake_case).

## 6. `wasi:*` imports of a `wasm32-wasip2` component are undocumented (Medium)

**Where**

- `wasm-tools component wit target/wasm32-wasip2/release/z_tenant_kyb.wasm` (our build,
  reference contract uses the same `Cargo.toml` shape and `.cargo/config.toml`):
  besides the five `host:*` imports the component imports `wasi:io/poll@0.2.9`,
  `wasi:clocks/monotonic-clock@0.2.9`, `wasi:io/error@0.2.9`, `wasi:io/streams@0.2.9`,
  `wasi:cli/{stdout,stderr,stdin,environment,exit,terminal-*}@0.2.9`.
- `grep -ri wasi docs/` -> only `set-up-dev-env.md:31` (`rustup target add wasm32-wasip2`).
  `capabilities-from-wit-import.md:11` says the linker world is chosen from the
  `host:*` imports; nothing says whether `wasi:*` is linked, stubbed or rejected.

**Problem.** The capability page's model ("your imports are your capabilities") is
incomplete for every contract built with Rust `std`: the component asks for stdio,
environment, clocks and exit. A reviewer auditing "what can this contract do" needs to
know these are satisfied by the runtime and inert.

**Suggested fix.** Add to "Capabilities come from your WIT imports": "Components built
with the Rust standard library on `wasm32-wasip2` also import `wasi:cli`, `wasi:io` and
`wasi:clocks` @0.2.x. The node links them with [stubs / a sandboxed implementation];
they grant no network or file access. If you want a smaller import set build with
`#![no_std]` / `panic = "abort"`."

## 7. Claim page: three URLs and two sign-in stories (Medium; SSO detail reported by others)

**Where**

- `docs/quickstart.md:15`, `set-up-dev-env.md:15`, `agent-auth-adk.md:16`,
  `common-errors.md:23` -> internal link `/developers/adk/get-started/prerequisites/request-test-tokens`.
- SDK `README.md:25-27` -> `https://www.terminal3.io/claim-page` "sign in with your work
  email; your key is issued instantly".
- Bounty brief / comments -> `https://go.terminal3.io/adk-community` with Google SSO only
  (*reported by others; we did not verify which providers the page offers*).

**Problem.** The npm README and the docs disagree on where to claim and how to sign in.
A "work email" reader on a non-Google domain may be blocked.

**Suggested fix.** Use one canonical URL everywhere and state the supported identity
providers on that page and in `README.md:25-27`.

## 8. Reference contract README is stale in three places (Medium)

**Where** (`z-tenant-flight/README.md`)

- `:3` "v0.3.0" vs `Cargo.toml:3` `version = "0.4.1"` vs `wit/world.wit` `package
  z:tenant-flight@0.4.0` -- three different versions in one repo.
- `:18-26` "Host-capability manifest -- Declare in your contract manifest
  `{ "host_capabilities": [...] }`" vs `docs/capabilities-from-wit-import.md:9` "You
  don't declare capabilities in a manifest -- there isn't one."
- `:16` "passenger PII ... is passed in by the agent" and `:88-106` a `book-offer` input
  full of `given_name` / `passport_number` / `email`, vs `wit/world.wit` `book-offer`
  doc "Carries NO passenger PII" and `src/booking.rs:76-80` placeholder markers.
- `:54` `cargo test --lib` -- with `.cargo/config.toml` setting `target =
  "wasm32-wasip2"` (identical in both repos), this builds the test binary as a WASI
  component and fails to run it. Reproduced in our crate (same config): `could not
  execute process 'target/wasm32-wasip2/debug/deps/z_tenant_kyb-….wasm' (never
  executed) ... Permission denied (os error 13)`. `cargo test --target <host-triple>
  --lib` is required.

**Suggested fix.** Regenerate the README from the WIT: drop the manifest section, show
the placeholder-based `book-offer` input, align the version, and write the test command
as `cargo test --target $(rustc -vV | sed -n 's/host: //p') --lib`.

## 9. `map-entry-set`: control-plane call vs typed helper (Low)

**Where**

- `docs/create-kv-maps.md:26` -- "`tenant.executeControl("map-entry-set", ...)` ...
  that's how seeding the API key works" (the seed page itself is not in our local copy).
- SDK `index.d.ts:6369` -- `entrySet(tail: string, key: string, value: string, opts?)`
  on `TenantMapsNamespace`, documented as an "SDK-only addition ... so `set` / `get` /
  `getStatus` are all first-class"; `:6379-6383` `entryGet` "requires the paired
  contract-side 1.24.0-or-later registration"; `:6579` `executeControl(functionName,
  input)` still exists.

**Problem.** Both work; the docs teach the low-level one. The typed helper also encodes
the canonical name for you (`canonicalNameForTarget`), which is where the
`canonical map name invalid` error in `common-errors.md:18` comes from.

**Suggested fix.** Show `await tenant.maps.entrySet("secrets", "duffel_api_key", key)`
as the primary form and keep `executeControl` as the escape hatch.

## 10. `getAuditEvents` exists in the SDK (Low; the "unverified" note is on a page we do not have locally)

**Where** -- SDK `index.d.ts:3077` `getAuditEvents(opts?: GetAuditEventsOptions):
Promise<AuditPage>`; options `:2436-2445` (`pii_did`, `limit`, `cursor`), payload sealed
to the session key per the doc comment at `:3070-3076`.

**Suggested fix.** Mark it verified on the reference page with that signature; note that
`pii_did` lets a delegated agent read the events it performed for a user while the grant
is live.

## 11. SDK version history (Low; partially verified)

**Where** -- `node_modules/@terminal3/t3n-sdk/package.json` `"version": "5.10.0"`;
`sdk-probe/package-lock.json:471-474` resolved from
`https://registry.npmjs.org/@terminal3/t3n-sdk/-/t3n-sdk-5.10.0.tgz`. The changelog page
that says there is no verified version history is not in our local copy.

**Suggested fix.** Generate the version list from `npm view @terminal3/t3n-sdk time` and
link the published `README.md` for each; at minimum state the current version and the
minimum version the testnet accepts (see item 12).

## 12. `contracts.register` input matches the docs; result shape and `source_hash` are undocumented (Low)

**Where** -- SDK `index.d.ts:6133-6143` `ContractPublishInput { tail; version; wasm:
Uint8Array | Blob; source_hash?: string }`; `:6187-6191` `ContractRegisterResult { name:
"z:<tid>:<tail>"; contract_id: number }`; `:6398-6399` `publish` and `register` are
aliases. `docs/common-errors.md:15` correctly names the `version` field.

**Not a bug.** Worth documenting: the numeric `contract_id` that `maps.create` ACLs
(`create-kv-maps.md:13-14`) expect, and that `source_hash` "never gates execution".

## 13. Contract logs are off by default; nothing in the docs says so (Low)

**Where** -- SDK `index.d.ts:6463-6471` `contracts.logs`: "Requires the tenant's
`log_max_entries` quota to be non-zero (the master enable; logs are off by default);
returns an empty `entries` array when the feature is disabled". `grep -rn
log_max_entries docs/` -> no hits.

**Suggested fix.** One line in Common errors: "`contracts.logs` returns `entries: []`
until the operator raises `log_max_entries` for your tenant."

---

## Things that checked out

- `docs/set-up-dev-env.md:54` `tenant.tenant.me()` -> `index.d.ts:6347`.
- `docs/common-errors.md:20` `tenant.maps.update` -> `index.d.ts:6353` (`create` is `:6352`).
- `docs/create-kv-maps.md:10-15` field names (`tail`, `visibility`, `writers`, `readers`)
  -> `index.d.ts:6101-6113`; the SDK warns on a missing `readers` exactly as the page says.
- `docs/common-errors.md:48` hex-encoding `tenant_did()` -> matches `package.wit`
  (`tenant-did: func() -> list<u8>`) and our `onboard.rs::secrets_map_name`.
- Quickstart symbol list (`T3nClient`, `setEnvironment`, `loadWasmComponent`,
  `eth_get_address`, `metamask_sign`, `createEthAuthInput`, `fetchTrustedManifest`) ->
  all exported by `index.d.ts:6594`, signatures at `:249`, `:375`, `:4190`, `:4201`,
  `:5897`, `:5968`.
- `contracts.execute(tail, { version, functionName, input })` -> `index.d.ts:6178-6182`,
  `:6486`.
