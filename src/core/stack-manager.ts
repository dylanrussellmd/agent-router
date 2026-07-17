/**
 * The orchestration layer. Composes paths + state + history + validator +
 * frontmatter I/O into the operations the CLI and plugin tools call.
 *
 * Public surface:
 *   - `listStacks`             list available stack names
 *   - `readStack`              parse a stack file
 *   - `getActiveStackName`     read state.json
 *   - `applyStack`             the big one: validate + preflight + history + rewrite frontmatter + update state
 *   - `back`                   compute target from state.previousActive and call applyStack
 *   - `captureStack`           read current frontmatter models into a new stack
 *   - `removeStack` / `importStack` / `exportStack`
 *
 * Every write goes through `atomicWriteFile` / `atomicWriteJson` so concurrent
 * readers see consistent state, and symlinked agent files (dotfile setups)
 * survive intact.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, atomicWriteJson } from "./atomic-write.js";
import {
  IOError,
  type RouterError,
  StackNotFoundError,
  UserError,
  ValidationError,
} from "./errors.js";
import {
  type AgentEntry,
  RESERVED_AGENT_KEYS,
  readAgentEntries,
  readAgentFileStrict,
  setFrontmatterModel,
  setFrontmatterOptions,
} from "./frontmatter.js";
import { appendHistory, listHistory, trimHistory } from "./history.js";
import type { RouterPaths } from "./paths.js";
import { type StackFile, StackFileSchema } from "./schema.js";
import { readState, writeState } from "./state.js";
import { type ValidateOptions, validateStackOrThrow } from "./validator.js";

/* ------------------------------------------------------------------------- *
 * read-only helpers                                                          *
 * ------------------------------------------------------------------------- */

export async function listStacks(paths: RouterPaths): Promise<string[]> {
  if (!existsSync(paths.stacksDir)) return [];
  let names: string[];
  try {
    names = await readdir(paths.stacksDir);
  } catch (cause) {
    throw new IOError(`Failed to read stacks dir: ${(cause as Error).message}`, cause);
  }
  return names
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -".json".length))
    .sort();
}

export function stackPath(paths: RouterPaths, name: string): string {
  return path.join(paths.stacksDir, `${name}.json`);
}

