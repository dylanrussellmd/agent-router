import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";
import type { RoutingEntry } from "./schema.js";

const ID = z
  .string()
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/);
const Candidate = z.object({ providerID: ID, id: ID }).strict();
const Result = Candidate.extend({
  status: z.enum(["available", "exhausted", "unknown"]),
  checkedAt: z.number().finite().nullable(),
  validUntil: z.number().finite().nullable(),
  resetAt: z.number().finite().nullable(),
  reason: z.string(),
  accountRef: z.string().nullable(),
  scopeRef: z.string().nullable(),
}).strict();
export const QuotaOutput = z.object({ candidates: z.array(Result).max(64) }).strict();

// Portable wire contract: the usage service owns credentials, bindings and caches.
export const UsageQuota = Rpc.define({
  id: "direct-api-usage",
  methods: {
    query: {
      input: z.object({ candidates: z.array(Candidate).max(64) }).strict(),
      output: QuotaOutput,
    },
  },
  events: {},
});

export const QuotaOptions = z
  .object({ enabled: z.boolean().default(false), allowPaidFallbacks: z.boolean().default(false) })
  .strict();
export type QuotaCandidate = z.infer<typeof Candidate>;
export type QuotaResult = z.infer<typeof Result>;
export type RouteSelection = { model: string; variant?: string | null | undefined };

export function quotaCandidate(entry: RouteSelection): QuotaCandidate {
  const slash = entry.model.indexOf("/");
  return { providerID: entry.model.slice(0, slash), id: entry.model.slice(slash + 1) };
}

export function effectiveQuotaStatus(
  candidate: QuotaCandidate,
  results: readonly QuotaResult[],
  now = Date.now(),
) {
  const matches = results.filter(
    (r) => r.providerID === candidate.providerID && r.id === candidate.id,
  );
  const result = matches.length === 1 ? matches[0] : undefined;
  const bound = Boolean(result?.accountRef && result.scopeRef);
  const fresh =
    bound &&
    result?.checkedAt !== null &&
    result?.checkedAt !== undefined &&
    result.checkedAt > 0 &&
    result.checkedAt <= now &&
    result.validUntil !== null &&
    result.validUntil > now &&
    (result.resetAt === null || result.resetAt > now);
  return { status: fresh ? (result?.status ?? "unknown") : "unknown", bound };
}

/** Only positive, account-scoped and unexpired evidence may exclude a route. */
export function chooseQuotaRoute(
  route: RoutingEntry,
  results: readonly QuotaResult[],
  allowPaidFallbacks: boolean,
  now = Date.now(),
  startIndex = 0,
): RouteSelection | undefined {
  for (const [index, entry] of [route, ...(route.fallbacks ?? [])].entries()) {
    if (index < startIndex) continue;
    const candidate = quotaCandidate(entry);
    const { status, bound } = effectiveQuotaStatus(candidate, results, now);
    if (status === "exhausted") continue;
    // Primary unknown stays primary. Unbound backups could incur paid usage.
    if (index === 0 || bound || allowPaidFallbacks) return entry;
  }
  return undefined;
}

type Query = (
  input: { candidates: QuotaCandidate[] },
  options: { signal: AbortSignal },
) => Promise<unknown>;

/** Hard deadline plus fixed concurrency cap, even if an RPC ignores cancellation. */
export function createQuotaQuery(query: Query, deadlineMs = 3000, capacity = 16) {
  const pending = new Set<AbortController>();
  let disposed = false;
  return {
    async read(candidates: QuotaCandidate[]): Promise<QuotaResult[]> {
      if (disposed || pending.size >= capacity) return [];
      const controller = new AbortController();
      pending.add(controller);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const request = Promise.resolve()
        .then(() => query({ candidates }, { signal: controller.signal }))
        .then((value) => {
          const parsed = QuotaOutput.safeParse(value);
          return parsed.success ? parsed.data.candidates : [];
        })
        .catch(() => [])
        .finally(() => pending.delete(controller));
      const timeout = new Promise<QuotaResult[]>((resolve) => {
        const stop = () => resolve([]);
        controller.signal.addEventListener("abort", stop, { once: true });
        timer = setTimeout(() => controller.abort(), deadlineMs);
      });
      try {
        return await Promise.race([request, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    dispose() {
      disposed = true;
      for (const controller of pending) controller.abort();
    },
  };
}
