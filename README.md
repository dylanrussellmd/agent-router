# @dylanrussell/omo-router

A small opencode plugin + CLI that lets you switch between **named stacks** of [`oh-my-openagent`](https://github.com/code-yeongyu/oh-my-openagent) model assignments. One command and a restart of `opencode` and your whole agent crew is now running on a different mix of models.

## What it does

`oh-my-openagent` reads `~/.config/opencode/oh-my-openagent.json` to decide which model backs each agent (`sisyphus`, `oracle`, …) and each category (`visual-engineering`, `deep`, `quick`, …). That file is a single source of truth — there's only one of it.

`omo-router` lets you keep multiple full snapshots of that file under names you pick (`premium`, `openrouter-cheap`, `free-only`, etc.) and swap between them on demand.

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
# Add the plugin to your opencode config:
#   "plugin": ["@dylanrussell/omo-router@latest", "oh-my-openagent@latest"]
# Then bootstrap:
npx -y @dylanrussell/omo-router init
```

`init` will:
1. Back up `~/.config/opencode/opencode.json` and `~/.config/opencode/oh-my-openagent.json` to `~/.config/opencode/.backups/<timestamp>/`.
2. Drop three seed stacks (`premium`, `openrouter-cheap`, `free-only`) into `~/.config/opencode/omo-router/stacks/`.
3. Set `premium` active and copy it to `oh-my-openagent.json`.
4. Add `@dylanrussell/omo-router@latest` to the `plugin` array in `opencode.json`.
5. Add the OpenRouter model IDs the seed stacks need to `provider.openrouter.models`.

## Quickstart

```bash
omo-router list                       # show stacks; * marks active
omo-router status                     # print active stack name
omo-router use openrouter-cheap       # switch (validates first)
# now restart opencode for the new stack to take effect
omo-router back                       # undo the most recent switch
omo-router validate --all             # check every stack against `opencode models`
omo-router show free-only             # print the JSON of a stack
omo-router add my-mix --from-active   # snapshot current oh-my-openagent.json as a new stack
omo-router edit my-mix                # open in $EDITOR
omo-router history                    # list recent switches
omo-router restore <history-id>       # revert oh-my-openagent.json to a prior state
omo-router path                       # print all paths used (debugging)
```

You can also alias to `omo` — `omo use premium` works the same.

## Inside opencode

The plugin exposes five tools the agent (or you, by asking it) can call:

- `omo_status` — what's active, what's available
- `omo_list` — list all stacks
- `omo_use({name, snapshotBack?, validate?})` — switch stacks; pops a TUI toast
- `omo_back({n?})` — undo last N switches
- `omo_validate({name?, active?})` — check model IDs against current opencode auth

## ⚠ Known footguns

- **Restart required.** `oh-my-openagent` reads its config once at plugin init. After every `omo-router use`, you must restart opencode for the new models to take effect. The CLI reminds you.
- **`bunx oh-my-opencode install` rewrites everything.** If you re-run the upstream installer it will overwrite `~/.config/opencode/oh-my-openagent.json` *and* `~/.config/opencode/opencode.json`. Re-run `omo-router use <whatever>` afterward to put your active stack back.
- **Snapshot-back is on by default.** When you switch from stack `A` to stack `B`, the *current* contents of `oh-my-openagent.json` (which may include migrations or hand-edits) are written back into `stacks/A.json` first. This preserves drift. Disable per-call with `--no-snapshot-back`.
- **Model validation is auth-state-dependent.** `omo-router validate` runs `opencode models`, which only lists models reachable through your current `opencode auth list`. If you revoke a key, previously-valid stacks may suddenly be invalid.

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

- [Architecture](./docs/Architecture.md) — switch algorithm, history, validation, drift
- [Stack Format](./docs/Stack-Format.md) — schema reference + examples
- [CLI Reference](./docs/CLI-Reference.md) — every subcommand with examples
- [Plugin Hooks](./docs/Plugin-Hooks.md) — opencode tool surface
- [Development](./docs/Development.md) — clone, install, build, test, dev loop
- [Troubleshooting](./docs/Troubleshooting.md) — common issues
- [Seed Stacks](./docs/Seed-Stacks.md) — what each seed contains
- [Publishing](./docs/Publishing.md) — npm publish workflow

The same docs live in the maintainer's Obsidian vault under `Projects/omo-router/`.

## License

MIT — see [LICENSE](./LICENSE).
