import { readFileSync, statSync } from "node:fs";
import { Command } from "commander";
import type { MapLifecycleStatus, TenantClient } from "@terminal3/t3n-sdk";
import { openTenant } from "../client.js";
import {
  SECRETS_TAIL,
  SECRET_ERP_API_KEY,
  SECRET_ERP_URL,
  describeSecret,
  hostOf,
  liveErpUrl,
  readState,
  relPath,
  writeState,
  type Config,
} from "../env.js";
import { messageChain, runCommand } from "../errors.js";

interface DeployOptions {
  dryRun?: boolean;
  claim?: boolean;
  contractId?: number;
  allowDemoErp?: boolean;
  yes?: boolean;
}

function readWasm(cfg: Config): Uint8Array {
  try {
    return new Uint8Array(readFileSync(cfg.wasmPath));
  } catch {
    throw new Error(`WASM artifact ${relPath(cfg.wasmPath)} not found — run \`cargo build --target wasm32-wasip2 --release\` in the project root`);
  }
}

function wasmSizeKb(cfg: Config): string {
  try {
    return `${(statSync(cfg.wasmPath).size / 1024).toFixed(1)} KB`;
  } catch {
    return "missing!";
  }
}

/** contracts.register is monotonic per version; a same-version re-run is a no-op and we reuse the known id. */
async function registerContract(tenant: TenantClient, cfg: Config, wasm: Uint8Array, knownId: number | undefined, did: string): Promise<number | undefined> {
  try {
    const r = await tenant.contracts.register({ tail: cfg.contractTail, version: cfg.contractVersion, wasm });
    console.log(`registered ${r.name} @ ${cfg.contractVersion} → contract_id ${r.contract_id}`);
    return r.contract_id;
  } catch (e) {
    if (!/not higher than current version/i.test(messageChain(e))) throw e;
    const st = readState();
    const id = knownId ?? (st.tenantDid === did ? st.contractId : undefined);
    const source = knownId !== undefined ? "--contract-id" : "cli/.kyb-state.json";
    console.log(
      `already registered at >= ${cfg.contractVersion} — skipping register (${id !== undefined ? `contract_id ${id} from ${source}` : "contract_id unknown: pass --contract-id or bump CONTRACT_VERSION"})`,
    );
    return id;
  }
}

/** Private map, readable/writable only by the contract (create-kv-maps.md: readers MUST be explicit). */
async function ensureSecretsMap(tenant: TenantClient, contractId: number | undefined): Promise<void> {
  const acl = contractId !== undefined ? { only: [contractId] } : undefined;
  let status: MapLifecycleStatus | "unknown" = "unknown";
  try {
    status = await tenant.maps.getStatus(SECRETS_TAIL);
  } catch (e) {
    console.log(`maps.getStatus("${SECRETS_TAIL}") failed (${messageChain(e)}) — falling back to create`);
  }
  if (status === "deleting") throw new Error(`map "${SECRETS_TAIL}" is still being deleted by the host sweeper — retry in a moment`);
  if (status === "active") {
    if (acl) {
      await tenant.maps.update(SECRETS_TAIL, { readers: acl, writers: acl });
      console.log(`map ${SECRETS_TAIL} exists — ACL synced to contract_id ${contractId}`);
    } else {
      console.log(`map ${SECRETS_TAIL} exists — ACL left unchanged (contract_id unknown)`);
    }
    return;
  }
  if (!acl) {
    throw new Error(`map "${SECRETS_TAIL}" must be created with the contract id on its ACL, but the id is unknown — pass --contract-id <n> or bump CONTRACT_VERSION so register returns it`);
  }
  try {
    await tenant.maps.create({ tail: SECRETS_TAIL, visibility: "private", writers: acl, readers: acl });
    console.log(`created private map ${SECRETS_TAIL} (readers/writers: contract_id ${contractId})`);
  } catch (e) {
    if (!/already exists/i.test(messageChain(e))) throw e;
    await tenant.maps.update(SECRETS_TAIL, { readers: acl, writers: acl });
    console.log(`map ${SECRETS_TAIL} already existed — ACL synced to contract_id ${contractId}`);
  }
}

/** Live-run guard: never seed a real bearer token next to a public echo service. Pure; throws before any network call. */
function erpSecretsForLiveRun(cfg: Config): string {
  const url = liveErpUrl(cfg); // refuses the demo default and, without --allow-demo-erp, every DEMO_ERP_HOSTS target
  if (cfg.erpApiKey && cfg.erpHostIsDemoEcho) {
    throw new Error(
      `ERP_API_KEY is set while ERP_ONBOARDING_URL points at ${hostOf(url)}, a public echo service — refusing: submit-onboarding would send that bearer token to it. Unset ERP_API_KEY for the demo endpoint, or point ERP_ONBOARDING_URL at your ERP.`,
    );
  }
  return url;
}

/** Production only: show what is seeded now and never overwrite it silently. Runs after ensureSecretsMap, so a fresh map reads back empty. */
async function confirmProductionOverwrite(tenant: TenantClient, cfg: Config, erpUrl: string, yes: boolean | undefined): Promise<void> {
  if (cfg.env !== "production") return;
  let existing: string | null;
  try {
    existing = await tenant.maps.entryGet(SECRETS_TAIL, SECRET_ERP_URL);
  } catch (e) {
    if (yes) {
      console.log(`production: could not read the current ${SECRET_ERP_URL} (${messageChain(e)}) — seeding anyway because --yes was given`);
      return;
    }
    throw new Error(`production: could not read the current ${SECRET_ERP_URL} (${messageChain(e)}) — refusing to overwrite blind; pass --yes to seed anyway`);
  }
  if (existing === null) {
    console.log(`production: ${SECRET_ERP_URL} is not seeded yet — nothing to overwrite`);
    return;
  }
  console.log(`production: current ${SECRET_ERP_URL} = ${existing}${existing === erpUrl ? " (same value)" : `\n            new     ${SECRET_ERP_URL} = ${erpUrl}`}`);
  if (!yes) throw new Error(`production: refusing to overwrite ${SECRET_ERP_URL} without --yes (current value printed above)`);
}

