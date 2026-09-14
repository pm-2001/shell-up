import pc from "picocolors";
import { init } from "./commands/init.js";
import { welcome } from "./commands/welcome.js";
import { configExists } from "./core/config.js";
import { doctor } from "./commands/doctor.js";
import { theme } from "./commands/theme.js";
import { applyCommand } from "./commands/apply.js";
import { uninstall } from "./commands/uninstall.js";
import { version } from "./core/render.js";
import { THEMES } from "./themes/index.js";

const COMMANDS = ["init", "welcome", "doctor", "theme", "apply", "uninstall", "help"];
const GLOBAL_FLAGS = ["-h", "--help", "-v", "--version"];
/** Flags each command understands. A bare `shellup` behaves like init. */
const COMMAND_FLAGS: Record<string, string[]> = {
  init: ["-y", "--yes"],
  welcome: ["-y", "--yes"],
};

function help(): void {
  console.log(`
  ${pc.bgCyan(pc.black(" shellup "))} ${pc.dim("v" + version())}   ${pc.dim("a beautiful, fast zsh in one command")}

  ${pc.bold("Usage")}
    ${pc.cyan("shellup")} ${pc.dim("<command>")}

  ${pc.bold("Commands")}
    ${pc.cyan("init")}              Set up your shell — interactive, backs up your .zshrc
    ${pc.cyan("doctor")}            Check what's wired up and what isn't
    ${pc.cyan("welcome")}           What shellup does, and set it up
    ${pc.cyan("theme")} ${pc.dim("[name]")}      Switch prompt theme ${pc.dim("(" + THEMES.map((t) => t.name).join(", ") + ")")}
    ${pc.cyan("apply")}             Regenerate shell files from config.json
    ${pc.cyan("uninstall")}         Remove the .zshrc block, optionally the config too

  ${pc.bold("Flags")}
    ${pc.cyan("-y, --yes")}         Skip the install confirmation (init only)
    ${pc.cyan("-v, --version")}     Print version
    ${pc.cyan("-h, --help")}        This message

  ${pc.dim("Config lives in ~/.config/shellup. Your own overrides go in custom.zsh,")}
  ${pc.dim("which shellup sources last and never overwrites.")}
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = argv.filter((a) => a.startsWith("-"));
  const [command, ...rest] = argv.filter((a) => !a.startsWith("-"));

  if (command !== undefined && !COMMANDS.includes(command)) {
    console.error(`\n  ${pc.red("Unknown command:")} ${command}\n  Run ${pc.cyan("shellup --help")} to see what's available.\n`);
    process.exitCode = 2;
    return;
  }

  // Refuse flags a command doesn't understand: `apply --dry-run` used to run a real
  // apply and edit your .zshrc.
  const allowed = [...GLOBAL_FLAGS, ...(COMMAND_FLAGS[command ?? "init"] ?? [])];
  const unknown = flags.filter((f) => !allowed.includes(f));
  if (unknown.length) {
    console.error(
      `\n  ${pc.red("Unknown option:")} ${unknown[0]}${command ? ` for ${pc.cyan(command)}` : ""}` +
        `\n  Run ${pc.cyan("shellup --help")} to see what's available.\n`,
    );
    process.exitCode = 2;
    return;
  }

  if (flags.includes("-v") || flags.includes("--version")) {
    console.log(version());
    return;
  }
  if (flags.includes("-h") || flags.includes("--help")) return help();
  const yes = flags.includes("-y") || flags.includes("--yes");

  switch (command) {
    case undefined:
      // A bare `shellup` on a fresh machine should explain itself; once set up,
      // it goes straight to reconfiguring.
      return configExists() ? init({ yes }) : welcome({ yes });
    case "init":
      return init({ yes });
    case "welcome":
      return welcome({ yes });
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
  }
}

main().catch((err: unknown) => {
  console.error(`\n  ${pc.red("✖")} ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
