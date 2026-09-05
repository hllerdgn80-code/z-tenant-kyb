import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { discoverWhoami } from "@terminal3/t3n-sdk";
import { inspectManifest, nodeUrlFor, openSession, openTenant } from "../client.js";
import {
  CLI_DIR,
  KEY_VARS,
  classifyKey,
  describeSecret,
  hostOf,
  readState,
  relPath,
  type Config,
  type KeyField,
} from "../env.js";
import { explainError, runCommand, secretsOf, type Secrets } from "../errors.js";

type Status = "ok" | "warn" | "fail" | "skip";
interface Check {
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
}
interface DoctorOptions {
  offline?: boolean;
  timeout: number;
  allowDemoErp?: boolean;
}

const EXPECTED_SDK = "5.2.0"; // last version whose fetchTrustedManifest() accepts testnet's manifest (5.3.0+ require rtmr1_allowlist — DISCREPANCIES.md #1)
const VIES_URL = "https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number";
/** Google Ireland Limited: validates with a name. (DE numbers validate without a name, and DE143593636 reported valid=false on 2026-09-04.) */
const VIES_PROBE = { countryCode: "IE", vatNumber: "6388047V" } as const;
const GLEIF_URL = "https://api.gleif.org/api/v1/lei-records?filter[entity.legalName]=SAP%20SE&page[size]=1";
const KEY_USED_BY: Record<KeyField, string> = {
  t3nApiKey: "deploy, logs, audit --as tenant",
  agentKey: "authorize (agent DID), screen, onboard, audit",
  userKey: "authorize, audit --as user",
};

const check = (name: string, status: Status, detail: string): Check => ({ name, status, detail });

function nodeCheck(): Check {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 20
    ? check("node", "ok", `v${process.versions.node}`)
    : check("node", "fail", `v${process.versions.node} — need Node >= 20.12 (process.loadEnvFile); the SDK needs >= 18`);
}

function sdkCheck(): Check {
  const pkg = path.join(CLI_DIR, "node_modules", "@terminal3", "t3n-sdk", "package.json");
  if (!existsSync(pkg)) return check("sdk", "fail", "@terminal3/t3n-sdk is not installed — run `npm install` in cli/");
  const version = (JSON.parse(readFileSync(pkg, "utf8")) as { version?: string }).version ?? "?";
  return version === EXPECTED_SDK
    ? check("sdk", "ok", `@terminal3/t3n-sdk ${version}`)
    : check("sdk", "warn", `@terminal3/t3n-sdk ${version} — this CLI and DISCREPANCIES.md were written against ${EXPECTED_SDK}`);
}

function wasmCheck(cfg: Config): Check {
  const rel = relPath(cfg.wasmPath);
  if (!existsSync(cfg.wasmPath)) {
    return check("wasm", "fail", `${rel} missing — run \`cargo build --target wasm32-wasip2 --release\` in the project root`);
  }
  const size = statSync(cfg.wasmPath).size;
  const head = Buffer.alloc(8);
  const fd = openSync(cfg.wasmPath, "r");
  try {
    readSync(fd, head, 0, 8, 0);
  } finally {
    closeSync(fd);
  }
  if (head.toString("latin1", 0, 4) !== "\0asm") return check("wasm", "fail", `${rel} is not a WebAssembly binary`);
  const layer = head.readUInt16LE(6); // component model: version 13, layer 1; core module: layer 0
  const kb = (size / 1024).toFixed(1);
  return layer === 1
    ? check("wasm", "ok", `${rel} — ${kb} KB, WASM component (layer 1)`)
    : check("wasm", "fail", `${rel} — ${kb} KB is a core module (layer ${layer}), not a component; build for wasm32-wasip2`);
}

function envChecks(cfg: Config): Check[] {
  const out: Check[] = [];
  for (const field of Object.keys(KEY_VARS) as KeyField[]) {
    const value = cfg[field];
    out.push(
      value
        ? check(KEY_VARS[field], "ok", `${describeSecret(value)}, ${classifyKey(value)}`)
        : check(KEY_VARS[field], "skip", `not set — needed by: ${KEY_USED_BY[field]}`),
    );
  }
  // One identity playing tenant + agent (or tenant + data owner) is a testnet demo shortcut, never a production setup.
  const sameKeyStatus: Status = cfg.env === "production" ? "fail" : "warn";
  if (cfg.t3nApiKey && cfg.t3nApiKey === cfg.agentKey) {
    out.push(check("AGENT_KEY", sameKeyStatus, `equals T3N_API_KEY — the agent must be its own identity with its own credits${cfg.env === "production" ? " (refused on production)" : ""}`));
  }
  if (cfg.t3nApiKey && cfg.t3nApiKey === cfg.userKey) {
    out.push(check("USER_KEY", sameKeyStatus, `equals T3N_API_KEY — the data owner whose profile is substituted must not be the tenant${cfg.env === "production" ? " (refused on production)" : ""}`));
  }
  out.push(erpUrlCheck(cfg));
  out.push(check("ERP_API_KEY", cfg.erpApiKey ? "ok" : "skip", cfg.erpApiKey ? describeSecret(cfg.erpApiKey) : "not set — optional bearer for the ERP"));
  const st = readState();
  out.push(
    check(
      "contract",
      "ok",
      `${st.scriptName ?? `z:<tid>:${cfg.contractTail}`} @ ${cfg.contractVersion} on ${cfg.env}${st.scriptName ? "" : " (not deployed yet — no cli/.kyb-state.json)"}`,
    ),
  );
  return out;
}

