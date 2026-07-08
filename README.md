<div align="center">

<img src="./assets/logo.svg" width="128" alt="omo-router logo" />

# omo-router

**Switch between named stacks of `oh-my-openagent.json` model assignments.**
opencode plugin + CLI · one command, one restart, new model crew.

[![npm version](https://img.shields.io/npm/v/@dylanrussell/omo-router.svg?color=06b6d4&label=npm&logo=npm&logoColor=white&style=flat-square)](https://www.npmjs.com/package/@dylanrussell/omo-router)
[![npm downloads](https://img.shields.io/npm/dm/@dylanrussell/omo-router.svg?color=06b6d4&label=downloads&style=flat-square)](https://www.npmjs.com/package/@dylanrussell/omo-router)
[![license](https://img.shields.io/npm/l/@dylanrussell/omo-router.svg?color=06b6d4&style=flat-square)](./LICENSE)
[![node](https://img.shields.io/node/v/@dylanrussell/omo-router.svg?color=06b6d4&logo=node.js&logoColor=white&style=flat-square)](https://nodejs.org)
[![CI](https://img.shields.io/github/actions/workflow/status/dylanrussellmd/omo-router/ci.yml?branch=main&label=CI&logo=github&logoColor=white&style=flat-square)](https://github.com/dylanrussellmd/omo-router/actions/workflows/ci.yml)
[![types: TypeScript](https://img.shields.io/badge/types-TypeScript-3178C6.svg?logo=typescript&logoColor=white&style=flat-square)](https://www.typescriptlang.org)
[![tested with vitest](https://img.shields.io/badge/tested%20with-vitest-FCC72B.svg?logo=vitest&logoColor=black&style=flat-square)](https://vitest.dev)

[Docs](./docs/README.md) · [Install](./docs/01-install.md) · [Quickstart](./docs/02-quickstart.md) · [FAQ](./docs/08-faq.md) · [Issues](https://github.com/dylanrussellmd/omo-router/issues)

</div>

---

## What it does

[`oh-my-openagent`](https://github.com/code-yeongyu/oh-my-openagent) reads `~/.config/opencode/oh-my-openagent.json` to decide which model backs each agent (`sisyphus`, `oracle`, …) and each category (`visual-engineering`, `deep`, `quick`, …). That file is a single source of truth — there's only one of it.

`omo-router` lets you keep multiple full snapshots of that file under names you pick (`premium`, `openrouter-cheap`, `free-only`, …) and swap between them on demand.

```
~/.config/opencode/
├── oh-my-openagent.json                  ← active stack (written by omo-router)
└── omo-router/
    ├── state.json                        ← {active, previousActive, …}
    ├── stacks/
    │   ├── premium.json                  ← named snapshots
    │   ├── openrouter-cheap.json
    │   └── free-only.json
    └── history/                          ← rolling 20 most-recent switches
```

## Install

```bash
npx -y @dylanrussell/omo-router init
```

`init` will:

1. Back up `~/.config/opencode/opencode.json` and `~/.config/opencode/oh-my-openagent.json` to `~/.config/opencode/.backups/<timestamp>/`.
2. Drop three seed stacks (`premium`, `openrouter-cheap`, `free-only`) into `~/.config/opencode/omo-router/stacks/`.
3. Set `premium` active and copy it to `oh-my-openagent.json`.
4. Add `@dylanrussell/omo-router@latest` to the `plugin` array in `opencode.json`.
5. Add `@dylanrussell/omo-router@latest` to the `plugin` array in `tui.json` — this loads the sidebar + `/omo-*` commands (opencode ≥ 1.17).
6. Add the OpenRouter model IDs the seed stacks need to `provider.openrouter.models`.

Then **restart opencode** so it picks up the plugin.

## Quickstart

```bash
omo-router add my-mix --from-active   # snapshot current oh-my-openagent.json as a new stack
omo-router back                       # undo the most recent switch
omo-router completion                 # install shell autocompletion scripts
omo-router edit my-mix                # open in $EDITOR
omo-router export my-mix              # export a stack to a file
omo-router history                    # list recent switches
omo-router import my-mix <file>       # import a stack from a file
omo-router init                       # initialize omo-router (creates seed stacks, backups)
omo-router list                       # show stacks; * marks active
omo-router path                       # print all paths used (debugging)
omo-router rm my-mix                  # remove a stack
omo-router restore <history-id>       # revert oh-my-openagent.json to a prior state
omo-router show free-only             # print the JSON of a stack
omo-router status                     # print active stack name
omo-router use openrouter-cheap       # switch (validates first)
omo-router validate --all             # check every stack against `opencode models`
```

You can also alias to `omo` — `omo use premium` works the same.

## Inside opencode

The plugin exposes five tools the agent (or you, by asking it) can call:

| tool | what it does |
|---|---|
| `omo_status` | active stack + list of available |
| `omo_list` | list with `isActive` flags |
| `omo_use({name, snapshotBack?, validate?})` | switch stacks; pops a TUI toast |
| `omo_back({n?})` | undo last N switches |
| `omo_validate({name?, active?})` | check model IDs against current opencode auth |

> *"Switch to openrouter-cheap"* — your agent calls `omo_use`, the toast pops up, you restart opencode.

## In the TUI

On opencode ≥ 1.17 the plugin also ships a TUI half (loaded from `tui.json`, wired up by `init`):

- **Sidebar panel** — always shows the active stack, the stack count, and a `⟳ restart required` badge after any switch. Updates live (≤1.5s) when the CLI or agent switches stacks underneath the TUI.
- **Commands** — type `/` or open the command palette:

| command | what it does |
|---|---|
| `/omo-switch` (alias `/omo`) | pick a stack, validate, switch |
| `/omo-view` | browse a stack's agent/category → model assignments |
| `/omo-edit` | reassign a model, picking from your reachable model catalog |
| `/omo-back` | confirm + revert to the previous stack |
| `/omo-validate` | check a stack's model IDs against current auth |
| `/omo-status` | toast the active stack + list |

Everything degrades gracefully: on older opencode versions (or if the TUI API changes) the sidebar and commands simply don't appear — the CLI and agent tools keep working.

Debugging the TUI half: `OMO_TUI_DEBUG=/tmp/omo-tui.log opencode` writes a trace of the plugin's init steps.

## ⚠ Things to know

- **Restart required.** `oh-my-openagent` reads its config once at plugin init. After every `omo-router use`, you must restart opencode for the new models to take effect. The CLI reminds you.
- **`bunx oh-my-opencode install` rewrites everything.** If you re-run the upstream installer it will overwrite `~/.config/opencode/oh-my-openagent.json` *and* `~/.config/opencode/opencode.json`. Just run `omo-router use <whatever>` afterward to put your active stack back.
- **Snapshot-back is on by default.** When you switch from stack `A` to stack `B`, the *current* contents of `oh-my-openagent.json` (which may include migrations or hand-edits) are written back into `stacks/A.json` first. Disable per-call with `--no-snapshot-back`.
- **Validation is auth-state-dependent.** `omo-router validate` runs `opencode models`, which only lists models reachable through your current auth. If you revoke a key, previously-valid stacks may suddenly be invalid.

## Autocompletions

`omo-router` supports autocompletions for `zsh`, `bash`, and `fish`. To install, run `omo-router completion` and follow the instructions for your shell.

## Architecture in 60 seconds

```
┌──────────────────────────────────────────────┐
│ opencode (Bun)                               │
│  └─ plugin: oh-my-openagent (reads config) ──┼── reads at startup ─┐
│  └─ plugin: omo-router (this package) ───────┼─ tools, toast       │
└──────────────────────────────────────────────┘                     │
                                                                     ▼
~/.config/opencode/oh-my-openagent.json    ◄── written on `omo-router use`
~/.config/opencode/omo-router/
  stacks/<name>.json                       ◄── source of truth for each stack
  state.json                               ◄── pointer to active stack
  history/<ts>__<from>-to-<to>.json        ◄── rolling switch log
```

## Documentation

- [Install](./docs/01-install.md)
- [Quickstart](./docs/02-quickstart.md)
- [Stacks explained](./docs/03-stacks-explained.md)
- [Switching stacks](./docs/04-switching.md)
- [Inside opencode](./docs/05-using-in-opencode.md)
- [Make your own stack](./docs/06-customizing.md)
- [Troubleshooting](./docs/07-troubleshooting.md)
- [FAQ](./docs/08-faq.md)

## Contributing

Issues and PRs welcome. Run locally:

```bash
git clone https://github.com/dylanrussellmd/omo-router.git
cd omo-router
pnpm install
pnpm test       # 106 tests, ~85% coverage
pnpm build
```

## License

MIT — see [LICENSE](./LICENSE).
