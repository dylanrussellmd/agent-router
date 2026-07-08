import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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

describe("snapshotKey", () => {
  it("distinguishes null active from a stack literally named like the sentinel", () => {
    expect(snapshotKey(null, [])).not.toBe(snapshotKey("", []));
  });

  it("changes when stacks change", () => {
    expect(snapshotKey("a", ["x"])).not.toBe(snapshotKey("a", ["x", "y"]));
  });
});

describe("readStackSnapshot", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "omo-tui-store-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const pathsFor = () => resolvePaths({ opencodeConfigDir: dir });

  it("returns nulls for an uninitialized home", async () => {
    const snapshot = await readStackSnapshot(pathsFor());
    expect(snapshot.active).toBeNull();
    expect(snapshot.stacks).toEqual([]);
  });

  it("reads active stack and stack list", async () => {
    const paths = pathsFor();
    await mkdir(paths.stacksDir, { recursive: true });
    await writeFile(path.join(paths.stacksDir, "premium.json"), "{}");
    await writeFile(path.join(paths.stacksDir, "cheap.json"), "{}");
    await writeFile(
      paths.statePath,
      JSON.stringify({
        version: 1,
        active: "premium",
        previousActive: null,
        lastSwitchedAt: new Date().toISOString(),
        lastSnapshottedFrom: null,
      }),
    );

    const snapshot = await readStackSnapshot(paths);
    expect(snapshot.active).toBe("premium");
    expect(snapshot.stacks).toEqual(["cheap", "premium"]);
  });

  it("degrades to null active when state.json is corrupt", async () => {
    const paths = pathsFor();
    await mkdir(paths.omoHome, { recursive: true });
    await writeFile(paths.statePath, "not json");

    const snapshot = await readStackSnapshot(paths);
    expect(snapshot.active).toBeNull();
  });
});

describe("createSidebarPoller", () => {
  const snap = (active: string | null, stacks: string[] = []): StackSnapshot => ({
    active,
    stacks,
    key: snapshotKey(active, stacks),
  });

  function manualScheduler() {
    const queue: Array<() => void> = [];
    return {
      schedule: (fn: () => void) => {
        queue.push(fn);
        return queue.length;
      },
      cancel: vi.fn(),
      async runNext() {
        const fn = queue.shift();
        fn?.();
        await Promise.resolve();
        await Promise.resolve();
      },
    };
  }

  it("fires onChange only when the key changes", async () => {
    const scheduler = manualScheduler();
    const reads = [snap("a"), snap("a"), snap("b")];
    const onChange = vi.fn();

    createSidebarPoller({
      read: async () => reads.shift() ?? snap("b"),
      intervalMs: 10,
      initial: snap("a"),
      onChange,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    });

    await scheduler.runNext();
    expect(onChange).not.toHaveBeenCalled();

    await scheduler.runNext();
    expect(onChange).not.toHaveBeenCalled();

    await scheduler.runNext();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].active).toBe("b");
    expect(onChange.mock.calls[0][1].active).toBe("a");
  });

  it("survives read failures and keeps polling", async () => {
    const scheduler = manualScheduler();
    let calls = 0;
    const onChange = vi.fn();

    createSidebarPoller({
      read: async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient");
        return snap("b");
      },
      intervalMs: 10,
      initial: snap("a"),
      onChange,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    });

    await scheduler.runNext();
    expect(onChange).not.toHaveBeenCalled();

    await scheduler.runNext();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("stop() prevents further onChange calls", async () => {
    const scheduler = manualScheduler();
    const onChange = vi.fn();

    const stop = createSidebarPoller({
      read: async () => snap("b"),
      intervalMs: 10,
      initial: snap("a"),
      onChange,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    });

    stop();
    await scheduler.runNext();
    expect(onChange).not.toHaveBeenCalled();
    expect(scheduler.cancel).toHaveBeenCalled();
  });
});
