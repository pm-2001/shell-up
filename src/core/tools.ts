import { has, hasFile } from "./detect.js";

export interface Tool {
  id: string;
  /** Binary name to probe with `command -v`. Omitted for plugins, which have none. */
  bin?: string;
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
  /** Zsh emitted into generated/tools.zsh. Always wrapped in a `command -v` guard. */
  snippet?: string;
  /** Applied via `git config --global`, only after an explicit prompt. */
  gitConfig?: [string, string][];
  recommended: boolean;
}

export const TOOLS: Tool[] = [
  {
    id: "eza", bin: "eza", label: "eza", hint: "ls with colors, icons and git status",
    brew: "eza", apt: "eza", dnf: "eza", pacman: "eza", recommended: true,
    snippet: [
      `alias ls='eza --group-directories-first'`,
      `alias ll='eza -l --group-directories-first --git --time-style=long-iso'`,
      `alias la='eza -la --group-directories-first --git --time-style=long-iso'`,
      `alias lt='eza --tree --level=2 --group-directories-first'`,
    ].join("\n"),
  },
  {
    id: "bat", bin: "bat", label: "bat", hint: "cat with syntax highlighting",
    brew: "bat", apt: "bat", dnf: "bat", pacman: "bat", recommended: true,
    // bat detects a non-tty stdout and behaves like plain cat, so aliasing is pipe-safe.
    snippet: [
      `export BAT_THEME="\${BAT_THEME:-ansi}"`,
      `alias cat='bat --style=plain --paging=never'`,
      `export MANPAGER="sh -c 'col -bx | bat -l man -p'"`,
    ].join("\n"),
  },
  {
    id: "fzf", bin: "fzf", label: "fzf", hint: "fuzzy finder — powers Ctrl-R history search",
    brew: "fzf", apt: "fzf", dnf: "fzf", pacman: "fzf", recommended: true,
    snippet: [
      `# fzf >=0.48 ships its own shell integration; older builds keep it in the prefix.`,
      `if fzf --zsh >/dev/null 2>&1; then`,
      `  source <(fzf --zsh)`,
      `elif [[ -d "\${HOMEBREW_PREFIX:-/opt/homebrew}/opt/fzf/shell" ]]; then`,
      `  source "\${HOMEBREW_PREFIX:-/opt/homebrew}/opt/fzf/shell/key-bindings.zsh"`,
      `  source "\${HOMEBREW_PREFIX:-/opt/homebrew}/opt/fzf/shell/completion.zsh" 2>/dev/null`,
      `fi`,
      `export FZF_DEFAULT_OPTS="--height 40% --layout=reverse --border=rounded --info=inline"`,
      `command -v fd >/dev/null 2>&1 && export FZF_DEFAULT_COMMAND='fd --type f --hidden --follow --exclude .git'`,
    ].join("\n"),
  },
  {
    id: "zoxide", bin: "zoxide", label: "zoxide", hint: "cd that learns — jump with `z name`",
    brew: "zoxide", apt: "zoxide", dnf: "zoxide", pacman: "zoxide", recommended: true,
    snippet: `eval "$(zoxide init zsh)"`,
  },
  {
    id: "fd", bin: "fd", label: "fd", hint: "find, but fast and sane",
    brew: "fd", apt: "fd-find", dnf: "fd-find", pacman: "fd", recommended: true,
  },
  {
    id: "ripgrep", bin: "rg", label: "ripgrep", hint: "grep, but fast (rg)",
    brew: "ripgrep", apt: "ripgrep", dnf: "ripgrep", pacman: "ripgrep", recommended: true,
  },
  {
    id: "delta", bin: "delta", label: "git-delta", hint: "side-by-side syntax-highlighted git diffs",
    brew: "git-delta", apt: "git-delta", dnf: "git-delta", pacman: "git-delta", recommended: true,
    gitConfig: [
      ["core.pager", "delta"],
      ["interactive.diffFilter", "delta --color-only"],
      ["delta.navigate", "true"],
      ["delta.line-numbers", "true"],
      ["merge.conflictstyle", "zdiff3"],
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

export const toolById = (id: string): Tool | undefined => TOOLS.find((t) => t.id === id);

/** Binaries are probed on PATH; plugins are probed on disk. */
export function isPresent(tool: Tool): boolean {
  if (tool.sourceFiles) return hasFile(tool.sourceFiles);
  return tool.bin ? has(tool.bin) : false;
}

export function packageFor(tool: Tool, pm: string): string | undefined {
  return pm === "brew" ? tool.brew : pm === "apt" ? tool.apt : pm === "dnf" ? tool.dnf : pm === "pacman" ? tool.pacman : undefined;
}
