# FAQ

## Is this a fork of `oh-my-openagent`?

No. omo-router sits next to it. `oh-my-openagent` keeps doing exactly what it does — reading `~/.config/opencode/oh-my-openagent.json` to route models for each agent and category. omo-router just lets you keep multiple versions of that file under names and swap between them.

## Why do I have to restart opencode every time I switch?

`oh-my-openagent` reads its config file once when opencode starts. Nothing on disk wakes a running session up to re-read it. The only way to get new model assignments into a running opencode is to restart it.

The CLI tells you this every time you switch.

## Can I use this without `oh-my-openagent`?

Not really. omo-router writes `oh-my-openagent.json`, which is only useful if `oh-my-openagent` is the thing reading it. If you're building your own routing layer, you can still use omo-router to swap config files for it — but the seed stacks are shaped for `oh-my-openagent`, so you'd want to replace them with your own.

## Is my `oh-my-openagent.json` safe?

`omo-router init` backs it up to `~/.config/opencode/.backups/<timestamp>/` before doing anything. After that, every switch records a snapshot in `~/.config/opencode/omo-router/history/` (the last 20).

You can always:

```bash
omo-router back
omo-router restore <history-id>
omo-router use <stack-name>
```

The backups never expire on their own. Delete them by hand if you don't want them.

## Will this conflict with `bunx oh-my-opencode install`?

The installer rewrites your config files when you run it. It doesn't know about omo-router, so it'll overwrite whatever stack was active.

Recovery is a single command — `omo-router use <name>` puts your stack back. Don't run the installer and `omo-router use` at the same time, though; the installer isn't atomic and you can end up with inconsistent files. Wait for one to finish.

## How do I know which stack is active?

```bash
omo-router status
```

Or in opencode, ask the agent: *"Which omo-router stack am I on?"* (it'll call `omo_status`).

## Can I share a stack with someone else?

Yes:

```bash
omo-router export my-mix /tmp/my-mix.json
# send /tmp/my-mix.json to them
```

They import it:

```bash
omo-router import my-mix ./my-mix.json
omo-router validate my-mix
```

If their auth setup is different, validation may flag missing models. They'll need to substitute IDs they can actually reach.

## Why do my OpenRouter model IDs need to be in the whitelist?

That's an opencode rule, not an omo-router one. opencode requires every `openrouter/<vendor>/<model>` ID to be declared in `provider.openrouter.models` in your `opencode.json` before it'll route to it.

`omo-router init` adds the seed stacks' IDs automatically. If you build a custom stack referencing an ID you haven't whitelisted, validation will warn you, and you can add the entry by hand in `opencode.json`.

## Is there a way to switch without leaving opencode?

Yes — ask the agent. The plugin exposes five tools (`omo_status`, `omo_list`, `omo_use`, `omo_back`, `omo_validate`) the agent can call. See [Inside opencode](./05-using-in-opencode.md). You still have to restart opencode after the switch.

## Does it work with Bun-only setups?

The plugin runs under whatever opencode runs (Bun in current versions). The CLI runs on Node 20+. If you're on a Bun-first machine without Node, install Node alongside it — the CLI is a few hundred KB and starts in milliseconds.

## What about Windows?

Should work via WSL. Native Windows isn't tested.

## Where does my data live?

| | |
|---|---|
| Stacks | `~/.config/opencode/omo-router/stacks/<name>.json` |
| Active pointer | `~/.config/opencode/omo-router/state.json` |
| Switch history | `~/.config/opencode/omo-router/history/` |
| Active config (read by `oh-my-openagent`) | `~/.config/opencode/oh-my-openagent.json` |
| Backups (from `init`) | `~/.config/opencode/.backups/` |

`omo-router path` prints all of them.

## Can I run `init` again later?

Yes, it's a no-op unless you pass `--force`. It'll just confirm everything is still set up.

## How do I uninstall?

Remove the plugin entry from `~/.config/opencode/opencode.json`, then drop the bin and (optionally) the state directory:

```bash
npm uninstall -g @dylanrussell/omo-router
rm -rf ~/.config/opencode/omo-router/
```

Your `oh-my-openagent.json` keeps whatever stack was last active.

## Where does the name come from?

`oh-my-openagent` → "omo." Plus "router" because it routes between named stacks.

## Found a bug or want a feature?

Open an issue on GitHub. PRs welcome.
