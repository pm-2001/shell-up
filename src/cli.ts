import pc from "picocolors";
import { init } from "./commands/init.js";
import { doctor } from "./commands/doctor.js";
import { theme } from "./commands/theme.js";
import { applyCommand } from "./commands/apply.js";
import { uninstall } from "./commands/uninstall.js";
import { version } from "./core/render.js";
import { THEMES } from "./themes/index.js";

function help(): void {
  console.log(`
  ${pc.bgCyan(pc.black(" shellup "))} ${pc.dim("v" + version())}   ${pc.dim("a beautiful, fast zsh in one command")}

  ${pc.bold("Usage")}
    ${pc.cyan("shellup")} ${pc.dim("<command>")}

  ${pc.bold("Commands")}
    ${pc.cyan("init")}              Set up your shell — interactive, backs up your .zshrc
    ${pc.cyan("doctor")}            Check what's wired up and what isn't
    ${pc.cyan("theme")} ${pc.dim("[name]")}      Switch prompt theme ${pc.dim("(" + THEMES.map((t) => t.name).join(", ") + ")")}
    ${pc.cyan("apply")}             Regenerate shell files from config.json
    ${pc.cyan("uninstall")}         Remove the .zshrc block, optionally the config too

  ${pc.bold("Flags")}
    ${pc.cyan("-y, --yes")}         Skip the install confirmation during init
    ${pc.cyan("-v, --version")}     Print version
    ${pc.cyan("-h, --help")}        This message

  ${pc.dim("Config lives in ~/.config/shellup. Your own overrides go in custom.zsh,")}
  ${pc.dim("which shellup sources last and never overwrites.")}
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("-")));
  const [command, ...rest] = argv.filter((a) => !a.startsWith("-"));

  if (flags.has("-v") || flags.has("--version")) {
    console.log(version());
    return;
  }
  if (flags.has("-h") || flags.has("--help")) return help();

  switch (command) {
    case undefined:
    case "init":
      return init({ yes: flags.has("-y") || flags.has("--yes") });
    case "doctor":
      return doctor();
    case "theme":
      return theme(rest[0]);
    case "apply":
      return applyCommand();
    case "uninstall":
      return uninstall();
    case "help":
      return help();
    default:
      console.error(`\n  ${pc.red("Unknown command:")} ${command}\n  Run ${pc.cyan("shellup --help")} to see what's available.\n`);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`\n  ${pc.red("shellup failed:")} ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
