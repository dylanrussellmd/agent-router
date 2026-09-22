import type { Context } from "@opencode/plugin/promise/plugin";
import { createPinStore } from "./core/pin-store.js";
import {
  QuotaOptions,
  UsageQuota,
  chooseQuotaRoute,
  createQuotaQuery,
  effectiveQuotaStatus,
  quotaCandidate,
} from "./core/quota-preflight.js";
import type { RoutingEntry } from "./core/schema.js";
import { QuotaFallbackOptions } from "./quota-fallback-v2.js";

type Model = { providerID: string; id: string; variant?: string | undefined };
type Session = {
  agent?: string | undefined;
  model?: Model | undefined;
  parentID?: string | undefined;
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
  const expected = new Map<string, string>();
  const busy = new Set<string>();
  const versions = new Map<string, number>();
  const controls = new Set<string>();
  const pinned = new Set<string>();
  const deletedControls = new Set<string>();
  const pinStore = createPinStore(ctx.storage);
  const reasons = new Map<string, string>();
  let disposed = false;

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

  const evaluate = async (route: RoutingEntry, pending?: Model) => {
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
    async status(sessionID: string): Promise<{
      sessionID: string;
      mode: "automatic" | "pinned";
      model: Model | null;
      reason: string;
    }> {
      const session = await ctx.session.get({ sessionID });
      const explicit = await isPinned(sessionID);
      const automatic =
        !explicit && (!session.model || owned.get(sessionID)?.model === key(session.model));
      const resolved =
        session.model ??
        (session.agent
          ? (await ctx.agent.get({ agentID: session.agent })).data.model
          : undefined) ??
        (await ctx.model.default()).data;
      return {
        sessionID,
        mode: automatic ? "automatic" : "pinned",
        model: resolved
          ? {
              providerID: resolved.providerID,
              id: resolved.id,
              ...("variant" in resolved && typeof resolved.variant === "string"
                ? { variant: resolved.variant }
                : {}),
            }
          : null,
        reason: explicit
          ? "explicit_pin"
          : automatic
            ? (reasons.get(sessionID) ?? "awaiting_next_turn")
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
        } else {
          if (!owned.has(sessionID) && owned.size >= 1024)
            throw new Error("Automatic session capacity reached.");
          await pinStore.remove(sessionID, live);
          if (!live()) throw new Error("Router stopped; automatic routing was not resumed.");
          pinned.delete(sessionID);
          owned.set(sessionID, { agent: session.agent, model: key(session.model) });
          reason(sessionID, "automatic_next_explicit_turn", session.model);
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
        owned.delete(sessionID);
        expected.delete(sessionID);
        // Only in-flight admissions need an invalidation generation.
        invalidate(sessionID);
        if (type === "session.deleted") {
          if (controls.has(sessionID)) deletedControls.add(sessionID);
          pinned.delete(sessionID);
          reasons.delete(sessionID);
          return pinStore.remove(sessionID).then(() => false);
        }
      }
      return false;
    },
    async main(sessionID: string, session: Session, pending?: Model): Promise<Model | undefined> {
      if (disposed || !current() || session.parentID || !session.agent || busy.has(sessionID))
        return;
      if (busy.size >= 64) return;
      busy.add(sessionID);
      const generation = versions.get(sessionID) ?? 0;
      try {
        if (controls.has(sessionID) || (await isPinned(sessionID))) return;
        if (
          disposed ||
          controls.has(sessionID) ||
          pinned.has(sessionID) ||
          (versions.get(sessionID) ?? 0) !== generation
        )
          return;
        const route = routes[session.agent];
        if (!route) return;
        const previous = owned.get(sessionID);
        if (
          session.model &&
          (!previous || previous.agent !== session.agent || previous.model !== key(session.model))
        )
          return;
        if (!owned.has(sessionID) && owned.size >= 1024) return;
        const choose = await evaluate(route, pending);
        if (disposed || !current() || (versions.get(sessionID) ?? 0) !== generation) return;
        const latest = await ctx.session.get({ sessionID });
        if (
          disposed ||
          controls.has(sessionID) ||
          pinned.has(sessionID) ||
          latest.agent !== session.agent ||
          key(latest.model) !== key(session.model) ||
          (versions.get(sessionID) ?? 0) !== generation ||
          !current()
        )
          return;
        const decision = choose();
        const { choice } = decision;
        if (!choice) {
          reason(sessionID, decision.reason, session.model);
          return;
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
          } catch {
            expected.delete(sessionID);
            return;
          }
        }
        if (
          disposed ||
          controls.has(sessionID) ||
          pinned.has(sessionID) ||
          (versions.get(sessionID) ?? 0) !== generation
        )
          return;
        owned.set(sessionID, { agent: session.agent, model: key(model) });
        reason(sessionID, decision.reason, model);
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
      await pinStore.drain();
    },
  };
}
