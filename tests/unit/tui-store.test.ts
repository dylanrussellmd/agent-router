import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePaths } from "../../src/core/paths.js";
import {
  type StackSnapshot,
  createSidebarPoller,
  readStackSnapshot,
  snapshotKey,
} from "../../src/tui/store.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "ar-store-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readStackSnapshot", () => {
  it("degrades to (none) + empty list when nothing exists", async () => {
    const paths = resolvePaths({ routerHome: path.join(root, "nope"), env: {} });
    const snap = await readStackSnapshot(paths);
    expect(snap.active).toBeNull();
    expect(snap.stacks).toEqual([]);
    expect(snap.agents).toEqual([]);
  });

  it("reads active + stack names", async () => {
    const paths = resolvePaths({ routerHome: path.join(root, "router"), env: {} });
    mkdirSync(paths.stacksDir, { recursive: true });
    writeFileSync(path.join(paths.stacksDir, "premium.json"), "{}");
    writeFileSync(
      paths.statePath,
      JSON.stringify({
        version: 1,
        active: "premium",
        previousActive: null,
        lastSwitchedAt: new Date().toISOString(),
      }),
    );
    const snap = await readStackSnapshot(paths);
    expect(snap.active).toBe("premium");
    expect(snap.stacks).toEqual(["premium"]);
    expect(snap.key).toBe(snapshotKey("premium", ["premium"]));
  });

  it("reads the active stack's agent → model assignments, sorted by agent", async () => {
    const paths = resolvePaths({ routerHome: path.join(root, "router"), env: {} });
    mkdirSync(paths.stacksDir, { recursive: true });
    writeFileSync(
      path.join(paths.stacksDir, "work.json"),
      JSON.stringify({
        agents: {
          explorer: { model: "claude-opus" },
          build: { model: "gpt-5" },
        },
      }),
    );
    writeFileSync(
      paths.statePath,
      JSON.stringify({
        version: 1,
        active: "work",
        previousActive: null,
        lastSwitchedAt: new Date().toISOString(),
      }),
    );
    const snap = await readStackSnapshot(paths);
    expect(snap.agents).toEqual([
      { agent: "build", model: "gpt-5", variant: null, fallbacks: [] },
      { agent: "explorer", model: "claude-opus", variant: null, fallbacks: [] },
    ]);
    // key incorporates agents so edits are detected by the poller
    expect(snap.key).toBe(snapshotKey("work", ["work"], snap.agents));
  });

  it("degrades agents to empty when the active stack file is unreadable", async () => {
    const paths = resolvePaths({ routerHome: path.join(root, "router"), env: {} });
    mkdirSync(paths.stacksDir, { recursive: true });
    writeFileSync(path.join(paths.stacksDir, "broken.json"), "{not json");
    writeFileSync(
      paths.statePath,
      JSON.stringify({
        version: 1,
        active: "broken",
        previousActive: null,
        lastSwitchedAt: new Date().toISOString(),
      }),
    );
    const snap = await readStackSnapshot(paths);
    expect(snap.active).toBe("broken");
    expect(snap.agents).toEqual([]);
  });

  it("reads configured chains and variants without substituting applied state metadata", async () => {
    const paths = resolvePaths({ routerHome: path.join(root, "router"), env: {} });
    mkdirSync(paths.stacksDir, { recursive: true });
    const fallbacks = [{ model: "b/backup", variant: "high" }, { model: "c/last" }];
    writeFileSync(
      path.join(paths.stacksDir, "work.json"),
      JSON.stringify({ agents: { omni: { model: "a/primary", variant: "medium", fallbacks } } }),
    );
    writeFileSync(
      paths.statePath,
      JSON.stringify({
        version: 1,
        active: "work",
        previousActive: null,
        lastSwitchedAt: new Date().toISOString(),
        fallbackAgents: { omni: { model: "a/primary", fallbacks: [{ model: "d/old" }] } },
      }),
    );
    const snap = await readStackSnapshot(paths);
    expect(snap.active).toBe("work");
    expect(snap.agents).toEqual([
      { agent: "omni", model: "a/primary", variant: "medium", fallbacks },
    ]);
  });
});

