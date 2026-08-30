# shellup — keybindings
# Emacs bindings plus the two things people miss most: prefix-aware history
# search on the arrow keys, and word-wise movement that works over ssh.

[[ -o interactive ]] || return 0

bindkey -e

# Type a few characters, press Up: cycles only through matching history.
autoload -U up-line-or-beginning-search down-line-or-beginning-search
zle -N up-line-or-beginning-search
zle -N down-line-or-beginning-search
bindkey '^[[A' up-line-or-beginning-search      # Up
bindkey '^[[B' down-line-or-beginning-search    # Down
bindkey '^[OA' up-line-or-beginning-search      # Up (application mode)
bindkey '^[OB' down-line-or-beginning-search    # Down (application mode)

bindkey '^[[1;5C' forward-word                  # Ctrl-Right
bindkey '^[[1;5D' backward-word                 # Ctrl-Left
bindkey '^[[1;3C' forward-word                  # Alt-Right
bindkey '^[[1;3D' backward-word                 # Alt-Left
bindkey '^[f'     forward-word
bindkey '^[b'     backward-word

bindkey '^[[H' beginning-of-line                # Home
bindkey '^[[F' end-of-line                      # End
bindkey '^[[3~' delete-char                     # Delete
bindkey '^[[3;5~' kill-word                     # Ctrl-Delete

bindkey '^U' backward-kill-line                 # match bash: kill to start, not whole line
bindkey '^[^?' backward-kill-word               # Alt-Backspace

# Treat path separators as word boundaries so Ctrl-W deletes one path segment.
WORDCHARS='*?_-.[]~&;!#$%^(){}<>'

# Ctrl-Z again to foreground the job you just suspended.
_shellup_fg() {
  if [[ $#BUFFER -eq 0 ]]; then
    fg >/dev/null 2>&1 && zle redisplay
  else
    zle push-input
  fi
}
zle -N _shellup_fg
bindkey '^Z' _shellup_fg
