# Inside opencode

You don't have to leave the chat to switch stacks. The plugin gives your agent five tools you can ask it to call, in plain English.

## The five tools

| tool | what it does |
|---|---|
| `omo_status` | reports the active stack and lists the available ones |
| `omo_list` | same data, formatted as a list with `isActive` flags |
| `omo_use` | switches stacks; pops a TUI toast when it succeeds |
| `omo_back` | undoes the last N switches (default 1) |
| `omo_validate` | checks model IDs in a stack against your current opencode auth |

## How to use them

Just talk to your agent. The agent will call the right tool.

> *"Which omo-router stack am I on?"*

Agent calls `omo_status`, replies with `premium` (or whatever).

> *"Switch to openrouter-cheap."*

Agent calls `omo_use({name: "openrouter-cheap"})`. A toast pops up in the corner of the TUI:

```
omo-router: switched to "openrouter-cheap". Restart opencode for change to take effect.
```

> *"Take that back."*

Agent calls `omo_back`. Toast confirms the revert.

> *"Are all the models in my free-only stack actually reachable right now?"*

Agent calls `omo_validate({name: "free-only"})`, returns `{ok: true, checked: 28, missing: []}`.

## What the agent can't do

Switching stacks always requires you to **restart opencode** for the change to take effect. The plugin can't do that for you — opencode would shut itself down before finishing the task. The toast and tool response will remind you.

Practical flow:

1. Ask agent to switch.
2. Toast confirms.
3. You manually restart opencode (close the window, open a new session).
4. The new stack is live.

## When to use the tools vs. the CLI

Both touch the same files. Pick whichever is closer to hand.

- **Tools** are nice when you're already mid-conversation with the agent and don't want to context-switch to a terminal.
- **CLI** is nice when you're scripting, batching, or just prefer typing.

## When the toast doesn't show up

Some opencode versions or headless setups don't have a TUI toast hook available. The switch still happens — it just falls back to a log line you can find with:

```bash
tail -f ~/.local/share/opencode/log/*.log | grep omo-router
```

The functional change is identical with or without the toast.

## Slash command (kind of)

opencode's plugin API doesn't currently let plugins register slash commands directly. If you want a slash-style invocation, the easiest workaround is to ask the agent in plain English — it'll pick up the right tool from the names. The plugin tool descriptions are detailed enough that the agent rarely picks the wrong one.

→ Next: [Make your own stack](./06-customizing.md)
