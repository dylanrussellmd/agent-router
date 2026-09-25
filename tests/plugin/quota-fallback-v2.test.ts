import type { Context } from "@opencode/plugin/promise/plugin";
import type { SessionRetry } from "@opencode/plugin/promise/session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageQuota } from "../../src/core/quota-preflight.js";
import { createQuotaFallback } from "../../src/quota-fallback-v2.js";
import { createQuotaAdmission } from "../../src/quota-v2.js";
import { ORIGINAL_REQUEST, attachOriginalRequest } from "../../src/request-provenance.js";

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
  describe("request provenance cooperation with rewriting adapters", () => {
    type FixtureShape = Awaited<ReturnType<typeof fixture>>;
    const nativeUrl = "https://fixture.test/v1/chat/completions";
    /** Layered replacements over one original; returns the outermost wrapper. */
    function chain(depth: number, root = new Request(nativeUrl)) {
      let current = root;
      for (let i = 0; i < depth; i++) {
        const wrapper = new Request(nativeUrl);
        attachOriginalRequest(wrapper, current);
        current = wrapper;
      }
      return current;
    }
    /**
     * Drive request()/response() with distinct Request identities per hook,
     * as a rewriting adapter placed before or after the router would see.
     */
    function provenance(
      f: FixtureShape,
      options: {
        native?: Request;
        request?: (native: Request) => Request;
        response?: (native: Request) => Request;
        status?: number;
      } = {},
    ) {
      const native = options.native ?? new Request(nativeUrl);
      const base = f.model();
      f.fallback.request({ ...base, request: options.request ? options.request(native) : native });
      const response = new Response("SECRET_BODY_MUST_NOT_BE_READ", {
        status: options.status ?? 429,
      });
      vi.spyOn(response, "text").mockImplementation(() => {
        throw new Error("body read");
      });
      vi.spyOn(response, "json").mockImplementation(() => {
        throw new Error("body read");
      });
      const responded = options.response ? options.response(native) : native;
      f.fallback.response({ ...base, request: responded, response });
      return { ...base, request: native, response };
    }
    it("correlates a marked replacement in both hooks (adapter before router)", async () => {
      const f = await fixture();
      provenance(f, {
        request: (native) => attachOriginalRequest(new Request(nativeUrl), native),
        response: (native) => attachOriginalRequest(new Request(nativeUrl), native),
      });
      const event = f.retry();
      expect(await f.fallback.retry(event)).toBe(true);
      expect(event.decision).toEqual({ retry: true, delay: 0 });
      expect(f.ctx.session.switchModel).toHaveBeenCalledWith({ sessionID: "s", model: backup });
    });
    it("correlates when response carries the original after the request was rewritten", async () => {
      const f = await fixture();
      provenance(f, {
        request: (native) => attachOriginalRequest(new Request(nativeUrl), native),
        response: (native) => native,
      });
      expect(await f.fallback.retry(f.retry())).toBe(true);
      expect(f.ctx.session.switchModel).toHaveBeenCalledWith({ sessionID: "s", model: backup });
    });
    it("correlates when the router saw the original and the response carries a replacement", async () => {
      const f = await fixture();
      provenance(f, {
        request: (native) => native,
        response: (native) => attachOriginalRequest(new Request(nativeUrl), native),
      });
      expect(await f.fallback.retry(f.retry())).toBe(true);
      expect(f.ctx.session.switchModel).toHaveBeenCalledWith({ sessionID: "s", model: backup });
    });
    it("validates the resolved original endpoint, never the replacement URL", async () => {
      const f = await fixture();
      // Root is a wrong endpoint even though the replacement looks native.
      provenance(f, {
        native: new Request("https://other.test/v1/chat/completions"),
        request: (native) => attachOriginalRequest(new Request(nativeUrl), native),
        response: (native) => attachOriginalRequest(new Request(nativeUrl), native),
      });
      expect(await f.fallback.retry(f.retry())).toBe(false);
      expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
    });
    it("approves a native root regardless of the adapter's gateway URL", async () => {
      const f = await fixture();
      // The adapter rewrites to a private gateway; the resolved original is native.
      provenance(f, {
        request: (native) =>
          attachOriginalRequest(new Request("https://gateway.test/v1/chat/completions"), native),
        response: (native) =>
          attachOriginalRequest(new Request("https://gateway.test/v1/chat/completions"), native),
      });
      expect(await f.fallback.retry(f.retry())).toBe(true);
      expect(f.ctx.session.switchModel).toHaveBeenCalledWith({ sessionID: "s", model: backup });
    });
    it("rejects a response marked with an unrelated original identity", async () => {
      const f = await fixture();
      const base = f.model();
      const native = new Request(nativeUrl);
      f.fallback.request({ ...base, request: native });
      // A different, never-observed original backs the response's replacement.
      const unrelated = new Request(nativeUrl);
      const replacement = attachOriginalRequest(new Request(nativeUrl), unrelated);
      const response = new Response("SECRET_BODY_MUST_NOT_BE_READ", { status: 429 });
      vi.spyOn(response, "text").mockImplementation(() => {
        throw new Error("body read");
      });
      vi.spyOn(response, "json").mockImplementation(() => {
        throw new Error("body read");
      });
      f.fallback.response({ ...base, request: replacement, response });
      expect(await f.fallback.retry(f.retry())).toBe(false);
      expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
    });
    it("rejects malformed provenance (accessor marker) without invoking it", async () => {
      const f = await fixture();
      const base = f.model();
      const replacement = new Request(nativeUrl);
      Object.defineProperty(replacement, ORIGINAL_REQUEST, {
        get: () => {
          throw new Error("getter must not run");
        },
        enumerable: false,
        configurable: false,
      });
      f.fallback.request({ ...base, request: replacement });
      provenance(f, {});
      expect(await f.fallback.retry(f.retry())).toBe(false);
      expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
    });
    it("resolves bounded chains and rejects overflow end to end", async () => {
      const f = await fixture();
      const native = new Request(nativeUrl);
      provenance(f, { native, request: () => chain(8, native) });
      expect(await f.fallback.retry(f.retry())).toBe(true);
      expect(f.ctx.session.switchModel).toHaveBeenCalledWith({ sessionID: "s", model: backup });
      // A fresh generated admission, then a chain one hop past the bound.
      f.fallback.admit("s", "build", primary);
      const overflow = chain(9);
      f.fallback.request({ ...f.model(), request: overflow });
      expect(await f.fallback.retry(f.retry())).toBe(false);
      expect(f.ctx.session.switchModel).toHaveBeenCalledTimes(1);
    });
    it("rejects malformed response provenance without invoking an accessor", async () => {
      const f = await fixture();
      const base = f.model();
      const native = new Request(nativeUrl);
      f.fallback.request({ ...base, request: native });
      const replacement = new Request(nativeUrl);
      const getter = vi.fn(() => native);
      Object.defineProperty(replacement, ORIGINAL_REQUEST, { get: getter });
      f.fallback.response({
        ...base,
        request: replacement,
        response: new Response(null, { status: 429 }),
      });
      expect(await f.fallback.retry(f.retry())).toBe(false);
      expect(getter).not.toHaveBeenCalled();
      expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
    });
  });
});

