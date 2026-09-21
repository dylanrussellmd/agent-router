import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Context } from "@opencode/plugin/tui/context";
import { expect, it, vi } from "vitest";
import plugin from "../../src/tui/index.js";

vi.mock("@opentui/solid", () => ({
  createElement: (tag: string) => ({ tag, children: [] }),
  insert: (node: { children: unknown[] }, child: unknown) => node.children.push(child),
  setProp: (node: Record<string, unknown>, key: string, value: unknown) => {
    node[key] = value;
  },
}));

it("registers the V2 sidebar, slash commands, selection dialogs and cleanup", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ar-tui-v2-"));
  mkdirSync(path.join(root, "agents"));
  mkdirSync(path.join(root, "stacks"));
  writeFileSync(path.join(root, "agents", "build.md"), "---\nmodel: test/model\n---\nPrompt\n");
  writeFileSync(
    path.join(root, "stacks", "sample.json"),
    JSON.stringify({
      agents: { build: { model: "test/model", fallbacks: [{ model: "test/backup" }] } },
    }),
  );
  writeFileSync(
    path.join(root, "state.json"),
    JSON.stringify({
      version: 1,
      active: "sample",
      previousActive: null,
      lastSwitchedAt: new Date().toISOString(),
    }),
  );
  vi.stubEnv("AGENT_ROUTER_HOME", root);
  vi.stubEnv("AGENT_ROUTER_AGENTS_DIR", path.join(root, "agents"));
  vi.stubEnv("AGENT_ROUTER_STACKS_DIR", path.join(root, "stacks"));
  let commands: Array<{ id: string; slash: { name: string }; run(): void }> = [];
  const unregister = vi.fn();
  const claims: Array<{ append: string; render(input?: { sessionID: string }): unknown }> = [];
  const slot = vi.fn((claim: (typeof claims)[number]) => {
    claims.push(claim);
    return unregister;
  });
  let mounted = false;
  const select = vi.fn(async () => undefined);
  const toast = vi.fn();
  const revision = { value: 0 };
  let session = { agent: "build", model: { providerID: "test", id: "backup", variant: "default" } };
  const theme = {
    text: {
      default: "BASE",
      subdued: "MUTED",
      feedback: {
        success: { default: "SUCCESS" },
        warning: { default: "WARNING" },
      },
    },
  };
  const ctx = {
    theme,
    storage: {
      memory: () => [revision, (update: (draft: typeof revision) => void) => update(revision)],
    },
    renderer: { requestRender: vi.fn() },
    data: {
      session: { get: vi.fn(() => session) },
      location: { model: { list: () => [{ providerID: "test", id: "model" }] } },
    },
    ui: { slot, toast: { show: toast }, dialog: { select, confirm: vi.fn(), clear: vi.fn() } },
    keymap: {
      layer: (build: () => { commands: typeof commands }) => {
        if (!mounted) throw new Error("Keymap.Provider is missing");
        commands = build().commands;
      },
    },
  };
  try {
    const cleanup = await plugin.setup(ctx as unknown as Context);
    try {
      expect(slot).toHaveBeenCalledWith(expect.objectContaining({ append: "sidebar.content" }));
      expect(commands).toEqual([]);
      mounted = true;
      expect(claims.find((claim) => claim.append === "app")?.render()).toBeNull();
      expect(
        claims
          .find((claim) => claim.append === "sidebar.content")
          ?.render({ sessionID: "session" }),
      ).toEqual(expect.objectContaining({ tag: "box" }));
      type Node = {
        tag: string;
        children: Array<Node | string | (() => Node)>;
        fg?: string;
        wrapMode?: string;
      };
      const rootNode = claims
        .find((claim) => claim.append === "sidebar.content")
        ?.render({ sessionID: "session" }) as Node;
      const render = rootNode.children[0] as () => Node;
      const texts = (node: Node): Node[] =>
        node.tag === "text"
          ? [node]
          : node.children.flatMap((child) => (typeof child === "object" ? texts(child) : []));
      const rows = () => texts(render());
      expect(rows().find((n) => n.children[0] === "Agent Stacks")?.fg).toBe("BASE");
      expect(rows().find((n) => n.children[0] === "● test/backup")?.fg).toBe("SUCCESS");
      expect(
        rows()
          .filter((n) => String(n.children[0]).includes("test/"))
          .map((n) => n.children[0]),
      ).toEqual(["  test/model", "● test/backup"]);
      session = {
        agent: "build",
        model: { providerID: "external", id: "override", variant: "high" },
      };
      expect(rows().find((n) => n.children[0] === "● Current · external/override [high]")?.fg).toBe(
        "SUCCESS",
      );
      session = { agent: "build", model: { providerID: "test", id: "model", variant: "default" } };
      expect(rows().find((n) => n.children[0] === "● test/model")?.fg).toBe("SUCCESS");
      theme.text.feedback.success.default = "NEW_SUCCESS";
      expect(rows().find((n) => n.children[0] === "● test/model")?.fg).toBe("NEW_SUCCESS");
      expect(rows().some((n) => String(n.children[0]).includes("[default]"))).toBe(false);
      session = { ...session, agent: "explorer" };
      expect(rows().find((n) => n.children[0] === "  test/model")?.fg).toBe("MUTED");
      expect(ctx.data.session.get).toHaveBeenCalledWith("session");
      expect(commands.map((command) => command.slash.name)).toEqual([
        "agent-status",
        "agent-switch",
        "agent-view",
        "agent-edit",
        "agent-back",
        "agent-validate",
      ]);
      commands.find((command) => command.id === "agent-router.status")?.run();
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("sample") }),
      );
      commands.find((command) => command.id === "agent-router.view")?.run();
      await vi.waitFor(() =>
        expect(select).toHaveBeenCalledWith(expect.objectContaining({ title: "View stack" })),
      );
    } finally {
      await cleanup?.();
    }
    expect(unregister).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
