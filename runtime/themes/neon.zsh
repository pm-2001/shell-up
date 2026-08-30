# shellup theme: neon
# Bright two-line prompt drawn with box characters and common Unicode arrows —
# no patched font required, so it works next to minimal on a bare system.

typeset -g SHELLUP_CTX_PROMPT=""

shellup_theme_render() {
  local s=""
  if [[ -n $SHELLUP_GIT_BRANCH ]]; then
    s=" %F{240}·%f %F{213}⌥ ${SHELLUP_GIT_BRANCH}%f"
    (( SHELLUP_GIT_STAGED ))     && s+=" %F{82}●${SHELLUP_GIT_STAGED}%f"
    (( SHELLUP_GIT_UNSTAGED ))   && s+=" %F{220}✚${SHELLUP_GIT_UNSTAGED}%f"
    (( SHELLUP_GIT_UNTRACKED ))  && s+=" %F{45}◌${SHELLUP_GIT_UNTRACKED}%f"
    (( SHELLUP_GIT_CONFLICTED )) && s+=" %F{196}✖${SHELLUP_GIT_CONFLICTED}%f"
    (( SHELLUP_GIT_STASH ))      && s+=" %F{141}⚑${SHELLUP_GIT_STASH}%f"
    (( SHELLUP_GIT_AHEAD ))      && s+=" %F{51}⇡${SHELLUP_GIT_AHEAD}%f"
    (( SHELLUP_GIT_BEHIND ))     && s+=" %F{51}⇣${SHELLUP_GIT_BEHIND}%f"
    [[ -n $SHELLUP_GIT_ACTION ]] && s+=" %F{196}⚡${SHELLUP_GIT_ACTION}%f"
  fi
  SHELLUP_GIT_PROMPT=$s

  local ctx=""
  [[ -n $SHELLUP_VENV ]] && ctx=" %F{240}·%f %F{184}🐍${SHELLUP_VENV}%f"
  SHELLUP_CTX_PROMPT=$ctx
}

PROMPT='%F{240}╭─%f %F{51}%(4~|…/%3~|%~)%f${SHELLUP_GIT_PROMPT}${SHELLUP_CTX_PROMPT}
%F{240}╰─%f%(?.%F{213}.%F{196})❯%f '
RPROMPT='%F{240}${SHELLUP_DURATION}%f%(?.. %F{196}✖ %?%f)'
