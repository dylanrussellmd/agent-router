import type { Context } from "@opencode/plugin/promise/plugin";
import type { SessionRetry } from "@opencode/plugin/promise/session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQuotaFallback } from "../../src/quota-fallback-v2.js";
import { createQuotaAdmission } from "../../src/quota-v2.js";

type Model = { providerID: string; id: string; variant?: string | undefined };
type Kind = "primary" | "compaction" | "generate" | "title";

const primary: Model = { providerID: "fixture", id: "primary" };
const editor: Model = { providerID: "fixture", id: "editor" };
const mainAgent = "build";
const auxAgent = "code";
const routes = {
  build: {
    model: "fixture/primary",
    fallbacks: [{ model: "fixture/backup", variant: "high" }, { model: "fixture/last" }],
  },
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

async function fixture() {
  vi.spyOn(console, "info").mockImplementation(() => {});
  let session: { agent: string; model?: Model } = { agent: mainAgent };
  let current = true;
  const query = vi.fn(async (_input: unknown) => ({ candidates: [] }));
  const ctx = {
    options: { quotaFallback: { enabled: true, allowPaidFallbacks: true, maxSwitches: 8 } },
    rpc: () => ({ query }),
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {} },
    agent: { get: async () => ({ data: { model: primary } }) },
    session: {
      get: vi.fn(async () => ({ ...session })),
      switchModel: vi.fn(async ({ model }: { model: Model }) => {
        session = { agent: mainAgent, model };
        admission.event("s", "session.model.selected", model);
      }),
      context: vi.fn(async (_input: { sessionID: string }) => []),
    },
  };
  const admission = createQuotaAdmission(ctx as unknown as Context, routes, () => current);
  if (!admission) throw new Error("Fixture admission must be enabled");
  const fallback = createQuotaFallback(ctx as unknown as Context, routes, admission, () => current);
  if (!fallback) throw new Error("Fixture fallback must be enabled");
  cleanups.push(() => {
    fallback?.dispose();
    void admission?.dispose();
  });
  await admission.main("s", session);
  fallback?.admit("s", mainAgent, primary);
  function model(kind: Kind = "primary", selected: Model = primary, agent = mainAgent) {
    const event = {
      sessionID: "s",
      agent,
      model: selected,
      kind,
      baseURL: "https://fixture.test/v1",
    };
    fallback.model(event);
    return event;
  }
  function http(
    status = 429,
    kind: Kind = "primary",
    selected: Model = primary,
    agent = mainAgent,
    url = "https://fixture.test/v1/chat/completions",
  ) {
    const event = { ...model(kind, selected, agent), request: new Request(url) };
    fallback.request(event);
    const response = new Response("SECRET_BODY_MUST_NOT_BE_READ", { status });
    vi.spyOn(response, "text").mockImplementation(() => {
      throw new Error("body read");
    });
    vi.spyOn(response, "json").mockImplementation(() => {
      throw new Error("body read");
    });
    fallback.response({ ...event, response });
    return { ...event, response };
  }
  const retry = (overrides: Partial<SessionRetry> = {}): SessionRetry => ({
    sessionID: "s",
    agent: mainAgent,
    model: primary,
    attempt: 2,
    error: { type: "provider.quota", message: "SECRET_ERROR", status: 429 },
    decision: { retry: false },
    ...overrides,
  });
  return {
    ctx,
    admission,
    fallback,
    query,
    http,
    model,
    retry,
    invalidate: () => {
      current = false;
    },
  };
}

