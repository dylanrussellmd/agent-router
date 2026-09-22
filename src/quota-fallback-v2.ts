import { createHash } from "node:crypto";
import type { Context } from "@opencode/plugin/promise/plugin";
import type {
  SessionHttpRequest,
  SessionHttpResponse,
  SessionModelRequest,
  SessionRetry,
} from "@opencode/plugin/promise/session";
import { z } from "zod";
import {
  UsageQuota,
  createQuotaQuery,
  effectiveQuotaStatus,
  quotaCandidate,
} from "./core/quota-preflight.js";
import type { RoutingEntry } from "./core/schema.js";
import type { createQuotaAdmission } from "./quota-v2.js";

export const QuotaFallbackOptions = z
  .object({
    enabled: z.boolean().default(false),
    allowPaidFallbacks: z.boolean().default(false),
    maxSwitches: z.number().int().min(1).max(8).default(8),
  })
  .strict();
type Model = { providerID: string; id: string; variant?: string | undefined };
const key = (m: Model) =>
  `${m.providerID}/${m.id}#${m.variant === "default" ? "" : (m.variant ?? "")}`;
const ref = (m: { model: string; variant?: string | null | undefined }): Model => ({
  ...quotaCandidate(m),
  ...(m.variant && m.variant !== "default" ? { variant: m.variant } : {}),
});
const TTL = 5_000;
const clock = () => performance.now();
const CAP = 1024;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Native 2.0.8 has no retry request ID/kind/cancellation or atomic switch-and-retry. */
export function createQuotaFallback(
  ctx: Context,
  routes: Record<string, RoutingEntry>,
  admission: NonNullable<ReturnType<typeof createQuotaAdmission>>,
  current: () => boolean,
  selected: (id: string, agent: string, model: Model, messageID?: string) => void = () => {},
) {
  const parsed = QuotaFallbackOptions.safeParse(ctx.options?.quotaFallback ?? {});
  if (!parsed.success || !parsed.data.enabled) return undefined;
  const options = parsed.data;
  const query = createQuotaQuery((input, request) => ctx.rpc(UsageQuota).query(input, request));
  const turns = new Map<
    string,
    { agent: string; model: Model; switches: number; selected: boolean; generation: number }
  >();
  type Observation = {
    model: string;
    agent: string;
    kind: string;
    at: number;
    status?: number;
    sent?: boolean;
    ambiguous: boolean;
    origin?: string;
    paths?: string[];
  };
  const observations = new Map<string, Observation>();
  const requests = new WeakMap<Request, Observation>();
  // Auxiliary traffic poisons the whole admission, including 200 responses still streaming.
  const poisoned = new Set<string>();
  const busy = new Set<string>();
  const tickets = new Map<
    string,
    {
      parent: string;
      agent: string;
      callID: string;
      model?: string | undefined;
      promptHash?: string | undefined;
      at: number;
    }
  >();
  const claiming = new Map<string, object>();
  let disposed = false;
  let saturated = false;
  // Dropping a negative child ticket loses provenance. Latch closed until reload.
  let childSaturated = false;
  const poison = (id: string) => {
    if (poisoned.has(id) || poisoned.size < CAP) poisoned.add(id);
    else saturated = true;
  };
  const prune = () => {
    const cutoff = clock() - TTL;
    for (const [id, value] of observations) {
      if (value.at >= cutoff) continue;
      // Expiry revokes retry permission, never evidence of an unresolved overlap.
      if (value.ambiguous || value.status === undefined || value.status >= 400) poison(id);
      observations.delete(id);
    }
    for (const [id, value] of tickets) if (value.at < cutoff) tickets.delete(id);
  };
  const timer = setInterval(prune, TTL);
  timer.unref();
  const stop = (id: string) => {
    turns.delete(id);
    observations.delete(id);
    poisoned.delete(id);
    claiming.delete(id);
  };
  return {
    stop,
    admit(id: string, agent: string, model: Model) {
      stop(id);
      if (turns.size < CAP)
        turns.set(id, { agent, model, switches: 0, selected: false, generation: 0 });
    },
    // Keep only a digest of the automatic admission, never prompt text.
    ticket(id: string, parent: string, agent: string, model?: string, prompt?: string) {
      prune();
      if (tickets.size < CAP)
        tickets.set(`${parent}/${id}`, {
          parent,
          agent,
          model,
          callID: id,
          promptHash:
            prompt === undefined
              ? undefined
              : digest(`You are a subagent spawned by another session.\n${prompt}`),
          at: clock(),
        });
      else childSaturated = true;
    },
    async child(id: string, agent: string, model: Model) {
      if (
        childSaturated ||
        turns.has(id) ||
        claiming.has(id) ||
        claiming.size >= 64 ||
        disposed ||
        !current()
      )
        return;
      prune();
      const claim = {};
      claiming.set(id, claim);
      try {
        const session = await ctx.session.get({ sessionID: id });
        if (
          !session.parentID ||
          session.agent !== agent ||
          !session.model ||
          key(session.model) !== key(model)
        )
          return;
        const candidates = [...tickets].filter(([, t]) => t.parent === session.parentID);
        if (candidates.length !== 1 || (await admission.isPinned(id))) return;
        const messages = await ctx.session.context({ sessionID: session.parentID });
        const calls = messages.flatMap((m) => ("content" in m ? m.content : [])) as unknown as {
          id?: string;
          name?: string;
          state?: { status?: string; metadata?: { sessionID?: string }; input?: unknown };
        }[];
        const childMessages = await ctx.session.context({ sessionID: id });
        const users = childMessages.filter((m) => m.type === "user");
        const user = users.length === 1 ? users[0] : undefined;
        if (!user) return;
        const matched = candidates.filter(
          ([, t]) =>
            t.agent === agent &&
            t.promptHash &&
            digest(user.text) === t.promptHash &&
            // Positive native association beats a matching automatic prompt fingerprint.
            !calls.some(
              (call) =>
                call.name === "subagent" &&
                call.id !== t.callID &&
                call.state?.metadata?.sessionID === id,
            ) &&
            calls.some(
              (call) =>
                call.id === t.callID &&
                call.name === "subagent" &&
                call.state?.status === "running" &&
                (!call.state.metadata?.sessionID || call.state.metadata.sessionID === id),
            ) &&
            (!t.model ||
              t.model ===
                `${model.providerID}/${model.id}${model.variant && model.variant !== "default" ? `#${model.variant}` : ""}`),
        );
        const match = matched.length === 1 ? matched[0] : undefined;
        if (!match) return;
        const latest = await ctx.session.get({ sessionID: id });
        if (
          disposed ||
          childSaturated ||
          !current() ||
          claiming.get(id) !== claim ||
          latest.agent !== agent ||
          !latest.model ||
          key(latest.model) !== key(model) ||
          (await admission.isPinned(id)) ||
          claiming.get(id) !== claim ||
          childSaturated ||
          clock() - match[1].at > TTL
        )
          return;
        tickets.delete(match[0]);
        if (admission.claim(id, agent, model) && turns.size < CAP) {
          turns.set(id, { agent, model, switches: 0, selected: false, generation: 0 });
          selected(id, agent, model, user.id);
        }
      } finally {
        if (claiming.get(id) === claim) claiming.delete(id);
      }
    },
    model(event: SessionModelRequest) {
      prune();
      const turn = turns.get(event.sessionID);
      if (turn) turn.generation++;
      const previous = observations.get(event.sessionID);
      if (!previous && observations.size >= CAP) {
        poison(event.sessionID);
        return;
      }
      if (
        event.kind !== "primary" ||
        previous?.ambiguous ||
        (previous && (previous.status === undefined || previous.status >= 400))
      ) {
        poison(event.sessionID);
      }
      const observed: Observation = {
        model: key(event.model),
        agent: event.agent,
        kind: event.kind,
        at: clock(),
        ambiguous: event.kind !== "primary" || poisoned.has(event.sessionID),
      };
      // Approve only native configured base URL + recognized protocol operation paths.
      try {
        const url = new URL(event.baseURL ?? "");
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          observed.ambiguous = true;
        else {
          observed.origin = url.origin;
          const base = url.pathname.replace(/\/$/, "");
          observed.paths = ["/chat/completions", "/responses", "/messages"].map((p) => base + p);
        }
      } catch {
        observed.ambiguous = true;
      }
      observations.set(event.sessionID, observed);
    },
    request(event: SessionHttpRequest) {
      prune();
      const observed = observations.get(event.sessionID);
      if (!observed) return;
      const url = new URL(event.request.url);
      if (
        observed.sent ||
        observed.model !== key(event.model) ||
        observed.agent !== event.agent ||
        observed.kind !== event.kind ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.origin !== observed.origin ||
        !observed.paths?.includes(url.pathname)
      )
        observed.ambiguous = true;
      observed.sent = true;
      requests.set(event.request, observed);
      const turn = turns.get(event.sessionID);
      if (turn?.selected && event.kind === "primary" && key(turn.model) === key(event.model)) {
        turn.selected = false;
        admission.reason(event.sessionID, "quota_fallback_attempt_dispatched", event.model);
      }
    },
    response(event: SessionHttpResponse) {
      const observed = observations.get(event.sessionID);
      if (!observed) return;
      if (
        requests.get(event.request) !== observed ||
        observed.model !== key(event.model) ||
        observed.agent !== event.agent ||
        observed.kind !== event.kind
      )
        observed.ambiguous = true;
      else observed.status = event.response.status;
    },
    unsupported(id: string) {
      const observed = observations.get(id);
      poison(id);
      if (observed) observed.ambiguous = true;
    },
    async retry(event: SessionRetry): Promise<boolean> {
      const id = event.sessionID;
      prune();
      const observed = observations.get(id);
      if (observed && (observed.ambiguous || observed.status === undefined)) poison(id);
      observations.delete(id); // Single-use evidence, including noneligible failures.
      const turn = turns.get(id);
      const generation = turn?.generation;
      const live = () =>
        !disposed &&
        current() &&
        turns.get(id) === turn &&
        turn?.generation === generation &&
        !!observed &&
        clock() - observed.at <= TTL;
      if (
        disposed ||
        saturated ||
        !current() ||
        busy.has(id) ||
        busy.size >= 64 ||
        !turn ||
        !observed ||
        observed.ambiguous ||
        poisoned.has(id) ||
        observed.kind !== "primary" ||
        observed.agent !== event.agent ||
        observed.model !== key(event.model) ||
        turn.agent !== event.agent ||
        key(turn.model) !== key(event.model) ||
        event.error.type !== "provider.quota" ||
        ![402, 429].includes(observed.status ?? 0) ||
        event.error.status !== observed.status
      )
        return false;
      // A positively identified quota failure is handled here, even when the chain is exhausted.
      if (!options.allowPaidFallbacks || turn.switches >= options.maxSwitches) return true;
      const route = routes[turn.agent];
      if (!route) return true;
      const chain = [route, ...(route.fallbacks ?? [])].map(ref);
      const index = chain.findIndex((m) => key(m) === key(event.model));
      if (index < 0) return true;
      busy.add(id);
      try {
        const before = await ctx.session.get({ sessionID: id });
        if (
          before.agent !== turn.agent ||
          !admission.owns(id, before) ||
          (before.model && key(before.model) !== key(event.model)) ||
          (await admission.isPinned(id)) ||
          !live()
        )
          return true;
        const results = await query.read(
          chain.slice(index + 1).map(({ providerID, id }) => ({ providerID, id })),
        );
        const next = chain.slice(index + 1).find(
          (m) =>
            // Do not revisit a model, even if it occurs twice in the configured chain.
            !chain.slice(0, index + 1).some((old) => key(old) === key(m)) &&
            effectiveQuotaStatus(m, results).status !== "exhausted",
        );
        if (!next) return true;
        const latest = await ctx.session.get({ sessionID: id });
        if (
          !live() ||
          clock() - observed.at > TTL ||
          !admission.owns(id, latest) ||
          (await admission.isPinned(id)) ||
          latest.agent !== before.agent ||
          (latest.model ? key(latest.model) : "") !== (before.model ? key(before.model) : "") ||
          !live()
        )
          return true;
        if (!(await admission.select(id, turn.agent, next, live))) return true;
        turn.model = next;
        turn.switches++;
        turn.selected = true;
        admission.reason(
          id,
          live()
            ? "quota_fallback_selected_retry_requested_not_confirmed"
            : "quota_fallback_selected_retry_not_requested_control_changed",
          next,
        );
        // Never roll back: a later hook veto can leave this selection in place.
        if (live()) {
          selected(id, turn.agent, next);
          event.decision = { retry: true, delay: 0 };
        }
        return true;
      } catch {
        admission.reason(id, "quota_fallback_selection_failed_retry_not_requested");
        return true;
      } finally {
        busy.delete(id);
      }
    },
    dispose() {
      disposed = true;
      clearInterval(timer);
      query.dispose();
      turns.clear();
      observations.clear();
      tickets.clear();
      poisoned.clear();
      claiming.clear();
    },
  };
}
