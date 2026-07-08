import { describe, expect, it } from "vitest";
import type { StackFile } from "../../src/core/schema.js";
import {
  applyModelEdit,
  collectHostModels,
  listModelTargets,
  targetLabel,
} from "../../src/tui/actions.js";

const stack: StackFile = {
  $schema: "https://example.com/schema.json",
  agents: {
    oracle: {
      model: "anthropic/claude-opus-4-7",
      fallback_models: [{ model: "openrouter/openai/gpt-5.4" }],
      temperature: 0.2,
    },
    sisyphus: { model: "anthropic/claude-sonnet-4-6" },
  },
  categories: {
    quick: { model: "google/gemini-2.5-flash" },
  },
} as StackFile;

describe("listModelTargets", () => {
  it("walks agents then categories with fallback counts", () => {
    const targets = listModelTargets(stack);
    expect(targets.map((t) => targetLabel(t.ref))).toEqual([
      "agents.oracle",
      "agents.sisyphus",
      "categories.quick",
    ]);
    expect(targets[0].fallbackCount).toBe(1);
    expect(targets[1].fallbackCount).toBe(0);
    expect(targets[2].model).toBe("google/gemini-2.5-flash");
  });

  it("handles stacks with only categories", () => {
    const only: StackFile = { categories: { deep: { model: "x/y" } } } as StackFile;
    expect(listModelTargets(only)).toHaveLength(1);
  });
});

describe("applyModelEdit", () => {
  it("replaces the primary model and preserves everything else", () => {
    const edited = applyModelEdit(stack, { kind: "agents", key: "oracle" }, "new/model");
    expect(edited.agents?.oracle.model).toBe("new/model");
    expect(edited.agents?.oracle.fallback_models).toEqual([{ model: "openrouter/openai/gpt-5.4" }]);
    expect((edited.agents?.oracle as Record<string, unknown>).temperature).toBe(0.2);
    expect((edited as Record<string, unknown>).$schema).toBe("https://example.com/schema.json");
    expect(edited.agents?.sisyphus.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("does not mutate the input stack", () => {
    applyModelEdit(stack, { kind: "categories", key: "quick" }, "new/model");
    expect(stack.categories?.quick.model).toBe("google/gemini-2.5-flash");
  });

  it("throws for a missing entry", () => {
    expect(() => applyModelEdit(stack, { kind: "agents", key: "nope" }, "m")).toThrow(
      /agents\.nope/,
    );
  });
});

describe("collectHostModels", () => {
  it("extracts provider/model ids from record-shaped models", () => {
    const providers = [
      { id: "anthropic", models: { "claude-opus-4-7": {}, "claude-sonnet-4-6": {} } },
      { id: "openrouter", models: { "openai/gpt-5.4": {} } },
    ];
    expect(collectHostModels(providers)).toEqual([
      "anthropic/claude-opus-4-7",
      "anthropic/claude-sonnet-4-6",
      "openrouter/openai/gpt-5.4",
    ]);
  });

  it("extracts from array-shaped models with id fields", () => {
    const providers = [{ id: "p", models: [{ id: "m1" }, "m2"] }];
    expect(collectHostModels(providers)).toEqual(["p/m1", "p/m2"]);
  });

  it("returns empty for garbage input", () => {
    expect(collectHostModels(undefined)).toEqual([]);
    expect(collectHostModels("nope")).toEqual([]);
    expect(collectHostModels([null, {}, { id: 3 }])).toEqual([]);
  });
});