describe("auxiliary identity isolation in quota fallback", () => {
  it.each(["compaction", "generate", "title"] as const)(
    "distinct aux %s permits primary fallback across a primary response replay",
    async (kind) => {
      const f = await fixture();
      const old = f.http();
      f.http(200, kind, editor);
      f.fallback.response(old);
      expect(await f.fallback.retry(f.retry())).toBe(true);
      expect(f.ctx.session.switchModel).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["compaction", "generate", "title"] as const)(
    "distinct aux %s before the primary request permits primary fallback",
    async (kind) => {
      const f = await fixture();
      f.http(200, kind, editor);
      f.http();
      expect(await f.fallback.retry(f.retry())).toBe(true);
      expect(f.ctx.session.switchModel).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["compaction", "generate", "title"] as const)(
    "same-identity %s overlap stays blocked in either response order",
    async (kind) => {
      const f = await fixture();
      const old = f.http();
      f.http(200, kind);
      f.fallback.response(old);
      expect(await f.fallback.retry(f.retry())).toBe(false);
      expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
      // Aux before primary is equally poisoned once a fresh admit clears the tombstone.
      f.fallback.admit("s", mainAgent, primary);
      f.http(200, kind);
      f.http();
      expect(await f.fallback.retry(f.retry())).toBe(false);
      expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
    },
  );
  it("same-model/different-agent title permits the primary fallback", async () => {
    const f = await fixture();
    f.http();
    f.http(200, "title", primary, auxAgent);
    expect(await f.fallback.retry(f.retry())).toBe(true);
    expect(f.ctx.session.switchModel).toHaveBeenCalledTimes(1);
  });
  it("different-model/same-agent title permits the primary fallback", async () => {
    const f = await fixture();
    f.http();
    f.http(200, "title", editor, mainAgent);
    expect(await f.fallback.retry(f.retry())).toBe(true);
    expect(f.ctx.session.switchModel).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["agent", auxAgent as string, primary as Model],
    ["model", mainAgent as string, editor as Model],
  ] as const)(
    "an aux retry with a mismatched %s returns false and leaves primary evidence consumable once",
    async (_dimension, retryAgent, retryModel) => {
      const f = await fixture();
      f.http();
      const aux = f.retry({ agent: retryAgent, model: retryModel });
      expect(await f.fallback.retry(aux)).toBe(false);
      expect(aux.decision.retry).toBe(false);
      expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
      // The primary's single-use rejection evidence survived the aux retry.
      const event = f.retry();
      expect(await f.fallback.retry(event)).toBe(true);
      expect(event.decision.retry).toBe(true);
      expect(f.ctx.session.switchModel).toHaveBeenCalledTimes(1);
      expect(await f.fallback.retry(f.retry())).toBe(false);
      expect(f.ctx.session.switchModel).toHaveBeenCalledTimes(1);
    },
  );
  it("an aux event during a pending quota RPC does not invalidate the distinct primary generation", async () => {
    const f = await fixture();
    let release!: () => void;
    f.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ candidates: [] });
        }),
    );
    f.http();
    const event = f.retry();
    const pending = f.fallback.retry(event);
    await vi.waitFor(() => expect(release).toBeDefined());
    // Distinct auxiliary traffic while the primary switching decision is in flight.
    f.http(200, "title", editor);
    f.http(200, "generate", primary, auxAgent);
    release();
    await pending;
    expect(event.decision.retry).toBe(true);
    expect(f.ctx.session.switchModel).toHaveBeenCalledTimes(1);
  });
  it("primary HTTP 200 with an aux 429 never falls back", async () => {
    const f = await fixture();
    f.http(200);
    f.http(429, "title", editor);
    f.http(429, "generate", primary, auxAgent);
    expect(await f.fallback.retry(f.retry({ agent: auxAgent }))).toBe(false);
    expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
    expect(await f.fallback.retry(f.retry())).toBe(false);
    expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
    expect(await f.fallback.retry(f.retry())).toBe(false);
    expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
  });
  it.each(["same-identity-aux", "unsupported-primary"])(
    "rechecks ambiguity during the quota RPC: %s",
    async (cause) => {
      const f = await fixture();
      let release!: () => void;
      f.query.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ candidates: [] });
          }),
      );
      f.http();
      const event = f.retry();
      const pending = f.fallback.retry(event);
      await vi.waitFor(() => expect(release).toBeDefined());
      if (cause === "same-identity-aux") f.http(200, "title");
      else f.fallback.unsupported("s");
      release();
      await pending;
      expect(event.decision.retry).toBe(false);
      expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
    },
  );
  it("isolates a distinct auxiliary WebSocket, not a primary WebSocket", async () => {
    const f = await fixture();
    f.http();
    f.fallback.unsupported("s", { agent: "title", model: primary, kind: "title" });
    expect(await f.fallback.retry(f.retry())).toBe(true);
    expect(f.ctx.session.switchModel).toHaveBeenCalledTimes(1);
  });
  it("fails closed on auxiliary capacity exhaustion and releases entries on a new admission", async () => {
    const f = await fixture();
    for (let i = 0; i <= 1024; i++) f.model("title", { providerID: "fixture", id: `aux-${i}` });
    f.http();
    expect(await f.fallback.retry(f.retry())).toBe(false);
    expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
    f.fallback.admit("s", mainAgent, primary);
    f.http(200, "title", editor);
    f.http();
    expect(await f.fallback.retry(f.retry())).toBe(true);
    expect(f.ctx.session.switchModel).toHaveBeenCalledTimes(1);
  });
  it("conservative same-identity overlap stays blocked after expiry, and a new admit clears the tombstone", async () => {
    const f = await fixture();
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    // Aux completes first with HTTP 200; its identity outlives the observation TTL.
    f.http(200, "title");
    now += 5001;
    f.http();
    expect(await f.fallback.retry(f.retry())).toBe(false);
    expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
    // Only a new admitted generation clears the tombstone.
    f.fallback.admit("s", mainAgent, primary);
    f.http();
    expect(await f.fallback.retry(f.retry())).toBe(true);
    expect(f.ctx.session.switchModel).toHaveBeenCalledTimes(1);
  });
});
