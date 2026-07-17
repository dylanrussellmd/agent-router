/**
 * Frontmatter handling — the read/write layer between stacks and the agent
 * `.md` files opencode loads.
 *
 * Contract (see README): an agent file starts with a YAML frontmatter block
 * delimited by `---` lines, containing exactly one top-level `model:` key.
 * agent-router rewrites the `model:` line AND any model-option keys a stack
 * entry names (e.g. `reasoningEffort`, `thinking`, `temperature`); the prompt
 * body and every other frontmatter key are owned by the user and never touched.
 *
 * Parsing is deliberately line-based rather than a full YAML round-trip:
 * a YAML parser would re-serialize the whole block and clobber the user's
 * comments, key order, and formatting. A targeted line replacement cannot.
 * Only top-level (column-0) `model:` keys match, so nested keys like
 * `options.model` are never confused for the agent model.
 *
 * Option values are serialized to a single line: scalars via
 * {@link serializeOptionValue} (so quoting / reserved-word handling is
 * correct) and objects / arrays as JSON flow (which is a valid YAML subset).
 * Reading back uses {@link parseFrontmatterBlock} on the whole block so
 * captured values are typed correctly.
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { AgentFileError, IOError } from "./errors.js";
import { parseFrontmatterBlock, serializeOptionValue } from "./yaml-lite.js";

/** Matches the frontmatter block at the very start of the file. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** Matches a top-level `model:` line inside frontmatter (multiline mode). */
const MODEL_LINE_RE = /^model:[ \t]*(.*)$/m;

/**
 * opencode-owned agent-config keys that are NEVER treated as transcribable
 * model options. Everything else at the top level of frontmatter (besides
 * `model`, which is handled by its own read/write path) is considered a
 * provider pass-through option and is eligible for stack transcription.
 * Keep this list aligned with opencode's documented agent options.
 */
export const RESERVED_AGENT_KEYS: ReadonlySet<string> = new Set([
  "name",
  "mode",
  "description",
  "permission",
  "color",
  "tools",
  "prompt",
  "steps",
  "maxSteps",
]);

/** A captured/stack entry: a required model plus optional provider options. */
export interface AgentEntry {
  readonly model: string;
  readonly options: Record<string, unknown>;
}

/**
 * Serialize a single option value to one YAML line — the dependency-free
 * implementation from `yaml-lite` (scalars with safe quoting; objects/arrays
 * as JSON flow).
 */

/** Strip a trailing YAML comment (` # ...`) and surrounding quotes/space. */
function cleanModelValue(raw: string): string {
  let v = raw;
  const hash = v.search(/[ \t]#/);
  if (hash >= 0) v = v.slice(0, hash);
  v = v.trim();
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    v = v.slice(1, -1);
  }
  return v;
}

/**
 * Extract the frontmatter `model:` value from agent file content.
 * Returns null when the file has no frontmatter or no model line.
 */
export function getFrontmatterModel(content: string): string | null {
  const fm = FRONTMATTER_RE.exec(content);
  if (!fm?.[1]) return null;
  const line = MODEL_LINE_RE.exec(fm[1]);
  if (!line) return null;
  const value = cleanModelValue(line[1] ?? "");
  return value.length > 0 ? value : null;
}

/**
 * Return new content with the frontmatter `model:` line replaced by
 * `model: <model>`. Throws (plain Error — callers wrap with context) when
 * there is no frontmatter or no model line to replace.
 */
export function setFrontmatterModel(content: string, model: string): string {
  const fm = FRONTMATTER_RE.exec(content);
  if (!fm?.[1]) throw new Error("no frontmatter block");
  const block = fm[1];
  if (!MODEL_LINE_RE.test(block)) throw new Error("no `model:` line in frontmatter");
  // Replacement callback sidesteps `$`-pattern interpretation in the model id.
  const nextBlock = block.replace(MODEL_LINE_RE, () => `model: ${model}`);
  // Splice the edited block back into the matched frontmatter by index so no
  // string in the file is ever treated as a pattern.
  const blockStart = fm[0].indexOf(block);
  const nextFm = fm[0].slice(0, blockStart) + nextBlock + fm[0].slice(blockStart + block.length);
  return nextFm + content.slice(fm[0].length);
}

/**
 * Extract every transcribable model-option key from the frontmatter block.
 * Returns `{}` when there is no frontmatter or no option keys. `model` and
 * the {@link RESERVED_AGENT_KEYS} are excluded — `model` is handled by its
 * own path, reserved keys are opencode framework config, not provider options.
 *
 * The whole block is parsed with the `yaml` parser so values come back with
 * correct typing (numbers as numbers, flow mappings as objects, etc.). A
 * malformed block yields `{}` rather than throwing — capture is best-effort.
 */
