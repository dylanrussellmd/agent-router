import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRouterPlugin } from "../../src/plugin.js";

it("deterministic provider harness continues only on explicit next turn without replay or persistent writes", async () => {
  const fixture = setup();
  try {
    writeFileSync(
      path.join(fixture.stacksDir, "fallback.json"),
      JSON.stringify({
        agents: {
          Omni: { model: "a/one", fallbacks: [{ model: "b/two", variant: "low" }] },
        },
      }),
    );
    const client = makeFakeClient();
    const installer = (await AgentRouterPlugin(fakeCtx(client))) as unknown as PluginReturn;
    const use = installer.tool.router_use;
    if (!use) throw Error("router_use missing");
    await call(use, { name: "fallback" });
    const hooks = await AgentRouterPlugin(fakeCtx(client));
    const statePath = path.join(fixture.stacksDir, "..", "state.json");
    const stateBefore = readFileSync(statePath, "utf8");
    const agentBefore = readFileSync(path.join(fixture.agentsDir, "Omni.md"), "utf8");
    const requests: string[] = [];
    const completedTools: string[] = [];
    const transcript: string[] = [];
    const send = async (id: string) => {
      const output = {
        message: {
          id,
          sessionID: "session",
          role: "user",
          agent: "Omni",
          time: { created: 1 },
          model: { providerID: "a", modelID: "one" },
        },
        parts: [],
      };
      if (!hooks["chat.message"] || !hooks.event) throw Error("failover hooks missing");
      await hooks["chat.message"](
        { sessionID: "session" },
        output as Parameters<NonNullable<(typeof hooks)["chat.message"]>>[1],
      );
      const model = output.message.model;
      requests.push(`${model.providerID}/${model.modelID}`);
      if (model.providerID === "a") {
        completedTools.push("write-file");
        transcript.push("partial output; write-file completed");
        await hooks.event({
          event: {
            type: "message.updated",
            properties: {
              info: {
                id: "assistant",
                sessionID: "session",
                parentID: id,
                role: "assistant",
                agent: "Omni",
                ...model,
                error: {
                  name: "APIError",
                  data: { statusCode: 503, isRetryable: true, message: "unavailable" },
                },
              },
            },
          },
        } as Parameters<NonNullable<typeof hooks.event>>[0]);
      } else {
        expect(transcript).toEqual(["partial output; write-file completed"]);
        transcript.push("continued by deterministic fallback provider");
      }
    };
    await send("first");
    expect(requests).toEqual(["a/one"]);
    expect(client.toasts.at(-1)?.message).toContain("Nothing was retried automatically");
    await send("explicit-continue");
    expect(requests).toEqual(["a/one", "b/two"]);
    expect(completedTools).toEqual(["write-file"]);
    expect(transcript.at(-1)).toContain("continued");
    expect(readFileSync(statePath, "utf8")).toBe(stateBefore);
    expect(readFileSync(path.join(fixture.agentsDir, "Omni.md"), "utf8")).toBe(agentBefore);
    // External CLI/TUI state changes invalidate the running plugin's routing.
    writeFileSync(statePath, `${stateBefore}\n`);
    await send("after-external-apply");
    expect(requests.at(-1)).toBe("a/one");
  } finally {
    fixture.cleanup();
  }
});

const FAKE_OPENCODE_MODELS = ["a/one", "b/two", "c/three"];

it.each([false, true])(
  "uses the installed SDK showToast shape and handles error envelopes (%s)",
  async (error) => {
    const fixture = setup();
    try {
      const base = makeFakeClient();
      const notices: string[] = [];
      const client = {
        ...base,
        tui: {
          showToast: async (input: { body: { message: string } }) => {
            notices.push(input.body.message);
            return error ? { error: "unavailable" } : { data: true };
          },
        },
      };
      const hooks = (await AgentRouterPlugin(
        fakeCtx(client as unknown as FakeClient),
      )) as unknown as PluginReturn;
      const use = hooks.tool.router_use;
      if (!use) throw Error("router_use missing");
      await call(use, { name: "cheap" });
      expect(notices).toHaveLength(1);
      if (error) expect(base.logs.at(-1)?.message).toContain("toast-fallback");
    } finally {
      fixture.cleanup();
    }
  },
);

function agentMd(model: string, name: string): string {
  return `---\ndescription: ${name} agent\nmode: subagent\nmodel: ${model}\n---\nYou are ${name}.\n`;
}

interface ToolDef {
  description: string;
  args: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    context?: unknown,
  ) => Promise<string | { output: string; metadata?: Record<string, unknown> }>;
}

interface PluginReturn {
  tool: Record<string, ToolDef>;
}

