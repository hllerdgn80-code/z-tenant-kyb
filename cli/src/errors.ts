import { RpcError } from "@terminal3/t3n-sdk";
import { loadConfig, type Config } from "./env.js";

/** Substring → actionable hint. Matched against the error chain and the node's `detail` only (common-errors.md + SDK d.ts notes). */
const HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/not higher than current version/i, "Already registered at this or a newer version. Bump CONTRACT_VERSION (and CONTRACT_VERSION in src/lib.rs) to publish a new build; a re-run at the same version is a no-op."],
  [/map already exists/i, "Idempotent: the map exists — safe to ignore."],
  [/map not found/i, "Map tail mismatch: the contract reads z:<tid>:secrets and `kyb deploy` creates tail \"secrets\" — check both."],
  [/egress_denied|authorised_hosts/i, "The subject user's grant does not list this host. Run `kyb authorize` (grants ec.europa.eu, api.gleif.org and the ERP host) and call with --on-behalf-of <user DID>."],
  [/InsufficientCredit/i, "Metered calls are charged to the CALLING identity — the one named by `account=` in the detail has no test credits. Claim a key for that identity at https://go.terminal3.io/adk-community (tenant: `kyb deploy --claim` tries the testnet self-admit; the agent DID needs its own key/credits, never the tenant's)."],
  [/access denied: .* cannot (read|write) map/i, "The contract id is not on the map's readers/writers ACL. Re-run `kyb deploy` (it syncs the ACL to the registered contract id)."],
  [/placeholder|no user context/i, "Placeholders resolve only on a delegated call: pass --on-behalf-of <user DID> (or set USER_DID) so the host has a profile to substitute."],
  [/unknown field|deny_unknown_fields|missing field|Invalid action request/i, "Wire-shape mismatch between @terminal3/t3n-sdk and this node — testnet may lag the SDK. See cli/DISCREPANCIES.md and report the request_id in the developer Telegram."],
  [/trust manifest .* is malformed/i, "The node served a trust manifest that SDK >= 5.3.0 rejects (testnet, 2026-09-04: no rtmr1_allowlist). This CLI pins 5.2.0, the last compatible version — if you upgraded the SDK, downgrade or set T3N_TRUST=unsafe (testnet only; refused on production). See cli/DISCREPANCIES.md #1."],
  [/manifest .*(signature|verif)|signature .*manifest/i, "The manifest signature does not verify against the SDK-pinned operator key: the cluster rolled its key, or something sits between you and the node. Re-fetch; if it persists report it in the developer Telegram."],
  [/attestation verification|rtmr|trust anchor|tdx quote/i, "Node attestation verification failed: the TDX quote does not match the pinned peer IDs / RTMR allowlist. Testnet and the SDK may disagree — see cli/DISCREPANCIES.md."],
  [/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed? ?out|aborted/i, "Network: the host could not be reached. Check connectivity, T3N_ENV, and that no proxy blocks HTTPS."],
  [/Invalid Ethereum private key/i, "The key is not a 64-hex secp256k1 private key. The session flow needs that form; an opaque t3n_key_… key works only for agent calls (screen/onboard route those through invoke() automatically)."],
  [/invoke request failed/i, "invoke() hides the response body by design. HTTP 400/401/403 here usually means AGENT_KEY is not a valid t3n_key_… for this node, or contract_id/contract_version is not registered — check `kyb doctor` and `kyb deploy`."],
  [/tenant is suspended/i, "The operator suspended this tenant — ask them to resume it."],
  [/quota exceeded/i, "A per-tenant quota is exhausted — ask the cluster operator to raise it."],
  [/not (a )?tenant|not admitted|tenant .*not found/i, "This DID is not admitted as a tenant yet — try `kyb deploy --claim` (testnet self-admit via tenant.claim())."],
];

/** Every message down the `cause` chain, outermost first. */
export function messageChain(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur !== undefined && cur !== null && depth < 6; depth++) {
    parts.push(cur instanceof Error ? (cur.name === "Error" ? cur.message : `${cur.name}: ${cur.message}`) : String(cur));
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return parts.join(" ← ");
}

function findRpcError(e: unknown): RpcError | undefined {
  let cur: unknown = e;
  for (let depth = 0; cur instanceof Error && depth < 6; depth++) {
    if (cur instanceof RpcError) return cur;
    cur = cur.cause;
  }
  return undefined;
}

/** Replace every configured secret in `text` with a marker. Belt and braces: the SDK already redacts key material. */
export function redact(text: string, secrets: ReadonlyArray<string | undefined>): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("[redacted]");
  return out;
}

/** Every configured secret, for redaction. */
export type Secrets = ReadonlyArray<string | undefined>;
export function secretsOf(cfg: Config | undefined): Secrets {
  return cfg ? [cfg.t3nApiKey, cfg.agentKey, cfg.userKey, cfg.erpApiKey] : [];
}

/** Human explanation of any thrown value: message chain, RPC facts, then hints. Never throws. */
export function explainError(e: unknown, secrets: Secrets = []): string {
  const rpc = findRpcError(e);
  // Hints are matched against the error itself, never against the CLI's own lines below
  // (the "quote this when reporting" line once matched every /quote/ hint).
  const haystack = [messageChain(e), rpc?.detail ?? ""].join("\n");
  const lines = [messageChain(e)];
  if (rpc) {
    if (rpc.rpcMethod) lines.push(`rpc method: ${rpc.rpcMethod}`);
    if (rpc.httpStatus !== undefined) lines.push(`status: ${rpc.httpStatus}`);
    if (rpc.detail) lines.push(`detail: ${rpc.detail}`);
    if (rpc.requestId) lines.push(`request_id: ${rpc.requestId}  (quote this when reporting the bug)`);
  }
  for (const [re, hint] of HINTS) if (re.test(haystack)) lines.push(`hint: ${hint}`);
  return redact(lines.join("\n"), secrets);
}

/** Load the config and run a command body; any failure prints a clear explanation to stderr and sets exit code 1. */
export async function runCommand(body: (cfg: Config) => Promise<void>): Promise<void> {
  let cfg: Config | undefined;
  try {
    cfg = loadConfig();
    await body(cfg);
  } catch (e) {
    process.stderr.write(`error: ${explainError(e, secretsOf(cfg))}\n`);
    process.exitCode = 1;
  }
}
