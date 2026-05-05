# Switching stacks

Everything you can do with the active stack pointer.

## The basic switch

```bash
omo-router use openrouter-cheap
```

What happens:

1. Validates that every model in the target stack is actually reachable through your current opencode auth.
2. Saves a snapshot of your current `oh-my-openagent.json` to history (so you can come back).
3. If you'd hand-edited the live file (or oh-my-openagent applied a migration), those changes get folded back into the source stack — no work lost.
4. Copies the new stack's content into `oh-my-openagent.json`.
5. Tells you to restart opencode.

**You always need to restart opencode** for the change to take effect. opencode reads its model config once at startup; nothing on disk wakes a running session up.

## Undoing a switch

```bash
omo-router back
```

Reverts to whatever was active before your last `use`. Records the new switch in history too — so `back back` cycles between two stacks.

Going further:

```bash
omo-router back -n 3
```

Walks three switches backward. Errors out if you try to go further than history remembers (the last 20 switches).

## Skipping the validation

If `opencode models` is being slow or flaky, you can skip the pre-switch check:

```bash
omo-router use my-stack --no-validate
```

If you trust the stack but validation is flagging false positives:

```bash
omo-router use my-stack --force-invalid
```

(Validates but switches anyway. You'll see the warnings.)

You can also run validation standalone, without switching:

```bash
omo-router validate                # the active stack
omo-router validate --all          # every stack
omo-router validate openrouter-cheap
```

A passing report looks like:

```
premium: OK (29 model ids checked)
openrouter-cheap: OK (29 model ids checked)
free-only: OK (28 model ids checked)
```

A failing one tells you exactly where:

```
my-mix: MISSING 1 model id:
  agents.oracle.fallback_models[0].model            openrouter/anthropic/claude-typo
```

## History

```bash
omo-router history
```

Newest first:

```
2026-05-04T20-35-12-014Z__premium-to-openrouter-cheap  premium → openrouter-cheap
2026-05-04T19-02-44-700Z__openrouter-cheap-to-premium  openrouter-cheap → premium
2026-05-04T17-15-08-321Z__premium-to-free-only         premium → free-only
```

Each entry records what was active at that moment. The cap is 20 — older entries get pruned.

## Restore from a specific moment

The big lever for "I want exactly the file I had three switches ago, even after edits and migrations":

```bash
omo-router restore 2026-05-04T17-15-08-321Z__premium-to-free-only
```

This copies that snapshot back into `oh-my-openagent.json`. After restoring, `omo-router status` will show a special marker like `(restored:<id>)` — meaning "the live file isn't bound to a named stack right now." Run `omo-router use <name>` whenever you want to bind back.

## Don't want snapshot-back?

By default, switching saves any drift in the live file back into the source stack. If you'd rather treat your stacks as immutable templates:

```bash
omo-router use openrouter-cheap --no-snapshot-back
```

Drift gets discarded. Use this when you've been experimenting on the live file and you don't want those experiments saved into the named stack.

## Cheat sheet

```bash
omo-router status                              # what's active
omo-router list                                # all available stacks
omo-router use <name>                          # switch
omo-router use <name> --no-snapshot-back       # switch without saving live drift
omo-router use <name> --no-validate            # switch without checking models
omo-router back                                # undo last switch
omo-router back -n 3                           # undo three switches
omo-router history                             # recent switches
omo-router restore <id>                        # rewind to a specific snapshot
omo-router validate                            # check the active stack
omo-router validate --all                      # check every stack
omo-router show <name>                         # print a stack's JSON
omo-router path                                # print all paths used (debugging)
```

→ Next: [Inside opencode](./05-using-in-opencode.md)
