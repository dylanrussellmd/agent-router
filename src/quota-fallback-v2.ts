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
import { resolveOriginalRequest } from "./request-provenance.js";

export const QuotaFallbackOptions = z
  .object({
    enabled: z.boolean().default(false),
    allowPaidFallbacks: z.boolean().default(false),
    maxSwitches: z.number().int().min(1).max(8).default(8),
  })
  .strict();
type Model = { providerID: string; id: string; variant?: string | undefined };
type Turn = {
  agent: string;
  model: Model;
  switches: number;
  selected: boolean;
  generation: number;
};
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
const key = (m: Model) =>
  `${m.providerID}/${m.id}#${m.variant === "default" ? "" : (m.variant ?? "")}`;
const ref = (m: { model: string; variant?: string | null | undefined }): Model => ({
  ...quotaCandidate(m),
  ...(m.variant && m.variant !== "default" ? { variant: m.variant } : {}),
});
const TTL = 5_000;
const clock = () => performance.now();
const CAP = 1024;
const TRACE_TTL = 30 * 60_000;
const TRACE_ATTEMPTS = 4;
const TRACE_EVENTS = 32;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

type TraceScalar = string | number | boolean | null;
type TraceEvent = { at: string; event: string; [key: string]: TraceScalar };
type TraceAttempt = { id: string; startedAt: string; events: TraceEvent[] };

function endpointDetails(value: string | undefined) {
  try {
    const url = new URL(value ?? "");
    return {
      valid: true,
      origin: url.origin,
      path: url.pathname,
      hasCredentials: !!(url.username || url.password),
      hasQuery: !!url.search,
      hasHash: !!url.hash,
    };
  } catch {
    return {
      valid: false,
      origin: null,
      path: null,
      hasCredentials: false,
      hasQuery: false,
      hasHash: false,
    };
  }
}

