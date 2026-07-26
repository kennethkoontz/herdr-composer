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
- **s** / **m** / **e** / **h** / **o** open space, model, effort, harness, or
  toggle create-more (plain letter when focus is off the prompt; **alt/⌥** +
  letter works from the prompt too)
- type anywhere to edit the prompt
- **esc** closes

Create focuses/creates the workspace, opens a fresh tab, starts the harness with
model/effort flags in a background job (popup closes immediately), and submits
the prompt when non-empty.

Default harnesses: `pi`, `claude`, `codex`, `grok`.

## Config

See `config.example.json`. Important keys:

| Key | Purpose |
| --- | --- |
| `project_roots` | Directories scanned for space paths |
| `harnesses` | Ordered harness list in the UI |
| `defaults.model` / `defaults.effort` | Per-harness defaults |
| `models.*` / `effort.*` | Picker options per harness |

Pi models are also discovered via `pi --list-models`. Grok models via `grok models`.

## License

MIT
