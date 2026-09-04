import { Command } from "commander";
import { buildRequest, callAsAgent, pretty, type AgentCall } from "../client.js";
import { scriptNameOrPlaceholder, type Config } from "../env.js";
import { runCommand } from "../errors.js";

interface ScreenOptions {
  country: string;
  vat: string;
  lei?: string;
  name?: string;
  onBehalfOf?: string;
  script?: string;
  dryRun?: boolean;
}

function toCall(opts: ScreenOptions): AgentCall {
  return {
    functionName: "screen-vendor",
    input: {
      country_code: opts.country.trim().toUpperCase(),
      vat_number: opts.vat.trim(),
      ...(opts.lei ? { lei: opts.lei.trim().toUpperCase() } : {}),
      ...(opts.name ? { legal_name: opts.name.trim() } : {}),
    },
    ...(opts.onBehalfOf ? { onBehalfOf: opts.onBehalfOf } : {}),
    ...(opts.script ? { script: opts.script } : {}),
  };
}

export async function screen(cfg: Config, opts: ScreenOptions): Promise<void> {
  const call = toCall(opts);
  if (opts.dryRun) {
    console.log(JSON.stringify(buildRequest(cfg, call, scriptNameOrPlaceholder(cfg, opts.script)), null, 2));
    return;
  }
  const { request, agentDid, result } = await callAsAgent(cfg, call);
  console.error(`screen-vendor on ${request.contract_id}@${request.contract_version} as ${agentDid}${request.pii_did ? ` for ${request.pii_did}` : " (self call — no pii_did)"}`);
  console.log(pretty(result));
}

export const screenCommand = new Command("screen")
  .description("Run screen-vendor as the agent: EU VIES VAT check + GLEIF LEI lookup inside the enclave, returns risk flags")
  .requiredOption("--country <cc>", "ISO alpha-2 VIES member code, e.g. DE")
  .requiredOption("--vat <number>", "VAT number, e.g. 143593636 (country prefix tolerated)")
  .option("--lei <lei>", "20-char LEI to look up directly (otherwise GLEIF is searched by legal name)")
  .option("--name <legalName>", "claimed legal name, compared with VIES and GLEIF")
  .option("--on-behalf-of <did>", "data owner DID whose grant authorises egress (default: USER_DID / state file)")
  .option("--script <name>", "z:<tid>:<tail> override")
  .option("--dry-run", "print the wire request only")
  .action((opts: ScreenOptions) => runCommand((cfg) => screen(cfg, opts)));
