# shellup theme: minimal
# Deliberately glyph-free — every character here exists in any monospace font,
# so this is the theme that is always safe to fall back to.

typeset -g SHELLUP_CTX_PROMPT=""

shellup_theme_render() {
  # Branch and venv names come from outside, and zsh reads a literal % in them as a
  # prompt escape (feat/100%-done rendered as feat/100/<cwd>one), so double it.
  local s=""
  if [[ -n $SHELLUP_GIT_BRANCH ]]; then
    s=" %F{242}on%f %F{magenta}${SHELLUP_GIT_BRANCH//\%/%%}%f"
    (( SHELLUP_GIT_STAGED ))     && s+=" %F{green}+${SHELLUP_GIT_STAGED}%f"
    (( SHELLUP_GIT_UNSTAGED ))   && s+=" %F{yellow}!${SHELLUP_GIT_UNSTAGED}%f"
    (( SHELLUP_GIT_UNTRACKED ))  && s+=" %F{blue}?${SHELLUP_GIT_UNTRACKED}%f"
    (( SHELLUP_GIT_CONFLICTED )) && s+=" %F{red}x${SHELLUP_GIT_CONFLICTED}%f"
    (( SHELLUP_GIT_STASH ))      && s+=" %F{cyan}*${SHELLUP_GIT_STASH}%f"
    (( SHELLUP_GIT_AHEAD ))      && s+=" %F{cyan}^${SHELLUP_GIT_AHEAD}%f"
    (( SHELLUP_GIT_BEHIND ))     && s+=" %F{cyan}v${SHELLUP_GIT_BEHIND}%f"
    [[ -n $SHELLUP_GIT_ACTION ]] && s+=" %F{red}(${SHELLUP_GIT_ACTION})%f"
  fi
  SHELLUP_GIT_PROMPT=$s

  local ctx=""
  [[ -n $SHELLUP_VENV ]] && ctx=" %F{yellow}(${SHELLUP_VENV//\%/%%})%f"
  SHELLUP_CTX_PROMPT=$ctx
}

PROMPT='%F{39}%(4~|…/%3~|%~)%f${SHELLUP_GIT_PROMPT}${SHELLUP_CTX_PROMPT}
%(?.%F{green}.%F{red})>%f '
RPROMPT='%F{242}${SHELLUP_DURATION}%f%(?.. %F{red}[%?]%f)'
