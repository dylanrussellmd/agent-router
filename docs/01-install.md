# Install

You'll need **opencode** already installed and authenticated. If you're already using `oh-my-openagent`, you're good to go. If not, [install it first](https://github.com/code-yeongyu/oh-my-openagent).

## One command to bootstrap

```bash
npx -y @dylanrussell/omo-router init
```

That's it. This:

1. Backs up your current `~/.config/opencode/opencode.json` and `~/.config/opencode/oh-my-openagent.json` to `~/.config/opencode/.backups/<timestamp>/` so you can always roll back.
2. Drops three ready-made stacks (`premium`, `openrouter-cheap`, `free-only`) into `~/.config/opencode/omo-router/stacks/`.
3. Sets `premium` as the active stack and copies it to `oh-my-openagent.json`. (If your current setup matches `premium`, this is a no-op.)
4. Adds `@dylanrussell/omo-router@latest` to your `opencode.json` plugin list.
5. Adds the OpenRouter model IDs the seed stacks need to your model whitelist.

Then **restart opencode** so it picks up the new plugin.

## Verify it worked

```bash
omo-router status              # → premium
omo-router list                # → 3 stacks, * marks premium
omo-router validate --all      # → all OK
```

If `omo-router` isn't on your `PATH`:

```bash
npx @dylanrussell/omo-router status
```

works the same — just slightly slower because npx resolves the package first.

## Install globally (optional)

If you want `omo-router` and the shorter `omo` to be on your `$PATH` without `npx`:

```bash
npm install -g @dylanrussell/omo-router
omo --version
```

Both bins point at the same code. Use whichever is faster to type.

## What it didn't change

- Your existing `oh-my-openagent.json` content was preserved as-is — `premium` is just a *named copy* of what you already had.
- Your auth tokens, MCP config, opencode prompts, themes — all untouched.

If `init` ran on a machine that already had a state file, it's a no-op. Re-run with `--force` if you want to wipe and start over.

## Uninstall

```bash
# remove the plugin entry from ~/.config/opencode/opencode.json (manual edit)
# then drop the global bin:
npm uninstall -g @dylanrussell/omo-router
# state survives at ~/.config/opencode/omo-router/ — delete if you don't want it:
rm -rf ~/.config/opencode/omo-router/
```

Your `oh-my-openagent.json` keeps whatever stack was last active.

→ Next: [Quickstart](./02-quickstart.md)
