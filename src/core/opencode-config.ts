/**
 * Read and edit `~/.config/opencode/opencode.json`.
 *
 * `omo-router init` is the only place that writes this file. The mutations
 * are deliberately minimal:
 *
 *   1. Ensure `plugin` array contains `@dylanrussell/omo-router@latest`.
 *   2. Ensure `provider.openrouter.models` contains every OpenRouter ID our
 *      seed stacks reference (so opencode actually exposes them).
 *
 * Both ops are idempotent: re-running `init` on an already-configured file
 * leaves it unchanged. We always back up before writing — see `backups.ts`.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { atomicWriteJson } from "./atomic-write.js";
import { IOError, ValidationError } from "./errors.js";
import { type OpencodeJson, OpencodeJsonSchema } from "./schema.js";

export const PLUGIN_NPM_NAME = "@dylanrussell/omo-router";
/** What we add to opencode.json's plugin[] — name@latest for auto-updates. */
export const PLUGIN_REGISTRY_ENTRY = `${PLUGIN_NPM_NAME}@latest`;

/** Read opencode.json. Returns null if absent. Throws on parse/schema error. */
export async function readOpencodeJson(opencodeJsonPath: string): Promise<OpencodeJson | null> {
  return readPluginConfigFile(opencodeJsonPath, "opencode.json");
}

/**
 * Read tui.json — opencode's TUI config. Same loose schema as opencode.json;
 * the TUI (opencode >= 1.17) loads its plugins from THIS file's `plugin`
 * array, so omo-router's sidebar half must be registered here.
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
  const existing = config.plugin ?? [];
  const already = existing.some(
    (p) => p === entry || stripVersionTag(p) === stripVersionTag(entry),
  );
  if (already) {
    return { config, result: { added: false, plugin: existing } };
  }
  const next = [...existing, entry];
  return {
    config: { ...config, plugin: next },
    result: { added: true, plugin: next },
  };
}

/** Strip `@version` from a plugin entry. `foo@1.2.3` → `foo`; scoped names handled. */
function stripVersionTag(entry: string): string {
  // For scoped packages `@org/name@ver`, the `@` we want is the LAST one.
  // For unscoped `name@ver`, also the last @.
  const lastAt = entry.lastIndexOf("@");
  // If `lastAt` is 0 it's the leading `@` of a scoped name with no version.
  if (lastAt <= 0) return entry;
  return entry.slice(0, lastAt);
}

export interface EnsureOpenrouterModelsResult {
  /** Model IDs we actually added (excluding ones already present). */
  readonly added: ReadonlyArray<string>;
}

/**
 * Pure transform: ensure `config.provider.openrouter.models` contains an empty
 * object entry for each id in `modelIds`. We use `{}` as the value because
 * that's the convention in the user's existing opencode.json — opencode
 * accepts a plain `{}` per model. Idempotent.
 */
export function ensureOpenrouterModels(
  config: OpencodeJson,
  modelIds: ReadonlyArray<string>,
): { config: OpencodeJson; result: EnsureOpenrouterModelsResult } {
  const existingProvider = config.provider ?? {};
  const existingOpenrouter =
    (existingProvider.openrouter as { models?: Record<string, unknown> } | undefined) ?? {};
  const existingModels = existingOpenrouter.models ?? {};

  const added: string[] = [];
  const nextModels: Record<string, unknown> = { ...existingModels };
  for (const id of modelIds) {
    if (!(id in nextModels)) {
      nextModels[id] = {};
      added.push(id);
    }
  }

  if (added.length === 0) {
    return { config, result: { added: [] } };
  }

  return {
    config: {
      ...config,
      provider: {
        ...existingProvider,
        openrouter: {
          ...existingOpenrouter,
          models: nextModels,
        },
      },
    },
    result: { added },
  };
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
 * half of omo-router loads. Creates the file when absent. Idempotent.
 * Returns whether an entry was added (callers back up before calling when the
 * file already exists).
 */
export async function ensureTuiJsonPluginEntry(
  tuiJsonPath: string,
  entry: string = PLUGIN_REGISTRY_ENTRY,
): Promise<EnsurePluginEntryResult> {
  const existing = (await readTuiJson(tuiJsonPath)) ?? { $schema: TUI_JSON_SCHEMA_URL };
  const { config, result } = ensurePluginEntry(existing, entry);
  if (result.added) {
    await atomicWriteJson(tuiJsonPath, config);
  }
  return result;
}
