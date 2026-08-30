# shellup theme: powerline
# Requires a Nerd Font — the separators and icons below are private-use glyphs
# and render as tofu boxes without one. `shellup doctor` checks for this.

typeset -g SHELLUP_CTX_PROMPT=""

shellup_theme_render() {
  local s=""
  if [[ -n $SHELLUP_GIT_BRANCH ]]; then
    local body=" ${SHELLUP_GIT_BRANCH}"
    (( SHELLUP_GIT_STAGED ))     && body+=" +${SHELLUP_GIT_STAGED}"
    (( SHELLUP_GIT_UNSTAGED ))   && body+=" !${SHELLUP_GIT_UNSTAGED}"
    (( SHELLUP_GIT_UNTRACKED ))  && body+=" ?${SHELLUP_GIT_UNTRACKED}"
    (( SHELLUP_GIT_CONFLICTED )) && body+=" ${SHELLUP_GIT_CONFLICTED}"
    (( SHELLUP_GIT_STASH ))      && body+=" ${SHELLUP_GIT_STASH}"
    (( SHELLUP_GIT_AHEAD ))      && body+=" ⇡${SHELLUP_GIT_AHEAD}"
    (( SHELLUP_GIT_BEHIND ))     && body+=" ⇣${SHELLUP_GIT_BEHIND}"
    [[ -n $SHELLUP_GIT_ACTION ]] && body+="  ${SHELLUP_GIT_ACTION}"

    # Dirty tree turns the segment amber; clean stays green.
    local bg=71
    (( SHELLUP_GIT_UNSTAGED + SHELLUP_GIT_UNTRACKED + SHELLUP_GIT_CONFLICTED )) && bg=178
    s="%K{$bg}%F{24}%f%F{233}${body} %f%k%F{$bg}%f"
  else
    s="%F{24}%f"
  fi
  SHELLUP_GIT_PROMPT=$s

  local ctx=""
  [[ -n $SHELLUP_VENV ]] && ctx=" %F{184} ${SHELLUP_VENV}%f"
  SHELLUP_CTX_PROMPT=$ctx
}

PROMPT='%K{24}%F{233} %(4~|…/%3~|%~) %f%k${SHELLUP_GIT_PROMPT}${SHELLUP_CTX_PROMPT}
%(?.%F{71}.%F{160})❯%f '
RPROMPT='%F{240}${SHELLUP_DURATION}%f%(?.. %F{160} %?%f)'
