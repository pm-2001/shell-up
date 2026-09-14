# shellup — prompt engine
#
# The expensive part of a git prompt is `git status` in a large repo. Doing that
# synchronously is what makes themed prompts feel sluggish, so here the only
# blocking work per prompt is a single `git rev-parse`; counts, divergence and
# stash state are computed in a background process that repaints the prompt when
# it lands. Themes never touch any of this — they read the SHELLUP_* variables
# and define shellup_theme_render to format them.

[[ -o interactive ]] || return 0

autoload -Uz add-zsh-hook
setopt prompt_subst

# Overridden by whichever theme file loads next. Defined here so a missing or
# broken theme degrades to a plain prompt instead of erroring on every line.
shellup_theme_render() { SHELLUP_GIT_PROMPT=""; }

typeset -g SHELLUP_GIT_ROOT="" SHELLUP_GIT_BRANCH="" SHELLUP_GIT_ACTION=""
typeset -gi SHELLUP_GIT_STAGED=0 SHELLUP_GIT_UNSTAGED=0 SHELLUP_GIT_UNTRACKED=0
typeset -gi SHELLUP_GIT_CONFLICTED=0 SHELLUP_GIT_AHEAD=0 SHELLUP_GIT_BEHIND=0
typeset -gi SHELLUP_GIT_STASH=0 SHELLUP_GIT_LOADING=0
typeset -g SHELLUP_GIT_PROMPT="" SHELLUP_DURATION="" SHELLUP_VENV=""
typeset -gi _shellup_async_fd=0 _shellup_timer=0
typeset -g  _shellup_async_root=""   # repo the in-flight worker is reading
typeset -gi _shellup_async_dirty=0   # a command ran since that worker started

: ${SHELLUP_SLOW_THRESHOLD:=3}

_shellup_git_reset() {
  SHELLUP_GIT_ROOT=""; SHELLUP_GIT_BRANCH=""; SHELLUP_GIT_ACTION=""
  SHELLUP_GIT_STAGED=0; SHELLUP_GIT_UNSTAGED=0; SHELLUP_GIT_UNTRACKED=0
  SHELLUP_GIT_CONFLICTED=0; SHELLUP_GIT_AHEAD=0; SHELLUP_GIT_BEHIND=0
  SHELLUP_GIT_STASH=0; SHELLUP_GIT_LOADING=0; SHELLUP_GIT_PROMPT=""
}

# Runs in a background process. Prints one space-separated line; "-" means empty,
# so every field stays at a fixed position and the reader needs no parsing rules.
_shellup_git_worker() {
  # A background `git status` otherwise takes .git/index.lock to refresh the index,
  # which can make a `git commit` or `git add` you run at that moment fail with
  # "index.lock: File exists". This runs in a subshell, so the export can't leak.
  export GIT_OPTIONAL_LOCKS=0
  builtin cd -q "$1" 2>/dev/null || return
  local line xy branch="-" action="-" rest
  local -i staged=0 unstaged=0 untracked=0 conflicted=0 ahead=0 behind=0 stash=0

  while IFS= read -r line; do
    case $line in
      '# branch.head '*) branch=${line#'# branch.head '} ;;
      '# branch.ab '*)
        rest=${line#'# branch.ab '}
        ahead=${${rest%% *}#+}
        behind=${${rest##* }#-}
        ;;
      '? '*) (( untracked += 1 )) ;;
      'u '*) (( conflicted += 1 )) ;;
      [12]' '*)
        xy=${line[3,4]}                       # porcelain v2: X=index, Y=worktree
        [[ ${xy[1]} != '.' ]] && (( staged += 1 ))
        [[ ${xy[2]} != '.' ]] && (( unstaged += 1 ))
        ;;
    esac
  done < <(command git status --porcelain=v2 --branch --untracked-files=normal 2>/dev/null)

  stash=$(command git rev-list --walk-reflogs --count refs/stash 2>/dev/null) || stash=0
  [[ -z $stash ]] && stash=0

  local gitdir
  gitdir=$(command git rev-parse --git-dir 2>/dev/null)
  if [[ -n $gitdir ]]; then
    if   [[ -d $gitdir/rebase-merge || -d $gitdir/rebase-apply ]]; then action="rebase"
    elif [[ -f $gitdir/MERGE_HEAD ]];       then action="merge"
    elif [[ -f $gitdir/CHERRY_PICK_HEAD ]]; then action="cherry-pick"
    elif [[ -f $gitdir/REVERT_HEAD ]];      then action="revert"
    elif [[ -f $gitdir/BISECT_LOG ]];       then action="bisect"
    fi
  fi

  [[ $branch == '(detached)' ]] && branch="@$(command git rev-parse --short HEAD 2>/dev/null)"
  print -r -- "$staged $unstaged $untracked $conflicted $ahead $behind $stash $action $branch"
}