/** Current native OpenCode 2.x hosts have no retry request ID/kind/cancellation or atomic switch-and-retry. */
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
  const turns = new Map<string, Turn>();
  const observations = new Map<string, Observation>();
  const requests = new WeakMap<Request, Observation>();
  // Retry lacks a request kind. Retain auxiliary identities for the admission:
  // only an auxiliary request with the same agent AND model is ambiguous.
  // Native OpenCode runner retries capture the prepared operation's agent/model;
  // title generation streams independently and does not invoke the retry hook.
  const auxiliary = new Map<string, Set<string>>();
  let auxiliarySize = 0;
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
  const traces = new Map<string, TraceAttempt[]>();
  let disposed = false;
  let saturated = false;
  // Dropping a negative child ticket loses provenance. Latch closed until reload.
  let childSaturated = false;
  const poison = (id: string) => {
    if (poisoned.has(id) || poisoned.size < CAP) poisoned.add(id);
    else saturated = true;
  };
  const identity = (agent: string, model: string) => JSON.stringify([agent, model]);
  const observeAuxiliary = (event: {
    sessionID: string;
    agent: string;
    model: Model;
    kind: string;
  }) => {
    if (event.kind === "primary") return false;
    const id = event.sessionID;
    const signature = identity(event.agent, key(event.model));
    const entries = auxiliary.get(id) ?? new Set<string>();
    if (!entries.has(signature)) {
      if (auxiliarySize >= CAP) poison(id);
      else {
        entries.add(signature);
        auxiliarySize++;
        auxiliary.set(id, entries);
      }
    }
    const primary = observations.get(id);
    if (primary && identity(primary.agent, primary.model) === signature) poison(id);
    return true;
  };
  const pruneTraces = () => {
    const cutoff = Date.now() - TRACE_TTL;
    for (const [id, attempts] of traces) {
      const fresh = attempts.filter((attempt) => Date.parse(attempt.startedAt) >= cutoff);
      if (fresh.length) traces.set(id, fresh);
      else traces.delete(id);
    }
  };
  const startTrace = (id: string, attemptID?: string) => {
    try {
      pruneTraces();
      let attempts = traces.get(id);
      if (!attempts) {
        if (traces.size >= CAP) {
          const oldest = traces.keys().next().value;
          if (oldest) traces.delete(oldest);
        }
        attempts = [];
      }
      attempts.push({
        id: attemptID?.slice(0, 200) || `attempt-${Date.now()}`,
        startedAt: new Date().toISOString(),
        events: [],
      });
      if (attempts.length > TRACE_ATTEMPTS) attempts.splice(0, attempts.length - TRACE_ATTEMPTS);
      traces.set(id, attempts);
      recordTrace(id, "prompt.begin", {});
    } catch {
      // Diagnostics must never affect routing.
    }
  };
  const recordTrace = (
    id: string,
    event: string,
    details: Record<string, TraceScalar | undefined>,
  ) => {
    try {
      let attempts = traces.get(id);
      if (!attempts?.length) {
        startTrace(id);
        attempts = traces.get(id);
      }
      const attempt = attempts?.at(-1);
      if (!attempt) return;
      const item: TraceEvent = { at: new Date().toISOString(), event };
      for (const [key, value] of Object.entries(details)) {
        if (value !== undefined) item[key] = value;
      }
      attempt.events.push(item);
      if (attempt.events.length > TRACE_EVENTS)
        attempt.events.splice(0, attempt.events.length - TRACE_EVENTS);
    } catch {
      // Diagnostics must never affect routing.
    }
  };
  const snapshot = (id: string, observed?: Observation, turn?: Turn) => ({
    observationPresent: !!observed,
    observedKind: observed?.kind ?? null,
    observedAgent: observed?.agent ?? null,
    observedModel: observed?.model ?? null,
    observedStatus: observed?.status ?? null,
    observedSent: observed?.sent ?? false,
    observedAmbiguous: observed?.ambiguous ?? false,
    turnPresent: !!turn,
    turnAgent: turn?.agent ?? null,
    turnModel: turn ? key(turn.model) : null,
    turnSwitches: turn?.switches ?? null,
    poisoned: poisoned.has(id),
    configurationCurrent: current(),
  });
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
    auxiliarySize -= auxiliary.get(id)?.size ?? 0;
    auxiliary.delete(id);
    poisoned.delete(id);
    claiming.delete(id);
  };
  return {
    stop,
    begin(sessionID: string, attemptID?: string) {
      startTrace(sessionID, attemptID);
    },
    admissionSkipped(
      sessionID: string,
      reason: string,
      details: Record<string, TraceScalar | undefined> = {},
    ) {
      recordTrace(sessionID, "admission.skipped", { reason, ...details });
    },
    diagnostics(sessionID: string) {
      pruneTraces();
      return {
        attempts: (traces.get(sessionID) ?? []).map((attempt) => ({
          id: attempt.id,
          startedAt: attempt.startedAt,
          events: attempt.events.map((event) => ({ ...event })),
        })),
      };
    },
    admit(id: string, agent: string, model: Model) {
      stop(id);
      if (turns.size < CAP) {
        turns.set(id, { agent, model, switches: 0, selected: false, generation: 0 });
        recordTrace(id, "turn.admitted", { agent, model: key(model) });
      } else recordTrace(id, "turn.admission_skipped", { reason: "turn_capacity" });
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
          recordTrace(id, "child.turn.admitted", { agent, model: key(model) });
          selected(id, agent, model, user.id);
        }
      } finally {
        if (claiming.get(id) === claim) claiming.delete(id);
      }
    },
    model(event: SessionModelRequest) {
      prune();
      if (observeAuxiliary(event)) {
        const primary = observations.get(event.sessionID);
        recordTrace(event.sessionID, "model.request.auxiliary", {
          kind: event.kind,
          agent: event.agent,
          model: key(event.model),
          sameIdentityAsPrimary:
            !!primary &&
            identity(primary.agent, primary.model) === identity(event.agent, key(event.model)),
          primaryObservationAmbiguous: primary?.ambiguous ?? false,
        });
        return;
      }
      const turn = turns.get(event.sessionID);
      if (turn) turn.generation++;
      const previous = observations.get(event.sessionID);
      if (!previous && observations.size >= CAP) {
        poison(event.sessionID);
        recordTrace(event.sessionID, "model.request.rejected", {
          reason: "observation_capacity",
          kind: event.kind,
          agent: event.agent,
          model: key(event.model),
        });
        return;
      }
      if (
        auxiliary.get(event.sessionID)?.has(identity(event.agent, key(event.model))) ||
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
        ambiguous: poisoned.has(event.sessionID),
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
      const base = endpointDetails(event.baseURL);
      recordTrace(event.sessionID, "model.request", {
        kind: event.kind,
        agent: event.agent,
        model: key(event.model),
        baseValid: base.valid,
        baseOrigin: base.origin,
        basePath: base.path,
        baseHasCredentials: base.hasCredentials,
        baseHasQuery: base.hasQuery,
        baseHasHash: base.hasHash,
        turnPresent: !!turn,
        turnAgent: turn?.agent ?? null,
        turnModel: turn ? key(turn.model) : null,
        generation: turn?.generation ?? null,
        ambiguous: observed.ambiguous,
      });
    },
    request(event: SessionHttpRequest) {
      prune();
      if (observeAuxiliary(event)) {
        const endpoint = endpointDetails(event.request.url);
        recordTrace(event.sessionID, "http.request.auxiliary", {
          kind: event.kind,
          agent: event.agent,
          model: key(event.model),
          origin: endpoint.origin,
          path: endpoint.path,
          hasCredentials: endpoint.hasCredentials,
          hasQuery: endpoint.hasQuery,
        });
        return;
      }
      const observed = observations.get(event.sessionID);
      if (!observed) {
        const endpoint = endpointDetails(event.request.url);
        recordTrace(event.sessionID, "http.request.ignored", {
          reason: "no_model_request_observation",
          kind: event.kind,
          agent: event.agent,
          model: key(event.model),
          origin: endpoint.origin,
          path: endpoint.path,
          hasCredentials: endpoint.hasCredentials,
          hasQuery: endpoint.hasQuery,
        });
        return;
      }
      // Resolve the exact original Request a trusted rewriting plugin replaced.
      // Endpoint validation and WeakMap correlation use only that original; the
      // replacement's URL/headers are the adapter's business, never authority.
      let root: Request;
      try {
        root = resolveOriginalRequest(event.request);
      } catch {
        // Malformed or untrusted provenance cannot be correlated. Reject the
        // request so it can never later be mistaken for observed evidence.
        observed.ambiguous = true;
        observed.sent = true;
        recordTrace(event.sessionID, "http.request", {
          matched: false,
          reason: "invalid_request_provenance",
          kind: event.kind,
          agent: event.agent,
          model: key(event.model),
          requestOrigin: endpointDetails(event.request.url).origin,
          requestPath: endpointDetails(event.request.url).path,
          observedAmbiguous: observed.ambiguous,
        });
        return;
      }
      const url = new URL(root.url);
      const matchSent = !observed.sent;
      const matchModel = observed.model === key(event.model);
      const matchAgent = observed.agent === event.agent;
      const matchKind = observed.kind === event.kind;
      const matchURL =
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.origin === observed.origin &&
        !!observed.paths?.includes(url.pathname);
      if (!matchSent || !matchModel || !matchAgent || !matchKind || !matchURL)
        observed.ambiguous = true;
      observed.sent = true;
      requests.set(root, observed);
      recordTrace(event.sessionID, "http.request", {
        matched: matchSent && matchModel && matchAgent && matchKind && matchURL,
        provenance: root === event.request ? "native" : "rewritten_to_original",
        kind: event.kind,
        agent: event.agent,
        model: key(event.model),
        requestOrigin: url.origin,
        requestPath: url.pathname,
        matchSent,
        matchModel,
        matchAgent,
        matchKind,
        matchURL,
        observedAmbiguous: observed.ambiguous,
      });
      const turn = turns.get(event.sessionID);
      if (turn?.selected && event.kind === "primary" && key(turn.model) === key(event.model)) {
        turn.selected = false;
        admission.reason(event.sessionID, "quota_fallback_attempt_dispatched", event.model);
      }
    },
    response(event: SessionHttpResponse) {
      if (observeAuxiliary(event)) {
        const endpoint = endpointDetails(event.request.url);
        recordTrace(event.sessionID, "http.response.auxiliary", {
          kind: event.kind,
          agent: event.agent,
          model: key(event.model),
          status: event.response.status,
          origin: endpoint.origin,
          path: endpoint.path,
        });
        return;
      }
      const observed = observations.get(event.sessionID);
      if (!observed) {
        const endpoint = endpointDetails(event.request.url);
        recordTrace(event.sessionID, "http.response.ignored", {
          reason: "no_model_request_observation",
          kind: event.kind,
          agent: event.agent,
          model: key(event.model),
          status: event.response.status,
          origin: endpoint.origin,
          path: endpoint.path,
        });
        return;
      }
      // Correlate by the same original identity used at request time so the
      // adapter may wrap the request before or after the router's hooks.
      let root: Request;
      try {
        root = resolveOriginalRequest(event.request);
      } catch {
        // Invalid provenance is never trusted to resolve an observation.
        observed.ambiguous = true;
        recordTrace(event.sessionID, "http.response", {
          matched: false,
          reason: "invalid_response_provenance",
          kind: event.kind,
          agent: event.agent,
          model: key(event.model),
          status: event.response.status,
          responseOrigin: endpointDetails(event.request.url).origin,
          responsePath: endpointDetails(event.request.url).path,
          observedAmbiguous: observed.ambiguous,
        });
        return;
      }
      const matchRequest = requests.get(root) === observed;
      const matchModel = observed.model === key(event.model);
      const matchAgent = observed.agent === event.agent;
      const matchKind = observed.kind === event.kind;
      if (!matchRequest || !matchModel || !matchAgent || !matchKind) observed.ambiguous = true;
      else observed.status = event.response.status;
      const endpoint = endpointDetails(root.url);
      recordTrace(event.sessionID, "http.response", {
        matched: matchRequest && matchModel && matchAgent && matchKind,
        provenance: root === event.request ? "native" : "rewritten_to_original",
        kind: event.kind,
        agent: event.agent,
        model: key(event.model),
        status: event.response.status,
        responseOrigin: endpoint.origin,
        responsePath: endpoint.path,
        matchRequest,
        matchModel,
        matchAgent,
        matchKind,
        observedStatus: observed.status ?? null,
        observedAmbiguous: observed.ambiguous,
      });
    },
    unsupported(id: string, event?: { agent: string; model: Model; kind: string }) {
      if (event && observeAuxiliary({ ...event, sessionID: id })) {
        recordTrace(id, "transport.unsupported.auxiliary", {
          kind: event.kind,
          agent: event.agent,
          model: key(event.model),
        });
        return;
      }
      const observed = observations.get(id);
      poison(id);
      if (observed) observed.ambiguous = true;
      recordTrace(id, "transport.unsupported", {
        reason: "websocket_or_unsupported_transport",
        observedKind: observed?.kind ?? null,
        observedAgent: observed?.agent ?? null,
        observedModel: observed?.model ?? null,
      });
    },
    async retry(event: SessionRetry): Promise<boolean> {
      const id = event.sessionID;
      prune();
      const observed = observations.get(id);
      const initialTurn = turns.get(id);
      const retryDetails = () => ({
        ...snapshot(id, observed, initialTurn),
        retryAgent: event.agent,
        retryModel: key(event.model),
        errorType: event.error.type,
        errorStatus: event.error.status ?? null,
        nativeRetryDecision: event.decision.retry,
        attempt: event.attempt,
      });
      recordTrace(id, "retry.received", retryDetails());
      const reject = (reason: string) => {
        recordTrace(id, "retry.rejected", { reason, ...retryDetails() });
        return false;
      };
      // An auxiliary retry with a distinct identity must not consume the primary's
      // single-use rejection evidence. Same-identity overlap remains poisoned.
      if (observed && (observed.agent !== event.agent || observed.model !== key(event.model)))
        return reject("retry_identity_does_not_match_observation");
      if (observed && (observed.ambiguous || observed.status === undefined)) poison(id);
      observations.delete(id); // Single-use evidence, including noneligible failures.
      const turn = turns.get(id);
      const generation = turn?.generation;
      const live = () =>
        !disposed &&
        !saturated &&
        !poisoned.has(id) &&
        current() &&
        turns.get(id) === turn &&
        turn?.generation === generation &&
        !!observed &&
        !auxiliary.get(id)?.has(identity(observed.agent, observed.model)) &&
        clock() - observed.at <= TTL;
      if (disposed) return reject("router_disposed");
      if (saturated) return reject("router_capacity_saturated");
      if (!current()) return reject("configuration_changed");
      if (busy.has(id)) return reject("session_retry_busy");
      if (busy.size >= 64) return reject("retry_capacity_reached");
      if (!turn) return reject("turn_not_admitted");
      if (!observed) return reject("primary_request_observation_missing");
      if (observed.ambiguous) return reject("primary_request_observation_ambiguous");
      if (poisoned.has(id))
        return reject(
          observed.status === undefined
            ? observed.sent
              ? "http_response_not_correlated"
              : "http_response_not_seen"
            : "admission_poisoned_by_overlap",
        );
      if (observed.kind !== "primary") return reject("request_kind_not_primary");
      if (observed.agent !== event.agent) return reject("retry_agent_mismatch");
      if (observed.model !== key(event.model)) return reject("retry_model_mismatch");
      if (turn.agent !== event.agent) return reject("admitted_agent_mismatch");
      if (key(turn.model) !== key(event.model)) return reject("admitted_model_mismatch");
      if (event.error.type !== "provider.quota") return reject("error_type_not_provider_quota");
      if (![402, 429].includes(observed.status ?? 0))
        return reject("http_response_status_not_quota");
      if (event.error.status !== observed.status) return reject("http_error_status_mismatch");
      recordTrace(id, "retry.eligible", retryDetails());
      // A positively identified quota failure is handled here, even when the chain is exhausted.
      if (!options.allowPaidFallbacks || turn.switches >= options.maxSwitches) {
        const reason = !options.allowPaidFallbacks
          ? "quota_fallback_paid_disabled"
          : "quota_fallback_switch_limit";
        admission.reason(id, reason);
        recordTrace(id, "fallback.blocked", {
          reason,
          switches: turn.switches,
          maxSwitches: options.maxSwitches,
          allowPaidFallbacks: options.allowPaidFallbacks,
          retryRequested: false,
        });
        return true;
      }
      const route = routes[turn.agent];
      if (!route) {
        recordTrace(id, "fallback.blocked", {
          reason: "configured_route_missing",
          retryRequested: false,
        });
        return true;
      }
      const chain = [route, ...(route.fallbacks ?? [])].map(ref);
      const index = chain.findIndex((m) => key(m) === key(event.model));
      if (index < 0) {
        recordTrace(id, "fallback.blocked", {
          reason: "primary_model_not_in_configured_chain",
          configuredPrimary: key(ref(route)),
          retryModel: key(event.model),
          retryRequested: false,
        });
        return true;
      }
      busy.add(id);
      try {
        const before = await ctx.session.get({ sessionID: id });
        let blockedReason: string | undefined;
        let beforeOwned: boolean | undefined;
        let beforePinned: boolean | undefined;
        let beforeLive: boolean | undefined;
        if (before.agent !== turn.agent) blockedReason = "session_agent_changed_before_fallback";
        else {
          beforeOwned = admission.owns(id, before);
          if (!beforeOwned) blockedReason = "session_admission_not_owned";
          else if (before.model && key(before.model) !== key(event.model))
            blockedReason = "session_model_changed_before_fallback";
          else {
            beforePinned = await admission.isPinned(id);
            if (beforePinned) blockedReason = "session_pinned_before_fallback";
            else {
              beforeLive = live();
              if (!beforeLive) blockedReason = "admission_no_longer_live";
            }
          }
        }
        if (blockedReason) {
          recordTrace(id, "fallback.blocked", {
            reason: blockedReason,
            sessionAgent: before.agent ?? null,
            sessionModel: before.model ? key(before.model) : null,
            beforeOwned: beforeOwned ?? null,
            beforePinned: beforePinned ?? null,
            beforeLive: beforeLive ?? null,
            retryRequested: false,
          });
          return true;
        }
        const results = await query.read(
          chain.slice(index + 1).map(({ providerID, id }) => ({ providerID, id })),
        );
        recordTrace(id, "fallback.quota_query", { candidateCount: chain.length - index - 1 });
        for (const candidate of chain.slice(index + 1))
          recordTrace(id, "fallback.candidate", {
            providerID: candidate.providerID,
            model: candidate.id,
            status: effectiveQuotaStatus(candidate, results).status,
          });
        const next = chain.slice(index + 1).find(
          (m) =>
            // Do not revisit a model, even if it occurs twice in the configured chain.
            !chain.slice(0, index + 1).some((old) => key(old) === key(m)) &&
            effectiveQuotaStatus(m, results).status !== "exhausted",
        );
        if (!next) {
          admission.reason(id, "quota_fallback_no_candidate");
          recordTrace(id, "fallback.blocked", {
            reason: "no_eligible_fallback_candidate",
            retryRequested: false,
          });
          return true;
        }
        recordTrace(id, "fallback.candidate_selected", {
          providerID: next.providerID,
          model: next.id,
          variant: next.variant ?? null,
          status: effectiveQuotaStatus(next, results).status,
        });
        admission.observe(id, next, results);
        const latest = await ctx.session.get({ sessionID: id });
        blockedReason = undefined;
        let latestLive: boolean | undefined;
        let latestOwned: boolean | undefined;
        let latestPinned: boolean | undefined;
        latestLive = live();
        if (!latestLive) blockedReason = "admission_no_longer_live_before_select";
        else if (clock() - observed.at > TTL)
          blockedReason = "quota_evidence_expired_before_select";
        else {
          latestOwned = admission.owns(id, latest);
          if (!latestOwned) blockedReason = "session_admission_lost_before_select";
          else {
            latestPinned = await admission.isPinned(id);
            if (latestPinned) blockedReason = "session_pinned_before_select";
            else if (latest.agent !== before.agent)
              blockedReason = "session_agent_changed_before_select";
            else if (
              (latest.model ? key(latest.model) : "") !== (before.model ? key(before.model) : "")
            )
              blockedReason = "session_model_changed_before_select";
            else if (!live()) blockedReason = "admission_no_longer_live_before_select";
          }
        }
        if (blockedReason) {
          recordTrace(id, "fallback.blocked", {
            reason: blockedReason,
            latestAgent: latest.agent ?? null,
            latestModel: latest.model ? key(latest.model) : null,
            latestLive: latestLive ?? null,
            latestOwned: latestOwned ?? null,
            latestPinned: latestPinned ?? null,
            retryRequested: false,
          });
          return true;
        }
        if (!(await admission.select(id, turn.agent, next, live))) {
          recordTrace(id, "fallback.blocked", {
            reason: "model_selection_not_completed",
            providerID: next.providerID,
            model: next.id,
            retryRequested: false,
          });
          return true;
        }
        turn.model = next;
        turn.switches++;
        turn.selected = true;
        const retryStillLive = live();
        admission.reason(
          id,
          retryStillLive
            ? "quota_fallback_selected_retry_requested_not_confirmed"
            : "quota_fallback_selected_retry_not_requested_control_changed",
          next,
        );
        // Never roll back: a later hook veto can leave this selection in place.
        let retryRequested = false;
        if (live()) {
          selected(id, turn.agent, next);
          event.decision = { retry: true, delay: 0 };
          retryRequested = true;
        }
        recordTrace(id, "fallback.selected", {
          providerID: next.providerID,
          model: next.id,
          variant: next.variant ?? null,
          retryRequested,
          finalRetryDecision: event.decision.retry,
          switches: turn.switches,
        });
        return true;
      } catch (error) {
        admission.reason(id, "quota_fallback_selection_failed_retry_not_requested");
        recordTrace(id, "fallback.failed", {
          reason: "selection_or_quota_query_exception",
          errorName: error instanceof Error ? error.name : typeof error,
          retryRequested: false,
        });
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
      auxiliary.clear();
      auxiliarySize = 0;
      traces.clear();
      tickets.clear();
      poisoned.clear();
      claiming.clear();
    },
  };
}
