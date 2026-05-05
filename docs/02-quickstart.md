# Quickstart

Five minutes from "what is this" to "I'm switching stacks confidently."

## The mental model

Your opencode setup has one config file that maps each agent (`sisyphus`, `oracle`, …) and each category (`deep`, `quick`, …) to a model. Without omo-router, you have one of those forever. With omo-router, you have **named copies** you can swap between with one command.

```
omo-router use premium             →  Opus + Pro everywhere, premium quality
omo-router use openrouter-cheap    →  Sonnet + Flash via OpenRouter, ~half the cost
omo-router use free-only           →  Gemini free tier, $0 for personal use
```

Switching always requires a **restart of opencode** for the new models to take effect. That's the only friction.

## The everyday commands

```bash
omo-router list                # see your stacks; * marks active
omo-router status              # which one is active
omo-router use <name>          # switch (validates models first)
omo-router back                # undo your last switch
```

### A typical session

You're working with the premium stack and notice it's eating budget on a long task that doesn't need Opus.

```bash
omo-router use openrouter-cheap
# Switched: premium → openrouter-cheap. Restart opencode for change to take effect.
```

You restart opencode (close the window, run `opencode` again). Carry on. Hours later, ready for a hard task:

```bash
omo-router use premium
# Switched: openrouter-cheap → premium. Restart opencode for change to take effect.
```

Restart again. Done.

## What if I picked the wrong stack?

```bash
omo-router back                # reverts to the previous one
omo-router back -n 3           # reverts three switches deep
omo-router history             # see what you've been doing
```

Every switch records a snapshot. The last 20 are kept. You can also restore *exactly* the file as it was at any of those moments — see [Switching stacks](./04-switching.md).

## What if it warns about missing models?

```bash
omo-router use my-custom
# error: Stack "my-custom" references 1 unreachable model ID.
#
#   agents.oracle.model              openrouter/anthropic/claude-typo-here
```

omo-router asked opencode "can you reach this model?" and opencode said no. Either:

- Fix the typo (`omo-router edit my-custom`), or
- The provider isn't authenticated (`opencode auth list`), or
- The model isn't on your OpenRouter whitelist (see [Troubleshooting](./07-troubleshooting.md))

You can also just bypass the gate (`--force-invalid`) if you know better than the validator. But usually, it's right.

## Inside opencode

You can also ask your agent to switch stacks for you:

> *"Use the omo_use tool to switch to free-only."*

The plugin includes five tools (`omo_status`, `omo_list`, `omo_use`, `omo_back`, `omo_validate`) — see [Inside opencode](./05-using-in-opencode.md). Either way, you still need to restart opencode after the switch.

## What's next

- [What's actually in each stack](./03-stacks-explained.md) — pick your daily driver
- [Make your own stack](./06-customizing.md) — when the seeds aren't quite right
- [Troubleshooting](./07-troubleshooting.md) — when something seems off
