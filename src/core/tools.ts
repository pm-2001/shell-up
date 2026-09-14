import { has, hasFile } from "./detect.js";

export interface Tool {
  id: string;
  /** Binary name to probe with `command -v`. Omitted for plugins, which have none. */
  bin?: string;
  /** Other names the same binary ships under, such as Debian's `batcat` for bat. */
  altBins?: string[];
  /**
   * For zsh plugins: candidate paths to the sourceable file. Presence means "any
   * of these exists", and the generated config sources the first one it finds.
   */
  sourceFiles?: string[];
  label: string;
  hint: string;
  brew?: string;
  apt?: string;
  dnf?: string;
  pacman?: string;
  /** Zsh emitted into generated/tools.zsh, wrapped in a guard on the binary's names. */
  snippet?: string;
  /** Applied via `git config --global`, only after an explicit prompt. */
  gitConfig?: [string, string][];
  /** The shellup version that first offered this tool, so init can point out what's new. */
  since?: string;
  recommended: boolean;
}

export const TOOLS: Tool[] = [
  {
    id: "eza", bin: "eza", label: "eza", hint: "ls with colors, icons and git status",
    brew: "eza", apt: "eza", dnf: "eza", pacman: "eza", recommended: true,
    snippet: [
      `# With no path argument, eza reads file names from stdin whenever stdin isn't a`,
      `# terminal: inside \`... | while read f; do ls; done\` it swallows the loop's input as`,
      `# file names, and on a pipe that stays open it hangs. Naming "." stops both.`,
      `_shellup_eza() {`,
      `  local arg ddash=0`,
      `  for arg in "$@"; do`,
      `    if (( ddash )) || [[ $arg != -* ]]; then`,
      `      eza "$@"`,
      `      return`,
      `    fi`,
      `    [[ $arg == -- ]] && ddash=1`,
      `  done`,
      `  eza "$@" .`,
      `}`,
      `() { local a; for a in ls ll la lt; do unalias $a 2>/dev/null; done }`,
      ``,
      `# ls itself only goes to eza when you are looking at the output and every flag means`,
      `# the same thing there. Pipes (ls -l | awk) need ls's own column layout, and flags eza`,
      `# reads differently (-t wants a field, -S shows block size, -c doesn't exist) would`,
      `# error or quietly do something else, so both run the real ls.`,
      `function ls {`,
      `  local arg flags="" ddash=0`,
      `  local -a args`,
      `  for arg in "$@"; do`,
      `    if (( ! ddash )) && [[ $arg == -- ]]; then`,
      `      ddash=1`,
      `    elif (( ! ddash )) && [[ $arg == -?* ]]; then`,
      `      flags+=\${arg#-}`,
      `      arg=\${arg//h/}      # eza sizes are already human-readable; its own -h adds a header row`,
      `      [[ $arg == - ]] && continue`,
      `    fi`,
      `    args+=("$arg")`,
      `  done`,
      `  if [[ ! -t 1 || $flags == *[^laAdrR1h]* ]]; then`,
      `    command ls "$@"`,
      `  else`,
      `    _shellup_eza --group-directories-first "\${args[@]}"`,
      `  fi`,
      `}`,
      `function ll { _shellup_eza -l --group-directories-first --git --time-style=long-iso "$@"; }`,
      `function la { _shellup_eza -la --group-directories-first --git --time-style=long-iso "$@"; }`,
      `function lt { _shellup_eza --tree --level=2 --group-directories-first "$@"; }`,
    ].join("\n"),
  },
  {
    id: "bat", bin: "bat", altBins: ["batcat"], label: "bat", hint: "cat with syntax highlighting",
    brew: "bat", apt: "bat", dnf: "bat", pacman: "bat", recommended: true,
    snippet: [
      `# Debian and Ubuntu install bat as batcat.`,
      `if (( ! $+commands[bat] )); then`,
      `  function bat { command batcat "$@"; }`,
      `fi`,
      `export BAT_THEME="\${BAT_THEME:-ansi}"`,
      `# bat only when you are looking at the output, with flags it reads the same way.`,
      `# Pipes and redirects (cat a > b) always get the real cat, and so do -v/-e/-t/-b,`,
      `# which bat rejects outright.`,
      `unalias cat 2>/dev/null`,
      `function cat {`,
      `  if [[ ! -t 1 ]]; then`,
      `    command cat "$@"`,
      `    return`,
      `  fi`,
      `  local arg`,
      `  for arg in "$@"; do`,
      `    [[ $arg == -- ]] && break`,
      `    if [[ $arg == -?* && \${arg#-} == *[^nsu]* ]]; then`,
      `      command cat "$@"`,
      `      return`,
      `    fi`,
      `  done`,
      `  bat --style=plain --paging=never "$@"`,
      `}`,
      `# MANPAGER runs under sh, which can't see the bat function above, so name the binary.`,
      `if (( $+commands[bat] )); then`,
      `  export MANPAGER="sh -c 'col -bx | bat -l man -p'"`,
      `else`,
      `  export MANPAGER="sh -c 'col -bx | batcat -l man -p'"`,
      `fi`,
    ].join("\n"),
  },
  {
    id: "fzf", bin: "fzf", label: "fzf", hint: "fuzzy finder — powers Ctrl-R history search",
    brew: "fzf", apt: "fzf", dnf: "fzf", pacman: "fzf", recommended: true,
    snippet: [
      `# fzf >=0.48 ships its own shell integration. Older builds leave the scripts wherever`,
      `# the package put them: Homebrew's prefix, Debian's docs dir, Fedora's or Arch's share.`,
      `if fzf --zsh >/dev/null 2>&1; then`,
      `  source <(fzf --zsh)`,
      `else`,
      `  () {`,
      `    local dir`,
      `    for dir in "\${HOMEBREW_PREFIX:-/opt/homebrew}/opt/fzf/shell" /usr/share/doc/fzf/examples /usr/share/fzf/shell /usr/share/fzf; do`,
      `      if [[ -r $dir/key-bindings.zsh ]]; then`,
      `        source $dir/key-bindings.zsh`,
      `        [[ -r $dir/completion.zsh ]] && source $dir/completion.zsh 2>/dev/null`,
      `        break`,
      `      fi`,
      `    done`,
      `  }`,
      `fi`,
      `export FZF_DEFAULT_OPTS="--height 40% --layout=reverse --border=rounded --info=inline"`,
      `# FZF_DEFAULT_COMMAND runs under sh, so it needs fd's real name (fdfind on Debian/Ubuntu).`,
      `if (( $+commands[fd] )); then`,
      `  export FZF_DEFAULT_COMMAND='fd --type f --hidden --follow --exclude .git'`,
      `elif (( $+commands[fdfind] )); then`,
      `  export FZF_DEFAULT_COMMAND='fdfind --type f --hidden --follow --exclude .git'`,
      `fi`,
    ].join("\n"),
  },
  {
    id: "zoxide", bin: "zoxide", label: "zoxide", hint: "cd that learns — jump with `z name`",
    brew: "zoxide", apt: "zoxide", dnf: "zoxide", pacman: "zoxide", recommended: true,
    snippet: `eval "$(zoxide init zsh)"`,
  },
  {
    id: "fd", bin: "fd", altBins: ["fdfind"], label: "fd", hint: "find, but fast and sane",
    brew: "fd", apt: "fd-find", dnf: "fd-find", pacman: "fd", recommended: true,
    snippet: [
      `# Debian and Ubuntu install fd as fdfind.`,
      `if (( ! $+commands[fd] )); then`,
      `  function fd { command fdfind "$@"; }`,
      `fi`,
    ].join("\n"),
  },
  {
    id: "ripgrep", bin: "rg", label: "ripgrep", hint: "grep, but fast (rg)",
    brew: "ripgrep", apt: "ripgrep", dnf: "ripgrep", pacman: "ripgrep", recommended: true,
  },
  {
    id: "delta", bin: "delta", label: "git-delta", hint: "side-by-side syntax-highlighted git diffs",
    brew: "git-delta", apt: "git-delta", dnf: "git-delta", pacman: "git-delta", recommended: true,
    // merge.conflictstyle is deliberately left alone: zdiff3 makes git older than 2.35
    // refuse to merge at all, and conflict layout is a preference unrelated to delta.
    gitConfig: [
      ["core.pager", "delta"],
      ["interactive.diffFilter", "delta --color-only"],
      ["delta.navigate", "true"],
      ["delta.line-numbers", "true"],
    ],
  },
  {
    id: "lazygit", bin: "lazygit", label: "lazygit", hint: "full git UI in the terminal (lg)",
    brew: "lazygit", apt: "lazygit", dnf: "lazygit", pacman: "lazygit", recommended: false,
    snippet: `alias lg='lazygit'`,
  },
  {
    id: "btop", bin: "btop", label: "btop", hint: "the good-looking top",
    brew: "btop", apt: "btop", dnf: "btop", pacman: "btop", recommended: false,
  },
  {
    id: "jq", bin: "jq", label: "jq", hint: "slice and query JSON",
    brew: "jq", apt: "jq", dnf: "jq", pacman: "jq", recommended: false,
  },
  {
    id: "tldr", bin: "tldr", label: "tldr", hint: "man pages with actual examples",
    brew: "tealdeer", apt: "tealdeer", dnf: "tealdeer", pacman: "tealdeer", recommended: false,
  },
  // Last on purpose: it wraps ZLE widgets, so it has to load after anything that
  // defines its own (fzf, zoxide).
  {
    id: "autosuggestions",
    label: "autosuggestions",
    hint: "greys in the rest of the command as you type — press → to accept",
    brew: "zsh-autosuggestions", apt: "zsh-autosuggestions",
    dnf: "zsh-autosuggestions", pacman: "zsh-autosuggestions",
    recommended: true,
    since: "0.2.0",
    sourceFiles: [
      "${HOMEBREW_PREFIX:-/opt/homebrew}/share/zsh-autosuggestions/zsh-autosuggestions.zsh",
      "/usr/local/share/zsh-autosuggestions/zsh-autosuggestions.zsh",
      "/usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh",
      "/usr/share/zsh/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh",
    ],
    // Set before sourcing, because the plugin reads some of these at load time.
    snippet: [
      `# 'history' replays what you actually ran; 'completion' falls back to the`,
      `# completion system, so \`git \` suggests a subcommand on a fresh machine.`,
      `ZSH_AUTOSUGGEST_STRATEGY=(history completion)`,
      `ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE='fg=8'`,
      `# Stops the plugin doing work on pasted blobs, where it can't help anyway.`,
      `ZSH_AUTOSUGGEST_BUFFER_MAX_SIZE=20`,
    ].join("\n"),
  },
];