function erpUrlCheck(cfg: Config): Check {
  const name = "ERP_ONBOARDING_URL";
  if (cfg.erpUrlIsDemoDefault) {
    return check(name, "warn", `not set — --dry-run and doctor fall back to the demo echo ${cfg.erpOnboardingUrl}; a live \`deploy\` / \`authorize\` refuses to run without it`);
  }
  const host = hostOf(cfg.erpOnboardingUrl);
  if (!cfg.erpHostIsDemoEcho) return check(name, "ok", `${cfg.erpOnboardingUrl} (allowed host: ${host})`);
  if (cfg.allowDemoErp) {
    return check(name, "warn", `${cfg.erpOnboardingUrl} is a public echo service, allowed by --allow-demo-erp / KYB_ALLOW_DEMO_ERP=1 — it receives the resolved signatory data; throwaway identities only`);
  }
  return check(
    name,
    cfg.env === "production" ? "fail" : "warn",
    `${cfg.erpOnboardingUrl} is a public echo service — a live \`deploy\` / \`authorize\` refuses it: the echo target receives the resolved signatory data. Pass --allow-demo-erp (or set KYB_ALLOW_DEMO_ERP=1) with a throwaway demo identity only`,
  );
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  return { status: res.status, body };
}

const field = (v: unknown, key: string): unknown => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined);

async function viesCheck(timeoutMs: number, secrets: Secrets): Promise<Check> {
  try {
    const { status, body } = await fetchJson(
      VIES_URL,
      { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ countryCode: VIES_PROBE.countryCode, vatNumber: VIES_PROBE.vatNumber }) },
      timeoutMs,
    );
    if (status !== 200) return check("vies", "fail", `HTTP ${status} from ${VIES_URL}`);
    const valid = field(body, "valid");
    const userError = field(body, "userError");
    if (valid === true) return check("vies", "ok", `${VIES_PROBE.countryCode}${VIES_PROBE.vatNumber} valid=true name=${String(field(body, "name") ?? "?")}`);
    return check("vies", "warn", `reachable, but ${VIES_PROBE.countryCode}${VIES_PROBE.vatNumber} came back valid=${String(valid)} userError=${String(userError ?? "-")} — member-state outage (MS_UNAVAILABLE) or the probe number lapsed; the register itself answered`);
  } catch (e) {
    return check("vies", "fail", explainError(e, secrets));
  }
}

async function gleifCheck(timeoutMs: number, secrets: Secrets): Promise<Check> {
  try {
    const { status, body } = await fetchJson(GLEIF_URL, { headers: { accept: "application/vnd.api+json" } }, timeoutMs);
    if (status !== 200) return check("gleif", "fail", `HTTP ${status} from api.gleif.org`);
    const data = field(body, "data");
    const first = Array.isArray(data) ? data[0] : undefined;
    const lei = field(field(first, "attributes"), "lei");
    return typeof lei === "string"
      ? check("gleif", "ok", `SAP SE → LEI ${lei}`)
      : check("gleif", "fail", "reachable but no LEI record in the response");
  } catch (e) {
    return check("gleif", "fail", explainError(e, secrets));
  }
}

/** The SDK validates the served manifest against its SignedTrustManifest type; report the gap before the session checks hit it. */
async function manifestCheck(cfg: Config, timeoutMs: number): Promise<Check> {
  try {
    const r = await inspectManifest(nodeUrlFor(cfg), timeoutMs);
    const meta = `version ${r.version ?? "?"}, signed ${r.signedAt ?? "?"}`;
    if (r.missing.length === 0) return check("trust manifest", "ok", `${r.url} (${meta}) has every field SDK ${EXPECTED_SDK} requires`);
    const status: Status = "warn"; // pinned SDK 5.2.0 accepts this manifest; it only breaks after an SDK upgrade
    return check(
      "trust manifest",
      status,
      `${r.url} (${meta}) lacks ${r.missing.join(", ")} — SDK >= 5.3.0 rejects it as malformed (this CLI pins ${EXPECTED_SDK}, the last version that accepts it). ${cfg.trust === "manifest" ? "If you upgrade the SDK every session command will fail until the node publishes rtmr1_allowlist — see DISCREPANCIES.md #1" : `T3N_TRUST=${cfg.trust} skips the check`}`,
    );
  } catch (e) {
    return check("trust manifest", "fail", explainError(e, secretsOf(cfg)));
  }
}

