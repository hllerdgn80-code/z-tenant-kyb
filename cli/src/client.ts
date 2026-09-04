import {
  T3nClient,
  TenantClient,
  createEthAuthInput,
  discoverWhoami,
  eth_get_address,
  fetchTrustedManifest,
  getNodeUrl,
  invoke,
  loadWasmComponent,
  metamask_sign,
  setEnvironment,
  type TrustAnchorOrUnsafe,
  type WasmComponent,
} from "@terminal3/t3n-sdk";
import {
  KEY_VARS,
  classifyKey,
  defaultUserDid,
  requireKey,
  resolveScriptName,
  type Config,
  type ContractFunction,
  type KeyField,
} from "./env.js";

export interface Session {
  readonly t3n: T3nClient;
  /** did:t3n:… read back from the authenticated session — never derived. */
  readonly did: string;
  readonly nodeUrl: string;
}

let wasmOnce: Promise<WasmComponent> | undefined;
const wasm = (): Promise<WasmComponent> => (wasmOnce ??= loadWasmComponent());

/** Wrap one network step so a failure names the step and the node it hit. */
async function step<T>(label: string, nodeUrl: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new Error(`${label} failed against ${nodeUrl}`, { cause: e });
  }
}

/** Select the cluster (quickstart: setEnvironment) and return the resolved node URL. */
export function nodeUrlFor(cfg: Config): string {
  setEnvironment(cfg.env);
  return getNodeUrl();
}

/** Fields of SignedTrustManifest in SDK 5.10.0's d.ts — what fetchTrustedManifest validates against. */
export const MANIFEST_FIELDS = ["cluster", "version", "peer_ids", "rtmr3_allowlist", "rtmr1_allowlist", "signed_at", "signature"] as const;

export interface ManifestReport {
  readonly url: string;
  readonly version?: number;
  readonly signedAt?: string;
  readonly missing: string[];
  readonly manifest: Record<string, unknown>;
}

/** Fetch the node's served manifest without the SDK's schema check, and say which required fields it lacks. */
export async function inspectManifest(nodeUrl: string, timeoutMs = 10_000): Promise<ManifestReport> {
  const url = `${nodeUrl}/api/trust-manifest`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const manifest = (await res.json()) as Record<string, unknown>;
  const missing = MANIFEST_FIELDS.filter((f) => !(f in manifest));
  return {
    url,
    missing,
    manifest,
    ...(typeof manifest["version"] === "number" ? { version: manifest["version"] } : {}),
    ...(typeof manifest["signed_at"] === "string" ? { signedAt: manifest["signed_at"] } : {}),
  };
}

let warnedUnsafe = false;

/**
 * The trust anchor for T3nClient, per T3N_TRUST (see env.ts). Strict by default; the unsafe
 * downgrade is explicit, logged once per run, and rejected on production in loadConfig().
 * (A "pin the served manifest without verifying it" middle ground is impossible: the T3nClient
 * constructor rejects any anchor whose rtmr1_allowlist is missing or empty.)
 */
export async function trustAnchorFor(cfg: Config, nodeUrl: string): Promise<TrustAnchorOrUnsafe> {
  if (cfg.trust === "unsafe") {
    if (!warnedUnsafe) {
      warnedUnsafe = true;
      console.error(`warning: T3N_TRUST=unsafe — node attestation for ${nodeUrl} is NOT verified in this run`);
    }
    return { unsafe_trust_server: true };
  }
  return step("fetchTrustedManifest", nodeUrl, () => fetchTrustedManifest(cfg.env));
}

