import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateStack } from "../../src/core/validator.js";
import plugin from "../../src/plugin.js";

interface TestTool {
  name: string;
  input: { required?: string[] };
  execute(input: unknown): Promise<{ content: string }>;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function fixture(defaultVariant = false, routingControls = false) {
  const root = mkdtempSync(path.join(tmpdir(), "ar-v2-"));
  const agents = path.join(root, "agents");
  mkdirSync(agents);
  mkdirSync(path.join(root, "stacks"));
  const agentPath = path.join(agents, "build.md");
  writeFileSync(
    agentPath,
    `---\nmodel: headroom/deepseek${defaultVariant ? "" : "#high"}\npermissions: []\n---\nUser-owned prompt\n`,
  );
  const statePath = path.join(root, "state.json");
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      active: "test",
      previousActive: null,
      lastSwitchedAt: "now",
      fallbackAgents: {
        build: {
          model: "headroom/deepseek",
          ...(defaultVariant ? {} : { variant: "high" }),
          fallbacks: [{ model: "headroom/kimi", ...(defaultVariant ? {} : { variant: "high" }) }],
        },
      },
    }),
  );
  vi.stubEnv("AGENT_ROUTER_HOME", root);
  vi.stubEnv("AGENT_ROUTER_AGENTS_DIR", agents);
  vi.stubEnv("AGENT_ROUTER_STACKS_DIR", path.join(root, "stacks"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const hooks: Record<string, (event: unknown) => Promise<void>> = {};
  const tools: Record<string, TestTool> = {};
  const rpcMethods: Record<
    string,
    (input: unknown, context: { signal?: AbortSignal }) => Promise<unknown>
  > = {};
  const storage = new Map<string, unknown>();
  let session = {
    projectID: "project",
    location: { directory: root },
    agent: "build",
    model: { providerID: "headroom", id: "deepseek", variant: defaultVariant ? "default" : "high" },
  };
  const switchModel = vi.fn(async ({ model }) => {
    session = { ...session, model };
  });
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  const ctx = {
    location: { directory: root, project: { id: "project" } },
    options: routingControls ? { quotaFallback: { enabled: true, allowPaidFallbacks: true } } : {},
    storage: {
      get: vi.fn(async (key: string) => storage.get(key)),
      set: vi.fn(async (key: string, value: unknown) => storage.set(key, value)),
    },
    rpc: {
      register: vi.fn(async (_definition: unknown, methods: typeof rpcMethods) => {
        Object.assign(rpcMethods, methods);
        return { dispose: vi.fn() };
      }),
    },
    model: {
      list: async () => ({
        location: { directory: root },
        data: ["deepseek", "kimi"].map((id) => ({
          id,
          providerID: "headroom",
          variants: [{ id: "high" }],
        })),
      }),
    },
    tool: {
      transform: async (edit: (editor: { add(tool: TestTool): void }) => void) =>
        edit({
          add: (tool: TestTool) => {
            tools[tool.name] = tool;
          },
        }),
      hook: vi.fn(async () => {}),
    },
    event: {
      async *subscribe({ signal }: { signal: AbortSignal }) {
        signal.addEventListener("abort", () => wake?.(), { once: true });
        while (!signal.aborted) {
          if (!queue.length)
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          while (queue.length) yield queue.shift();
        }
      },
    },
    session: {
      hook: async (name: string, hook: (event: unknown) => Promise<void>) => {
        hooks[name] = hook;
      },
      get: vi.fn(async () => session),
      switchModel,
      prompt: vi.fn(),
      synthetic: vi.fn(),
      command: vi.fn(),
    },
  };
  const cleanup = await plugin.setup(ctx as unknown as Context);
  const prompt = async (messageID: string) =>
    hooks.prompt?.({ sessionID: "s", messageID, prompt: { text: "explicit user instruction" } });
  const failure = async (status: number, retry = true, kind = "primary") => {
    await hooks["model.request"]?.({ sessionID: "s", kind });
    const event = {
      sessionID: "s",
      agent: "build",
      model: session.model,
      error: { type: "provider.failure", status, message: "failure" },
      decision: { retry, delay: 0 },
    };
    await hooks.retry?.(event);
    return event;
  };
  return {
    root,
    tools,
    rpcMethods,
    session,
    ctx,
    switchModel,
    prompt,
    failure,
    statePath,
    agentPath,
    emit: async (type: string, data: Record<string, unknown> = {}) => {
      queue.push({ type, data: { sessionID: "s", ...data } });
      wake?.();
      await new Promise((resolve) => setImmediate(resolve));
    },
    cleanup: async () => {
      await cleanup?.();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("OpenCode 2.x adapter (minimum 2.0.8)", () => {
  it("exposes location-scoped TUI controls without prompting or switching models", async () => {
    const f = await fixture(false, true);
    try {
      const status = await f.rpcMethods.status({ sessionID: "ses_test" }, {});
      expect(status).toMatchObject({ mode: "pinned", reason: "manual_or_preexisting_selection" });

      const automatic = await f.rpcMethods.control({ sessionID: "ses_test", action: "auto" }, {});
      expect(automatic).toMatchObject({
        mode: "automatic",
        reason: "automatic_next_explicit_turn",
      });

      const pinned = await f.rpcMethods.control({ sessionID: "ses_test", action: "pin" }, {});
      expect(pinned).toMatchObject({ mode: "pinned", reason: "explicit_pin" });
      expect(f.switchModel).not.toHaveBeenCalled();
      expect(f.ctx.session.prompt).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });

  it("rejects TUI routing controls for a session outside the serving location", async () => {
    const f = await fixture(false, true);
    try {
      f.session.location.directory = "/foreign";
      const result = await f.rpcMethods.control({ sessionID: "ses_foreign", action: "pin" }, {});
      expect(result).toBeNull();
      expect(f.ctx.storage.set).not.toHaveBeenCalled();
      expect(f.switchModel).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });

  it("normalizes the real host's default variant and recognizes its own selection event", async () => {
    const f = await fixture(true);
    try {
      await f.prompt("first");
      expect((await f.failure(429)).decision.retry).toBe(false);
      await f.prompt("next");
      expect(f.switchModel).toHaveBeenCalledExactlyOnceWith({
        sessionID: "s",
        model: { providerID: "headroom", id: "kimi" },
      });
      await f.emit("session.model.selected", {
        model: { providerID: "headroom", id: "kimi", variant: "default" },
      });
      expect((await f.failure(503)).decision.retry).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  it.each([
    "session.execution.interrupted",
    "session.agent.selected",
    "session.model.selected",
    "session.deleted",
  ])("discards pending fallback on %s", async (type) => {
    const f = await fixture();
    try {
      const before = readFileSync(f.agentPath, "utf8");
      await f.prompt("first");
      await f.failure(429);
      await f.emit(type, { model: { providerID: "headroom", id: "manual" } });
      await f.prompt("next");
      expect(f.switchModel).not.toHaveBeenCalled();
      expect(readFileSync(f.agentPath, "utf8")).toBe(before);
    } finally {
      await f.cleanup();
    }
  });

  it("does not overwrite a model selection racing next-turn admission", async () => {
    const f = await fixture();
    try {
      await f.prompt("first");
      await f.failure(429);
      const original = await f.ctx.session.get();
      f.ctx.session.get.mockResolvedValueOnce(original).mockResolvedValueOnce({
        ...original,
        model: { providerID: "headroom", id: "manual", variant: "high" },
      });
      await f.prompt("next");
      expect(f.switchModel).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });

  it.each([429, 500, 502, 503, 504])(
    "defers HTTP %s fallback until a new user turn and never replays",
    async (status) => {
      const f = await fixture();
      try {
        const before = readFileSync(f.agentPath, "utf8");
        await f.prompt("first");
        expect((await f.failure(status)).decision.retry).toBe(false);
        expect(f.switchModel).not.toHaveBeenCalled();
        await f.prompt("first");
        expect(f.switchModel).not.toHaveBeenCalled();
        await f.prompt("next");
        expect(f.switchModel).toHaveBeenCalledExactlyOnceWith({
          sessionID: "s",
          model: { providerID: "headroom", id: "kimi", variant: "high" },
        });
        for (const method of [f.ctx.session.prompt, f.ctx.session.synthetic, f.ctx.session.command])
          expect(method).not.toHaveBeenCalled();
        expect(readFileSync(f.agentPath, "utf8")).toBe(before);
      } finally {
        await f.cleanup();
      }
    },
  );

  it.each([
    [401, true, "primary"],
    [429, false, "primary"],
    [503, true, "compaction"],
  ] as const)("ignores noneligible failures %s/%s/%s", async (status, retry, kind) => {
    const f = await fixture();
    try {
      await f.prompt("first");
      expect((await f.failure(status, retry, kind)).decision.retry).toBe(retry);
      await f.prompt("next");
      expect(f.switchModel).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });

  it("registers six JSON-schema tools and invalidates routing on external stack changes", async () => {
    const f = await fixture();
    try {
      expect(Object.keys(f.tools).sort()).toEqual([
        "router_back",
        "router_capture",
        "router_list",
        "router_status",
        "router_use",
        "router_validate",
      ]);
      expect(f.tools.router_use.input.required).toContain("name");
      const status = JSON.parse((await f.tools.router_status.execute({})).content);
      expect(status.active).toBe("test");
      await f.prompt("first");
      await f.failure(429);
      writeFileSync(f.statePath, `${readFileSync(f.statePath, "utf8")}\n`);
      await f.prompt("next");
      expect(f.switchModel).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });
});

it("validates primary and fallback variants against V2 catalogs", async () => {
  const runOpencodeModels = async () =>
    JSON.stringify({
      location: { directory: "/test" },
      data: ["deepseek", "kimi"].map((id) => ({
        providerID: "headroom",
        id,
        variants: [{ id: "high" }],
      })),
    });
  const stack = {
    agents: {
      build: {
        model: "headroom/deepseek",
        variant: "max",
        fallbacks: [{ model: "headroom/kimi", variant: "max" }],
      },
    },
  };
  const invalid = await validateStack(stack, { runOpencodeModels });
  expect(invalid.missing.map((entry) => entry.path)).toEqual([
    "agents.build.variant",
    "agents.build.fallbacks.0.variant",
  ]);
  stack.agents.build.variant = "high";
  stack.agents.build.fallbacks = [{ model: "headroom/kimi", variant: "high" }];
  expect((await validateStack(stack, { runOpencodeModels })).ok).toBe(true);
});