describe("bounded quota-fallback diagnostics", () => {
  it("records a successful correlated primary 429 through model switch and retry request", async () => {
    const f = await fixture();
    f.http(429);
    const event = f.retry();

    expect(await f.fallback.retry(event)).toBe(true);
    const trace = f.fallback.diagnostics("s").attempts.at(-1);
    expect(trace).toBeDefined();
    expect(trace?.events.map((item) => item.event)).toEqual(
      expect.arrayContaining([
        "turn.admitted",
        "model.request",
        "http.request",
        "http.response",
        "retry.received",
        "retry.eligible",
        "fallback.candidate_selected",
        "fallback.selected",
      ]),
    );
    expect(trace?.events.find((item) => item.event === "http.response")).toMatchObject({
      matched: true,
      status: 429,
      observedStatus: 429,
    });
    expect(trace?.events.find((item) => item.event === "fallback.selected")).toMatchObject({
      providerID: backup.providerID,
      model: backup.id,
      retryRequested: true,
      finalRetryDecision: true,
    });
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain("SECRET_BODY_MUST_NOT_BE_READ");
    expect(serialized).not.toContain("SECRET_ERROR");
  });

  it("records a missing primary HTTP response without consuming an uncorrelated fallback", async () => {
    const f = await fixture();
    f.model();

    expect(await f.fallback.retry(f.retry())).toBe(false);
    expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
    expect(
      f.fallback
        .diagnostics("s")
        .attempts.at(-1)
        ?.events.find((item) => item.event === "retry.rejected"),
    ).toMatchObject({
      reason: "http_response_not_seen",
      errorType: "provider.quota",
      errorStatus: 429,
      observedStatus: null,
    });
  });

  it("identifies an ambiguous original endpoint and retains bounded history across stop", async () => {
    const f = await fixture();
    const base = f.model();
    const request = new Request("https://other.test/v1/chat/completions");
    f.fallback.request({ ...base, request });
    f.fallback.response({ ...base, request, response: new Response(null, { status: 429 }) });
    expect(await f.fallback.retry(f.retry())).toBe(false);

    const rejected = f.fallback
      .diagnostics("s")
      .attempts.at(-1)
      ?.events.find((item) => item.event === "retry.rejected");
    expect(rejected).toMatchObject({ reason: "primary_request_observation_ambiguous" });

    for (let index = 0; index < 6; index++) {
      f.fallback.begin("s", `trace-${index}`);
      f.fallback.admissionSkipped("s", "synthetic_test", { index });
      f.fallback.stop("s");
    }
    const attempts = f.fallback.diagnostics("s").attempts;
    expect(attempts).toHaveLength(4);
    expect(attempts.map((attempt) => attempt.id)).toEqual([
      "trace-2",
      "trace-3",
      "trace-4",
      "trace-5",
    ]);
    expect(attempts[0]?.events.some((item) => item.event === "admission.skipped")).toBe(true);
  });
});