/** Quickstart flow: trust anchor → T3nClient → handshake → authenticate → DID from the session. */
export async function openSession(cfg: Config, field: KeyField): Promise<Session> {
  const key = requireKey(cfg, field);
  const kind = classifyKey(key);
  if (kind !== "eth-private-key") {
    const what = kind === "t3n-api-key" ? "an opaque t3n_key_… API key" : "not a 64-hex secp256k1 private key";
    throw new Error(`${KEY_VARS[field]} is ${what}; the session flow (handshake + authenticate) needs the private-key form.`);
  }
  const nodeUrl = nodeUrlFor(cfg);
  const address = eth_get_address(key);
  const trustAnchor = await trustAnchorFor(cfg, nodeUrl);
  const t3n = new T3nClient({
    trustAnchor,
    wasmComponent: await wasm(),
    handlers: { EthSign: metamask_sign(address, undefined, key) },
  });
  await step("handshake", nodeUrl, () => t3n.handshake());
  const did = await step("authenticate", nodeUrl, () => t3n.authenticate(createEthAuthInput(address)));
  return { t3n, did: did.value, nodeUrl };
}

export interface TenantSession extends Session {
  readonly tenant: TenantClient;
}

/** Tenant (contract owner) session + TenantClient (set-up-dev-env.md; baseUrl passed explicitly per common-errors.md). */
export async function openTenant(cfg: Config): Promise<TenantSession> {
  const s = await openSession(cfg, "t3nApiKey");
  const tenant = new TenantClient({ t3n: s.t3n, baseUrl: s.nodeUrl, tenantDid: s.did, environment: cfg.env });
  return { ...s, tenant };
}

/** The agent's DID: from its session (private key) or from the keyed whoami (opaque t3n_key_…). */
export async function agentIdentity(cfg: Config): Promise<{ did: string; mode: "session" | "api-key" }> {
  const key = requireKey(cfg, "agentKey");
  if (classifyKey(key) === "t3n-api-key") {
    const nodeUrl = nodeUrlFor(cfg);
    const who = await step("discoverWhoami", nodeUrl, () => discoverWhoami({ baseUrl: nodeUrl, apiKey: key }));
    return { did: who.did, mode: "api-key" };
  }
  const s = await openSession(cfg, "agentKey");
  return { did: s.did, mode: "session" };
}

export interface AgentCall {
  readonly functionName: ContractFunction;
  readonly input: Record<string, unknown>;
  /** Data owner DID (pii_did) — egress and placeholders resolve from THIS user's grant. */
  readonly onBehalfOf?: string;
  readonly script?: string;
}

/** Server-side ExecuteActionRequest (SDK d.ts: strict field names, semver contract_version, optional pii_did). */
export interface WireRequest {
  contract_id: string;
  contract_version: string;
  function_name: string;
  pii_did?: string;
  input: Record<string, unknown>;
}

export function buildRequest(cfg: Config, call: AgentCall, scriptName: string): WireRequest {
  const piiDid = call.onBehalfOf ?? defaultUserDid(cfg);
  return {
    contract_id: scriptName,
    contract_version: cfg.contractVersion,
    function_name: call.functionName,
    ...(piiDid ? { pii_did: piiDid } : {}),
    input: call.input,
  };
}

export interface AgentResult {
  readonly request: WireRequest;
  readonly agentDid: string;
  readonly result: unknown;
}

/** Invoke a contract function as the agent, over a session (private key) or statelessly (t3n_key_…). */
export async function callAsAgent(cfg: Config, call: AgentCall): Promise<AgentResult> {
  const key = requireKey(cfg, "agentKey");
  const request = buildRequest(cfg, call, resolveScriptName(cfg, call.script));
  if (classifyKey(key) === "t3n-api-key") {
    const nodeUrl = nodeUrlFor(cfg);
    const result = await step(`invoke ${call.functionName}`, nodeUrl, () => invoke({ baseUrl: nodeUrl, apiKey: key, request }));
    return { request, agentDid: "(stateless api-key call)", result };
  }
  const s = await openSession(cfg, "agentKey");
  const result = await step(`execute ${call.functionName}`, s.nodeUrl, () => s.t3n.executeAndDecode(request));
  return { request, agentDid: s.did, result };
}

/** Contract results are JSON bytes; the node may hand them back already decoded or as a JSON string. */
export function pretty(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}
