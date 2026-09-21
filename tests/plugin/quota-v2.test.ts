import type { Context } from "@opencode/plugin/promise/plugin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PIN_STORE_KEY } from "../../src/core/pin-store.js";
import { createQuotaAdmission } from "../../src/quota-v2.js";

function fixture(allowPaidFallbacks = false) {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const stored = new Map<string, unknown>();
  let status = "exhausted";
  let current = true;
  let session: { agent: string; model?: { providerID: string; id: string; variant?: string } } = {
    agent: "build",
  };
  const query = vi.fn(async ({ candidates }) => ({
    candidates: candidates.map((c: { id: string }) => ({
      ...c,
      status: c.id === "primary" ? status : "unknown",
      checkedAt: Date.now() - 1,
      validUntil: Date.now() + 60000,
      resetAt: Date.now() + 120000,
      reason: "fixture",
      accountRef: "account",
      scopeRef: "scope",
    })),
  }));
  const ctx = {
    options: { quotaPreflight: { enabled: true, allowPaidFallbacks } },
    rpc: () => ({ query }),
    storage: {
      get: async (key: string) => stored.get(key),
      set: async (key: string, value: unknown) => {
        stored.set(key, value);
      },
      remove: async (key: string) => {
        stored.delete(key);
      },
    },
    agent: { get: async () => ({ data: { model: { providerID: "fixture", id: "primary" } } }) },
    session: {
      get: vi.fn(async () => ({ ...session })),
      switchModel: vi.fn(async ({ model }) => {
        session = { ...session, model };
        admission?.event("s", "session.model.selected", model);
      }),
    },
  };
  const admission = createQuotaAdmission(
    ctx as unknown as Context,
    {
      build: { model: "fixture/primary", fallbacks: [{ model: "fixture/backup" }] },
    },
    () => current,
  );
  if (!admission) throw new Error("Quota admission fixture must be enabled");
  return {
    ctx,
    query,
    admission,
    stored,
    main: (pending?: { providerID: string; id: string }) => admission.main("s", session, pending),
    status: (value: string) => {
      status = value;
    },
    invalidate: () => {
      current = false;
    },
    pin: (id: string) => {
      session = { agent: "build", model: { providerID: "fixture", id } };
      admission.event("s", "session.model.selected", session.model);
    },
  };
}
afterEach(() => vi.restoreAllMocks());

