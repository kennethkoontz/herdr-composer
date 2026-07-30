# herdr-composer

Conductor-style composer popup for [Herdr](https://herdr.dev): pick a **space**,
**harness**, **model**, and **effort**, type a prompt, and spawn an agent in a
fresh tab.

Requires [Herdr](https://herdr.dev) `0.7.0+` and Node.js 20+.

## Install

From GitHub:

```sh
herdr plugin install kennethkoontz/herdr-composer -y
```

Or link a local checkout while developing:

```sh
git clone https://github.com/kennethkoontz/herdr-composer.git
herdr plugin link ./herdr-composer --enabled
```

Optional config:

```sh
CONFIG="$(herdr plugin config-dir kennethkoontz.herdr-composer)"
cp config.example.json "$CONFIG/config.json"
# edit harnesses, models, project_roots, defaults…
```

Bind a key in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "kennethkoontz.herdr-composer.open"
description = "Composer"
```

Reload config (`prefix+shift+r` or `herdr server reload-config`).

## Use

- Bound key (or `herdr plugin action invoke kennethkoontz.herdr-composer.open`)
  opens the popup
- **tab** / **↑↓** move fields
- **enter** opens a picker, or creates from the prompt/Create chip
- In pickers: **↑↓** or **ctrl-p** / **ctrl-n** move the selection
- **←/→** on harness cycles kinds; on the footer moves across chips
- **⌥w** / **⌥m** / **⌥e** / **⌥h** / **⌥t** / **⌥o** (alt + letter) open
  space, model, effort, harness, or toggle worktree/create-more from anywhere,
  including the prompt. Plain **w** / **m** / **e** / **h** / **t** / **o**
  work when focus is off the prompt.
- type anywhere to edit the prompt
- in the prompt: **shift+enter** (or **alt+enter**) inserts a newline;
  **enter** creates
- in the prompt: **←/→**, **ctrl-b/f** move; **ctrl-a** / **home** start;
  **ctrl-e** / **end** end; **ctrl-k** kill to end; **ctrl-u** kill to start
- in the prompt: **shift+←/→** (or **shift+home/end**) selects text; **ctrl+c**
  copies the selection to the clipboard (plain **ctrl+c** still cancels when
  nothing is selected)
- mouse drag-select in the prompt (copies to the clipboard on release, same as
  Herdr panes)
- paste text into the prompt via the terminal paste (bracketed paste) or
  **ctrl-v** (clipboard text; on macOS, an image is saved to a temp PNG and
  its path is inserted instead)
- **esc** closes

Create makes a Git worktree from the selected space and opens it as a new Herdr
workspace by default. The branch is derived from the prompt and given a unique
suffix. Turn off the **worktree** chip to keep the previous behavior:
focus/create the selected workspace and open a fresh tab there. In either mode,
Composer starts the harness with model/effort flags in a background job (the
popup closes immediately) and submits the prompt when non-empty.

If the harness opens a first-run dialog — most often the folder-trust check in a
brand-new worktree — Composer focuses the pane and holds the prompt until the
dialog is answered (up to two minutes), then submits it. The prompt is never
typed into the dialog. If the dialog is still open after that, Composer leaves
the prompt unsent and shows a notification instead.

Default harnesses: `pi`, `claude`, `codex`, `grok`.

## Config

See `config.example.json`. Important keys:

| Key | Purpose |
| --- | --- |
| `project_roots` | Directories scanned for space paths |
| `harnesses` | Ordered harness list in the UI |
| `defaults.worktree` | Create a Herdr Git worktree by default (`true`) |
| `defaults.model` / `defaults.effort` | Per-harness defaults |
| `models.*` / `effort.*` | Picker options per harness |

Pi models are also discovered via `pi --list-models`. Grok models via `grok models`.

## License

MIT
