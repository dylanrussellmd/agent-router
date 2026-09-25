# Unreleased

- Add a native `/agent-routing` TUI command to inspect and change the current session's Automatic/Pinned mode without an LLM turn; scope its control RPC to the serving project location.
- Preserve quota-fallback request correlation across trusted transport rewrites using bounded, in-process original-request provenance; unmarked replacements remain ineligible.
- Isolate auxiliary requests with distinct agent/model identities so title generation cannot overwrite primary quota evidence. Same-identity overlaps still fail closed.
- Declare OpenCode 2.x API peer support from 2.0.8, compile against 2.0.14 types, and add CI coverage for the minimum, current, and latest 2.x hosts.

# 2.2.0

- Add separately opt-in, explicitly paid-approved native same-session quota fallback for automatic main turns and positively correlated new child admissions.
- Require single-use, short-lived HTTP rejection evidence and structured quota errors; preserve pin/manual/cancel guards, chain bounds, native model attribution, and completed tool history.
- Report selected-versus-dispatched state and document best-effort correlation plus the accepted non-atomic late-veto residual selection.
- Add production-router native synthetic quota fallback checks and conservative correlation/control tests, including strict quota RPC projection, unresolved-request expiry, and child-ticket capacity guards.

# 2.1.2

- Remove selection-source labels from agent headings; show only the agent name.
- Keep selected models orange with normal font weight. Selection logic and precedence are unchanged.

# 2.1.1

- Highlight selected models for every agent in the native warning/orange color, preserving precedence order and complete identities.
- Prefer the viewed session, then running same-location direct children, then native defaults and stack defaults; label the source explicitly.
- Preserve multiple selections when active children of one agent use different models. Never treat inactive children or other locations as live selections.
- Keep routing mode/freshness unknown when no native status transport is connected; do not infer pin state from a model ID.

# 2.1.0

- Add opt-in account-scoped quota preflight before automatic main turns and new subagent tasks, using the usage service's credential-free RPC.
- Skip only fresh confirmed exhausted candidates; unknown quota keeps the primary. Paid fallback requires explicit approval.
- Add session-scoped `router_pin`, `router_auto`, and `router_routing_status` controls. Pins survive restarts with bounded storage and deletion cleanup.
- Preserve staged next-turn reactive fallback precedence, manual overrides, and completed tools. No automatic mid-task retry is enabled.
- Verify native main/child admission, quota recovery, durable pinning, timeout handling, and concurrent admission/disposal guards.

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
