# shellup

Level up your terminal in 60 seconds — a fast async prompt, modern tool swaps, and
sane zsh defaults, installed by one command and fully reversible by another.

```bash
npx @pm-2001/shellup init
```

Or install it so `shellup` stays on your `PATH`:

```bash
npm i -g @pm-2001/shellup     # the -g matters
shellup init
```

The package name is scoped; the command is just `shellup`.

> **`zsh: command not found: shellup`?** You installed without `-g`. A plain
> `npm i @pm-2001/shellup` only writes `./node_modules/.bin/shellup`, which is not on
> your `PATH`. Use `npm i -g`, or run it through `npx` as above.

No framework to adopt, no dotfiles repo to fork, and **three lines** added to your
`.zshrc`. Everything else lives in `~/.config/shellup`.

---

## What you get

**A prompt that doesn't slow you down.** Most themed prompts run `git status`
synchronously on every line, which is why they crawl in a large repo. shellup does one
`git rev-parse` up front and computes counts, ahead/behind, stash and rebase state in a
background process, repainting when the result lands.

```
~/dev/shellup on main +2 !1 ?3 ⇡1
> npm test                                                    4s
```

**Suggestions as you type.** The rest of the command appears in grey, pulled from
what you've actually run before — press <kbd>→</kbd> to accept it, <kbd>Alt</kbd>+<kbd>→</kbd>
to take one word. When history has nothing, it falls back to the completion system, so
`git ` still suggests a subcommand on a brand-new machine.

```
$ git pus­h origin main        ← "h origin main" is grey; → accepts
```

**Three themes**, two of which need no special font:

| theme | needs a Nerd Font | |
|---|---|---|
| `minimal` | no | clean two-line prompt, safe in any terminal |
| `neon` | no | bright, boxed, still font-safe |
| `powerline` | yes | segmented arrows and icons |

**Modern tool swaps**, each installed for you and wired up behind a guard:
[eza](https://github.com/eza-community/eza), [bat](https://github.com/sharkdp/bat),
[fzf](https://github.com/junegunn/fzf), [zoxide](https://github.com/ajeetdsouza/zoxide),
[fd](https://github.com/sharkdp/fd), [ripgrep](https://github.com/BurntSushi/ripgrep),
[git-delta](https://github.com/dandavison/delta), [zsh-autosuggestions](https://github.com/zsh-users/zsh-autosuggestions), lazygit, btop, jq, tldr.

`ls` and `cat` switch to eza and bat only when you're looking at the output. Pipes, redirects,
and flags that mean something different there still get the real commands, so scripts and
muscle memory keep working.

**zsh defaults worth having**: 100k lines of shared, deduplicated history; completion
with case-insensitive matching and a menu; `auto_cd` and a directory stack; prefix-aware
history search on <kbd>↑</kbd>; word-wise movement that survives ssh; `Ctrl-Z` to toggle
back into a suspended job.

**Aliases and functions** that stay out of the way — git shortcuts, `mkcd`, `extract`
(one command for every archive format), `serve`, `onport`, `bak`, `cdr`.

## Commands

```bash
shellup init          # interactive setup
shellup doctor        # what's wired up, what isn't, and how to fix it
shellup theme neon    # switch prompt theme
shellup apply         # regenerate after hand-editing config.json
shellup uninstall     # remove cleanly
shellup redis         # live view of your local Redis
```

## A live view of Redis

```bash
shellup redis                       # localhost:6379
shellup redis localhost:6380/2      # another port, database 2
shellup redis redis://:pass@host:6379 --read-only
```

A full-screen view that stays live until you press `q`, for seeing what your app
actually caches while it runs:

- **Keys**: every key grouped by prefix (`user:`, `cache:`, `session:`), with its type,
  TTL counting down, size and memory. Keys appear, change and disappear as your app
  writes them. Every type is readable: strings (JSON pretty-printed, binary as hex),
  hashes (with per-field TTLs), lists, sets, sorted sets, streams, vector sets, and
  RedisJSON / time series where the modules are installed.
- **Activity**: every command your apps send, as they send it, plus keys expiring and
  being evicted. Pause it, filter it, or jump from a command to its key.
- **Server**: memory, ops/s, cache hit rate, most-used commands, the slow log, clients.
- **Pub/Sub**: channels with subscribers, every message published, and a way to publish.

Delete a key, a whole prefix, or everything matching a filter (always confirmed); set a
TTL; rename; edit a short string; copy a value; switch database. `?` lists every key.

It stays out of your way:

- Listing uses `SCAN`, never `KEYS`, and shellup's own commands never appear in the
  activity feed or in the hit rate, which counts only your apps' lookups.
- To see key changes live it turns on `notify-keyspace-events`, and puts it back when
  you quit. If your app changes that setting while shellup is open, your app's value
  is the one that stays.
- The activity feed uses `MONITOR`, which can slow a busy server, so it's on by default
  only for a Redis on your own machine. If Redis ever queues commands faster than
  shellup can read them, the feed pauses itself for 30 seconds rather than let that
  backlog take memory your keys need.
- `--read-only` changes nothing at all.

## What it touches

```
~/.zshrc                          3 lines, in a marked block (or $ZDOTDIR/.zshrc if you set it)
~/.gitconfig                      delta settings, only if you say yes; uninstall offers to undo them
~/.config/shellup/
  config.json                     your choices
  init.zsh                        generated entry point
  generated/tools.zsh             generated tool integrations
  runtime/                        prompt engine, themes, aliases, functions
  custom.zsh                      YOURS — sourced last, never overwritten
  backups/                        timestamped copies of your .zshrc
```

Your `.zshrc` is backed up before every write. `shellup uninstall` removes the block and
leaves the file byte-for-byte as it was.

## Design notes

- **Every tool integration is guarded by `command -v`.** Uninstalling `eza` later
  degrades to plain `ls` instead of breaking your shell on every new terminal.
- **Non-interactive shells return immediately.** Sourcing a prompt engine during `scp` or
  a script is wasted work, and can corrupt protocols that expect clean stdout.
- **`custom.zsh` is sourced last**, so anything you write there wins over shellup's
  defaults without forking anything.
- **`compinit` checks its cache once a day** rather than rebuilding on every shell start.
- **macOS per-session history is switched off.** `/etc/zshrc_Apple_Terminal` runs before
  your `.zshrc` and, on a restored Terminal window, repoints `HISTFILE` into
  `~/.zsh_sessions` — which quietly breaks a single shared history. shellup takes Apple's
  documented opt-out and reclaims the file.

## Requirements

zsh, and Node 20.12+ to run the installer. macOS or Linux. Tool installation uses whichever
of `brew`, `apt`, `dnf` or `pacman` you have — without one, shellup still writes the
config and the integrations activate on their own once the tools reach your `PATH`.

## License

MIT
# shell-up
