import { Command } from "commander";
import { openTenant } from "../client.js";
import { type Config } from "../env.js";
import { runCommand } from "../errors.js";

const LEVELS = ["info", "debug", "error"] as const;
type Level = (typeof LEVELS)[number];

interface LogsOptions {
  limit: number;
  since?: number;
  level?: string;
}

export async function logs(cfg: Config, opts: LogsOptions): Promise<void> {
  if (opts.level !== undefined && !(LEVELS as readonly string[]).includes(opts.level)) {
    throw new Error(`--level must be one of ${LEVELS.join(" | ")}`);
  }
  const { tenant } = await openTenant(cfg);
  const page = await tenant.contracts.logs(cfg.contractTail, {
    limit: opts.limit,
    ...(opts.since !== undefined ? { sinceSeq: opts.since } : {}),
    ...(opts.level !== undefined ? { minLevel: opts.level as Level } : {}),
  });
  if (page.entries.length === 0) {
    console.log("no log entries — contract logs need the tenant quota log_max_entries > 0 (off by default; ask the cluster operator) and at least one call that emitted logging::info");
  }
  for (const e of page.entries) {
    console.log(`${new Date(e.ts_ms).toISOString()} ${e.level.padEnd(5)} ${e.message}`);
  }
  if (page.next_seq !== null) console.log(`next_seq ${page.next_seq}${page.truncated ? " (truncated — pass --since to continue)" : ""}`);
}

export const logsCommand = new Command("logs")
  .description("Read the contract's debug log ring (logging::info/error lines emitted inside the enclave) as the tenant")
  .option("--limit <n>", "max entries", (v) => Number.parseInt(v, 10), 50)
  .option("--since <seq>", "continue from this sequence number", (v) => Number.parseInt(v, 10))
  .option("--level <level>", `minimum level: ${LEVELS.join(" | ")}`)
  .action((opts: LogsOptions) => runCommand((cfg) => logs(cfg, opts)));
