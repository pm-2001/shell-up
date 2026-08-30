# shellup — aliases
# Only aliases that are safe without any extra binary installed. Anything that
# depends on eza/bat/lazygit lives in generated/tools.zsh behind a guard.

[[ -o interactive ]] || return 0

# ── Navigation ─────────────────────────────────────────────────────────────
alias ..='cd ..'
alias ...='cd ../..'
alias ....='cd ../../..'
alias -- -='cd -'

# ── Safety rails ───────────────────────────────────────────────────────────
alias cp='cp -i'
alias mv='mv -i'
alias mkdir='mkdir -p'

# ── git ────────────────────────────────────────────────────────────────────
alias g='git'
alias gs='git status --short --branch'
alias ga='git add'
alias gaa='git add --all'
alias gc='git commit'
alias gcm='git commit -m'
alias gca='git commit --amend'
alias gco='git checkout'
alias gsw='git switch'
alias gb='git branch'
alias gd='git diff'
alias gds='git diff --staged'
alias gp='git push'
alias gpl='git pull'
alias gf='git fetch --all --prune'
alias gst='git stash'
alias gl='git log --oneline --graph --decorate -20'
alias gll='git log --oneline --graph --decorate --all'
alias gundo='git reset --soft HEAD~1'
alias gwip='git add -A && git commit -m "wip" --no-verify'

# ── Shell housekeeping ─────────────────────────────────────────────────────
alias reload='exec zsh'
alias path='print -l $path'
alias now='date "+%Y-%m-%d %H:%M:%S"'
alias week='date +%V'
alias ports='lsof -iTCP -sTCP:LISTEN -P -n'
alias myip='curl -s https://api.ipify.org && echo'