/** The owner writes entries through the control plane (map-entry-set) regardless of the contract-only ACL. */
async function seedSecrets(tenant: TenantClient, cfg: Config, erpUrl: string): Promise<void> {
  await tenant.maps.entrySet(SECRETS_TAIL, SECRET_ERP_URL, erpUrl);
  console.log(`seeded ${SECRET_ERP_URL} → ${erpUrl}`);
  if (cfg.erpApiKey) {
    await tenant.maps.entrySet(SECRETS_TAIL, SECRET_ERP_API_KEY, cfg.erpApiKey);
    console.log(`seeded ${SECRET_ERP_API_KEY} (${describeSecret(cfg.erpApiKey)})`);
  } else {
    console.log(`${SECRET_ERP_API_KEY} not set — the contract will POST without an Authorization header`);
  }
}

function erpUrlNote(cfg: Config): string {
  if (cfg.erpUrlIsDemoDefault) return " — demo default, ERP_ONBOARDING_URL is not set: a live run refuses it";
  if (!cfg.erpHostIsDemoEcho) return "";
  return cfg.allowDemoErp
    ? " — public echo host, allowed by --allow-demo-erp / KYB_ALLOW_DEMO_ERP=1: it receives the resolved signatory data"
    : " — public echo host: a live run refuses it without --allow-demo-erp";
}

export async function deploy(cfg: Config, opts: DeployOptions): Promise<void> {
  const plan = [
    `tenant session with T3N_API_KEY (${describeSecret(cfg.t3nApiKey)}) on ${cfg.env} → tenant DID read back from the session${opts.claim ? ", then tenant.claim() self-admit" : ""}`,
    `contracts.register({ tail: "${cfg.contractTail}", version: "${cfg.contractVersion}", wasm: ${relPath(cfg.wasmPath)} (${wasmSizeKb(cfg)}) }) → z:<tid>:${cfg.contractTail} + contract_id`,
    `maps.getStatus("${SECRETS_TAIL}") → create private map with readers/writers { only: [contract_id] } if absent, else maps.update() to sync the ACL`,
    ...(cfg.env === "production" ? [`production: maps.entryGet("${SECRETS_TAIL}", "${SECRET_ERP_URL}") → print the current value and refuse to overwrite it unless --yes`] : []),
    `maps.entrySet("${SECRETS_TAIL}", "${SECRET_ERP_URL}", ${cfg.erpOnboardingUrl} [host ${hostOf(cfg.erpOnboardingUrl)}]${erpUrlNote(cfg)})${cfg.erpApiKey ? ` + entrySet("${SECRETS_TAIL}", "${SECRET_ERP_API_KEY}", <${describeSecret(cfg.erpApiKey)}>)` : " (ERP_API_KEY not set — skipped)"}`,
    "write cli/.kyb-state.json { tenantDid, scriptName, contractId, version }",
  ];
  console.log(`deploy plan (${opts.dryRun ? "dry run — nothing sent" : "live"}):`);
  plan.forEach((line, i) => console.log(`  ${i + 1}. ${line}`));
  if (opts.dryRun) return;

  const erpUrl = erpSecretsForLiveRun(cfg);
  const wasm = readWasm(cfg);
  const { tenant, did, nodeUrl } = await openTenant(cfg);
  console.log(`\ntenant DID ${did} (node ${nodeUrl})`);
  if (opts.claim) {
    const r = await tenant.tenant.claim();
    console.log(`tenant.claim() → ${JSON.stringify(r)}`);
  }
  const contractId = await registerContract(tenant, cfg, wasm, opts.contractId, did);
  await ensureSecretsMap(tenant, contractId);
  await confirmProductionOverwrite(tenant, cfg, erpUrl, opts.yes);
  await seedSecrets(tenant, cfg, erpUrl);
  const scriptName = tenant.canonicalName(cfg.contractTail);
  writeState({ tenantDid: did, scriptName, version: cfg.contractVersion, ...(contractId !== undefined ? { contractId } : {}) });
  console.log(`\nscriptName  ${scriptName}\ncontract_id ${contractId ?? "unknown"}\nnext: kyb authorize (as the data owner), then kyb screen / kyb onboard (as the agent)`);
}

export const deployCommand = new Command("deploy")
  .description("Register the WASM contract, create/ACL the `secrets` map and seed the ERP secrets — idempotent")
  .option("--dry-run", "print the plan without touching the network")
  .option("--claim", "call tenant.claim() (testnet self-admit) before registering")
  .option("--contract-id <n>", "known contract id for the map ACL when register is a same-version no-op", (v) => Number.parseInt(v, 10))
  .option("--allow-demo-erp", "let a live run seed a public echo host (httpbin.org, postman-echo.com, webhook.site) — it receives the resolved signatory data; throwaway identities only")
  .option("--yes", "production: overwrite an already-seeded erp_onboarding_url (deploy prints the current value first)")
  .action((opts: DeployOptions) => runCommand((cfg) => deploy(cfg, opts), { allowDemoErp: opts.allowDemoErp }));