# Starts the single background worker. Only called when none is in flight.
_shellup_async_start() {
  _shellup_async_root=$1
  _shellup_async_dirty=0
  exec {_shellup_async_fd}< <( _shellup_git_worker "$1" )
  zle -F $_shellup_async_fd _shellup_async_callback
}

# Fired by zle when the worker has written its line (or hung up).
_shellup_async_callback() {
  local fd=$1 data
  IFS= read -r data <&$fd
  zle -F $fd 2>/dev/null
  # No `2>/dev/null` on this exec. With no command, exec applies its redirects to
  # the shell itself, permanently: it would close the fd AND send the shell's
  # stderr to /dev/null for the rest of the session, silencing `git push`, server
  # logs and every error message after it. The fd is always open here.
  exec {fd}<&-
  _shellup_async_fd=0

  # The user moved to another repo, or out of git, while this was running, so the
  # result describes a directory they have already left.
  if [[ $_shellup_async_root != "$SHELLUP_GIT_ROOT" ]]; then
    [[ -n $SHELLUP_GIT_ROOT ]] && _shellup_async_start "$SHELLUP_GIT_ROOT"
    return 0
  fi

  local -i rerun=$_shellup_async_dirty
  if [[ -n $data ]]; then
    local -a f=( ${=data} )
    SHELLUP_GIT_STAGED=$f[1];     SHELLUP_GIT_UNSTAGED=$f[2]
    SHELLUP_GIT_UNTRACKED=$f[3];  SHELLUP_GIT_CONFLICTED=$f[4]
    SHELLUP_GIT_AHEAD=$f[5];      SHELLUP_GIT_BEHIND=$f[6]
    SHELLUP_GIT_STASH=$f[7]
    [[ $f[8] != '-' ]] && SHELLUP_GIT_ACTION=$f[8] || SHELLUP_GIT_ACTION=""
    [[ $f[9] != '-' ]] && SHELLUP_GIT_BRANCH=$f[9]
  fi
  # A command ran after this worker started, so these counts may already be stale:
  # show them, stay in the loading state, and read the repo once more.
  SHELLUP_GIT_LOADING=$rerun

  shellup_theme_render
  zle && zle reset-prompt
  if (( rerun )); then
    _shellup_async_start "$SHELLUP_GIT_ROOT"
  fi
}

_shellup_preexec() {
  _shellup_timer=$EPOCHSECONDS
}

_shellup_precmd() {
  # Command duration, surfaced only when it was long enough to care about.
  SHELLUP_DURATION=""
  if (( _shellup_timer )); then
    local -i elapsed=$(( EPOCHSECONDS - _shellup_timer ))
    if (( elapsed >= SHELLUP_SLOW_THRESHOLD )); then
      if   (( elapsed < 60 ));   then SHELLUP_DURATION="${elapsed}s"
      elif (( elapsed < 3600 )); then SHELLUP_DURATION="$(( elapsed / 60 ))m$(( elapsed % 60 ))s"
      else                            SHELLUP_DURATION="$(( elapsed / 3600 ))h$(( (elapsed % 3600) / 60 ))m"
      fi
    fi
    _shellup_timer=0
  fi

  SHELLUP_VENV=""
  [[ -n $VIRTUAL_ENV ]] && SHELLUP_VENV=${VIRTUAL_ENV:t}

  # The one synchronous git call: cheap even in a huge repo.
  local -a info
  info=( ${(f)"$(command git rev-parse --show-toplevel --abbrev-ref HEAD 2>/dev/null)"} )
  if (( ${#info} < 2 )); then
    _shellup_git_reset
    shellup_theme_render
    return
  fi

  local root=$info[1] branch=$info[2]
  # rev-parse still prints the toplevel on an unborn branch but resolves HEAD to
  # the literal string "HEAD"; a detached checkout does the same. Git forbids a
  # branch actually named HEAD, so this is an unambiguous signal to look closer.
  if [[ $branch == HEAD ]]; then
    branch=$(command git symbolic-ref --short HEAD 2>/dev/null) \
      || branch="@$(command git rev-parse --short HEAD 2>/dev/null)"
  fi
  # Leaving a repo must clear counts, or the old repo's state bleeds into the new prompt.
  [[ $root != "$SHELLUP_GIT_ROOT" ]] && _shellup_git_reset
  SHELLUP_GIT_ROOT=$root
  SHELLUP_GIT_BRANCH=$branch
  SHELLUP_GIT_LOADING=1
  shellup_theme_render

  # One worker at a time. In a repo where `git status` is slow, starting a fresh one
  # on every Enter stacks them up (ten presses meant eleven at once); instead, mark
  # the in-flight result stale and let the callback read the repo once more.
  if (( _shellup_async_fd )); then
    _shellup_async_dirty=1
  else
    _shellup_async_start "$root"
  fi
}

zmodload zsh/datetime 2>/dev/null
add-zsh-hook preexec _shellup_preexec
add-zsh-hook precmd  _shellup_precmd
