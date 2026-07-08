/**
 * Snapshot + polling layer for the TUI sidebar.
 *
 * Polling (not fs.watch): omo-router writes state.json atomically via
 * temp-file + rename, and Bun's fs.watch drops the rename-to-target event
 * (verified: Bun 1.3.14 reports only the temp file, Node reports both), so a
 * watcher filtered on "state.json" never fires inside opencode. A 1.5s poll
 * of two tiny reads is the reliable alternative — the same pattern
 * oh-my-openagent's TUI sidebar uses in production.
 */

import type { OmoPaths } from "../core/paths.js";
import { getActiveStackName, listStacks } from "../core/stack-manager.js";

export interface StackSnapshot {
  readonly active: string | null;
  readonly stacks: readonly string[];
  readonly key: string;
}

export function snapshotKey(active: string | null, stacks: readonly string[]): string {
  return `${active ?? "\u0000"}|${stacks.join(",")}`;
}

/** Error-tolerant read: never throws, degrades to `(none)` + empty list. */
export async function readStackSnapshot(paths: OmoPaths): Promise<StackSnapshot> {
  const [active, stacks] = await Promise.all([
    getActiveStackName(paths).catch(() => null),
    listStacks(paths).catch(() => [] as string[]),
  ]);
  return { active, stacks, key: snapshotKey(active, stacks) };
}

export interface SidebarPollerOptions {
  readonly read: () => Promise<StackSnapshot>;
  readonly intervalMs: number;
  readonly initial: StackSnapshot;
  readonly onChange: (next: StackSnapshot, prev: StackSnapshot) => void;
  /** Injectable for tests; defaults to global setTimeout/clearTimeout. */
  readonly schedule?: (fn: () => void, ms: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
}

/** Chained-timeout poller with in-flight guard. Returns a stop function. */
export function createSidebarPoller(options: SidebarPollerOptions): () => void {
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms) as unknown);
  const cancel =
    options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let current = options.initial;
  let disposed = false;
  let inFlight = false;
  let timer: unknown;

  const tick = async (): Promise<void> => {
    if (disposed) return;
    if (inFlight) {
      timer = schedule(tick, options.intervalMs);
      return;
    }
    inFlight = true;
    try {
      const next = await options.read();
      if (!disposed && next.key !== current.key) {
        const prev = current;
        current = next;
        options.onChange(next, prev);
      }
    } catch {
      /* transient read failure — retry next tick */
    } finally {
      inFlight = false;
      if (!disposed) timer = schedule(tick, options.intervalMs);
    }
  };

  timer = schedule(tick, options.intervalMs);

  return () => {
    disposed = true;
    if (timer !== undefined) cancel(timer);
  };
}
