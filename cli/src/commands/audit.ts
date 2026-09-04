import { Command } from "commander";
import { openSession } from "../client.js";
import { type Config, type KeyField } from "../env.js";
import { runCommand } from "../errors.js";

const ROLES = { tenant: "t3nApiKey", agent: "agentKey", user: "userKey" } as const satisfies Record<string, KeyField>;
type Role = keyof typeof ROLES;

interface AuditOptions {
  as: string;
  piiDid?: string;
  limit?: number;
  cursor?: string;
}

export async function audit(cfg: Config, opts: AuditOptions): Promise<void> {
  if (!(opts.as in ROLES)) throw new Error(`--as must be one of ${Object.keys(ROLES).join(" | ")}`);
  const s = await openSession(cfg, ROLES[opts.as as Role]);
  // The docs call this API unverified; the 5.10.0 d.ts declares it — guard at runtime rather than trust either.
  const probe = s.t3n as unknown as { getAuditEvents?: unknown };
  if (typeof probe.getAuditEvents !== "function") {
    throw new Error("this @terminal3/t3n-sdk build does not expose T3nClient.getAuditEvents — the audit read is not available with the installed SDK");
  }
  const page = await s.t3n.getAuditEvents({
    ...(opts.piiDid ? { pii_did: opts.piiDid } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.cursor ? { cursor: opts.cursor } : {}),
  });
  console.error(`audit trail read as ${opts.as} ${s.did}${opts.piiDid ? ` for ${opts.piiDid}` : ""}`);
  console.log(JSON.stringify(page, null, 2));
}

export const auditCommand = new Command("audit")
  .description("Read host-stamped audit events (audit.get-mine) — guarded: the docs mark this SDK call unverified")
  .option("--as <role>", "whose session reads the trail: tenant | agent | user", "agent")
  .option("--pii-did <did>", "as a delegated agent, read the events performed for this user")
  .option("--limit <n>", "page size", (v) => Number.parseInt(v, 10))
  .option("--cursor <hex>", "next_cursor from a previous page")
  .action((opts: AuditOptions) => runCommand((cfg) => audit(cfg, opts)));
