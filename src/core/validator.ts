/**
 * Validate that every model ID referenced by a stack file is reachable
 * through the user's current opencode auth.
 *
 * Strategy: shell out to `opencode models`, capture the line-per-id list,
 * compare to the IDs found in the stack. The model catalogue is
 * auth-state-dependent — a user without an Anthropic key won't see
 * `anthropic/...` IDs even though they exist on the registry — so this gives
 * us a real "will this work" answer instead of a registry sniff.
 *
 * For tests, callers can inject a fake `runOpencodeModels` that returns
 * canned text. See `tests/fixtures/opencode-models-output.txt`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ModelValidationError } from "./errors.js";
import type { StackFile } from "./schema.js";

const execFileAsync = promisify(execFile);

export interface ValidateOptions {
  /**
   * Override the model lister. Defaults to running `opencode models` via
   * `execFile`. Tests pass a static string.
   */
  readonly runOpencodeModels?: () => Promise<string>;
}

export interface MissingModel {
  /** Dotted location inside the stack — e.g., `agents.oracle.model`. */
  readonly path: string;
  /** The unreachable model ID. */
  readonly modelId: string;
}

export interface ValidateResult {
  readonly ok: boolean;
  readonly checked: number;
  readonly missing: ReadonlyArray<MissingModel>;
  /** Models reachable through current auth, parsed from `opencode models`. */
  readonly available: ReadonlySet<string>;
}

const DEFAULT_RUNNER = async (): Promise<string> => {
  const { stdout } = await execFileAsync("opencode", ["api", "model.list"], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
};

/** Parse `opencode models` stdout into a Set of model IDs. */
export function parseModelList(stdout: string): Set<string> {
  const out = new Set<string>();
  if (/^[\[{]/.test(stdout.trimStart())) {
    const parsed = JSON.parse(stdout);
    const models = (Array.isArray(parsed) ? parsed : parsed.data) as Array<{
      providerID: string;
      id: string;
      enabled?: boolean;
      variants?: Array<{ id: string }>;
    }>;
    for (const model of models) {
      if (model.enabled === false) continue;
      const id = `${model.providerID}/${model.id}`;
      out.add(id);
      for (const variant of model.variants ?? []) out.add(`${id}#${variant.id}`);
    }
    return out;
  }
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    out.add(line);
  }
  return out;
}

/** Collect every `(path, modelId)` pair from a stack's `agents` record. */
export function collectModelRefs(stack: StackFile): Array<MissingModel> {
  const refs: Array<MissingModel> = [];
  for (const [k, v] of Object.entries(stack.agents)) {
    refs.push({ path: `agents.${k}.model`, modelId: v.model });
    for (const [index, candidate] of (v.fallbacks ?? []).entries()) {
      refs.push({ path: `agents.${k}.fallbacks.${index}.model`, modelId: candidate.model });
    }
  }
  return refs;
}

/**
 * Validate `stack` against the current opencode model catalogue.
 *
 * Returns a structured result; never throws on validation failure (for use
 * in CLI/plugin contexts that want to format the output themselves).
 */
export async function validateStack(
  stack: StackFile,
  options: ValidateOptions = {},
): Promise<ValidateResult> {
  const runner = options.runOpencodeModels ?? DEFAULT_RUNNER;
  const stdout = await runner();
  const available = parseModelList(stdout);
  const refs = collectModelRefs(stack);
  const missing = refs.filter((r) => !available.has(r.modelId));
  // Legacy text fixtures cannot prove variant availability. V2 JSON catalogs can.
  if (/^[\[{]/.test(stdout.trimStart())) {
    for (const [agent, entry] of Object.entries(stack.agents)) {
      for (const [index, candidate] of [entry, ...(entry.fallbacks ?? [])].entries()) {
        if (!candidate.variant) continue;
        const modelId = `${candidate.model}#${candidate.variant}`;
        if (!available.has(modelId))
          missing.push({
            path:
              index === 0
                ? `agents.${agent}.variant`
                : `agents.${agent}.fallbacks.${index - 1}.variant`,
            modelId,
          });
      }
    }
  }
  return { ok: missing.length === 0, checked: refs.length, missing, available };
}

/**
 * Convenience: validate and throw `ModelValidationError` on failure. Used by
 * the pre-apply gate in `stack-manager.applyStack`.
 */
export async function validateStackOrThrow(
  stackName: string,
  stack: StackFile,
  options: ValidateOptions = {},
): Promise<ValidateResult> {
  const result = await validateStack(stack, options);
  if (!result.ok) throw new ModelValidationError(stackName, result.missing);
  return result;
}
