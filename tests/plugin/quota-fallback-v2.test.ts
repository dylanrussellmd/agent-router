import type { Context } from "@opencode/plugin/promise/plugin";
import type { SessionRetry } from "@opencode/plugin/promise/session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageQuota } from "../../src/core/quota-preflight.js";
import { createQuotaFallback } from "../../src/quota-fallback-v2.js";
import { createQuotaAdmission } from "../../src/quota-v2.js";

const primary = { providerID: "fixture", id: "primary" };
const backup = { providerID: "fixture", id: "backup", variant: "high" };
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

async function fixture(options = { enabled: true, allowPaidFallbacks: true, maxSwitches: 8 }) {
  vi.spyOn(console, "info").mockImplementation(() => {});
  let session: { agent: string; model?: typeof primary & { variant?: string } } = {
    agent: "build",
  };
  let current = true;
  const query = vi.fn(async (_input: unknown) => ({ candidates: [] }));
  const ctx = {
    options: { quotaFallback: options },
    rpc: () => ({ query }),
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {} },
    agent: { get: async () => ({ data: { model: primary } }) },
    session: {
      get: vi.fn(async () => ({ ...session })),
      switchModel: vi.fn(async ({ model }) => {
        session = { agent: "build", model };
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
  fallback?.admit("s", "build", primary);
  function model(
    kind: "primary" | "compaction" | "generate" | "title" = "primary",
    selected = primary,
  ) {
    const event = {
      sessionID: "s",
      agent: "build",
      model: selected,
      kind,
      baseURL: "https://fixture.test/v1",
    };
    fallback.model(event);
    return event;
  }
  function http(
    status = 429,
    kind: "primary" | "compaction" | "generate" | "title" = "primary",
    selected = primary,
    url = "https://fixture.test/v1/chat/completions",
  ) {
    const event = { ...model(kind, selected), request: new Request(url) };
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
    agent: "build",
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
    manual: () => {
      session = { agent: "build", model: primary };
      admission.event("s", "session.model.selected", primary);
      fallback.stop("s");
    },
  };
}

describe("opt-in quota fallback", () => {
  it.each(["available", "exhausted"])(
    "uses the actual strict quota RPC input schema with a variant backup: %s",
    async (status) => {
      const f = await fixture();
      const inputSchema = UsageQuota.methods.query.input;
      expect(inputSchema.safeParse({ candidates: [backup] }).success).toBe(false);
      f.query.mockImplementationOnce(async (input) => {
        const parsed = inputSchema.parse(input);
        const now = Date.now();
        return {
          candidates: parsed.candidates.map((candidate) => ({
            ...candidate,
            status: candidate.id === "backup" ? status : "unknown",
            checkedAt: now - 1,
            validUntil: now + 60000,
            resetAt: null,
            reason: "fixture",
            accountRef: "account",
            scopeRef: "scope",
          })),
        } as never;
      });
      f.http();
      await f.fallback.retry(f.retry());
      expect(f.query).toHaveBeenCalledWith(
        {
          candidates: [
            { providerID: "fixture", id: "backup" },
            { providerID: "fixture", id: "last" },
          ],
        },
        expect.anything(),
      );
      expect(f.ctx.session.switchModel).toHaveBeenCalledWith({
        sessionID: "s",
        model: status === "exhausted" ? { providerID: "fixture", id: "last" } : backup,
      });
    },
  );
  it("retains unresolved-request ambiguity after observation expiry", async () => {
    const f = await fixture();
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const a = { ...f.model(), request: new Request("https://fixture.test/v1/chat/completions") };
    f.fallback.request(a); // A remains unresolved when B starts, even after evidence expires.
    now += 5001;
    f.http();
    const event = f.retry();
    expect(await f.fallback.retry(event)).toBe(false);
    expect(event.decision.retry).toBe(false);
    expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
    now += 5001;
    f.http();
    expect(await f.fallback.retry(f.retry())).toBe(false);
    // Only a new admitted generation clears the tombstone.
    f.fallback.admit("s", "build", primary);
    f.http();
    expect(await f.fallback.retry(f.retry())).toBe(true);
    expect(f.ctx.session.switchModel).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    "rejects a child positively bound to a different native call (ticket overflow: %s)",
    async (overflow) => {
      const f = await fixture();
      const session = { agent: "build", parentID: "parent", model: primary };
      f.ctx.session.get.mockResolvedValue(session);
      f.ctx.session.context.mockImplementation(
        async ({ sessionID }) =>
          (sessionID === "parent"
            ? [
                {
                  type: "assistant",
                  content: [
                    {
                      id: "automatic",
                      name: "subagent",
                      state: {
                        status: "running",
                        metadata: {},
                        input: { agent: "build", prompt: "Synthetic task" },
                      },
                    },
                    {
                      id: "explicit",
                      name: "subagent",
                      state: {
                        status: "running",
                        metadata: { sessionID: "child" },
                        input: {
                          agent: "build",
                          model: "fixture/primary",
                          prompt: "Synthetic task",
                        },
                      },
                    },
                  ],
                },
              ]
            : [
                {
                  id: "child-user",
                  type: "user",
                  text: "You are a subagent spawned by another session.\nSynthetic task",
                },
              ]) as never,
      );
      f.fallback.ticket("automatic", "parent", "build", "fixture/primary", "Synthetic task");
      if (overflow) {
        for (let i = 0; i < 1023; i++)
          f.fallback.ticket(`other-${i}`, `other-parent-${i}`, "build");
        f.fallback.ticket("explicit", "parent", "build", "fixture/primary");
      }
      // Without overflow the negative ticket is absent too: native metadata alone must veto.
      await f.fallback.child("child", "build", primary);
      expect(f.admission.owns("child", session)).toBe(false);
    },
  );
  it("ticket overflow alone closes child claims, including an already pending claim", async () => {
    const f = await fixture();
    const session = { agent: "build", parentID: "parent", model: primary };
    f.ctx.session.get.mockResolvedValue(session);
    let release!: () => void;
    f.ctx.session.context.mockImplementation(async ({ sessionID }) => {
      if (sessionID === "parent") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return [
          {
            type: "assistant",
            content: [
              { id: "automatic", name: "subagent", state: { status: "running", metadata: {} } },
            ],
          },
        ] as never;
      }
      return [
        {
          id: "child-user",
          type: "user",
          text: "You are a subagent spawned by another session.\nSynthetic task",
        },
      ] as never;
    });
    f.fallback.ticket("automatic", "parent", "build", "fixture/primary", "Synthetic task");
    const claim = f.fallback.child("child", "build", primary);
    await vi.waitFor(() => expect(release).toBeDefined());
    for (let i = 0; i < 1023; i++) f.fallback.ticket(`other-${i}`, `other-parent-${i}`, "build");
    f.fallback.ticket("explicit", "parent", "build", "fixture/primary");
    release();
    await claim;
    expect(f.admission.owns("child", session)).toBe(false);
    const reads = f.ctx.session.get.mock.calls.length;
    await f.fallback.child("child", "build", primary);
    expect(f.ctx.session.get).toHaveBeenCalledTimes(reads);
  });
  it("requires a separate opt-in and explicit paid approval", async () => {
    const f = await fixture({ enabled: true, allowPaidFallbacks: false, maxSwitches: 8 });
    f.http();
    const event = f.retry();
    await f.fallback.retry(event);
    expect(event.decision.retry).toBe(false);
    expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
    expect(
      createQuotaFallback({ options: {} } as Context, routes, f.admission, () => true),
    ).toBeUndefined();
  });
  it("selects the next configured variant, consumes evidence once, and reports dispatch separately", async () => {
    const f = await fixture();
    f.http();
    const event = f.retry();
    expect(await f.fallback.retry(event)).toBe(true);
    expect(event.decision).toEqual({ retry: true, delay: 0 });
    expect(f.ctx.session.switchModel).toHaveBeenCalledWith({ sessionID: "s", model: backup });
    expect((await f.admission.status("s")).reason).toContain("not_confirmed");
    expect(await f.fallback.retry(f.retry())).toBe(false);
    f.http(200, "primary", backup);
    expect((await f.admission.status("s")).reason).toBe("quota_fallback_attempt_dispatched");
  });
  it("keeps a residual selection after a later veto", async () => {
    const f = await fixture();
    f.http();
    const event = f.retry();
    await f.fallback.retry(event);
    event.decision = { retry: false };
    expect((await f.admission.status("s")).model).toEqual(backup);
    expect((await f.admission.status("s")).reason).toContain("not_confirmed");
    expect(f.ctx.session.switchModel).toHaveBeenCalledTimes(1);
  });
  it("bounds switches per admission without wrapping", async () => {
    const f = await fixture({ enabled: true, allowPaidFallbacks: true, maxSwitches: 1 });
    f.http();
    await f.fallback.retry(f.retry());
    f.http(429, "primary", backup);
    const event = f.retry({ model: backup });
    await f.fallback.retry(event);
    expect(event.decision.retry).toBe(false);
    expect(f.ctx.session.switchModel).toHaveBeenCalledTimes(1);
  });
  it.each([200, 401, 408, 500, 503])("preserves policy for HTTP %s", async (status) => {
    const f = await fixture();
    f.http(status);
    const event = f.retry({ decision: { retry: true, delay: 500 } });
    await f.fallback.retry(event);
    expect(event.decision).toEqual({ retry: true, delay: 500 });
    expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
  });
  it("requires structured quota type, matching status and variant; nonquota consumes evidence", async () => {
    const f = await fixture();
    f.http();
    const event = f.retry({
      error: { type: "provider.rate-limit", message: "quota exhausted", status: 429 },
    } as Partial<SessionRetry>);
    expect(await f.fallback.retry(event)).toBe(false);
    expect(await f.fallback.retry(f.retry())).toBe(false);
    f.http();
    expect(await f.fallback.retry(f.retry({ model: { ...primary, variant: "other" } }))).toBe(
      false,
    );
    f.http();
    expect(
      await f.fallback.retry(
        f.retry({ error: { type: "provider.quota", message: "", status: 402 } }),
      ),
    ).toBe(false);
    expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
  });
  it.each(["compaction", "generate", "title"] as const)(
    "poisons %s overlap in either response order",
    async (kind) => {
      const f = await fixture();
      const old = f.http();
      f.http(200, kind);
      f.fallback.response(old);
      expect(await f.fallback.retry(f.retry())).toBe(false);
      f.fallback.admit("s", "build", primary);
      f.http(200, kind);
      f.http();
      expect(await f.fallback.retry(f.retry())).toBe(false);
      expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
    },
  );
  it("never resurrects old evidence after a newer successful request", async () => {
    const f = await fixture();
    const old = f.http();
    f.http(200);
    f.fallback.response(old);
    expect(await f.fallback.retry(f.retry())).toBe(false);
    expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
  });
  it("rejects request identity replacement and overlapping primary requests", async () => {
    const f = await fixture();
    const old = f.http();
    f.fallback.response({ ...old, request: new Request(old.request.url) });
    expect(await f.fallback.retry(f.retry())).toBe(false);
    const a = { ...f.model(), request: new Request("https://fixture.test/v1/chat/completions") };
    f.fallback.request(a);
    f.http();
    expect(await f.fallback.retry(f.retry())).toBe(false);
  });
  it.each([
    "https://other.test/v1/chat/completions",
    "https://fixture.test/v1/chat/completions?secret=sentinel",
    "https://fixture.test/unknown",
  ])("rejects unapproved endpoint %s", async (url) => {
    const f = await fixture();
    f.http(429, "primary", primary, url);
    expect(await f.fallback.retry(f.retry())).toBe(false);
  });
  it("expires observations on a monotonic clock and does not read or log secrets", async () => {
    const f = await fixture();
    const start = performance.now();
    f.http();
    vi.spyOn(performance, "now").mockReturnValue(start + 5001);
    expect(await f.fallback.retry(f.retry())).toBe(false);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain("SECRET");
  });
  it.each(["manual", "cancel", "config", "new-request", "pin"])(
    "rechecks %s during the quota await",
    async (action) => {
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
      if (action === "manual") f.manual();
      if (action === "cancel") f.fallback.stop("s");
      if (action === "config") f.invalidate();
      if (action === "new-request") f.http(200);
      if (action === "pin") await f.admission.control("s", "pin", async () => f.fallback.stop("s"));
      const before = f.ctx.session.switchModel.mock.calls.length;
      release();
      await pending;
      expect(f.ctx.session.switchModel).toHaveBeenCalledTimes(before);
      expect(event.decision.retry).toBe(false);
    },
  );
  it("skips only fresh confirmed exhausted backups, unknown service permits fallback", async () => {
    const f = await fixture();
    f.query.mockResolvedValueOnce({
      candidates: [{ ...backup, variant: undefined, status: "exhausted" }],
    } as never);
    // Invalid service data is unknown, never a reason to prohibit the configured backup.
    f.http();
    await f.fallback.retry(f.retry());
    expect(f.ctx.session.switchModel).toHaveBeenCalledWith({ sessionID: "s", model: backup });
  });
  it("skips a confirmed exhausted backup and stops at the end of the chain", async () => {
    const f = await fixture();
    const now = Date.now();
    f.query.mockResolvedValueOnce({
      candidates: [
        {
          providerID: "fixture",
          id: "backup",
          status: "exhausted",
          checkedAt: now - 1,
          validUntil: now + 60000,
          resetAt: null,
          reason: "test",
          accountRef: "account",
          scopeRef: "scope",
        },
      ],
    } as never);
    f.http();
    await f.fallback.retry(f.retry());
    const last = { providerID: "fixture", id: "last" };
    expect(f.ctx.session.switchModel).toHaveBeenCalledWith({ sessionID: "s", model: last });
    f.http(429, "primary", last);
    const event = f.retry({ model: last });
    await f.fallback.retry(event);
    expect(event.decision.retry).toBe(false);
    expect(f.ctx.session.switchModel).toHaveBeenCalledTimes(1);
  });
  it("starts after the staged reactive selection rather than jumping back to primary", async () => {
    const f = await fixture();
    const selected = await f.admission.main("s", await f.ctx.session.get(), backup);
    expect(selected).toEqual(backup);
    f.fallback.admit("s", "build", backup);
    f.http(429, "primary", backup);
    await f.fallback.retry(f.retry({ model: backup }));
    expect(f.ctx.session.switchModel).toHaveBeenLastCalledWith({
      sessionID: "s",
      model: { providerID: "fixture", id: "last" },
    });
  });
  it("does not route WebSocket or unobserved errors", async () => {
    const f = await fixture();
    expect(await f.fallback.retry(f.retry())).toBe(false);
    f.http();
    f.fallback.unsupported("s");
    expect(await f.fallback.retry(f.retry())).toBe(false);
  });
  it("respects a native agent change before its event is delivered", async () => {
    const f = await fixture();
    f.http();
    f.ctx.session.get.mockResolvedValue({ agent: "manual-agent" });
    await f.fallback.retry(f.retry());
    expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
  });
  it.each(["automatic", "explicit", "resumed", "ambiguous"])(
    "requires positive child admission provenance: %s",
    async (mode) => {
      const f = await fixture();
      const session = { agent: "build", parentID: "parent", model: primary };
      f.ctx.session.get.mockResolvedValue(session);
      f.ctx.session.context.mockImplementation(
        async ({ sessionID }: { sessionID: string }) =>
          (sessionID === "parent"
            ? [
                {
                  type: "assistant",
                  content: [
                    { id: "call", name: "subagent", state: { status: "running", metadata: {} } },
                  ],
                },
              ]
            : [
                {
                  id: "child-user",
                  type: "user",
                  text: "You are a subagent spawned by another session.\nSynthetic task",
                },
              ]) as never,
      );
      f.fallback.ticket(
        "call",
        "parent",
        "build",
        "fixture/primary",
        mode === "automatic" || mode === "ambiguous" ? "Synthetic task" : undefined,
      );
      if (mode === "ambiguous")
        f.fallback.ticket("other-call", "parent", "build", "fixture/primary");
      await f.fallback.child("child", "build", primary);
      expect(f.admission.owns("child", session)).toBe(mode === "automatic");
    },
  );
});
