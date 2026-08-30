# shellup — functions
# The handful of things that are genuinely awkward to type out every time.

[[ -o interactive ]] || return 0

# Make a directory and step into it.
mkcd() {
  [[ -z $1 ]] && { print -u2 "usage: mkcd <dir>"; return 2 }
  mkdir -p -- "$1" && builtin cd -- "$1"
}

# One command for every archive format, instead of remembering nine flag sets.
extract() {
  [[ -z $1 ]] && { print -u2 "usage: extract <archive>"; return 2 }
  [[ -f $1 ]] || { print -u2 "extract: no such file: $1"; return 1 }
  case $1 in
    *.tar.bz2|*.tbz2) tar xjf   -- "$1" ;;
    *.tar.gz|*.tgz)   tar xzf   -- "$1" ;;
    *.tar.xz)         tar xJf   -- "$1" ;;
    *.tar.zst)        tar --zstd -xf -- "$1" ;;
    *.tar)            tar xf    -- "$1" ;;
    *.bz2)            bunzip2   -- "$1" ;;
    *.gz)             gunzip    -- "$1" ;;
    *.zip)            unzip     -- "$1" ;;
    *.7z)             7z x         "$1" ;;
    *.rar)            unrar x      "$1" ;;
    *.Z)              uncompress -- "$1" ;;
    *) print -u2 "extract: don't know how to open $1"; return 1 ;;
  esac
}

# Serve the current directory over HTTP. `serve 3000` to pick a port.
serve() {
  local port=${1:-8000}
  print "serving $PWD on http://localhost:$port"
  python3 -m http.server "$port"
}

# What is holding this port, and what do I kill?
onport() {
  [[ -z $1 ]] && { print -u2 "usage: onport <port>"; return 2 }
  lsof -nP -iTCP:"$1" -sTCP:LISTEN
}

# Timestamped copy, for when you're about to edit something risky.
bak() {
  [[ -z $1 ]] && { print -u2 "usage: bak <file>"; return 2 }
  cp -a -- "$1" "$1.$(date +%Y%m%d-%H%M%S).bak" && print "backed up $1"
}

# Jump to the root of the current git repo.
cdr() {
  local root
  root=$(git rev-parse --show-toplevel 2>/dev/null) || { print -u2 "cdr: not in a git repo"; return 1 }
  builtin cd -- "$root"
}
