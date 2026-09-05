# DOC_SYNC — pending find/replace pairs for the Google Doc (mirror of docs/SUBMISSION.md)

`docs/SUBMISSION.md` is not edited directly. Apply each pair by hand in the Google Doc,
then apply the same pair to `docs/SUBMISSION.md` so the two stay identical. Each FIND is
exact text that occurs once in the current document.

## 1. Screenshots, item 8 — audit result on a self-call

FIND: 8. `kyb logs` — contract log lines from inside the TEE (no PII), `kyb audit` — audit read as the agent.

REPLACE: 8. `kyb logs` — contract log lines from inside the TEE (no PII), `kyb audit` — audit read as the agent (it returned an empty batch list on this self-call).

## 2. Maintenance and handover — what was and was not exercised

FIND: with fixture tests for every parser, one secret to change to point at a real ERP.

REPLACE: with fixture tests for every parser, one secret to change to point at a real ERP.

What was and was not exercised: the live run used one identity for tenant, agent and data owner (self-grant, `pii_did` = the caller's own DID) because separately generated identities start with zero credits. The delegated path — agent DID ≠ data-owner DID, `pii_did` set to the owner, placeholders resolved from another profile, egress via the owner's grant — is untested, as is the no-grant failure (expected `host/http.egress_denied` / `PlaceholderNoUserContext`). `docs/HANDOVER.md` section 6 has the full list.

## 3. Bugs, item 0b — claim-page claim is observed once plus reported, not independently verified

FIND: but the page is Google-SSO only and rate-limited to one signup per e-mail, so a second identity cannot be funded without a second Google account or a manual top-up

REPLACE: but the page appears to issue one key per e-mail via Google SSO (observed with our single account and reported by other entrants; not verified beyond one account), so a second identity cannot be funded without a second account or a manual top-up

## 4. Code hardening (2026-09-05) — test count and component size

FIND: 19 native unit tests cover the parsers

REPLACE: 24 native unit tests cover the parsers

## 5. Code hardening (2026-09-05) — component size after the notes guard and GLEIF best-match

FIND: 154 KB (157,768 byte) component

REPLACE: 160 KB (163,671 byte) component

## 6. Verification list, item 2 — CLI unit tests

FIND: `cargo test --target x86_64-apple-darwin --lib` — all native tests pass;

REPLACE: `cargo test --target x86_64-apple-darwin --lib` — all native tests pass; `cd cli && npm test` — 56 vitest unit tests for the CLI helpers (key classification, secret redaction, ERP echo-host guard, error hints) pass;

## 7. Deliverables list, item 2 — component size in the prose line

FIND: -> 154 KB component, validated with `wasm-tools`.

REPLACE: -> 160 KB component, validated with `wasm-tools`.
