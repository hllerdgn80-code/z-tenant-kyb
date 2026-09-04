# X thread (bonus)

Post as a 2-tweet thread. Attach the `wasm-tools component wit` screenshot to tweet 1
and the `kyb screen` (or `--dry-run`) screenshot to tweet 2. Repo URL:
https://github.com/hllerdgn80-code/z-tenant-kyb.

## Tweet 1

Built a vendor KYB agent on @terminal3io's new ADK docs for the @SuperteamEarn bounty.

Rust TEE contract: screens suppliers via EU VIES + GLEIF, then registers them in the ERP; the enclave fills in the signatory's name via {{profile.*}} placeholders. No PII in the agent, ever.

## Tweet 2

Repo + handover runbook + doc bug report: https://github.com/hllerdgn80-code/z-tenant-kyb

19 native tests, 154 KB wasm32-wasip2 component, operator CLI with --dry-run. Handing it to Terminal 3 to host; happy to keep maintaining it.

Docs feedback inside (nested placeholders, env naming, wasi imports).
