# Troubleshooting

When something doesn't behave the way you expect.

## "I switched stacks but opencode is still using the old models"

Did you restart opencode?

opencode reads its model config once at startup. Switching stacks updates `oh-my-openagent.json` on disk, but a running opencode session is using the values it read when it started. You need:

```bash
pkill -f opencode      # or just close the window
opencode               # in a new terminal
```

If you've restarted and it's still wrong, check that the on-disk state actually matches your stack:

```bash
omo-router status
diff <(jq -S . ~/.config/opencode/oh-my-openagent.json) \
     <(jq -S . ~/.config/opencode/omo-router/stacks/$(omo-router status).json)
```

Empty diff → on-disk state is correct, the issue is somewhere else (auth, opencode version, etc.).

## "Validation says my stack is broken"

```
$ omo-router use my-stack
error: Stack "my-stack" references 1 unreachable model ID.

  agents.oracle.model            openrouter/anthropic/claude-fakemodel
```

`opencode models` doesn't include that ID for your current auth. Three usual reasons:

**It's a typo.** Fix the stack:

```bash
omo-router edit my-stack
```

**The provider isn't authenticated.** Check what's available:

```bash
opencode auth list
```

If anthropic, google, or openrouter is missing, log in:

```bash
opencode auth login
```

**The OpenRouter whitelist is missing the ID.** opencode requires every `openrouter/...` model to be listed in your `~/.config/opencode/opencode.json` under `provider.openrouter.models`. For example, to use `openrouter/anthropic/claude-haiku-4.5` you need:

```json
{
  "provider": {
    "openrouter": {
      "models": {
        "anthropic/claude-haiku-4.5": {}
      }
    }
  }
}
```

`omo-router init` adds the seeds' IDs automatically. Custom stacks may need manual entries.

If you know better than the validator (rare), bypass it:

```bash
omo-router use my-stack --force-invalid     # validate, but switch anyway
omo-router use my-stack --no-validate       # skip validation entirely
```

## "I edited oh-my-openagent.json by hand and now I'm worried"

You're fine. The next `omo-router use <other>` will detect the drift and snapshot your edits back into the source stack file before overwriting the live one.

If you'd rather capture them as their own named stack right now:

```bash
omo-router add my-edits --from-active
```

## "I ran the upstream installer and now my stack is gone"

`bunx oh-my-opencode install` rewrites `~/.config/opencode/oh-my-openagent.json` and `~/.config/opencode/opencode.json`. It doesn't know about omo-router.

Recovery is just one command:

```bash
omo-router use $(omo-router status)
```

Or pick whatever you want to be active:

```bash
omo-router use premium
```

The upstream installer drops its own backups in `~/.config/opencode/.backups/<timestamp>/` if you need the *exact* file from before the installer ran.

## "omo-router validate fails with `opencode: not found`"

The validator runs `opencode models` to learn what's reachable. If that command isn't on your `PATH`, validation can't run.

Usually this happens when you installed opencode under nvm and your shell is using a different Node version. Confirm:

```bash
which opencode
```

If it doesn't resolve, fix your shell's `PATH` (or the editor's, if you're invoking from one) so opencode is reachable.

You can always skip validation in the meantime:

```bash
omo-router use my-stack --no-validate
```

## "The toast didn't appear when I switched"

Some opencode versions don't expose the TUI toast hook. The switch still works — only the visual confirmation is missing. You can verify in the log:

```bash
tail -f ~/.local/share/opencode/log/*.log | grep omo-router
```

## "I want to undo, but `back` says no previous"

`back` only knows about switches *omo-router* recorded. If you've only ever run `init` (no `use`), there's nothing to revert to.

Use `restore` against a history entry instead:

```bash
omo-router history
omo-router restore <id>
```

Or pick a specific stack directly:

```bash
omo-router use premium
```

## "Two `omo-router` commands at once — is that safe?"

Yes. Every file write is atomic — concurrent commands either complete or do nothing, never leaving the files in a half-written state. The worst case is one of them losing the race; the loser's changes get overwritten by the winner, but both files stay valid.

The exception: don't run `omo-router use` while `bunx oh-my-opencode install` is rewriting your config. The installer isn't atomic. Wait for one to finish before starting the other.

## "Where do I see what omo-router actually wrote?"

```bash
omo-router path                       # all paths used
omo-router history                    # recent switches
ls -la ~/.config/opencode/.backups/   # config backups (init drops these here)
```

State file:

```bash
cat ~/.config/opencode/omo-router/state.json | jq .
```

## "I just want to start over"

```bash
rm -rf ~/.config/opencode/omo-router/    # wipes stacks, history, state
npx -y @dylanrussell/omo-router init     # back to a clean install
```

Your `oh-my-openagent.json` keeps whatever was last active.

→ Next: [FAQ](./08-faq.md)
