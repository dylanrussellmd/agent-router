import type { Context } from "@opencode/plugin/promise/plugin";
import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";
import type { createQuotaAdmission } from "./quota-v2.js";

export const routingReasons = {
  explicit_pin: "Explicitly pinned",
  manual_or_preexisting_selection: "Manual or pre-existing selection",
  awaiting_next_turn: "Awaiting next user turn",
  automatic_next_explicit_turn: "Automatic on next user turn",
  primary_available: "Primary quota available",
  primary_unknown: "Primary quota unknown",
  no_eligible_fallback: "No eligible fallback",
  staged_reactive_fallback: "Previously staged fallback",
  known_exhaustion_fallback: "Primary quota exhausted",
  quota_fallback_selected_retry_requested_not_confirmed: "Fallback selected; retry requested",
  quota_fallback_selected_retry_not_requested_control_changed:
    "Fallback selected; retry not requested",
  quota_fallback_attempt_dispatched: "Fallback attempt dispatched",
  quota_fallback_selection_failed_retry_not_requested: "Selection failed; retry not requested",
  quota_fallback_paid_disabled: "Fallback skipped: paid fallback disabled",
  quota_fallback_switch_limit: "Fallback skipped: switch limit",
  quota_fallback_no_candidate: "Fallback skipped: no eligible candidate",
  configuration_changed: "Configuration changed; reload needed",
  unknown: "Reason unknown",
} as const;
export const RoutingReason = z.enum(
  Object.keys(routingReasons) as [
    keyof typeof routingReasons,
    ...Array<keyof typeof routingReasons>,
  ],
);
const token = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._+/-]*$/);
export const RoutingStatusInput = z
  .object({
    sessionID: z
      .string()
      .max(200)
      .regex(/^ses_[a-zA-Z0-9]+$/),
  })
  .strict();
export const RoutingControlInput = RoutingStatusInput.extend({
  action: z.enum(["pin", "auto"]),
}).strict();
export const RoutingStatusOutput = z
  .object({
    sessionID: RoutingStatusInput.shape.sessionID,
    mode: z.enum(["automatic", "pinned"]),
    model: z
      .object({ providerID: token, id: token, variant: token.optional() })
      .strict()
      .nullable(),
    reason: RoutingReason,
    checkedAt: z.number().finite().positive().nullable(),
    validUntil: z.number().finite().positive().nullable(),
  })
  .strict();
export const RoutingStatusRpc = Rpc.define({
  id: "agent-router",
  methods: {
    status: { input: RoutingStatusInput, output: RoutingStatusOutput.nullable() },
    control: { input: RoutingControlInput, output: RoutingStatusOutput.nullable() },
  },
  events: {},
});

export function createRoutingStatusReader(
  ctx: Context,
  quota: ReturnType<typeof createQuotaAdmission>,
) {
  return async (input: unknown, signal?: AbortSignal) => {
    const parsed = RoutingStatusInput.safeParse(input);
    if (!parsed.success || signal?.aborted || !quota) return null;
    try {
      const session = await ctx.session.get(parsed.data, signal ? { signal } : {});
      if (signal?.aborted || !sameRoutingLocation(session, ctx.location)) return null;
      const status = await quota.status(parsed.data.sessionID, session);
      if (signal?.aborted) return null;
      return RoutingStatusOutput.safeParse(status).data ?? null;
    } catch {
      return null;
    }
  };
}

/** Fail closed before reading pins, defaults, or diagnostics for another location. */
export function sameRoutingLocation(session: unknown, location: unknown): boolean {
  const s = session as
    | { projectID?: string; location?: { directory?: string; workspaceID?: string } }
    | undefined;
  const l = location as
    | { directory?: string; workspaceID?: string; project?: { id?: string } }
    | undefined;
  return (
    !!l?.directory &&
    !!l.project?.id &&
    s?.location?.directory === l.directory &&
    s.location.workspaceID === l.workspaceID &&
    s.projectID === l.project.id
  );
}
