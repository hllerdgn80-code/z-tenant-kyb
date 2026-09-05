import { Command } from "commander";
import { toAgentAuthUpdateWire, type AgentAuthScriptGrant } from "@terminal3/t3n-sdk";
import { agentIdentity, openSession } from "../client.js";
import { CONTRACT_FUNCTIONS, REGISTER_HOSTS, hostOf, liveErpUrl, resolveScriptName, scriptNameOrPlaceholder, writeState, type Config } from "../env.js";
import { runCommand } from "../errors.js";

interface AuthorizeOptions {
  dryRun?: boolean;
  agentDid?: string;
  script?: string;
  host?: string[];
  allowDemoErp?: boolean;
}

function buildGrant(cfg: Config, scriptName: string, erpUrl: string, extraHosts: readonly string[]): AgentAuthScriptGrant {
  const allowedHosts = [...new Set([...REGISTER_HOSTS, hostOf(erpUrl), ...extraHosts])];
  return { scriptName, versionReq: cfg.contractVersion, functions: [...CONTRACT_FUNCTIONS], allowedHosts };
}

export async function authorize(cfg: Config, opts: AuthorizeOptions): Promise<void> {
  const extra = opts.host ?? [];
  if (opts.dryRun) {
    const agentDid = opts.agentDid ?? "<agent DID — read back from the AGENT_KEY session>";
    const grant = buildGrant(cfg, scriptNameOrPlaceholder(cfg, opts.script), cfg.erpOnboardingUrl, extra);
    if (cfg.erpUrlIsDemoDefault) console.log(`note: ERP_ONBOARDING_URL is not set — the demo host ${hostOf(cfg.erpOnboardingUrl)} is shown; a live run refuses it`);
    console.log("grant (SDK camelCase input, signed by the data owner's USER_KEY session via updateAgentAuth):");
    console.log(JSON.stringify({ agentDid, scripts: [grant] }, null, 2));
    console.log("\nwire sent to agent-auth-update (toAgentAuthUpdateWire):");
    console.log(JSON.stringify(toAgentAuthUpdateWire([{ agentDid, scripts: [grant] }]), null, 2));
    return;
  }
  const grant = buildGrant(cfg, resolveScriptName(cfg, opts.script), liveErpUrl(cfg), extra);
  let agentDid = opts.agentDid;
  if (!agentDid) {
    const agent = await agentIdentity(cfg);
    agentDid = agent.did;
    console.log(`agent DID ${agentDid} (${agent.mode})`);
  }
  const user = await openSession(cfg, "userKey");
  console.log(`data owner DID ${user.did}`);
  const { preservedRows } = await user.t3n.updateAgentAuth(agentDid, grant);
  writeState({ agentDid, userDid: user.did });
  console.log(`\ngranted ${grant.functions.join(", ")} on ${grant.scriptName} (versionReq ${grant.versionReq}) to ${agentDid}`);
  console.log(`allowedHosts: ${grant.allowedHosts.join(", ")}`);
  if (preservedRows.length) console.log(`preserved existing rows: ${preservedRows.join("; ")}`);
  console.log(`\nUSER_DID=${user.did}  (recorded in cli/.kyb-state.json; screen/onboard use it as pii_did)`);
}

export const authorizeCommand = new Command("authorize")
  .description("As the data owner (USER_KEY), grant the agent screen-vendor + submit-onboarding on the contract with the register/ERP hosts as egress")
  .option("--dry-run", "print the grant JSON and its wire form without any network call")
  .option("--agent-did <did>", "skip the agent session and grant to this DID")
  .option("--script <name>", "z:<tid>:<tail> override (default: cli/.kyb-state.json / SCRIPT_NAME)")
  .option("--host <host...>", "extra egress host(s) to allow")
  .option("--allow-demo-erp", "let a live run grant egress to a public echo host (httpbin.org, postman-echo.com, webhook.site) — it receives the resolved signatory data; throwaway identities only")
  .action((opts: AuthorizeOptions) => runCommand((cfg) => authorize(cfg, opts), { allowDemoErp: opts.allowDemoErp }));