describe("snapshotKey", () => {
  const primary = { agent: "omni", model: "a/primary" };
  const fallbacks = [{ model: "b/backup", variant: "high" }, { model: "c/last" }];
  const key = (entry: Parameters<typeof snapshotKey>[2]) => snapshotKey("work", ["work"], entry);

  it("detects fallback additions, removals, reordering, model edits and variant edits", () => {
    const original = key([{ ...primary, fallbacks }]);
    for (const changed of [
      [],
      fallbacks.slice(0, 1),
      [...fallbacks, { model: "d/extra" }],
      [...fallbacks].reverse(),
      [{ model: "b/changed", variant: "high" }, fallbacks[1]],
      [{ model: "b/backup", variant: "low" }, fallbacks[1]],
    ]) {
      expect(key([{ ...primary, fallbacks: changed }])).not.toBe(original);
    }
    expect(key([{ ...primary, variant: "high", fallbacks }])).not.toBe(original);
  });

  it("normalizes absent chains and cleared variants", () => {
    expect(key([primary])).toBe(key([{ ...primary, variant: null, fallbacks: [] }]));
  });
});

describe("createSidebarPoller", () => {
  function manualScheduler() {
    const queue: Array<() => void> = [];
    return {
      schedule: (fn: () => void) => {
        queue.push(fn);
        return queue.length;
      },
      cancel: () => {},
      flush: async () => {
        const fns = queue.splice(0);
        for (const fn of fns) fn();
        await Promise.resolve();
        await Promise.resolve();
      },
    };
  }

  function snap(active: string | null, stacks: string[]): StackSnapshot {
    return { active, stacks, agents: [], key: snapshotKey(active, stacks) };
  }

  it("fires onChange only when the key changes", async () => {
    const sched = manualScheduler();
    const onChange = vi.fn();
    let current = snap("a", ["a"]);
    const stop = createSidebarPoller({
      read: async () => current,
      intervalMs: 1000,
      initial: snap("a", ["a"]),
      onChange,
      schedule: sched.schedule,
      cancel: sched.cancel,
    });

    await sched.flush();
    expect(onChange).not.toHaveBeenCalled();

    current = snap("b", ["a", "b"]);
    await sched.flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0].active).toBe("b");
    stop();
  });

  it("survives read failures and keeps polling", async () => {
    const sched = manualScheduler();
    const onChange = vi.fn();
    let fail = true;
    const stop = createSidebarPoller({
      read: async () => {
        if (fail) throw new Error("transient");
        return snap("ok", ["ok"]);
      },
      intervalMs: 1000,
      initial: snap(null, []),
      onChange,
      schedule: sched.schedule,
      cancel: sched.cancel,
    });

    await sched.flush();
    expect(onChange).not.toHaveBeenCalled();
    fail = false;
    await sched.flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it("refreshes when only fallback configuration changes in the same stack", async () => {
    const sched = manualScheduler();
    const onChange = vi.fn();
    const assignment = { agent: "omni", model: "a/primary" };
    const snapshot = (fallbacks: { model: string; variant?: string }[]): StackSnapshot => {
      const agents = [{ ...assignment, fallbacks }];
      return { active: "a", stacks: ["a"], agents, key: snapshotKey("a", ["a"], agents) };
    };
    let current = snapshot([{ model: "b/backup" }]);
    const stop = createSidebarPoller({
      read: async () => current,
      intervalMs: 1000,
      initial: current,
      onChange,
      schedule: sched.schedule,
      cancel: sched.cancel,
    });
    await sched.flush();
    expect(onChange).not.toHaveBeenCalled();
    current = snapshot([{ model: "b/backup", variant: "high" }]);
    await sched.flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    current = snapshot([]);
    await sched.flush();
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stops scheduling after dispose", async () => {
    const sched = manualScheduler();
    const onChange = vi.fn();
    const stop = createSidebarPoller({
      read: async () => snap("x", ["x"]),
      intervalMs: 1000,
      initial: snap(null, []),
      onChange,
      schedule: sched.schedule,
      cancel: sched.cancel,
    });
    stop();
    await sched.flush();
    expect(onChange).not.toHaveBeenCalled();
  });
});
