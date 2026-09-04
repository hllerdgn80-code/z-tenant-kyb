import { Command } from "commander";
import { auditCommand } from "./commands/audit.js";
import { authorizeCommand } from "./commands/authorize.js";
import { deployCommand } from "./commands/deploy.js";
import { doctorCommand } from "./commands/doctor.js";
import { logsCommand } from "./commands/logs.js";
import { onboardCommand } from "./commands/onboard.js";
import { screenCommand } from "./commands/screen.js";

const program = new Command("kyb")
  .description(
    "Operator CLI for the z-tenant-kyb T3N trusted agent — vendor KYB: key-less VIES + GLEIF screening and PII-safe ERP onboarding inside the enclave.",
  )
  .version("0.1.0")
  .showHelpAfterError();

for (const c of [doctorCommand, deployCommand, authorizeCommand, screenCommand, onboardCommand, logsCommand, auditCommand]) {
  program.addCommand(c);
}

await program.parseAsync(process.argv);
