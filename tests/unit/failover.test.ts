import { describe, expect, it } from "vitest";
import { createFailover } from "../../src/core/failover.js";

function harness(notice?: (message: string) => Promise<void>) {
  const notices: string[] = [];
  const router = createFailover(
    {
      worker: {
        model: "a/one",
        fallbacks: [{ model: "a/one" }, { model: "b/two", variant: "low" }, { model: "c/three" }],
      },
      other: { model: "a/one", fallbacks: [{ model: "c/three" }] },
    },
    notice ??
      (async (message) => {
        notices.push(message);
      }),
  );
  let id = 0;
  async function turn(
    sessionID = "s",
    model = { providerID: "a", modelID: "one" },
    agent = "worker",
  ) {
    const output = {
      message: { id: `u${++id}`, agent, model },
      parts: [{ type: "text", text: "Explicit continue" }],
    };
    await router.message({ sessionID }, output);
    return output;
  }
  function failure(
    parentID: string,
    model = { providerID: "a", modelID: "one" },
    error: unknown = { name: "APIError", data: { statusCode: 503, isRetryable: true } },
    sessionID = "s",
    agent = "worker",
  ) {
    return router.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: `assistant-${parentID}`,
            sessionID,
            parentID,
            role: "assistant",
            agent,
            ...model,
            error,
          },
        },
      },
    });
  }
  return { router, turn, failure, notices };
}