function setup(): {
  agentsDir: string;
  stacksDir: string;
  cleanup: () => void;
} {
  const routerHome = mkdtempSync(path.join(tmpdir(), "ar-plugin-"));
  const agentsDir = mkdtempSync(path.join(tmpdir(), "ar-plugin-agents-"));
  const binDir = mkdtempSync(path.join(tmpdir(), "ar-plugin-bin-"));
  const prevPath = process.env.PATH ?? "";
  const prevHome = process.env.AGENT_ROUTER_HOME;
  const prevAgents = process.env.AGENT_ROUTER_AGENTS_DIR;
  process.env.AGENT_ROUTER_HOME = routerHome;
  process.env.AGENT_ROUTER_AGENTS_DIR = agentsDir;

  // Stub `opencode` so the validator's default `execFile("opencode", ["models"])`
  // resolves deterministically in any environment, including CI.
  const stubScript = path.join(binDir, "opencode");
  writeFileSync(
    stubScript,
    `#!/usr/bin/env bash\nif [ "$1" = "api" ]; then\n  printf '%s\\n' ${FAKE_OPENCODE_MODELS.map((m) => `"${m}"`).join(" ")}\n  exit 0\nfi\nexit 0\n`,
    { mode: 0o755 },
  );
  chmodSync(stubScript, 0o755);
  process.env.PATH = `${binDir}:${prevPath}`;

  writeFileSync(path.join(agentsDir, "Omni.md"), agentMd("a/one", "Omni"));
  writeFileSync(path.join(agentsDir, "oracle.md"), agentMd("b/two", "oracle"));

  const stacksDir = path.join(routerHome, "stacks");
  mkdirSync(stacksDir, { recursive: true });
  writeFileSync(
    path.join(stacksDir, "premium.json"),
    JSON.stringify({ agents: { Omni: { model: "a/one" }, oracle: { model: "b/two" } } }),
  );
  writeFileSync(
    path.join(stacksDir, "cheap.json"),
    JSON.stringify({ agents: { Omni: { model: "c/three" }, oracle: { model: "c/three" } } }),
  );
  writeFileSync(
    path.join(routerHome, "state.json"),
    `${JSON.stringify({
      version: 1,
      active: "premium",
      previousActive: null,
      lastSwitchedAt: new Date().toISOString(),
    })}\n`,
  );
  return {
    agentsDir,
    stacksDir,
    cleanup: () => {
      if (prevHome === undefined) Reflect.deleteProperty(process.env, "AGENT_ROUTER_HOME");
      else process.env.AGENT_ROUTER_HOME = prevHome;
      if (prevAgents === undefined) Reflect.deleteProperty(process.env, "AGENT_ROUTER_AGENTS_DIR");
      else process.env.AGENT_ROUTER_AGENTS_DIR = prevAgents;
      process.env.PATH = prevPath;
      rmSync(routerHome, { recursive: true, force: true });
      rmSync(agentsDir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    },
  };
}

interface FakeClient {
  logs: Array<{ service: string; level: string; message: string }>;
  toasts: Array<{ message: string; variant: string }>;
  app: {
    log: (input: {
      body: {
        service: string;
        level: "debug" | "info" | "warn" | "error";
        message: string;
        extra?: Record<string, unknown>;
      };
    }) => Promise<void>;
  };
  tui: {
    toast: {
      show: (i: {
        body: { message: string; variant: "info" | "success" | "warning" };
      }) => Promise<void>;
    };
  };
}

function makeFakeClient(): FakeClient {
  const logs: FakeClient["logs"] = [];
  const toasts: FakeClient["toasts"] = [];
  return {
    logs,
    toasts,
    app: {
      async log(input) {
        logs.push({
          service: input.body.service,
          level: input.body.level,
          message: input.body.message,
        });
      },
    },
    tui: {
      toast: {
        async show(i) {
          toasts.push(i.body);
        },
      },
    },
  };
}

const fakeCtx = (client: FakeClient) =>
  ({
    client,
    project: { worktree: "/tmp" },
    directory: "/tmp",
    worktree: "/tmp",
    $: () => ({}),
  }) as unknown as Parameters<typeof AgentRouterPlugin>[0];

async function call(t: ToolDef, args: Record<string, unknown>): Promise<unknown> {
  const r = await t.execute(args);
  if (typeof r === "string") return JSON.parse(r);
  return JSON.parse(r.output);
}

describe("AgentRouterPlugin", () => {
  it("returns six tools and logs init message", async () => {
    const { cleanup } = setup();
    try {
      const client = makeFakeClient();
      const result = (await AgentRouterPlugin(fakeCtx(client))) as unknown as PluginReturn;
      expect(Object.keys(result.tool).sort()).toEqual([
        "router_back",
        "router_capture",
        "router_list",
        "router_status",
        "router_use",
        "router_validate",
      ]);
      expect(client.logs.find((l) => l.service === "agent-router")?.message).toBe("init");
    } finally {
      cleanup();
    }
  });

  it("router_status returns active + available + current mapping", async () => {
    const { cleanup } = setup();
    try {
      const client = makeFakeClient();
      const r = (await AgentRouterPlugin(fakeCtx(client))) as unknown as PluginReturn;
      const status = (await call(r.tool.router_status as ToolDef, {})) as {
        active: string | null;
        available: string[];
        current: Record<string, string>;
      };
      expect(status.active).toBe("premium");
      expect(status.available.sort()).toEqual(["cheap", "premium"]);
      expect(status.current).toEqual({ Omni: "a/one", oracle: "b/two" });
    } finally {
      cleanup();
    }
  });

  it("router_list reflects isActive", async () => {
    const { cleanup } = setup();
    try {
      const client = makeFakeClient();
      const r = (await AgentRouterPlugin(fakeCtx(client))) as unknown as PluginReturn;
      const list = (await call(r.tool.router_list as ToolDef, {})) as Array<{
        name: string;
        isActive: boolean;
      }>;
      expect(list.find((x) => x.name === "premium")?.isActive).toBe(true);
      expect(list.find((x) => x.name === "cheap")?.isActive).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("router_use rewrites frontmatter and fires toast", async () => {
    const { cleanup, agentsDir } = setup();
    try {
      const client = makeFakeClient();
      const r = (await AgentRouterPlugin(fakeCtx(client))) as unknown as PluginReturn;
      const out = (await call(r.tool.router_use as ToolDef, {
        name: "cheap",
        validate: false,
      })) as { previous: string; current: string; changed: string[]; restartRequired: boolean };
      expect(out.current).toBe("cheap");
      expect(out.previous).toBe("premium");
      expect(out.changed.sort()).toEqual(["Omni", "oracle"]);
      expect(out.restartRequired).toBe(true);
      expect(readFileSync(path.join(agentsDir, "Omni.md"), "utf8")).toContain("model: c/three");
      expect(client.toasts).toHaveLength(1);
      expect(client.toasts[0]?.message).toMatch(/cheap/);
    } finally {
      cleanup();
    }
  });

  it("router_use with unknown name returns structured error and no toast", async () => {
    const { cleanup } = setup();
    try {
      const client = makeFakeClient();
      const r = (await AgentRouterPlugin(fakeCtx(client))) as unknown as PluginReturn;
      const out = (await call(r.tool.router_use as ToolDef, {
        name: "ghost",
        validate: false,
      })) as { error?: string };
      expect(out.error).toBeDefined();
      expect(client.toasts).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("router_back undoes last switch and fires toast", async () => {
    const { cleanup } = setup();
    try {
      const client = makeFakeClient();
      const r = (await AgentRouterPlugin(fakeCtx(client))) as unknown as PluginReturn;
      await call(r.tool.router_use as ToolDef, { name: "cheap", validate: false });
      client.toasts.length = 0;
      const out = (await call(r.tool.router_back as ToolDef, {})) as {
        previous: string;
        current: string;
      };
      expect(out.current).toBe("premium");
      expect(client.toasts).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("router_capture snapshots current models", async () => {
    const { cleanup } = setup();
    try {
      const client = makeFakeClient();
      const r = (await AgentRouterPlugin(fakeCtx(client))) as unknown as PluginReturn;
      const out = (await call(r.tool.router_capture as ToolDef, { name: "snap" })) as {
        name: string;
        agents: number;
      };
      expect(out.name).toBe("snap");
      expect(out.agents).toBe(2);
      const list = (await call(r.tool.router_list as ToolDef, {})) as Array<{ name: string }>;
      expect(list.map((x) => x.name).sort()).toEqual(["cheap", "premium", "snap"]);
    } finally {
      cleanup();
    }
  });

  it("router_validate returns structured ok/missing for stacks and frontmatter", async () => {
    const { cleanup, stacksDir } = setup();
    try {
      writeFileSync(
        path.join(stacksDir, "broken.json"),
        JSON.stringify({ agents: { Omni: { model: "vendor-not-real/foo" } } }),
      );
      const client = makeFakeClient();
      const r = (await AgentRouterPlugin(fakeCtx(client))) as unknown as PluginReturn;
      const out = (await call(r.tool.router_validate as ToolDef, { name: "broken" })) as {
        ok?: boolean;
        missing?: Array<{ path: string; modelId: string }>;
        error?: string;
      };
      expect(out.ok === false || typeof out.error === "string").toBe(true);

      const live = (await call(r.tool.router_validate as ToolDef, { active: true })) as {
        ok?: boolean;
        checked?: number;
      };
      expect(live.ok).toBe(true);
      expect(live.checked).toBe(2);
    } finally {
      cleanup();
    }
  });
});
