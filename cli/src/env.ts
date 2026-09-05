import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** cli/ directory (this file lives in cli/src). */
export const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Repository root (Cargo.toml, wit/, target/). */
export const PROJECT_DIR = path.resolve(CLI_DIR, "..");
/** Non-secret deployment facts written by `deploy` / `authorize`. */
export const STATE_FILE = path.join(CLI_DIR, ".kyb-state.json");

export const T3N_ENVS = ["sandbox", "testnet", "production"] as const;
export type T3nEnv = (typeof T3N_ENVS)[number];

/**
 * How the node attestation is pinned (T3N_TRUST):
 *  - manifest: fetchTrustedManifest() — operator-signed and verified. Default; the only mode allowed on production.
 *  - unsafe:   { unsafe_trust_server: true } — no attestation check. The only way to reach testnet with SDK >= 5.3.0 (this CLI pins 5.2.0 instead)
 *              while its served manifest lacks rtmr1_allowlist (2026-09-04); see DISCREPANCIES.md #1.
 */
export const TRUST_MODES = ["manifest", "unsafe"] as const;
export type TrustMode = (typeof TRUST_MODES)[number];

/** WIT exports of the contract (wit/world.wit). */
export const CONTRACT_FUNCTIONS = ["screen-vendor", "submit-onboarding"] as const;
export type ContractFunction = (typeof CONTRACT_FUNCTIONS)[number];

/** Map tail + keys the contract reads (src/onboard.rs). */
export const SECRETS_TAIL = "secrets";
export const SECRET_ERP_URL = "erp_onboarding_url";
export const SECRET_ERP_API_KEY = "erp_api_key";
/** Hosts screen-vendor reaches (src/screen.rs); the ERP host is added from ERP_ONBOARDING_URL. */
export const REGISTER_HOSTS = ["ec.europa.eu", "api.gleif.org"] as const;
/** Echo endpoint substituted when ERP_ONBOARDING_URL is unset — for `--dry-run` and `doctor` only; live runs refuse it (liveErpUrl). */
export const DEMO_ERP_URL = "https://httpbin.org/post";
/**
 * Public request-echo services. Whatever the contract POSTs there — the ERP body with the signatory's
 * {{profile.*}} placeholders already resolved — is shown to whoever reads the echo, so a live `deploy` /
 * `authorize` refuses them unless --allow-demo-erp / KYB_ALLOW_DEMO_ERP=1 says a throwaway identity is in use.
 */
export const DEMO_ERP_HOSTS = ["httpbin.org", "postman-echo.com", "webhook.site"] as const;

