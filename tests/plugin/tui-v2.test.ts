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
vi.mock("solid-js", () => ({ createEffect: (fn: () => void) => fn(), onCleanup: vi.fn() }));

it("registers the V2 sidebar, slash commands, selection dialogs and cleanup", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ar-tui-v2-"));
  mkdirSync(path.join(root, "agents"));
  mkdirSync(path.join(root, "stacks"));
  writeFileSync(path.join(root, "agents", "build.md"), "---\nmodel: test/model\n---\nPrompt\n");
  writeFileSync(
    path.join(root, "stacks", "sample.json"),
    JSON.stringify({
      agents: {
        build: { model: "test/model", fallbacks: [{ model: "test/backup" }] },
        explorer: { model: "test/slow" },
      },
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
  let nextSelection: string | undefined;
  const select = vi.fn(async () => nextSelection);
  const toast = vi.fn();
  const routingStatus = {
    sessionID: "ses_test",
    mode: "pinned" as const,
    model: { providerID: "test", id: "backup" },
    reason: "manual_or_preexisting_selection" as const,
    checkedAt: null,
    validUntil: null,
  };
  const readRouting = vi.fn(async () => routingStatus);
  const controlRouting = vi.fn(async ({ action }: { action: "pin" | "auto" }) => ({
    ...routingStatus,
    mode: action === "auto" ? ("automatic" as const) : ("pinned" as const),
    reason:
      action === "auto" ? ("automatic_next_explicit_turn" as const) : ("explicit_pin" as const),
  }));
  const rpc = vi.fn(() => ({ status: readRouting, control: controlRouting }));
  const revision = { value: 0 };
  let session = {
    id: "session",
    location: { directory: "/project" },
    agent: "build",
    model: { providerID: "test", id: "backup", variant: "default" },
    time: { updated: 50 },
  };
  // Viewed parent, conflicting active children, and an unrelated child.
  const siblings = [
    {
      id: "child-1",
      parentID: "session",
      location: { directory: "/project" },
      agent: "explorer",
      model: { providerID: "test", id: "fast" },
      time: { updated: 100 },
    },
    {
      id: "child-2",
      parentID: "session",
      location: { directory: "/project" },
      agent: "explorer",
      model: { providerID: "test", id: "slow" },
      time: { updated: 200 },
    },
    {
      id: "alien",
      parentID: "elsewhere",
      location: { directory: "/project" },
      agent: "explorer",
      model: { providerID: "test", id: "alien" },
      time: { updated: 300 },
    },
  ];
  const roots: Record<string, string> = {
    session: "session",
    "child-1": "session",
    "child-2": "session",
    alien: "elsewhere",
  };
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
  let route: { type: "home" } | { type: "session"; sessionID: string } = { type: "home" };
  const ctx = {
    location: { directory: "/project" },
    client: { rpc },
    theme,
    storage: {
      memory: () => [revision, (update: (draft: typeof revision) => void) => update(revision)],
    },
    renderer: { requestRender: vi.fn() },
    data: {
      session: {
        get: vi.fn(() => session),
        list: vi.fn(() => [session, ...siblings]),
        root: vi.fn((id: string) => roots[id] ?? id),
        status: vi.fn(() => "running"),
      },
      location: { model: { list: () => [{ providerID: "test", id: "model" }] } },
    },
    ui: {
      router: { current: () => route },
      slot,
      toast: { show: toast },
      dialog: { select, confirm: vi.fn(), clear: vi.fn() },
    },
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
      // Viewed session's live fallback selection, orange.
      expect(rows().find((n) => n.children[0] === "● test/backup")?.fg).toBe("WARNING");
      // Conflicting active children retain both selections, orange.
      expect(rows().find((n) => n.children[0] === "● test/slow")?.fg).toBe("WARNING");
      expect(rows().find((n) => n.children[0] === "● test/fast")?.fg).toBe("WARNING");
      // An unrelated family's session never leaks into the sidebar.
      expect(rows().some((n) => String(n.children[0]).includes("alien"))).toBe(false);
      ctx.data.session.status.mockReturnValue("idle");
      expect(rows().some((n) => n.children[0] === "● test/fast")).toBe(false);
      ctx.data.session.status.mockReturnValue("running");
      siblings[0].location.directory = "/other";
      expect(rows().some((n) => n.children[0] === "● test/fast")).toBe(false);
      siblings[0].location.directory = "/project";
      expect(rows().some((n) => n.children[0] === "Routing · unknown · freshness unknown")).toBe(
        true,
      );
      expect(
        rows()
          .filter((n) => String(n.children[0]).includes("test/"))
          .map((n) => n.children[0]),
      ).toEqual(["  test/model", "● test/backup", "● test/slow", "● test/fast"]);
      session = {
        id: "session",
        location: { directory: "/project" },
        agent: "build",
        model: { providerID: "external", id: "override", variant: "high" },
        time: { updated: 60 },
      };
      expect(rows().find((n) => n.children[0] === "● external/override [high]")?.fg).toBe(
        "WARNING",
      );
      session = {
        id: "session",
        location: { directory: "/project" },
        agent: "build",
        model: { providerID: "test", id: "model", variant: "default" },
        time: { updated: 70 },
      };
      expect(rows().find((n) => n.children[0] === "● test/model")?.fg).toBe("WARNING");
      // The selection color tracks theme.text.feedback.warning.default, not success.
      theme.text.feedback.warning.default = "NEW_ORANGE";
      expect(rows().find((n) => n.children[0] === "● test/model")?.fg).toBe("NEW_ORANGE");
      expect(rows().some((n) => String(n.children[0]).includes("[default]"))).toBe(false);
      // Switching the viewed session to explorer demotes build to its
      // configured default; the off-chain live model stays a separate row.
      session = { ...session, agent: "explorer" };
      expect(rows().filter((n) => n.children[0] === "● test/model")).toHaveLength(2);
      expect(rows().find((n) => n.children[0] === "  test/backup")?.fg).toBe("MUTED");
      expect(ctx.data.session.get).toHaveBeenCalledWith("session");
      expect(commands.map((command) => command.slash.name)).toEqual([
        "agent-status",
        "agent-routing",
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
      route = { type: "session", sessionID: "ses_test" };
      nextSelection = "automatic";
      commands.find((command) => command.id === "agent-router.routing")?.run();
      await vi.waitFor(() =>
        expect(controlRouting).toHaveBeenCalledWith(
          { sessionID: "ses_test", action: "auto" },
          { location: ctx.location },
        ),
      );
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("Automatic routing resumes") }),
      );
      nextSelection = undefined;
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
