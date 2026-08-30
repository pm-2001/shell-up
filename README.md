# shellup

Level up your terminal in 60 seconds — a fast async prompt, modern tool swaps, and
sane zsh defaults, installed by one command and fully reversible by another.

```bash
npx shellup init
```

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
[git-delta](https://github.com/dandavison/delta), lazygit, btop, jq, tldr.

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
```

## What it touches

```
~/.zshrc                          3 lines, in a marked block, appended
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

## Requirements

zsh, and Node 18+ to run the installer. macOS or Linux. Tool installation uses whichever
of `brew`, `apt`, `dnf` or `pacman` you have — without one, shellup still writes the
config and the integrations activate on their own once the tools reach your `PATH`.

## License

MIT
# shell-up