export function isDemoErpHost(host: string): boolean {
  const h = host.toLowerCase();
  return DEMO_ERP_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

export interface Config {
  readonly t3nApiKey?: string;
  readonly agentKey?: string;
  readonly userKey?: string;
  readonly erpOnboardingUrl: string;
  /** True when ERP_ONBOARDING_URL was unset and DEMO_ERP_URL was substituted. */
  readonly erpUrlIsDemoDefault: boolean;
  /** True when the ERP host is one of DEMO_ERP_HOSTS (a public echo service). */
  readonly erpHostIsDemoEcho: boolean;
  /** --allow-demo-erp or KYB_ALLOW_DEMO_ERP=1: a live run may seed/grant a DEMO_ERP_HOSTS target. */
  readonly allowDemoErp: boolean;
  readonly erpApiKey?: string;
  readonly env: T3nEnv;
  readonly trust: TrustMode;
  readonly contractTail: string;
  readonly contractVersion: string;
  readonly scriptName?: string;
  readonly userDid?: string;
  readonly wasmPath: string;
}

/** Env-var name of each key field, for messages. */
export const KEY_VARS = { t3nApiKey: "T3N_API_KEY", agentKey: "AGENT_KEY", userKey: "USER_KEY" } as const;
export type KeyField = keyof typeof KEY_VARS;

function optional(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function loadDotEnv(): void {
  const file = path.join(CLI_DIR, ".env");
  if (existsSync(file)) process.loadEnvFile(file); // already-exported variables take precedence
}

export interface ConfigOverrides {
  /** A command's --allow-demo-erp flag; KYB_ALLOW_DEMO_ERP=1 is the env-var equivalent. */
  readonly allowDemoErp?: boolean | undefined;
}

export function loadConfig(overrides: ConfigOverrides = {}): Config {
  loadDotEnv();
  const env = optional("T3N_ENV") ?? "testnet";
  if (!(T3N_ENVS as readonly string[]).includes(env)) {
    throw new Error(`T3N_ENV must be one of ${T3N_ENVS.join(" | ")} (got "${env}")`);
  }
  const trust = optional("T3N_TRUST") ?? "manifest";
  if (!(TRUST_MODES as readonly string[]).includes(trust)) {
    throw new Error(`T3N_TRUST must be one of ${TRUST_MODES.join(" | ")} (got "${trust}")`);
  }
  if (env === "production" && trust !== "manifest") {
    throw new Error(`T3N_TRUST=${trust} is refused on production — only the verified operator-signed manifest is accepted there`);
  }
  const erpFromEnv = optional("ERP_ONBOARDING_URL");
  const erpOnboardingUrl = erpFromEnv ?? DEMO_ERP_URL;
  if (!URL.canParse(erpOnboardingUrl)) throw new Error(`ERP_ONBOARDING_URL is not a valid URL: "${erpOnboardingUrl}"`);
  const allowDemoErp = overrides.allowDemoErp === true || optional("KYB_ALLOW_DEMO_ERP") === "1";

  const t3nApiKey = optional("T3N_API_KEY");
  const agentKey = optional("AGENT_KEY");
  const userKey = optional("USER_KEY");
  const erpApiKey = optional("ERP_API_KEY");
  const scriptName = optional("SCRIPT_NAME");
  const userDid = optional("USER_DID");
  const defaultWasm = path.join(PROJECT_DIR, "target", "wasm32-wasip2", "release", "z_tenant_kyb.wasm");

  return {
    erpOnboardingUrl,
    erpUrlIsDemoDefault: erpFromEnv === undefined,
    erpHostIsDemoEcho: isDemoErpHost(hostOf(erpOnboardingUrl)),
    allowDemoErp,
    env: env as T3nEnv,
    trust: trust as TrustMode,
    contractTail: optional("CONTRACT_TAIL") ?? "kyb",
    contractVersion: optional("CONTRACT_VERSION") ?? "0.1.0",
    wasmPath: path.resolve(CLI_DIR, optional("WASM_PATH") ?? defaultWasm),
    ...(t3nApiKey ? { t3nApiKey } : {}),
    ...(agentKey ? { agentKey } : {}),
    ...(userKey ? { userKey } : {}),
    ...(erpApiKey ? { erpApiKey } : {}),
    ...(scriptName ? { scriptName } : {}),
    ...(userDid ? { userDid } : {}),
  };
}

export function requireKey(cfg: Config, field: KeyField): string {
  const v = cfg[field];
  if (!v) throw new Error(`${KEY_VARS[field]} is not set — put it in cli/.env (see cli/.env.example) or export it.`);
  return v;
}

/**
 * The docs call two different things "API key": the quickstart feeds it to
 * eth_get_address (a 32-byte hex secp256k1 private key), while the SDK's
 * invoke()/discover*() relay an opaque `t3n_key_…` token. Classify, never guess.
 */
export type KeyKind = "eth-private-key" | "t3n-api-key" | "unknown";
export function classifyKey(key: string): KeyKind {
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(key)) return "eth-private-key";
  if (key.startsWith("t3n_key_")) return "t3n-api-key";
  return "unknown";
}

/** Describe a secret without revealing any of it. */
export function describeSecret(value: string | undefined): string {
  return value ? `set (${value.length} chars)` : "not set";
}

export function hostOf(url: string): string {
  return new URL(url).hostname;
}

/**
 * The ERP URL for a live (non-dry-run) command. The demo default is refused so a forgotten
 * variable can never seed httpbin.org — together with a real ERP_API_KEY — into a tenant, and an
 * explicit DEMO_ERP_HOSTS target needs --allow-demo-erp / KYB_ALLOW_DEMO_ERP=1 (demoErpRefusal).
 */
export function liveErpUrl(cfg: Config): string {
  if (cfg.erpUrlIsDemoDefault) {
    throw new Error(
      `ERP_ONBOARDING_URL is not set — refusing to use the demo endpoint ${DEMO_ERP_URL} on a live run. Set it in cli/.env (explicitly to ${DEMO_ERP_URL} plus KYB_ALLOW_DEMO_ERP=1 for a smoke test without ERP_API_KEY).`,
    );
  }
  const refusal = demoErpRefusal(cfg);
  if (refusal) throw new Error(refusal);
  return cfg.erpOnboardingUrl;
}

/** Why a live run must not use the configured ERP URL — undefined when it may. Pure. */
export function demoErpRefusal(cfg: Config): string | undefined {
  if (!cfg.erpHostIsDemoEcho || cfg.allowDemoErp) return undefined;
  return `ERP_ONBOARDING_URL points at ${hostOf(cfg.erpOnboardingUrl)}, a public request-echo service — refusing on a live run: submit-onboarding POSTs the ERP body there with the signatory's {{profile.*}} markers already resolved, so the echo target (and anyone who can read its log) receives the data owner's real name/e-mail. Pass --allow-demo-erp (or set KYB_ALLOW_DEMO_ERP=1) only with a throwaway demo identity, or point ERP_ONBOARDING_URL at your ERP.`;
}

export function relPath(p: string): string {
  return path.relative(PROJECT_DIR, p) || p;
}

export interface State {
  tenantDid?: string;
  scriptName?: string;
  contractId?: number;
  version?: string;
  agentDid?: string;
  userDid?: string;
  updatedAt?: string;
}

export function readState(): State {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  } catch (e) {
    throw new Error(`${STATE_FILE} is not valid JSON — delete it and re-run \`kyb deploy\` (${(e as Error).message})`);
  }
}

export function writeState(patch: State): State {
  const next: State = { ...readState(), ...patch, updatedAt: new Date().toISOString() };
  writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** z:<tid>:<tail> — from --script, SCRIPT_NAME, or the state file written by deploy. */
export function resolveScriptName(cfg: Config, override?: string): string {
  const name = override ?? cfg.scriptName ?? readState().scriptName;
  if (!name) {
    throw new Error(
      "Contract name unknown: run `kyb deploy` first (it records z:<tid>:<tail> in cli/.kyb-state.json), or pass --script / set SCRIPT_NAME.",
    );
  }
  return name;
}

/** Same, but tolerant — for --dry-run output before anything is deployed. */
export function scriptNameOrPlaceholder(cfg: Config, override?: string): string {
  return override ?? cfg.scriptName ?? readState().scriptName ?? `z:<tid>:${cfg.contractTail}`;
}

/** Default data-owner DID for delegated calls (pii_did). */
export function defaultUserDid(cfg: Config): string | undefined {
  return cfg.userDid ?? readState().userDid;
}