/**
 * Everything any shellup version has written to ~/.gitconfig for delta, including
 * merge.conflictstyle=zdiff3 from 0.3.x and earlier. uninstall uses it to recognise
 * the settings it may offer to undo.
 */
export const LEGACY_DELTA_GIT_CONFIG: [string, string][] = [
  ["core.pager", "delta"],
  ["interactive.diffFilter", "delta --color-only"],
  ["delta.navigate", "true"],
  ["delta.line-numbers", "true"],
  ["merge.conflictstyle", "zdiff3"],
];

export const toolById = (id: string): Tool | undefined => TOOLS.find((t) => t.id === id);

/** Every name the tool's binary may be installed under. */
export function binNames(tool: Tool): string[] {
  return [...(tool.bin ? [tool.bin] : []), ...(tool.altBins ?? [])];
}

/** Binaries are probed on PATH under any of their names; plugins are probed on disk. */
export function isPresent(tool: Tool): boolean {
  if (tool.sourceFiles) return hasFile(tool.sourceFiles);
  return binNames(tool).some((name) => has(name));
}

export function packageFor(tool: Tool, pm: string): string | undefined {
  return pm === "brew" ? tool.brew : pm === "apt" ? tool.apt : pm === "dnf" ? tool.dnf : pm === "pacman" ? tool.pacman : undefined;
}
