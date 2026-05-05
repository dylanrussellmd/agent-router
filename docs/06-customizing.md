# Make your own stack

The three seeds are starting points. Anything you can put in `~/.config/opencode/oh-my-openagent.json`, you can save as a named stack.

## Three ways to make a new one

### 1. Snapshot your current setup

You've been tweaking `oh-my-openagent.json` directly and like the result. Save it under a name:

```bash
omo-router add my-mix --from-active
```

Now `my-mix` is one of your stacks. You can switch away to anything else and come back to `my-mix` whenever.

### 2. Empty template

```bash
omo-router add experimental
omo-router edit experimental    # opens in $EDITOR
```

The empty file is just `{ "agents": {}, "categories": {} }`. Add what you need.

### 3. Import from a file

If a friend gave you a `their-stack.json`:

```bash
omo-router import their-mix ./their-stack.json
```

`omo-router edit their-mix` to inspect or tweak.

## What goes in a stack file

A stack is just a snapshot of an `oh-my-openagent.json`. The shape:

```json
{
  "$schema": "https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/dev/assets/oh-my-opencode.schema.json",
  "agents": {
    "sisyphus": {
      "model": "anthropic/claude-opus-4-7",
      "variant": "max"
    },
    "oracle": {
      "model": "openrouter/openai/gpt-5.4",
      "variant": "high",
      "fallback_models": [
        { "model": "anthropic/claude-opus-4-7", "variant": "max" }
      ]
    }
  },
  "categories": {
    "deep": {
      "model": "google/gemini-3.1-pro-preview",
      "variant": "high"
    },
    "quick": {
      "model": "google/gemini-2.5-flash"
    }
  }
}
```

You only need at least one of `agents` or `categories`. Anything else `oh-my-openagent` accepts (fallback chains, variants, temperature, disabled-skills, etc.) rides along verbatim.

## Concrete examples

### "Like premium, but Sonnet for sisyphus"

```bash
omo-router add sisyphus-sonnet --from-active
omo-router edit sisyphus-sonnet
```

Edit the `sisyphus` entry:

```json
"sisyphus": {
  "model": "anthropic/claude-sonnet-4-6"
}
```

Save. Validate before switching:

```bash
omo-router validate sisyphus-sonnet
omo-router use sisyphus-sonnet
# restart opencode
```

### "Mostly free, but Opus for the oracle"

Copy `free-only` and override one entry:

```bash
omo-router show free-only > /tmp/hybrid.json
# edit /tmp/hybrid.json, change agents.oracle.model to "anthropic/claude-opus-4-7"
omo-router import hybrid /tmp/hybrid.json
omo-router validate hybrid
omo-router use hybrid
```

### "All in on free models for a week"

```bash
omo-router use free-only
# restart opencode
# week passes
omo-router back
# restart opencode
```

## Sharing stacks

Stacks are plain JSON. Send the file to someone:

```bash
omo-router export my-mix ~/Downloads/my-mix.json
# email it, drop it in a gist, whatever
```

They import it:

```bash
omo-router import my-mix ./my-mix.json
omo-router validate my-mix    # might fail if they don't have your auth providers
```

If their auth setup is different, the validation may flag missing models. They'll need to swap those entries for IDs they can actually reach.

## Removing a stack

```bash
omo-router rm my-old-mix
```

Refuses if it's the active stack — switch first, or pass `--force`.

## Things to know

- Stack names must match `[A-Za-z0-9._-]+`. Spaces, slashes, anything weird gets rejected.
- The active stack stays in sync with `oh-my-openagent.json` — any direct edits to the live file get saved back to the active stack the next time you switch (unless you pass `--no-snapshot-back`).
- You can have as many stacks as you want. They're all just files in `~/.config/opencode/omo-router/stacks/`.

→ Next: [Troubleshooting](./07-troubleshooting.md)