export function getFrontmatterOptions(content: string): Record<string, unknown> {
  const fm = FRONTMATTER_RE.exec(content);
  if (!fm?.[1]) return {};
  const parsed = parseFrontmatterBlock(fm[1]);
  if (!parsed) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (k === "model" || RESERVED_AGENT_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Return new content with the frontmatter option keys set to match `options`.
 *
 * For each key in `options`:
 *   - if the key already exists at top level (col 0) in frontmatter, its line
 *     (and any indented continuation lines — e.g. a block-style mapping value)
 *     is replaced with a single flow-style line;
 *   - if the key is absent, it is appended at the end of the block;
 *   - if the value is `null` or `undefined`, the key line is removed.
 *
 * Returns the original `content` reference unchanged when `options` is empty
 * or when no line would change, so callers can detect no-ops by reference
 * equality. Throws (plain Error) when there is no frontmatter block.
 */
export function setFrontmatterOptions(content: string, options: Record<string, unknown>): string {
  const fm = FRONTMATTER_RE.exec(content);
  if (!fm?.[1]) throw new Error("no frontmatter block");
  const block = fm[1];
  const keys = Object.keys(options);
  if (keys.length === 0) return content;

  const eol = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/);
  const handled = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i] ?? "");
    if (!m) continue;
    const key = m[1] ?? "";
    if (!(key in options)) continue;
    handled.add(key);
    // Consume the key line plus any indented continuation (block-style value).
    let end = i + 1;
    while (end < lines.length && /^[ \t]+/.test(lines[end] ?? "")) end++;
    const value = options[key];
    if (value === null || value === undefined) {
      lines.splice(i, end - i);
      i--; // re-examine this index — it now holds the line that followed
    } else {
      lines.splice(i, end - i, `${key}: ${serializeOptionValue(value)}`);
    }
  }

  const appended: string[] = [];
  for (const [key, value] of Object.entries(options)) {
    if (handled.has(key)) continue;
    if (value === null || value === undefined) continue;
    appended.push(`${key}: ${serializeOptionValue(value)}`);
  }

  const nextBlock =
    appended.length > 0 ? lines.join(eol) + eol + appended.join(eol) : lines.join(eol);
  if (nextBlock === block) return content;

  // Splice the edited block back into the matched frontmatter by index so no
  // string in the file is ever treated as a replacement pattern.
  const blockStart = fm[0].indexOf(block);
  const nextFm = fm[0].slice(0, blockStart) + nextBlock + fm[0].slice(blockStart + block.length);
  return nextFm + content.slice(fm[0].length);
}

/** Absolute path of `<agentsDir>/<name>.md`. */
export function agentFilePath(agentsDir: string, name: string): string {
  return path.join(agentsDir, `${name}.md`);
}

/** List agent names (`.md` basenames) in the agents dir, sorted. */
export async function listAgentFiles(agentsDir: string): Promise<string[]> {
  if (!existsSync(agentsDir)) return [];
  let names: string[];
  try {
    names = await readdir(agentsDir);
  } catch (cause) {
    throw new IOError(`Failed to read agents dir: ${(cause as Error).message}`, cause);
  }
  return names
    .filter((n) => n.endsWith(".md"))
    .map((n) => n.slice(0, -".md".length))
    .sort();
}

/**
 * Read the current agent → entry mapping from every `.md` file in the agents
 * dir. Files without a frontmatter `model:` line are skipped (they aren't
 * routable agents — e.g. docs accidentally living there). Each entry carries
 * the model plus any transcribable option keys found in frontmatter.
 */
export async function readAgentEntries(agentsDir: string): Promise<Record<string, AgentEntry>> {
  const out: Record<string, AgentEntry> = {};
  for (const name of await listAgentFiles(agentsDir)) {
    const filePath = agentFilePath(agentsDir, name);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (cause) {
      throw new IOError(`Failed to read ${filePath}: ${(cause as Error).message}`, cause);
    }
    const model = getFrontmatterModel(content);
    if (model === null) continue;
    out[name] = { model, options: getFrontmatterOptions(content) };
  }
  return out;
}

/**
 * Read the current agent → model mapping (model only, no options). Kept as a
 * thin wrapper over {@link readAgentEntries} for callers that only need the
 * model string (e.g. the `current` / `validate --active` display paths).
 */
export async function readAgentModels(agentsDir: string): Promise<Record<string, string>> {
  const entries = await readAgentEntries(agentsDir);
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(entries)) out[name] = entry.model;
  return out;
}

/**
 * Read one agent file strictly: throws `AgentFileError` when the file is
 * missing or has no rewritable `model:` line. Returns the raw content, the
 * current model, and any transcribable options, ready for rewriting.
 */
export async function readAgentFileStrict(
  agentsDir: string,
  name: string,
): Promise<{ filePath: string; content: string; model: string; options: Record<string, unknown> }> {
  const filePath = agentFilePath(agentsDir, name);
  if (!existsSync(filePath)) {
    throw new AgentFileError(name, filePath, "file does not exist");
  }
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (cause) {
    throw new IOError(`Failed to read ${filePath}: ${(cause as Error).message}`, cause);
  }
  const model = getFrontmatterModel(content);
  if (model === null) {
    throw new AgentFileError(name, filePath, "no frontmatter `model:` line to rewrite");
  }
  return { filePath, content, model, options: getFrontmatterOptions(content) };
}
