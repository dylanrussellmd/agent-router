/**
 * Snapshot + polling layer for the TUI sidebar.
 *
 * Polling (not fs.watch): agent-router writes state.json atomically via
 * temp-file + rename, and Bun's fs.watch drops the rename-to-target event
 * (verified: Bun 1.3.14 reports only the temp file, Node reports both), so a
 * watcher filtered on "state.json" never fires inside opencode. A 1.5s poll
 * of two tiny reads is the reliable alternative.
 */

import type { RouterPaths } from "../core/paths.js";
import { getActiveStackName, listStacks, readStack } from "../core/stack-manager.js";

export interface ModelAssignment {
  readonly model: string;
  readonly variant?: string | null | undefined;
}

export interface AgentAssignment extends ModelAssignment {
  readonly agent: string;
  readonly fallbacks?: readonly ModelAssignment[];
}

export interface StackSnapshot {
  readonly active: string | null;
  readonly stacks: readonly string[];
  /** Configured primary + fallback chains, sorted by agent. Not live runtime selections. */
  readonly agents: readonly AgentAssignment[];
  readonly key: string;
}

export function snapshotKey(
  active: string | null,
  stacks: readonly string[],
  agents: readonly AgentAssignment[] = [],
): string {
  return JSON.stringify([
    active,
    stacks,
    agents.map((a) => [
      a.agent,
      a.model,
      a.variant ?? null,
      (a.fallbacks ?? []).map((fallback) => [fallback.model, fallback.variant ?? null]),
    ]),
  ]);
}

/** Error-tolerant read: never throws, degrades to `(none)` + empty list. */
export async function readStackSnapshot(paths: RouterPaths): Promise<StackSnapshot> {
  const [active, stacks] = await Promise.all([
    getActiveStackName(paths).catch(() => null),
    listStacks(paths).catch(() => [] as string[]),
  ]);
  let agents: AgentAssignment[] = [];
  if (active !== null) {
    try {
      const stack = await readStack(paths, active);
      agents = Object.entries(stack.agents)
        .map(([agent, entry]) => ({
          agent,
          model: entry.model,
          variant: entry.variant ?? null,
          fallbacks: entry.fallbacks ?? [],
        }))
        .sort((a, b) => a.agent.localeCompare(b.agent));
    } catch {
      /* active stack unreadable — degrade to empty agent list */
    }
  }
  return { active, stacks, agents, key: snapshotKey(active, stacks, agents) };
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
