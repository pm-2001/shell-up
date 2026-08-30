import * as p from "@clack/prompts";
import pc from "picocolors";
import { init } from "./init.js";
import { version } from "../core/render.js";
import { banner } from "../core/ui.js";

/**
 * First run, before any config exists. npm hides postinstall output by default
 * (npm 7+), so this — not the install log — is where a new user actually learns
 * what shellup does and what to type next.
 */
export async function welcome(opts: { yes?: boolean } = {}): Promise<void> {
  console.log();
  p.intro(banner(version()));

  const dot = pc.dim("·");
  p.note(
    [
      `${dot} async git prompt that stays instant in large repos`,
      `${dot} suggestions as you type, drawn from your own history`,
      `${dot} eza, bat, fzf, zoxide and delta installed and wired up`,
      `${dot} history, completion and keybindings that behave`,
      `${dot} 3 lines in your .zshrc, reversible with one command`,
    ].join("\n"),
    "A faster, better-looking zsh — set up in about a minute",
  );

  const go = await p.confirm({ message: "Set it up now?", initialValue: true });
  if (p.isCancel(go) || !go) {
    p.outro(
      `No problem. Run ${pc.cyan("shellup init")} when you're ready` +
        `, or ${pc.cyan("shellup --help")} to see everything.`,
    );
    return;
  }

  // Continue in the same visual block rather than opening a second one.
  await init({ ...opts, skipIntro: true });
}
