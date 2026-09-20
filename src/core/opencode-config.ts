/**
 * Read and edit `~/.config/opencode/opencode.json` and `tui.json`.
 *
 * `agent-router init` is the only place that writes these files. The mutation
 * is deliberately minimal: ensure each `plugin` array contains
 * `@dylanrussell/agent-router@latest` (and drop the legacy
 * `@dylanrussell/omo-router` entry when present).
 *
 * All ops are idempotent: re-running `init` on an already-configured file
 * leaves it unchanged. We always back up before writing — see `backups.ts`.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { atomicWriteJson } from "./atomic-write.js";
import { IOError, ValidationError } from "./errors.js";
import { type OpencodeJson, OpencodeJsonSchema } from "./schema.js";

export const PLUGIN_NPM_NAME = "@dylanrussell/agent-router";
/** What we add to plugin[] arrays — name@latest for auto-updates. */
export const PLUGIN_REGISTRY_ENTRY = `${PLUGIN_NPM_NAME}@latest`;
/** The predecessor package `init` removes when found. */
export const LEGACY_PLUGIN_NPM_NAME = "@dylanrussell/omo-router";

/** Read opencode.json. Returns null if absent. Throws on parse/schema error. */
export async function readOpencodeJson(opencodeJsonPath: string): Promise<OpencodeJson | null> {
  return readPluginConfigFile(opencodeJsonPath, "opencode.json");
}

/**
 * Read tui.json — opencode's TUI config. Same loose schema as opencode.json;
 * the TUI (opencode >= 1.17) loads its plugins from THIS file's `plugin`
 * array, so agent-router's sidebar half must be registered here.
 */
export async function readTuiJson(tuiJsonPath: string): Promise<OpencodeJson | null> {
  return readPluginConfigFile(tuiJsonPath, "tui.json");
}

async function readPluginConfigFile(filePath: string, label: string): Promise<OpencodeJson | null> {
  if (!existsSync(filePath)) return null;
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (cause) {
    throw new IOError(`Failed to read ${filePath}: ${(cause as Error).message}`, cause);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ValidationError(`${label} is not valid JSON: ${(cause as Error).message}`, filePath);
  }
  const result = OpencodeJsonSchema.safeParse(parsed);
  if (!result.success) {
    throw new ValidationError(
      `${label} failed validation: ${result.error.issues.map((i) => i.message).join("; ")}`,
      filePath,
      result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  return result.data;
}

export interface EnsurePluginEntryResult {
  /** True if we actually had to add the entry. */
  readonly added: boolean;
  /** The plugin array after the operation (always defined). */
  readonly plugin: string[];
}

/**
 * Pure transform: ensure `config.plugin` contains `entry`.
 * Returns the new config (does NOT write). Idempotent.
 */
export function ensurePluginEntry(
  config: OpencodeJson,
  entry: string = PLUGIN_REGISTRY_ENTRY,
): { config: OpencodeJson; result: EnsurePluginEntryResult } {
  const existing = config.plugins ?? config.plugin ?? [];
  const already = existing.some(
    (p) =>
      pluginPackage(p) === entry || stripVersionTag(pluginPackage(p)) === stripVersionTag(entry),
  );
  if (already) {
    return { config, result: { added: false, plugin: existing.map(pluginPackage) } };
  }
  const next = [...existing, entry];
  return {
    config: { ...config, plugins: next },
    result: { added: true, plugin: next.map(pluginPackage) },
  };
}

export interface RemovePluginEntryResult {
  /** The entries actually removed. */
  readonly removed: ReadonlyArray<string>;
  readonly plugin: string[];
}

/**
 * Pure transform: remove every plugin entry whose package name (version tag
 * stripped) equals `npmName`. Idempotent.
 */
export function removePluginEntry(
  config: OpencodeJson,
  npmName: string = LEGACY_PLUGIN_NPM_NAME,
): { config: OpencodeJson; result: RemovePluginEntryResult } {
  const key = config.plugins ? "plugins" : "plugin";
  const existing = config[key] ?? [];
  const removed = existing.filter((p) => stripVersionTag(pluginPackage(p)) === npmName);
  if (removed.length === 0) {
    return { config, result: { removed: [], plugin: existing.map(pluginPackage) } };
  }
  const next = existing.filter((p) => stripVersionTag(pluginPackage(p)) !== npmName);
  return {
    config: { ...config, [key]: next },
    result: { removed: removed.map(pluginPackage), plugin: next.map(pluginPackage) },
  };
}

/** Strip `@version` from a plugin entry. `foo@1.2.3` → `foo`; scoped names handled. */
function pluginPackage(entry: string | { package: string }): string {
  return typeof entry === "string" ? entry : entry.package;
}

function stripVersionTag(entry: string): string {
  // For scoped packages `@org/name@ver`, the `@` we want is the LAST one.
  // For unscoped `name@ver`, also the last @.
  const lastAt = entry.lastIndexOf("@");
  // If `lastAt` is 0 it's the leading `@` of a scoped name with no version.
  if (lastAt <= 0) return entry;
  return entry.slice(0, lastAt);
}

/** Write opencode.json. Caller is responsible for backing up first. */
export async function writeOpencodeJson(
  opencodeJsonPath: string,
  config: OpencodeJson,
): Promise<void> {
  await atomicWriteJson(opencodeJsonPath, config);
}

const TUI_JSON_SCHEMA_URL = "https://opencode.ai/config.json";

/**
 * Ensure tui.json exists and lists `entry` in its `plugin` array so the TUI
 * half of agent-router loads (and drop the legacy omo-router entry). Creates
 * the file when absent. Idempotent. Returns whether an entry was added
 * (callers back up before calling when the file already exists).
 */
export async function ensureTuiJsonPluginEntry(
  tuiJsonPath: string,
  entry: string = PLUGIN_REGISTRY_ENTRY,
): Promise<EnsurePluginEntryResult> {
  const existing = (await readTuiJson(tuiJsonPath)) ?? { $schema: TUI_JSON_SCHEMA_URL };
  const removed = removePluginEntry(existing);
  const { config, result } = ensurePluginEntry(removed.config, entry);
  if (result.added || removed.result.removed.length > 0) {
    await atomicWriteJson(tuiJsonPath, config);
  }
  return result;
}
