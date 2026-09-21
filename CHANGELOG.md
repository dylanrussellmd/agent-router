# 2.0.2

- Simplify stack chains to one model per line in precedence order, without Primary/Fallback labels.
- Highlight the live session's selected agent/model with native theme color, bold text and a marker; show out-of-chain selections separately.
- React to session model/agent changes, normalize default variants, and wrap full provider/model identities in narrow sidebars.

# 2.0.1

- Normalize V2's `default` variant so pending next-user-turn fallback is not disabled by an equivalent model reference.
- Pass the native catalog into `router_back` validation instead of launching the obsolete CLI model command.
- Verify real isolated 2.0.8 HTTP 429/503 failover without replay, explicit model override, stack switching, undo, history and fixture integrity.
- Patch development dependencies; the full dependency audit reports no known advisories.

# 2.0.0

- Target OpenCode 2.0.8 with server and terminal `setup` entrypoints.
- Include literal root `index.ts`/`tui.ts` wrappers for the 2.0.8 local-directory resolver; published packages retain their exports.
- Add an isolated real-host integration check for package activation, terminal discovery, and RPC input validation through a disposable test probe.
- Preserve all six router tools, stack operations, history, sidebar and six slash commands.
- Register terminal commands under a mounted app slot so OpenCode 2.0.8 provides its Keymap context. Sidebar slots return real renderables with reactive child insertion.
- Register terminal plugins in `cli.json` and use native `plugins` entries, including package/options objects.
- Validate advertised model variants using the V2 model catalog. Unsupported `max` variants must be changed explicitly to an advertised variant such as `high`.
- Preserve legacy frontmatter and support capture/apply of native `model#variant` references.
- Queue fallback selection for the next explicit user prompt after retryable HTTP 429/500/502/503/504. Veto automatic same-turn retry for routed failures; never submit prompts or replay tools.

## Operational limits

- Applying/backing out stacks still requires restarting OpenCode to reload agent files.
- Terminal stack operations access local files; remote-server filesystem management is not supported.
- Fallback notices are server logs. The sidebar shows configured routing with the current session selection highlighted; it does not expose pending fallback state.
- OpenCode 2.0.8 does not identify request kind on retry hooks. The plugin conservatively tracks the last model-request kind and only handles primary requests. Concurrent auxiliary requests can suppress fallback handling.
- Session defaults must resolve to explicit agent/model selections before routing. Fallback routing is bounded to 1,024 tracked sessions per plugin instance.
