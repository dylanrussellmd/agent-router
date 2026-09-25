import type { Context } from "@opencode/plugin/promise/plugin";
import { createPinStore } from "./core/pin-store.js";
import {
  QuotaOptions,
  type QuotaResult,
  UsageQuota,
  chooseQuotaRoute,
  createQuotaQuery,
  effectiveQuotaStatus,
  quotaCandidate,
} from "./core/quota-preflight.js";
import type { RoutingEntry } from "./core/schema.js";
import { QuotaFallbackOptions } from "./quota-fallback-v2.js";
import { RoutingReason, RoutingStatusOutput } from "./routing-status.js";

type Model = { providerID: string; id: string; variant?: string | undefined };
type Session = {
  agent?: string | undefined;
  model?: Model | undefined;
  parentID?: string | undefined;
};
type DiagnosticScalar = string | number | boolean | null;
export type MainDiagnostic = {
  outcome: "selected" | "skipped";
  reason: string;
  details: Record<string, DiagnosticScalar>;
};
const key = (model: Model | undefined) =>
  model
    ? `${model.providerID}/${model.id}#${model.variant === "default" ? "" : (model.variant ?? "")}`
    : "";

export function createQuotaAdmission(
  ctx: Context,
  routes: Record<string, RoutingEntry>,
  current: () => boolean,
) {
  const parsed = QuotaOptions.safeParse(ctx.options?.quotaPreflight ?? {});
  const fallback = QuotaFallbackOptions.safeParse(ctx.options?.quotaFallback ?? {});
  if ((!parsed.success || !parsed.data.enabled) && (!fallback.success || !fallback.data.enabled))
    return undefined;
  const options = parsed.success ? parsed.data : { enabled: false, allowPaidFallbacks: false };
  // Lazy lookup tolerates service plugin ordering and absent query registrations.
  const query = createQuotaQuery((input, request) => ctx.rpc(UsageQuota).query(input, request));
  const owned = new Map<string, { agent: string; model: string }>();
  const lastControl = new Map<
    string,
    { action: "pin" | "auto"; agent: string; model: string; at: number }
  >();
  const lastOwnershipEvent = new Map<
    string,
    {
      event: string;
      ownerPresent: boolean;
      ownerAgent: string | null;
      ownerModel: string | null;
      at: number;
    }
  >();
  const expected = new Map<string, string>();
  const busy = new Set<string>();
  const versions = new Map<string, number>();
  const controls = new Set<string>();
  const pinned = new Set<string>();
  const deletedControls = new Set<string>();
  const pinStore = createPinStore(ctx.storage);
  const reasons = new Map<string, string>();
  const freshness = new Map<string, { checkedAt: number | null; validUntil: number | null }>();
  let disposed = false;

  const remember = <T>(map: Map<string, T>, sessionID: string, value: T) => {
    if (!map.has(sessionID) && map.size >= 1024) {
      const oldest = map.keys().next().value;
      if (oldest) map.delete(oldest);
    }
    map.set(sessionID, value);
  };
  const ownershipDetails = (sessionID: string, session: Session) => {
    const owner = owned.get(sessionID);
    const control = lastControl.get(sessionID);
    const invalidation = lastOwnershipEvent.get(sessionID);
    const model = key(session.model);
    return {
      sessionAgent: session.agent ?? null,
      sessionModel: model || null,
      ownerPresent: !!owner,
      ownerAgent: owner?.agent ?? null,
      ownerModel: owner?.model || null,
      ownerAgentMatches: !!owner && owner.agent === session.agent,
      ownerModelMatches: model ? !!owner && owner.model === model : null,
      lastControlAction: control?.action ?? null,
      lastControlAgent: control?.agent ?? null,
      lastControlModel: control?.model || null,
      lastControlAgeMs: control ? Math.max(0, Date.now() - control.at) : null,
      lastOwnershipEvent: invalidation?.event ?? null,
      lastOwnershipEventOwnerPresent: invalidation?.ownerPresent ?? null,
      lastOwnershipEventOwnerAgent: invalidation?.ownerAgent ?? null,
      lastOwnershipEventOwnerModel: invalidation?.ownerModel ?? null,
      lastOwnershipEventAgeMs: invalidation ? Math.max(0, Date.now() - invalidation.at) : null,
      lastOwnershipEventAfterControl: !!control && !!invalidation && invalidation.at >= control.at,
    } satisfies Record<string, DiagnosticScalar>;
  };

  const invalidate = (sessionID: string) => {
    if (busy.has(sessionID)) versions.set(sessionID, (versions.get(sessionID) ?? 0) + 1);
  };
  const reason = (sessionID: string, value: string, model?: Model) => {
    if (disposed) return;
    if (reasons.has(sessionID) || reasons.size < 1024) reasons.set(sessionID, value);
    console.info(`agent-router: [${sessionID}] ${value}${model ? ` ${key(model)}` : ""}`);
  };
  const isPinned = async (sessionID: string) => {
    if (pinned.has(sessionID)) return true;
    try {
      return await pinStore.has(sessionID);
    } catch {
      // An unreadable durable pin must never be silently cleared.
      return true;
    }
  };

  const observe = (sessionID: string, candidate: Model, results: readonly QuotaResult[]) => {
    if (disposed || (!freshness.has(sessionID) && freshness.size >= 1024)) return;
    const matches = results.filter(
      (r) => r.providerID === candidate.providerID && r.id === candidate.id,
    );
    const r = matches.length === 1 ? matches[0] : undefined;
    const checkedAt =
      r?.accountRef && r.scopeRef && r.checkedAt && r.checkedAt <= Date.now() && r.checkedAt > 0
        ? r.checkedAt
        : null;
    const validUntil =
      checkedAt && r?.validUntil && r.validUntil > checkedAt
        ? Math.min(r.validUntil, r.resetAt ?? r.validUntil)
        : null;
    freshness.set(sessionID, {
      checkedAt,
      validUntil: validUntil && validUntil > 0 ? validUntil : null,
    });
  };
  const evaluate = async (route: RoutingEntry, pending?: Model, sessionID?: string) => {
    const candidates = [route, ...(route.fallbacks ?? [])]
      .map(quotaCandidate)
      .filter(
        (entry, index, all) =>
          all.findIndex(
            (other) => other.providerID === entry.providerID && other.id === entry.id,
          ) === index,
      );
    const results = options.enabled ? await query.read(candidates) : [];
    // Evaluate at the final decision, including after any further host reads.
    return () => {
      if (sessionID) observe(sessionID, quotaCandidate(route), results);
      const now = Date.now();
      const startIndex = pending
        ? Math.max(
            0,
            [route, ...(route.fallbacks ?? [])].findIndex(
              (entry) =>
                key({
                  ...quotaCandidate(entry),
                  ...(entry.variant ? { variant: entry.variant } : {}),
                }) === key(pending),
            ),
          )
        : 0;
      const choice = options.enabled
        ? chooseQuotaRoute(route, results, options.allowPaidFallbacks, now, startIndex)
        : pending
          ? [route, ...(route.fallbacks ?? [])][startIndex]
          : route;
      return {
        choice,
        reason: !choice
          ? "no_eligible_fallback"
          : pending
            ? "staged_reactive_fallback"
            : choice.model !== route.model
              ? "known_exhaustion_fallback"
              : effectiveQuotaStatus(quotaCandidate(route), results, now).status === "available"
                ? "primary_available"
                : "primary_unknown",
      };
    };
  };
  return {
    isPinned,
    reason,
    observe,
    clearFreshness: () => freshness.clear(),
    owns(sessionID: string, session: Session) {
      return (
        !disposed &&
        current() &&
        !controls.has(sessionID) &&
        !pinned.has(sessionID) &&
        !!session.agent &&
        (!session.model ||
          (owned.get(sessionID)?.agent === session.agent &&
            owned.get(sessionID)?.model === key(session.model)))
      );
    },
    claim(sessionID: string, agent: string, model: Model) {
      if (disposed || !current() || controls.has(sessionID) || pinned.has(sessionID)) return false;
      if (!owned.has(sessionID) && owned.size >= 1024) return false;
      owned.set(sessionID, { agent, model: key(model) });
      return true;
    },
    async select(sessionID: string, agent: string, model: Model, live: () => boolean) {
      if (!live()) return false;
      expected.set(sessionID, key(model));
      try {
        await ctx.session.switchModel({
          sessionID,
          model: {
            providerID: model.providerID,
            id: model.id,
            ...(model.variant ? { variant: model.variant } : {}),
          },
        });
        if (live()) owned.set(sessionID, { agent, model: key(model) });
        return true;
      } catch (error) {
        expected.delete(sessionID);
        throw error;
      }
    },
    async status(
      sessionID: string,
      knownSession?: Session,
    ): Promise<{
      sessionID: string;
      mode: "automatic" | "pinned";
      model: Model | null;
      reason: string;
      checkedAt: number | null;
      validUntil: number | null;
    }> {
      const session = knownSession ?? (await ctx.session.get({ sessionID }));
      const explicit = await isPinned(sessionID);
      const automatic =
        !explicit &&
        (!session.model ||
          (owned.get(sessionID)?.agent === session.agent &&
            owned.get(sessionID)?.model === key(session.model)));
      const resolved =
        session.model ??
        (session.agent
          ? (await ctx.agent.get({ agentID: session.agent })).data.model
          : undefined) ??
        (await ctx.model.default()).data;
      return {
        sessionID,
        mode: automatic ? "automatic" : "pinned",
        model:
          RoutingStatusOutput.shape.model.safeParse(resolved).success && resolved
            ? {
                providerID: resolved.providerID,
                id: resolved.id,
                ...("variant" in resolved && typeof resolved.variant === "string"
                  ? { variant: resolved.variant }
                  : {}),
              }
            : null,
        ...(freshness.get(sessionID) ?? { checkedAt: null, validUntil: null }),
        reason: explicit
          ? "explicit_pin"
          : !current()
            ? "configuration_changed"
            : automatic
              ? (RoutingReason.safeParse(reasons.get(sessionID) ?? "awaiting_next_turn").data ??
                "unknown")
              : "manual_or_preexisting_selection",
      };
    },
    async control(sessionID: string, action: "pin" | "auto", pause: () => Promise<void>) {
      if (disposed || !current())
        throw new Error("Router configuration changed; reload before changing session routing.");
      if (controls.has(sessionID) || controls.size >= 64)
        throw new Error("Session routing control is busy; try again.");
      if (action === "pin" && !pinned.has(sessionID) && pinned.size >= 1024)
        throw new Error("Session pin capacity reached.");
      controls.add(sessionID);
      invalidate(sessionID);
      const live = () => !disposed && current() && !deletedControls.has(sessionID);
      try {
        await pause();
        const session = await ctx.session.get({ sessionID });
        if (!live())
          throw new Error("Router stopped or session deleted before the control completed.");
        if (!session.agent || !routes[session.agent])
          throw new Error("No configured route for this session agent.");
        if (action === "pin") {
          owned.delete(sessionID);
          expected.delete(sessionID);
          await pinStore.add(sessionID, live);
          if (!live()) throw new Error("Router stopped or session deleted during pinning.");
          pinned.add(sessionID);
          if (!session.model) {
            const agent = await ctx.agent.get({ agentID: session.agent });
            const resolved = agent.data.model ?? (await ctx.model.default()).data;
            if (!resolved) throw new Error("No native model is resolved; routing remains pinned.");
            const latest = await ctx.session.get({ sessionID });
            if (!live()) throw new Error("Router stopped or session deleted during pinning.");
            if (latest.agent !== session.agent || key(latest.model) !== key(session.model))
              throw new Error(
                "Session selection changed while pinning; current selection remains pinned.",
              );
            const model = {
              providerID: resolved.providerID,
              id: resolved.id,
              ...("variant" in resolved && typeof resolved.variant === "string"
                ? { variant: resolved.variant }
                : {}),
            };
            await ctx.session.switchModel({ sessionID, model });
          }
          if (!live()) throw new Error("Router stopped or session deleted during pinning.");
          reason(sessionID, "explicit_pin", (await ctx.session.get({ sessionID })).model);
          remember(lastControl, sessionID, {
            action,
            agent: session.agent,
            model: key(session.model),
            at: Date.now(),
          });
        } else {
          if (!owned.has(sessionID) && owned.size >= 1024)
            throw new Error("Automatic session capacity reached.");
          await pinStore.remove(sessionID, live);
          if (!live()) throw new Error("Router stopped; automatic routing was not resumed.");
          pinned.delete(sessionID);
          owned.set(sessionID, { agent: session.agent, model: key(session.model) });
          reason(sessionID, "automatic_next_explicit_turn", session.model);
          remember(lastControl, sessionID, {
            action,
            agent: session.agent,
            model: key(session.model),
            at: Date.now(),
          });
        }
      } finally {
        controls.delete(sessionID);
        deletedControls.delete(sessionID);
      }
    },
    /** Called for every selection event, including before the first prompt. */
    event(sessionID: string, type: string, model?: Model) {
      if (type === "session.model.selected" && expected.get(sessionID) === key(model)) {
        expected.delete(sessionID);
        return true;
      }
      if (
        [
          "session.model.selected",
          "session.agent.selected",
          "session.execution.interrupted",
          "session.deleted",
        ].includes(type)
      ) {
        const previousOwner = owned.get(sessionID);
        remember(lastOwnershipEvent, sessionID, {
          event: type,
          ownerPresent: !!previousOwner,
          ownerAgent: previousOwner?.agent ?? null,
          ownerModel: previousOwner?.model ?? null,
          at: Date.now(),
        });
        owned.delete(sessionID);
        expected.delete(sessionID);
        // Only in-flight admissions need an invalidation generation.
        invalidate(sessionID);
        if (type === "session.deleted") {
          if (controls.has(sessionID)) deletedControls.add(sessionID);
          pinned.delete(sessionID);
          reasons.delete(sessionID);
          freshness.delete(sessionID);
          lastControl.delete(sessionID);
          lastOwnershipEvent.delete(sessionID);
          return pinStore.remove(sessionID).then(() => false);
        }
      }
      return false;
    },
    async main(
      sessionID: string,
      session: Session,
      pending?: Model,
      diagnostic?: (result: MainDiagnostic) => void,
    ): Promise<Model | undefined> {
      const report = (
        outcome: MainDiagnostic["outcome"],
        reason: string,
        details: Record<string, DiagnosticScalar> = {},
      ) => {
        try {
          diagnostic?.({
            outcome,
            reason,
            details: { ...ownershipDetails(sessionID, session), ...details },
          });
        } catch {
          // Diagnostics must never affect routing.
        }
      };
      const skip = (reason: string, details: Record<string, DiagnosticScalar> = {}) => {
        report("skipped", reason, details);
        return undefined;
      };
      if (disposed) return skip("router_disposed");
      if (!current()) return skip("configuration_inactive");
      if (session.parentID) return skip("child_session_not_main_admission");
      if (!session.agent) return skip("session_agent_missing");
      if (busy.has(sessionID)) return skip("session_admission_busy");
      if (busy.size >= 64) return skip("admission_capacity_reached");
      busy.add(sessionID);
      const generation = versions.get(sessionID) ?? 0;
      try {
        if (controls.has(sessionID)) return skip("routing_control_in_progress");
        if (await isPinned(sessionID)) return skip("session_is_pinned");
        if (
          disposed ||
          controls.has(sessionID) ||
          pinned.has(sessionID) ||
          (versions.get(sessionID) ?? 0) !== generation
        ) {
          return skip("admission_invalidated_before_route_check", {
            disposed,
            controlInProgress: controls.has(sessionID),
            pinned: pinned.has(sessionID),
            generationChanged: (versions.get(sessionID) ?? 0) !== generation,
          });
        }
        const route = routes[session.agent];
        if (!route) return skip("agent_route_missing");
        const previous = owned.get(sessionID);
        if (
          session.model &&
          (!previous || previous.agent !== session.agent || previous.model !== key(session.model))
        ) {
          return skip("current_model_not_owned", {
            ownerAgentMatches: !!previous && previous.agent === session.agent,
            ownerModelMatches: !!previous && previous.model === key(session.model),
          });
        }
        if (!owned.has(sessionID) && owned.size >= 1024) return skip("ownership_capacity_reached");
        const choose = await evaluate(route, pending, sessionID);
        if (disposed || !current() || (versions.get(sessionID) ?? 0) !== generation) {
          return skip("admission_invalidated_during_quota_check", {
            disposed,
            configurationCurrent: current(),
            generationChanged: (versions.get(sessionID) ?? 0) !== generation,
          });
        }
        const latest = await ctx.session.get({ sessionID });
        if (
          disposed ||
          controls.has(sessionID) ||
          pinned.has(sessionID) ||
          latest.agent !== session.agent ||
          key(latest.model) !== key(session.model) ||
          (versions.get(sessionID) ?? 0) !== generation ||
          !current()
        ) {
          return skip("session_changed_during_admission", {
            latestAgentMatches: latest.agent === session.agent,
            latestModelMatches: key(latest.model) === key(session.model),
            controlInProgress: controls.has(sessionID),
            pinned: pinned.has(sessionID),
            generationChanged: (versions.get(sessionID) ?? 0) !== generation,
            configurationCurrent: current(),
          });
        }
        const decision = choose();
        const { choice } = decision;
        if (!choice) {
          reason(sessionID, decision.reason, session.model);
          return skip("no_eligible_quota_route", {
            decisionReason: decision.reason,
            routeCandidateCount: 1 + (route.fallbacks?.length ?? 0),
            quotaPreflightEnabled: options.enabled,
            allowPaidFallbacks: options.allowPaidFallbacks,
            pendingFallback: !!pending,
          });
        }
        const model = {
          ...quotaCandidate(choice),
          ...(choice.variant && choice.variant !== "default" ? { variant: choice.variant } : {}),
        };
        // Leave an unresolved automatic primary unresolved; this preserves native defaults.
        if (
          key(model) !== key(session.model) &&
          (session.model || choice.model !== route.model || choice.variant !== route.variant)
        ) {
          expected.set(sessionID, key(model));
          try {
            await ctx.session.switchModel({ sessionID, model });
          } catch (error) {
            expected.delete(sessionID);
            return skip("native_model_switch_failed", {
              selectedModel: key(model),
              errorName: error instanceof Error ? error.name : "non_error_throw",
            });
          }
        }
        if (
          disposed ||
          controls.has(sessionID) ||
          pinned.has(sessionID) ||
          (versions.get(sessionID) ?? 0) !== generation
        ) {
          return skip("admission_invalidated_after_model_switch", {
            disposed,
            controlInProgress: controls.has(sessionID),
            pinned: pinned.has(sessionID),
            generationChanged: (versions.get(sessionID) ?? 0) !== generation,
            selectedModel: key(model),
          });
        }
        owned.set(sessionID, { agent: session.agent, model: key(model) });
        reason(sessionID, decision.reason, model);
        report("selected", decision.reason, {
          selectedAgent: session.agent,
          selectedModel: key(model),
          primaryModel: key(quotaCandidate(route)),
          routeCandidateCount: 1 + (route.fallbacks?.length ?? 0),
          quotaPreflightEnabled: options.enabled,
          allowPaidFallbacks: options.allowPaidFallbacks,
          pendingFallback: !!pending,
          ownerPresent: true,
          ownerAgent: session.agent,
          ownerModel: key(model),
          ownerAgentMatches: true,
          ownerModelMatches: true,
        });
        return model;
      } finally {
        busy.delete(sessionID);
        versions.delete(sessionID);
      }
    },
    async child(event: { tool: string; input: unknown }) {
      if (
        disposed ||
        !current() ||
        event.tool !== "subagent" ||
        !event.input ||
        typeof event.input !== "object"
      )
        return;
      const input = event.input as Record<string, unknown>;
      // Presence, not truthiness: explicit overrides and resumed tasks stay native.
      if (
        "model" in input ||
        "sessionID" in input ||
        "session_id" in input ||
        "task_id" in input ||
        typeof input.agent !== "string"
      )
        return;
      const route = routes[input.agent];
      if (!route) return;
      const originalAgent = input.agent;
      const choose = await evaluate(route);
      const { choice } = choose();
      if (!choice || disposed || !current() || input.agent !== originalAgent || "model" in input)
        return;
      input.model =
        choice.model + (choice.variant && choice.variant !== "default" ? `#${choice.variant}` : "");
    },
    async dispose() {
      disposed = true;
      query.dispose();
      owned.clear();
      expected.clear();
      versions.clear();
      controls.clear();
      pinned.clear();
      reasons.clear();
      freshness.clear();
      lastControl.clear();
      lastOwnershipEvent.clear();
      await pinStore.drain();
    },
  };
}
