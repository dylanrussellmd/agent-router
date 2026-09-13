import { z } from "zod";
import type { RoutingEntry } from "./schema.js";

const Model = z.object({
  providerID: z.string(),
  modelID: z.string(),
  variant: z.string().optional(),
});
const ErrorInfo = z.object({
  name: z.string(),
  data: z
    .object({ statusCode: z.number().optional(), isRetryable: z.boolean().optional() })
    .passthrough(),
});
const Event = z.object({
  type: z.string(),
  properties: z
    .object({
      sessionID: z.string().optional(),
      error: ErrorInfo.optional(),
      info: z
        .object({
          id: z.string().optional(),
          sessionID: z.string().optional(),
          role: z.string().optional(),
          parentID: z.string().optional(),
          agent: z.string().optional(),
          providerID: z.string().optional(),
          modelID: z.string().optional(),
          variant: z.string().optional(),
          error: ErrorInfo.optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
});

type Selection = z.infer<typeof Model>;
interface Turn {
  agent: string;
  parent: string;
  model: Selection;
  handled: boolean;
}
interface Session {
  disabled: boolean;
  indices: Map<string, number>;
  turn?: Turn | undefined;
  pending?: Selection | undefined;
}

function selection(entry: { model: string; variant?: string | null | undefined }): Selection {
  const slash = entry.model.indexOf("/");
  return {
    providerID: entry.model.slice(0, slash),
    modelID: entry.model.slice(slash + 1),
    variant: entry.variant ?? undefined,
  };
}
function same(a: Selection, b: Selection) {
  return a.providerID === b.providerID && a.modelID === b.modelID && a.variant === b.variant;
}

/** No network calls or disk writes: selection happens synchronously at next-turn admission. */
export function createFailover(
  routes: Record<string, RoutingEntry>,
  notice: (message: string) => Promise<void>,
) {
  const sessions = new Map<string, Session>();
  let enabled = true;
  const chains = new Map(
    Object.entries(routes).map(([agent, entry]) => {
      const chain = [entry, ...(entry.fallbacks ?? [])].map(selection);
      return [
        agent,
        chain.filter((value, i) => !chain.slice(0, i).some((previous) => same(previous, value))),
      ];
    }),
  );
  const notify = (message: string) => notice(`agent-router: ${message}`).catch(() => {});

  return {
    disable() {
      enabled = false;
      sessions.clear();
    },
    async message(
      input: { sessionID: string },
      output: {
        message: {
          id: string;
          agent: string;
          model: Selection;
        };
      },
    ) {
      if (!enabled) return;
      const message = output.message;
      const chain = chains.get(message.agent);
      if (!chain || chain.length < 2) {
        const existing = sessions.get(input.sessionID);
        if (existing) {
          existing.turn = undefined;
          existing.pending = undefined;
        }
        return;
      }
      let state = sessions.get(input.sessionID);
      if (!state) {
        // Do not evict and accidentally reset exhausted budgets in long-lived servers.
        if (sessions.size >= 1024) return;
        state = { disabled: false, indices: new Map() };
        sessions.set(input.sessionID, state);
      }
      if (state.disabled) return;
      const current = chain[state.indices.get(message.agent) ?? 0];
      const primary = chain[0];
      if (!current || !primary) return;
      const incoming = message.model;
      const previous = state.turn?.agent === message.agent ? state.turn : undefined;
      const pending = previous ? state.pending : undefined;
      // The host may still carry our previous selection while the index already points ahead.
      if (
        !same(incoming, current) &&
        !same(incoming, primary) &&
        !(pending && previous && same(incoming, previous.model))
      ) {
        state.disabled = true;
        state.pending = undefined;
        return;
      }
      state.pending = undefined;
      if (pending) message.model = { ...pending };
      else message.model = { ...current };
      // All state/mutation precedes the first await, including duplicate suppression.
      state.turn = {
        agent: message.agent,
        parent: message.id,
        model: { ...message.model },
        handled: false,
      };
      if (pending)
        await notify(
          `[${input.sessionID}] selected ${pending.providerID}/${pending.modelID} for this new turn. No previous prompt or tool was replayed.`,
        );
    },
    async event(input: { event: unknown }) {
      if (!enabled) return;
      const parsed = Event.safeParse(input.event);
      if (!parsed.success) return;
      const { type, properties: p } = parsed.data;
      const sessionID =
        p.sessionID ?? p.info?.sessionID ?? (type === "session.deleted" ? p.info?.id : undefined);
      if (!sessionID) return;
      const state = sessions.get(sessionID);
      if (!state || state.disabled) return;
      if (
        type === "session.deleted" ||
        type === "session.next.model.switched" ||
        type === "session.next.agent.switched" ||
        (type === "session.error" && p.error?.name === "MessageAbortedError")
      ) {
        state.disabled = true;
        state.pending = undefined;
        return;
      }
      // session.error lacks an attempt ID. Never fail over on that ambiguous signal.
      if (type !== "message.updated") return;
      const info = p.info;
      const turn = state.turn;
      if (
        !info ||
        !turn ||
        info.role !== "assistant" ||
        info.parentID !== turn.parent ||
        info.agent !== turn.agent ||
        info.providerID !== turn.model.providerID ||
        info.modelID !== turn.model.modelID ||
        !info.error
      )
        return;
      if (info.error.name === "MessageAbortedError") {
        state.disabled = true;
        state.pending = undefined;
        return;
      }
      if (turn.handled) return;
      turn.handled = true;
      const error = info.error;
      const status = error.data.statusCode;
      if (
        error.name !== "APIError" ||
        !error.data.isRetryable ||
        status === undefined ||
        ![429, 500, 502, 503, 504].includes(status)
      )
        return;
      const chain = chains.get(turn.agent);
      if (!chain) return;
      const index = (state.indices.get(turn.agent) ?? 0) + 1;
      const next = chain[index];
      if (!next) {
        await notify(
          `[${sessionID}] fallback chain exhausted for ${turn.agent}. Choose a model manually; no retry was sent.`,
        );
        return;
      }
      state.indices.set(turn.agent, index);
      state.pending = next;
      await notify(
        `[${sessionID}] ${turn.agent} failed (HTTP ${status}). Next user turn will use ${next.providerID}/${next.modelID}${next.variant ? ` (${next.variant})` : ""}. Send an explicit retry/continue instruction after reviewing partial output and completed tools. Nothing was retried automatically.`,
      );
    },
  };
}