describe("next-turn failover harness", () => {
  it("advances through the chain when each turn carries the last router-selected model", async () => {
    const h = harness();
    const first = await h.turn();
    await h.failure(first.message.id, first.message.model);
    const second = await h.turn("s", first.message.model);
    expect(second.message.model).toEqual({ providerID: "b", modelID: "two", variant: "low" });
    await h.failure(second.message.id, second.message.model);
    const third = await h.turn("s", second.message.model);
    expect(third.message.model).toEqual({ providerID: "c", modelID: "three", variant: undefined });
    expect((await h.turn("s", third.message.model)).message.model).toEqual(third.message.model);
  });

  it.each([
    { providerID: "manual", modelID: "choice" },
    { providerID: "b", modelID: "two", variant: "manual" },
  ])("preserves genuine overrides during a fallback-to-fallback advance: %j", async (model) => {
    const h = harness();
    const first = await h.turn();
    await h.failure(first.message.id, first.message.model);
    const second = await h.turn("s", first.message.model);
    await h.failure(second.message.id, second.message.model);
    expect((await h.turn("s", model)).message.model).toEqual(model);
    expect((await h.turn()).message.model.modelID).toBe("one");
  });

  it("does not allow the previous fallback after its pending transition is consumed", async () => {
    const h = harness();
    const first = await h.turn();
    await h.failure(first.message.id, first.message.model);
    const second = await h.turn("s", first.message.model);
    await h.failure(second.message.id, second.message.model);
    const third = await h.turn("s", second.message.model);
    expect(third.message.model.modelID).toBe("three");
    expect((await h.turn("s", second.message.model)).message.model).toEqual(second.message.model);
    expect((await h.turn()).message.model.modelID).toBe("one");
  });

  it("retains a tombstone for real session.deleted payloads", async () => {
    const h = harness();
    const first = await h.turn();
    await h.failure(first.message.id);
    await h.router.event({
      event: { type: "session.deleted", properties: { info: { id: "s", title: "deleted" } } },
    });
    expect((await h.turn()).message.model.modelID).toBe("one");
  });

  it("stops admitting new sessions at the fixed memory bound", async () => {
    const h = harness();
    for (let i = 0; i < 1024; i++) await h.turn(`session-${i}`);
    const untracked = await h.turn("over-limit");
    await h.failure(untracked.message.id, untracked.message.model, undefined, "over-limit");
    expect(h.notices).toEqual([]);
    expect((await h.turn("over-limit")).message.model.modelID).toBe("one");
  });

  it("preserves explicit variant overrides on the same model", async () => {
    const h = harness();
    const first = await h.turn();
    await h.failure(first.message.id);
    const manualModel = { providerID: "a", modelID: "one", variant: "manual" };
    expect((await h.turn("s", manualModel)).message.model).toEqual(manualModel);
  });

  it("treats the same model with a different variant as a distinct candidate", async () => {
    const router = createFailover(
      {
        worker: {
          model: "a/one",
          variant: "high",
          fallbacks: [{ model: "a/one", variant: "low" }],
        },
      },
      async () => {},
    );
    const message = {
      id: "user",
      agent: "worker",
      model: { providerID: "a", modelID: "one", variant: "high" },
    };
    await router.message({ sessionID: "s" }, { message });
    await router.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "assistant",
            sessionID: "s",
            parentID: "user",
            agent: "worker",
            role: "assistant",
            providerID: "a",
            modelID: "one",
            variant: "high",
            error: { name: "APIError", data: { statusCode: 429, isRetryable: true } },
          },
        },
      },
    });
    const next = { ...message, id: "next" };
    await router.message({ sessionID: "s" }, { message: next });
    expect(next.model.variant).toBe("low");
  });

  it("ignores malformed and uncorrelated event payloads", async () => {
    const h = harness();
    await h.turn();
    for (const event of [null, {}, { type: "session.error", properties: {} }])
      await h.router.event({ event });
    expect(h.notices).toEqual([]);
  });
  it("uses ordered unique candidates on explicit turns, keeps tools/text intact, and exhausts", async () => {
    const h = harness();
    const first = await h.turn();
    const completedTools = ["write-file:completed"];
    await Promise.all([h.failure(first.message.id), h.failure(first.message.id)]);
    expect(h.notices).toHaveLength(1);
    expect(first.message.model).toEqual({ providerID: "a", modelID: "one", variant: undefined });
    const second = await h.turn();
    expect(second.message.model).toEqual({ providerID: "b", modelID: "two", variant: "low" });
    expect(second.parts).toEqual(first.parts);
    expect(completedTools).toEqual(["write-file:completed"]);
    await h.failure(second.message.id, second.message.model);
    const third = await h.turn();
    expect(third.message.model).toEqual({ providerID: "c", modelID: "three", variant: undefined });
    await h.failure(third.message.id, third.message.model);
    expect(h.notices.at(-1)).toContain("exhausted");
    expect((await h.turn()).message.model).toEqual(third.message.model);
    expect((await h.turn("isolated")).message.model.modelID).toBe("one");
  });

  it.each([
    { name: "ProviderAuthError", data: {} },
    { name: "UnknownError", data: { message: "timeout" } },
    { name: "ContextOverflowError", data: {} },
    { name: "ContentFilterError", data: {} },
    { name: "APIError", data: { statusCode: 401, isRetryable: true } },
    { name: "APIError", data: { statusCode: 400, isRetryable: true } },
    { name: "APIError", data: { isRetryable: true } },
    { name: "APIError", data: { statusCode: 503, isRetryable: false } },
  ])("does not classify permanent/ambiguous errors: %j", async (error) => {
    const h = harness();
    const first = await h.turn();
    await h.failure(first.message.id, first.message.model, error);
    expect((await h.turn()).message.model.modelID).toBe("one");
    expect(h.notices).toEqual([]);
  });

  it("ignores stale errors, ambiguous session errors, and untracked sessions", async () => {
    const h = harness();
    const old = await h.turn();
    await h.turn();
    await h.failure(old.message.id);
    await h.failure("unknown", undefined, undefined, "other-session");
    await h.router.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "s",
          error: { name: "APIError", data: { statusCode: 503, isRetryable: true } },
        },
      },
    });
    expect(h.notices).toEqual([]);
  });

  it.each([
    "session.next.model.switched",
    "session.next.agent.switched",
    "session.deleted",
    "session.error",
  ])("cancels staged switching on %s", async (type) => {
    const h = harness();
    const first = await h.turn();
    await h.failure(first.message.id);
    await h.router.event({
      event: {
        type,
        properties: { sessionID: "s", error: { name: "MessageAbortedError", data: {} } },
      },
    });
    expect((await h.turn()).message.model.modelID).toBe("one");
  });

  it("preserves manual model/variant overrides and disables future automatic selection", async () => {
    const h = harness();
    const first = await h.turn();
    await h.failure(first.message.id);
    const manual = await h.turn("s", { providerID: "manual", modelID: "choice" });
    expect(manual.message.model.modelID).toBe("choice");
    expect((await h.turn()).message.model.modelID).toBe("one");
  });

  it("cancellation wins while notice delivery is blocked", async () => {
    let release = () => {};
    const h = harness(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = await h.turn();
    const pending = h.failure(first.message.id);
    await h.failure(first.message.id, first.message.model, {
      name: "MessageAbortedError",
      data: {},
    });
    release();
    await pending;
    expect((await h.turn()).message.model.modelID).toBe("one");
  });

  it("keeps per-agent budgets separate and clears pending on an unrelated agent turn", async () => {
    const h = harness();
    const first = await h.turn();
    await h.failure(first.message.id);
    const other = await h.turn("s", undefined, "other");
    expect(other.message.model.modelID).toBe("one");
    await h.failure(other.message.id, other.message.model, undefined, "s", "other");
    expect((await h.turn("s", undefined, "other")).message.model.modelID).toBe("three");
    expect((await h.turn("s", undefined, "unconfigured")).message.model.modelID).toBe("one");
  });

  it("disable and notice failures cannot cause replay or throw", async () => {
    const h = harness(async () => {
      throw Error("UI unavailable");
    });
    const first = await h.turn();
    await h.failure(first.message.id);
    h.router.disable();
    expect((await h.turn()).message.model.modelID).toBe("one");
  });
});