async function nodeStatusCheck(cfg: Config, timeoutMs: number): Promise<Check> {
  const nodeUrl = nodeUrlFor(cfg);
  try {
    const res = await fetch(`${nodeUrl}/status`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok
      ? check("t3n node", "ok", `${nodeUrl}/status → HTTP ${res.status}`)
      : check("t3n node", "fail", `${nodeUrl}/status → HTTP ${res.status}`);
  } catch (e) {
    return check("t3n node", "fail", `${nodeUrl} unreachable: ${explainError(e, secretsOf(cfg))}`);
  }
}

/** Handshake + authenticate with each configured key; for a t3n_key_… agent key use the keyed whoami instead. */
async function identityChecks(cfg: Config, timeoutMs: number): Promise<Check[]> {
  const out: Check[] = [];
  if (cfg.t3nApiKey) {
    try {
      const { did, tenant } = await openTenant(cfg);
      out.push(check("tenant session", "ok", `DID ${did}`));
      try {
        const me = await tenant.tenant.me();
        out.push(check("tenant admitted", "ok", `tenant.me() → status ${String(field(me, "status") ?? JSON.stringify(me))}`));
      } catch (e) {
        out.push(check("tenant admitted", "warn", `tenant.me() failed — try \`kyb deploy --claim\` (testnet self-admit). ${explainError(e, secretsOf(cfg))}`));
      }
    } catch (e) {
      out.push(check("tenant session", "fail", explainError(e, secretsOf(cfg))));
    }
  } else {
    out.push(check("tenant session", "skip", "T3N_API_KEY not set"));
  }

  if (cfg.agentKey && classifyKey(cfg.agentKey) === "t3n-api-key") {
    try {
      const who = await discoverWhoami({ baseUrl: nodeUrlFor(cfg), apiKey: cfg.agentKey, timeoutMs });
      out.push(check("agent identity", "ok", `DID ${who.did} (opaque api key → stateless invoke path)`));
    } catch (e) {
      out.push(check("agent identity", "fail", explainError(e, secretsOf(cfg))));
    }
  } else {
    out.push(await sessionCheck(cfg, "agentKey", "agent session"));
  }
  out.push(await sessionCheck(cfg, "userKey", "user session"));
  return out;
}

async function sessionCheck(cfg: Config, key: KeyField, name: string): Promise<Check> {
  if (!cfg[key]) return check(name, "skip", `${KEY_VARS[key]} not set`);
  try {
    const s = await openSession(cfg, key);
    return check(name, "ok", `DID ${s.did}`);
  } catch (e) {
    return check(name, "fail", explainError(e, secretsOf(cfg)));
  }
}

function print(checks: readonly Check[]): number {
  const pad = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    const tag = { ok: " ok ", warn: "warn", fail: "FAIL", skip: "skip" }[c.status];
    console.log(` ${tag}  ${c.name.padEnd(pad)}  ${c.detail.split("\n").join(`\n${" ".repeat(pad + 8)}`)}`);
  }
  const count = (s: Status): number => checks.filter((c) => c.status === s).length;
  const failures = count("fail");
  console.log(`\nsummary: ${count("ok")} ok, ${count("warn")} warn, ${failures} failed, ${count("skip")} skipped → exit ${failures ? 1 : 0}`);
  return failures;
}

export async function doctor(cfg: Config, opts: DoctorOptions): Promise<void> {
  console.log(`kyb doctor — env ${cfg.env}, trust ${cfg.trust}, node ${nodeUrlFor(cfg)}${opts.offline ? " (offline: network checks skipped)" : ""}\n`);
  const checks: Check[] = [nodeCheck(), sdkCheck(), wasmCheck(cfg), ...envChecks(cfg)];
  if (opts.offline) {
    checks.push(check("network", "skip", "--offline"));
  } else {
    const secrets = secretsOf(cfg);
    const [vies, gleif, node, manifest] = await Promise.all([viesCheck(opts.timeout, secrets), gleifCheck(opts.timeout, secrets), nodeStatusCheck(cfg, opts.timeout), manifestCheck(cfg, opts.timeout)]);
    checks.push(vies, gleif, node, manifest, ...(await identityChecks(cfg, opts.timeout)));
  }
  if (print(checks) > 0) process.exitCode = 1;
}

export const doctorCommand = new Command("doctor")
  .description("Check toolchain, WASM artifact, env vars (masked), VIES/GLEIF reachability and the T3N handshake for every configured key")
  .option("--offline", "skip every network check")
  .option("--timeout <ms>", "per-request timeout for the register/node probes", (v) => Number.parseInt(v, 10), 10_000)
  .option("--allow-demo-erp", "evaluate ERP_ONBOARDING_URL as a live run with --allow-demo-erp would")
  .action((opts: DoctorOptions) => runCommand((cfg) => doctor(cfg, opts), { allowDemoErp: opts.allowDemoErp }));
