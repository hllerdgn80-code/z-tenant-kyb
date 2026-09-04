import { Command } from "commander";
import { buildRequest, callAsAgent, pretty, type AgentCall } from "../client.js";
import { scriptNameOrPlaceholder, type Config } from "../env.js";
import { runCommand } from "../errors.js";

interface OnboardOptions {
  vendorId: string;
  screeningRef: string;
  includeEmail?: boolean;
  notes?: string;
  onBehalfOf?: string;
  script?: string;
  dryRun?: boolean;
}

function toCall(opts: OnboardOptions): AgentCall {
  return {
    functionName: "submit-onboarding",
    input: {
      vendor_id: opts.vendorId.trim(),
      screening_ref: opts.screeningRef.trim(),
      ...(opts.includeEmail ? { include_email: true } : {}),
      ...(opts.notes ? { notes: opts.notes } : {}),
    },
    ...(opts.onBehalfOf ? { onBehalfOf: opts.onBehalfOf } : {}),
    ...(opts.script ? { script: opts.script } : {}),
  };
}

export async function onboard(cfg: Config, opts: OnboardOptions): Promise<void> {
  const call = toCall(opts);
  if (opts.dryRun) {
    console.log(JSON.stringify(buildRequest(cfg, call, scriptNameOrPlaceholder(cfg, opts.script)), null, 2));
    return;
  }
  const { request, agentDid, result } = await callAsAgent(cfg, call);
  if (!request.pii_did) {
    console.error("warning: no pii_did — {{profile.*}} placeholders need a data-owner context; pass --on-behalf-of <did> or run `kyb authorize` first");
  }
  console.error(`submit-onboarding on ${request.contract_id}@${request.contract_version} as ${agentDid}${request.pii_did ? ` for ${request.pii_did}` : ""}`);
  console.log(pretty(result));
}

export const onboardCommand = new Command("onboard")
  .description("Run submit-onboarding as the agent: POST the vendor to the ERP with the signatory as {{profile.*}} placeholders resolved in the enclave")
  .requiredOption("--vendor-id <id>", "your vendor id (1–128 chars)")
  .requiredOption("--screening-ref <ref>", "reference to the screen-vendor result you are acting on")
  .option("--include-email", "also template {{profile.verified_contacts.email.value}} (nested marker — may be rejected by the host)")
  .option("--notes <text>", "free-text notes (max 1000 chars, no PII)")
  .option("--on-behalf-of <did>", "data owner DID whose profile is substituted (default: USER_DID / state file)")
  .option("--script <name>", "z:<tid>:<tail> override")
  .option("--dry-run", "print the wire request only")
  .action((opts: OnboardOptions) => runCommand((cfg) => onboard(cfg, opts)));
