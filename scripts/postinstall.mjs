// Shown once, right after `npm i -g @pm-2001/shellup`.
//
// Two hard rules: never fail an install, and never add noise where nobody is
// reading. Anything unexpected exits 0 quietly rather than breaking `npm i`.
try {
  const isGlobal = process.env.npm_config_global === "true";
  const inCI = Boolean(process.env.CI);
  // A local `npm i` of this as a dependency, or a CI install, wants silence.
  if (!isGlobal || inCI) process.exit(0);

  const plain = Boolean(process.env.NO_COLOR) || process.env.TERM === "dumb";
  const c = (code, s) => (plain ? s : `\x1b[${code}m${s}\x1b[0m`);
  const dim = (s) => c("2", s);
  const cyan = (s) => c("36", s);
  const bold = (s) => c("1", s);

  const { version } = JSON.parse(
    await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
    ),
  );

  const dot = dim("·");
  console.log(`
  ${c("46;30", " shellup ")} ${dim("v" + version)}

  ${bold("A faster, better-looking zsh — set up in about a minute.")}

    ${dot} async git prompt that stays instant in large repos
    ${dot} suggestions as you type, drawn from your own history
    ${dot} eza, bat, fzf, zoxide and delta installed and wired up
    ${dot} history, completion and keybindings that behave
    ${dot} 3 lines in your .zshrc, reversible with one command

  ${bold("Next:")}  ${cyan("shellup init")}       ${dim("set it up (interactive)")}
         ${cyan("shellup doctor")}     ${dim("check what's wired up")}
`);
} catch {
  // Never let a cosmetic banner fail an install.
  process.exit(0);
}