/** Read and validate a stack file. Throws `StackNotFoundError` or `ValidationError`. */
export async function readStack(paths: RouterPaths, name: string): Promise<StackFile> {
  const filePath = stackPath(paths, name);
  if (!existsSync(filePath)) {
    throw new StackNotFoundError(name, await listStacks(paths));
  }
  const raw = await readFile(filePath, "utf8").catch((cause: Error) => {
    throw new IOError(`Failed to read ${filePath}: ${cause.message}`, cause);
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ValidationError(
      `Stack "${name}" is not valid JSON: ${(cause as Error).message}`,
      filePath,
    );
  }
  const result = StackFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new ValidationError(
      `Stack "${name}" failed validation: ${result.error.issues.map((i) => i.message).join("; ")}`,
      filePath,
      result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  return result.data;
}

/** Raw file contents (string) — used when we want to forward bytes verbatim. */
export async function readStackRaw(paths: RouterPaths, name: string): Promise<string> {
  const filePath = stackPath(paths, name);
  if (!existsSync(filePath)) {
    throw new StackNotFoundError(name, await listStacks(paths));
  }
  return readFile(filePath, "utf8");
}

export async function getActiveStackName(paths: RouterPaths): Promise<string | null> {
  const state = await readState(paths.statePath);
  return state?.active ?? null;
}

/* ------------------------------------------------------------------------- *
 * applyStack — the central operation                                         *
 * ------------------------------------------------------------------------- */

export interface ApplyOptions {
  /** Default true. Set false to skip the pre-apply model-validation gate. */
  readonly validate?: boolean;
  /** Default false. When true, apply even if validation finds missing models. */
  readonly forceInvalid?: boolean;
  /** Plumbed to validator for tests / mocks. */
  readonly validateOptions?: ValidateOptions;
}

export interface ApplyResult {
  readonly previous: string | null;
  readonly current: string;
  /** Agents whose frontmatter model actually changed. */
  readonly changed: ReadonlyArray<string>;
  readonly historyId: string;
  readonly restartRequired: true;
}

/**
 * Apply stack `name` to the agent files. The algorithm:
 *
 *   1. Read + schema-validate the target stack (throws if missing).
 *   2. Validate the stack's model IDs against `opencode models` (unless
 *      --no-validate).
 *   3. STRICT PRE-FLIGHT: read every agent file the stack references. Any
 *      missing file or missing `model:` line aborts BEFORE any write — the
 *      suite is never left half-switched.
 *   4. Append the displaced mapping (current models + options of ALL agent
 *      files, as a capture-shaped JSON) to history.
 *   5. Atomic-write each agent file whose frontmatter would change. Both the
 *      `model:` line and any option keys the stack entry names are rewritten;
 *      option keys absent from the stack entry are left in place (to clear an
 *      option, set it to `null` in the stack entry).
 *   6. Update state.json.
 *   7. Trim history to 20.
 */
export async function applyStack(
  paths: RouterPaths,
  name: string,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const validate = options.validate ?? true;
  const forceInvalid = options.forceInvalid ?? false;

  const target = await readStack(paths, name);

  if (validate && !forceInvalid) {
    await validateStackOrThrow(name, target, options.validateOptions);
  }

  const pending: Array<{ agent: string; filePath: string; next: string | null }> = [];
  for (const [agent, entry] of Object.entries(target.agents)) {
    const { filePath, content, model } = await readAgentFileStrict(paths.agentsDir, agent);
    // Options first (line-preserving), then model. Each returns the SAME
    // content reference when it would change nothing, so a no-op entry
    // (same model, no option diffs) yields `next === null` and skips writing.
    const wantOptions = entryOptions(entry);
    const afterOptions = setFrontmatterOptions(content, wantOptions);
    const nextContent =
      entry.model === model ? afterOptions : setFrontmatterModel(afterOptions, entry.model);
    pending.push({ agent, filePath, next: nextContent === content ? null : nextContent });
  }

  const prevState = await readState(paths.statePath);
  const prevActive = prevState?.active ?? null;

  const displaced = { agents: entriesToStackAgents(await readAgentEntries(paths.agentsDir)) };
  const historyId = await appendHistory(
    paths.historyDir,
    prevActive ?? "(none)",
    name,
    `${JSON.stringify(displaced, null, 2)}\n`,
  );

  const changed: string[] = [];
  for (const p of pending) {
    if (p.next === null) continue;
    await atomicWriteFile(p.filePath, p.next);
    changed.push(p.agent);
  }

  await writeState(paths.statePath, {
    version: 1,
    active: name,
    previousActive: prevActive,
    lastSwitchedAt: new Date().toISOString(),
  });

  await trimHistory(paths.historyDir).catch(() => {});

  return {
    previous: prevActive,
    current: name,
    changed,
    historyId,
    restartRequired: true,
  };
}

/**
 * Extract the transcribable option keys from a stack entry. `model` is handled
 * by its own path; {@link RESERVED_AGENT_KEYS} (opencode framework config such
 * as `description`, `permission`, `tools`) are stripped so a stack entry can
 * never accidentally clobber framework fields. Everything else is treated as
 * a provider pass-through option and written to frontmatter on apply.
 */
function entryOptions(entry: { model: string }): Record<string, unknown> {
  const rec = entry as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k === "model" || RESERVED_AGENT_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Build a capture-shaped `agents` record from live frontmatter entries: each
 * agent maps to `{ model, ...options }`, with options spread as top-level
 * sibling keys (matching the opencode.json agent-config shape and the
 * frontmatter shape). Agents are emitted in sorted name order for stable
 * diffs and history.
 */
function entriesToStackAgents(
  entries: Record<string, AgentEntry>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const name of Object.keys(entries).sort()) {
    const entry = entries[name];
    if (!entry) continue;
    const { model, options } = entry;
    const stackEntry: Record<string, unknown> = { model };
    for (const [k, v] of Object.entries(options)) stackEntry[k] = v;
    out[name] = stackEntry;
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * back                                                                       *
 * ------------------------------------------------------------------------- */

/**
 * Undo last N switches (default 1). Implemented in terms of `applyStack` so
 * each step records a fresh history entry — invariants stay consistent.
 *
 * For N=1 we simply target `state.previousActive`. For N>1 we walk history
 * backward to find the n-th previous fromStack (best-effort: history can
 * truncate, in which case we stop at whatever we have).
 */
export async function back(
  paths: RouterPaths,
  n = 1,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  if (n < 1) throw new UserError("`back -n` must be at least 1.");
  const state = await readState(paths.statePath);
  if (!state || !state.previousActive) {
    throw new UserError("No previous stack to revert to.");
  }
  if (n === 1) return applyStack(paths, state.previousActive, options);
  const entries = await listHistory(paths.historyDir);
  if (entries.length < n) {
    throw new UserError(
      `Cannot go back ${n} steps; only ${entries.length} switch${entries.length === 1 ? "" : "es"} in history.`,
    );
  }
  // entries[0] is the newest = the snapshot taken right before the LAST switch.
  // entries[n-1].fromStack is the stack that was active before the n-th-most-recent switch.
  const target = entries[n - 1]?.fromStack;
  if (!target || target === "(none)") {
    throw new UserError(`Cannot go back ${n} steps to a non-stack target ("${target}").`);
  }
  return applyStack(paths, target, options);
}

/* ------------------------------------------------------------------------- *
 * capture / remove / import / export                                         *
 * ------------------------------------------------------------------------- */

const STACK_NAME_RE = /^[A-Za-z0-9._-]+$/;

function assertValidStackName(name: string): void {
  if (!STACK_NAME_RE.test(name)) {
    throw new UserError(
      `Stack name "${name}" contains invalid characters. Allowed: A-Z a-z 0-9 . _ -`,
    );
  }
}

export interface CaptureOptions {
  /** When true, overwrite an existing stack of the same name. */
  readonly force?: boolean;
}

export interface CaptureResult {
  readonly name: string;
  readonly path: string;
  /** Number of agents captured. */
  readonly agents: number;
}

/**
 * Snapshot the current frontmatter models AND option keys of every agent file
 * into a new stack. This replaces both the old snapshot-back concept and seed
 * stacks — your real, working setup is always one `capture` away from being a
 * stack.
 */
export async function captureStack(
  paths: RouterPaths,
  name: string,
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  assertValidStackName(name);
  const dest = stackPath(paths, name);
  if (existsSync(dest) && !options.force) {
    throw new UserError(`Stack "${name}" already exists. Use --force to overwrite.`);
  }
  const entries = await readAgentEntries(paths.agentsDir);
  const agents = entriesToStackAgents(entries);
  if (Object.keys(agents).length === 0) {
    throw new UserError(
      `No agent .md files with a frontmatter \`model:\` line found in ${paths.agentsDir}.`,
    );
  }
  await mkdir(paths.stacksDir, { recursive: true });
  await atomicWriteJson(dest, { agents });
  return { name, path: dest, agents: Object.keys(agents).length };
}

export async function removeStack(
  paths: RouterPaths,
  name: string,
  options: { readonly force?: boolean } = {},
): Promise<void> {
  const filePath = stackPath(paths, name);
  if (!existsSync(filePath)) {
    throw new StackNotFoundError(name, await listStacks(paths));
  }
  const active = await getActiveStackName(paths);
  if (active === name && !options.force) {
    throw new UserError(`"${name}" is the active stack. Use --force to remove anyway.`);
  }
  await unlink(filePath);
}

export async function importStack(
  paths: RouterPaths,
  name: string,
  fromFile: string,
  options: { readonly force?: boolean } = {},
): Promise<void> {
  assertValidStackName(name);
  const dest = stackPath(paths, name);
  if (existsSync(dest) && !options.force) {
    throw new UserError(`Stack "${name}" already exists. Use --force to overwrite.`);
  }
  if (!existsSync(fromFile)) {
    throw new UserError(`Import file does not exist: ${fromFile}`);
  }
  await mkdir(paths.stacksDir, { recursive: true });
  await copyFile(fromFile, dest);
}

export async function exportStack(paths: RouterPaths, name: string, toFile: string): Promise<void> {
  const filePath = stackPath(paths, name);
  if (!existsSync(filePath)) {
    throw new StackNotFoundError(name, await listStacks(paths));
  }
  await mkdir(path.dirname(toFile), { recursive: true });
  await copyFile(filePath, toFile);
}

/** Helper used by callers to test for any of our typed errors uniformly. */
export function isRouterError(e: unknown): e is RouterError {
  return (
    e instanceof Error &&
    typeof (e as { name?: string }).name === "string" &&
    /Error$/.test((e as Error).name)
  );
}
