# Native quota retry experiment (test only)

Run from the repository root with an installed **OpenCode 2.0.8** binary:

```sh
node scripts/probe-quota-retry.mjs /absolute/path/to/evidence.json
```

`OPENCODE_TEST_BINARY` selects the binary; `TMPDIR` selects disposable storage.
The optional output defaults to a JSON file alongside the disposable directory.
The host's disposable HOME/config/state/cache are removed after the run.
By default only this fixture plugin is loaded. The production router is not edited.
Both configured providers point to a loopback synthetic SSE endpoint; the child
process receives an allowlisted environment and synthetic credentials only.

## Production-router mode

Build first, then run `ROUTER_PRODUCTION=1 node scripts/probe-quota-retry.mjs
/tmp/opencode/router-phase2.json` (or `npm run test:quota-fallback`). This loads the
compiled production router before the fixture, with `quotaFallback.enabled` and
`allowPaidFallbacks` explicitly enabled in the disposable configuration. Set
`ROUTER_PREFLIGHT=1` to enable phase 1 alongside phase 2.

The fixture records production decisions rather than selecting fallback models.
Only HTTP 408 retries are vetoed to bound that negative control, after recording
the production decision; the later-veto scenario still deliberately vetoes quota
recovery. Main sessions start without explicit model overrides and automatic child
calls omit their model argument. Additional controls exercise original explicit
main/child selections, pinning, same-effective-model manual selection, and a
backup 503 using the existing reactive policy. Both post-tool cases assert the
counter stays one and native model attribution changes to the backup.

The experiment-only policy and limits below describe the default mode. Production
correlation limits, budgets, child provenance, and status reasons are documented
in the repository README's phase-2 section. The native non-atomic late-veto limit
applies to both modes.

## Assertions

- First-request quota: switch provider/model in the same native runner retry.
- Main and native foreground `subagent`: complete a counter tool, fail the next
  primary request, resume on backup with its durable tool result. Counter stays 1.
- Child first-request quota also succeeds. Native child ID and parentID remain
  linked; the parent receives one completed `subagent` result and completes once.
- Exactly one persisted user message per session: no user prompt resubmission.
- Final assistant and session model attribution identify the backup provider.
- Backup quota exhaustion stops after two total requests.
- Streamed text followed by an SSE quota error does not switch models.
- Authentication and HTTP 408 errors do not switch models.
- Explicit manual selection before the pending quota response is released wins.
- Interrupt before releasing the pending quota response results in no backup request.
- Explicit native compaction quota is rejected by the HTTP request-kind gate;
  the primary session model stays selected.
- Negative proof: a later retry hook vetoes dispatch, but the earlier awaited
  `switchModel` has already persisted backup selection. This is an asserted
  hazard, not a safety success.

The synthetic 429 body uses `error.type = GoUsageLimitError` and a neutral message.
Native classification produces `event.error.type = provider.quota`, initially
`decision.retry = false`. The fixture gates on that structured type, a recorded
primary HTTP rejection, unchanged session model, and an unused one-switch budget.
It awaits `switchModel` and sets `decision = { retry: true, delay: 0 }`.
No exception-message string matching is used by the fixture.

Evidence includes session/message/call IDs, model attribution, completed tool
records, request counts/order, tool-result context, native retry classifications,
original decisions, and counter values. Full request system prompts and host
logs/authentication are omitted. Failed assertions exit nonzero.

## Limits: this is not a production safety guarantee

- The fixture deliberately vetoes all noneligible native retries to make negative
  controls bounded. It does not demonstrate preservation of native retry policy.
- HTTP 408 is a provider timeout response, not a real transport deadline/socket
  timeout. WebSocket providers and real provider behavior are untested.
- The HTTP-response gate excludes the tested partial stream (HTTP 200). The retry
  hook itself has no streamed-output flag, request ID, cancellation signal, or
  request kind. The fixture's session-keyed HTTP observations can be overwritten
  by concurrent auxiliary requests and are not a universal attempt correlation.
- The manual and cancellation barriers precede response release. Selection or
  cancellation racing between the model read and awaited switch is unverified;
  there is no demonstrated atomic compare-and-switch/cancellation guard.
- The later-hook veto hazard is reproduced on the native host: zero backup
  requests but backup remains selected. A plugin cannot treat the switch and
  retry decision as one committed operation.
- The one-switch budget is in-memory and per session, not durable or per turn.
  Background child completion delivery, crash/restart recovery, multiple backup
  candidates, and concurrent prompts are unverified.
- Only the installed 2.0.8 native host is executed. Source equality of relevant
  2.0.12 files is not a native-host 2.0.12 test.

This fixture is deliberately opt-in and is not a deployable routing plugin.
