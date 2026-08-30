# shellup — zsh defaults
# Stock zsh forgets history across panes, re-asks for completions it already
# knows, and makes you type `cd`. These are the settings most people end up
# copying from a blog post eventually.

[[ -o interactive ]] || return 0

# ── History ────────────────────────────────────────────────────────────────
HISTFILE="${HISTFILE:-$HOME/.zsh_history}"
HISTSIZE=100000
SAVEHIST=100000
setopt append_history          # never truncate another shell's writes
setopt inc_append_history      # write as you go, not just on exit
setopt share_history           # new panes see what you just ran
setopt hist_ignore_dups
setopt hist_ignore_all_dups
setopt hist_ignore_space       # a leading space keeps it out of history
setopt hist_reduce_blanks
setopt hist_verify             # expand !! for review instead of running it
setopt extended_history

# ── Navigation ─────────────────────────────────────────────────────────────
setopt auto_cd                 # `../..` instead of `cd ../..`
setopt auto_pushd              # every cd builds a stack; `cd -<TAB>` to browse
setopt pushd_ignore_dups
setopt pushd_silent
DIRSTACKSIZE=20

# ── Globbing & misc ────────────────────────────────────────────────────────
setopt extended_glob
setopt no_case_glob
setopt interactive_comments    # `# note` is legal at the prompt
setopt no_beep
setopt no_flow_control         # frees Ctrl-S / Ctrl-Q for real bindings
unsetopt correct_all           # autocorrect guesses wrong more than it helps

# ── Completion ─────────────────────────────────────────────────────────────
# compinit rebuilds its cache on every launch unless told otherwise; checking
# the dump's age once a day keeps startup fast without going stale.
autoload -Uz compinit
() {
  local dump="${ZDOTDIR:-$HOME}/.zcompdump"
  if [[ -n ${dump}(#qN.mh+24) ]]; then
    compinit -d "$dump"
  else
    compinit -C -d "$dump"
  fi
}

zstyle ':completion:*' menu select
zstyle ':completion:*' matcher-list 'm:{a-zA-Z}={A-Za-z}' 'r:|[._-]=* r:|=*'
zstyle ':completion:*' list-colors "${(s.:.)LS_COLORS}"
zstyle ':completion:*' group-name ''
zstyle ':completion:*:descriptions' format '%F{242}%d%f'
zstyle ':completion:*:warnings'     format '%F{red}no matches%f'
zstyle ':completion:*' use-cache on
zstyle ':completion:*' cache-path "${XDG_CACHE_HOME:-$HOME/.cache}/zsh/compcache"
zstyle ':completion:*' special-dirs true
zstyle ':completion:*:*:kill:*:processes' list-colors '=(#b) #([0-9]#)*=0=01;31'
