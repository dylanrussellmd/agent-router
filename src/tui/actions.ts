/**
 * Pure logic behind the TUI dialogs — no opentui/api access, fully
 * unit-testable. Dialog flows in dialogs.ts call these.
 */

import type { ModelEntry, StackFile } from "../core/schema.js";

export interface StackEntryRef {
  readonly kind: "agents" | "categories";
  readonly key: string;
}

export interface ModelTarget {
  readonly ref: StackEntryRef;
  readonly model: string;
  readonly fallbackCount: number;
}

export function targetLabel(ref: StackEntryRef): string {
  return `${ref.kind}.${ref.key}`;
}

export function listModelTargets(stack: StackFile): ModelTarget[] {
  const out: ModelTarget[] = [];
  const walk = (kind: StackEntryRef["kind"], entries?: Record<string, ModelEntry>) => {
    for (const [key, entry] of Object.entries(entries ?? {})) {
      out.push({
        ref: { kind, key },
        model: entry.model,
        fallbackCount: entry.fallback_models?.length ?? 0,
      });
    }
  };
  walk("agents", stack.agents);
  walk("categories", stack.categories);
  return out;
}

/**
 * Replace the primary model of one entry, preserving every other key
 * (fallbacks, variants, unknown passthrough fields) untouched.
 */
export function applyModelEdit(stack: StackFile, ref: StackEntryRef, model: string): StackFile {
  const group = stack[ref.kind];
  const entry = group?.[ref.key];
  if (!group || !entry) {
    throw new Error(`No entry "${targetLabel(ref)}" in stack`);
  }
  return {
    ...stack,
    [ref.kind]: {
      ...group,
      [ref.key]: { ...entry, model },
    },
  };
}

/**
 * Extract `provider/model` IDs from the TUI host's provider catalog
 * (`api.state.provider`). Shape-defensive: the SDK type evolves, so treat it
 * as unknown and pull only what looks right. Returns [] when nothing usable.
 */
export function collectHostModels(providers: unknown): string[] {
  if (!Array.isArray(providers)) return [];
  const out = new Set<string>();
  for (const provider of providers) {
    if (typeof provider !== "object" || provider === null) continue;
    const record = provider as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : undefined;
    if (!id) continue;
    const models = record.models;
    if (Array.isArray(models)) {
      for (const m of models) {
        if (typeof m === "string") out.add(`${id}/${m}`);
        else if (typeof m === "object" && m !== null) {
          const mid = (m as Record<string, unknown>).id;
          if (typeof mid === "string") out.add(`${id}/${mid}`);
        }
      }
    } else if (typeof models === "object" && models !== null) {
      for (const key of Object.keys(models)) out.add(`${id}/${key}`);
    }
  }
  return [...out].sort();
}