describe("quota admission ownership", () => {
  it("accounts for durable capacity after recreation and frees deleted pins", async () => {
    const f = fixture();
    f.stored.set(PIN_STORE_KEY, {
      version: 1,
      sessionIDs: Array.from({ length: 1024 }, (_, i) => `saved-${i}`),
    });
    await f.admission.dispose();
    const restored = createQuotaAdmission(
      f.ctx as unknown as Context,
      { build: { model: "fixture/primary", fallbacks: [{ model: "fixture/backup" }] } },
      () => true,
    );
    if (!restored) throw new Error("Missing fixture admission");
    expect(await restored.isPinned("saved-0")).toBe(true);
    await expect(restored.control("s", "pin", async () => {})).rejects.toThrow("capacity");
    expect((f.stored.get(PIN_STORE_KEY) as { sessionIDs: string[] }).sessionIDs).toHaveLength(1024);
    await restored.event("saved-0", "session.deleted");
    expect(await restored.isPinned("saved-0")).toBe(false);
    await restored.control("s", "pin", async () => {});
    const pins = (f.stored.get(PIN_STORE_KEY) as { sessionIDs: string[] }).sessionIDs;
    expect(pins).toHaveLength(1024);
    expect(pins).toContain("s");
    expect(pins).not.toContain("saved-0");
    await restored.dispose();
  });
  it("deletes a durable pin whose write was in flight without resurrection", async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    vi.spyOn(f.ctx.storage, "set").mockImplementationOnce(
      (key, value) =>
        new Promise<void>((resolve) => {
          release = () => {
            f.stored.set(key, value);
            resolve();
          };
        }),
    );
    const pin = f.admission.control("s", "pin", async () => {}).catch((error) => error);
    await vi.waitFor(() => expect(release).toBeDefined());
    const deleted = f.admission.event("s", "session.deleted");
    let drained = false;
    const disposal = f.admission.dispose().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release?.();
    expect(await pin).toBeInstanceOf(Error);
    await deleted;
    await disposal;
    expect(f.stored.get(PIN_STORE_KEY)).toEqual({ version: 1, sessionIDs: [] });
    expect(await f.admission.isPinned("s")).toBe(false);
    expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
    await f.admission.dispose();
  });
  it("claims same-session admission before a paused durable read", async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    vi.spyOn(f.ctx.storage, "get").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    const first = f.main();
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(await f.main()).toBeUndefined();
    expect(f.query).not.toHaveBeenCalled();
    release?.();
    expect((await first)?.id).toBe("backup");
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.ctx.session.switchModel).toHaveBeenCalledTimes(1);
    await f.admission.dispose();
  });
  it("pins the current automatic fallback durably and resumes only on next admission", async () => {
    const f = fixture();
    await f.main();
    const pause = vi.fn(async () => {});
    await f.admission.control("s", "pin", pause);
    expect(await f.admission.status("s")).toMatchObject({
      mode: "pinned",
      reason: "explicit_pin",
      model: { id: "backup" },
    });
    expect(f.stored.get(PIN_STORE_KEY)).toEqual({ version: 1, sessionIDs: ["s"] });
    f.status("available");
    expect(await f.main()).toBeUndefined();
    expect(f.ctx.session.switchModel).toHaveBeenCalledTimes(1);
    await f.admission.control("s", "auto", pause);
    expect(f.ctx.session.switchModel).toHaveBeenCalledTimes(1);
    expect(await f.admission.status("s")).toMatchObject({
      mode: "automatic",
      reason: "automatic_next_explicit_turn",
      model: { id: "backup" },
    });
    expect((await f.main())?.id).toBe("primary");
    expect(pause).toHaveBeenCalledTimes(2);
    f.admission.dispose();
  });
  it("freezes an unresolved native primary and restores durable pins after recreation", async () => {
    const f = fixture();
    await f.admission.control("s", "pin", async () => {});
    expect(f.ctx.session.switchModel).toHaveBeenCalledWith({
      sessionID: "s",
      model: { providerID: "fixture", id: "primary" },
    });
    f.admission.dispose();
    const restored = createQuotaAdmission(
      f.ctx as unknown as Context,
      { build: { model: "fixture/primary", fallbacks: [{ model: "fixture/backup" }] } },
      () => true,
    );
    expect(await restored?.isPinned("s")).toBe(true);
    expect(await restored?.main("s", { agent: "build" })).toBeUndefined();
    expect(f.query).not.toHaveBeenCalled();
    restored?.dispose();
  });
  it("does not switch or recreate ownership when disposed during final read or switch", async () => {
    const f = fixture();
    let resume: ((session: { agent: string }) => void) | undefined;
    f.ctx.session.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resume = resolve;
        }),
    );
    const admission = f.main();
    await vi.waitFor(() => expect(resume).toBeDefined());
    f.admission.dispose();
    resume?.({ agent: "build" });
    expect(await admission).toBeUndefined();
    expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
    const g = fixture();
    const switchModel = g.ctx.session.switchModel.getMockImplementation();
    g.ctx.session.switchModel.mockImplementationOnce(async (input) => {
      await switchModel?.(input);
      g.admission.dispose();
    });
    expect(await g.main()).toBeUndefined();
    expect(await g.admission.status("s")).toMatchObject({ mode: "pinned" });
  });
  it.each(["available", "unknown"])(
    "keeps staged reactive backup precedence with %s primary",
    async (status) => {
      const f = fixture();
      f.status(status);
      expect((await f.main({ providerID: "fixture", id: "backup" }))?.id).toBe("backup");
      expect(await f.admission.status("s")).toMatchObject({ reason: "staged_reactive_fallback" });
      f.admission.dispose();
    },
  );
  it("selects before first unresolved turn and restores primary only on a new admission", async () => {
    const f = fixture();
    expect((await f.main())?.id).toBe("backup");
    f.status("available");
    expect(f.ctx.session.switchModel).toHaveBeenCalledTimes(1);
    expect((await f.main())?.id).toBe("primary");
    expect(f.ctx.session.switchModel).toHaveBeenCalledTimes(2);
    f.admission.dispose();
  });
  it("does not override explicit primary, manual same-model pins or pins before first turn", async () => {
    const f = fixture();
    f.pin("primary");
    expect(await f.main()).toBeUndefined();
    expect(f.query).not.toHaveBeenCalled();
    const g = fixture();
    await g.main();
    g.pin("backup");
    g.status("available");
    expect(await g.main()).toBeUndefined();
    expect(g.ctx.session.switchModel).toHaveBeenCalledTimes(1);
    f.admission.dispose();
    g.admission.dispose();
  });
  it("rechecks selection and stack after asynchronous query", async () => {
    const f = fixture();
    const original = f.query.getMockImplementation();
    if (!original) throw new Error("Missing fixture query");
    f.query.mockImplementationOnce(async (input) => {
      const result = await original(input);
      f.pin("primary");
      return result;
    });
    expect(await f.main()).toBeUndefined();
    expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
    const g = fixture();
    const originalG = g.query.getMockImplementation();
    if (!originalG) throw new Error("Missing fixture query");
    g.query.mockImplementationOnce(async (input) => {
      const result = await originalG(input);
      g.invalidate();
      return result;
    });
    expect(await g.main()).toBeUndefined();
    expect(g.ctx.session.switchModel).not.toHaveBeenCalled();
    f.admission.dispose();
    g.admission.dispose();
  });
  it("routes only new unpinned native children, preserving all other input", async () => {
    const f = fixture();
    const input = { agent: "build", prompt: "child", description: "test" };
    await f.admission.child({ tool: "subagent", input });
    expect(input).toEqual({
      agent: "build",
      prompt: "child",
      description: "test",
      model: "fixture/backup",
    });
    for (const extra of [
      { model: "fixture/primary" },
      { sessionID: "resume" },
      { task_id: "resume" },
    ]) {
      const pinned = { agent: "build", ...extra };
      await f.admission.child({ tool: "subagent", input: pinned });
      expect(pinned).toEqual({ agent: "build", ...extra });
    }
    expect(f.query).toHaveBeenCalledTimes(1);
    f.admission.dispose();
  });
  it("leaves unknown unresolved primary native and tolerates missing service", async () => {
    const f = fixture();
    f.query.mockRejectedValue(new Error("missing service"));
    expect((await f.main())?.id).toBe("primary");
    expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
    f.admission.dispose();
  });
  it("checks expiry after the batch and again after the final host read", async () => {
    vi.useFakeTimers();
    try {
      for (const phase of ["batch", "host"]) {
        const f = fixture();
        const query = f.query.getMockImplementation();
        if (!query) throw new Error("Missing fixture query");
        f.query.mockImplementationOnce(async (input) => {
          const output = await query(input);
          if (phase === "batch") vi.setSystemTime(Date.now() + 60001);
          return output;
        });
        if (phase === "host")
          f.ctx.session.get.mockImplementationOnce(async () => {
            vi.setSystemTime(Date.now() + 60001);
            return { agent: "build" };
          });
        expect((await f.main())?.id).toBe("primary");
        expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
        f.admission.dispose();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
