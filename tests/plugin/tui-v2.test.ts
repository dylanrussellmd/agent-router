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
    JSON.stringify({ agents: { build: { model: "test/model" } } }),
  );
  vi.stubEnv("AGENT_ROUTER_HOME", root);
  vi.stubEnv("AGENT_ROUTER_AGENTS_DIR", path.join(root, "agents"));
  vi.stubEnv("AGENT_ROUTER_STACKS_DIR", path.join(root, "stacks"));
  let commands: Array<{ id: string; slash: { name: string }; run(): void }> = [];
  const unregister = vi.fn();
  const claims: Array<{ append: string; render(): unknown }> = [];
  const slot = vi.fn((claim: (typeof claims)[number]) => {
    claims.push(claim);
    return unregister;
  });
  let mounted = false;
  const select = vi.fn(async () => undefined);
  const toast = vi.fn();
  const revision = { value: 0 };
  const ctx = {
    storage: {
      memory: () => [revision, (update: (draft: typeof revision) => void) => update(revision)],
    },
    renderer: { requestRender: vi.fn() },
    data: { location: { model: { list: () => [{ providerID: "test", id: "model" }] } } },
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
      expect(claims.find((claim) => claim.append === "sidebar.content")?.render()).toEqual(
        expect.objectContaining({ tag: "box" }),
      );
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
