import { describe, expect, it } from "vitest";
import {
  getFrontmatterModel,
  getFrontmatterOptions,
  setFrontmatterModel,
  setFrontmatterOptions,
} from "../../src/core/frontmatter.js";

const AGENT_MD = `---
description: Strategic advisor
mode: subagent
model: openai/gpt-5.5
temperature: 0.1
tools:
  write: false
---
You are Oracle.
`;

describe("getFrontmatterModel", () => {
  it("extracts the model value", () => {
    expect(getFrontmatterModel(AGENT_MD)).toBe("openai/gpt-5.5");
  });

  it("strips trailing YAML comments", () => {
    const md = AGENT_MD.replace(
      "model: openai/gpt-5.5",
      "model: openai/gpt-5.5   # the ONLY line agent-router touches",
    );
    expect(getFrontmatterModel(md)).toBe("openai/gpt-5.5");
  });

  it("strips quotes", () => {
    const md = AGENT_MD.replace("model: openai/gpt-5.5", 'model: "openai/gpt-5.5"');
    expect(getFrontmatterModel(md)).toBe("openai/gpt-5.5");
  });

  it("returns null without frontmatter", () => {
    expect(getFrontmatterModel("# just a doc\nmodel: nope\n")).toBeNull();
  });

  it("returns null without a model line", () => {
    expect(getFrontmatterModel("---\ndescription: x\n---\nbody\n")).toBeNull();
  });

  it("ignores indented (nested) model keys", () => {
    const md = "---\noptions:\n  model: nested/thing\ndescription: x\n---\nbody\n";
    expect(getFrontmatterModel(md)).toBeNull();
  });

  it("ignores model-like lines in the body", () => {
    const md = "---\ndescription: x\nmodel: real/model\n---\nmodel: body/decoy\n";
    expect(getFrontmatterModel(md)).toBe("real/model");
  });
});

describe("setFrontmatterModel", () => {
  it("replaces only the model line, preserving everything else", () => {
    const next = setFrontmatterModel(AGENT_MD, "anthropic/claude-opus-4-8");
    expect(getFrontmatterModel(next)).toBe("anthropic/claude-opus-4-8");
    expect(next).toContain("description: Strategic advisor");
    expect(next).toContain("You are Oracle.");
    expect(next).toContain("temperature: 0.1");
    expect(next).not.toContain("openai/gpt-5.5");
  });

  it("round-trips: set then get", () => {
    const next = setFrontmatterModel(AGENT_MD, "x/y");
    expect(getFrontmatterModel(next)).toBe("x/y");
  });

  it("is byte-identical outside the model line", () => {
    const next = setFrontmatterModel(AGENT_MD, "a/b");
    const before = AGENT_MD.split("\n").filter((l) => !l.startsWith("model:"));
    const after = next.split("\n").filter((l) => !l.startsWith("model:"));
    expect(after).toEqual(before);
  });

  it("does not interpret $-patterns in the model id", () => {
    const next = setFrontmatterModel(AGENT_MD, "weird/$&$'model");
    expect(next).toContain("model: weird/$&$'model");
  });

  it("throws without frontmatter", () => {
    expect(() => setFrontmatterModel("no frontmatter", "a/b")).toThrow(/frontmatter/);
  });

  it("throws without a model line", () => {
    expect(() => setFrontmatterModel("---\ndescription: x\n---\nbody\n", "a/b")).toThrow(/model/);
  });

  it("keeps a model line in the body untouched", () => {
    const md = "---\nmodel: real/model\n---\nmodel: body/decoy\n";
    const next = setFrontmatterModel(md, "new/model");
    expect(next).toContain("model: body/decoy");
    expect(getFrontmatterModel(next)).toBe("new/model");
  });
});

describe("getFrontmatterOptions", () => {
  it("returns non-reserved, non-model keys", () => {
    expect(getFrontmatterOptions(AGENT_MD)).toEqual({ temperature: 0.1 });
  });

  it("parses scalars, flow objects, and block-style mappings", () => {
    const md = `---
model: a/one
reasoningEffort: high
temperature: 0.7
thinking:
  type: enabled
  budget_tokens: 8000
limits: [1, 2, 3]
---
body
`;
    expect(getFrontmatterOptions(md)).toEqual({
      reasoningEffort: "high",
      temperature: 0.7,
      thinking: { type: "enabled", budget_tokens: 8000 },
      limits: [1, 2, 3],
    });
  });

  it("excludes reserved framework keys", () => {
    const md = "---\ndescription: x\nmode: subagent\npermission:\n  edit: deny\nmodel: a/b\n---\n";
    expect(getFrontmatterOptions(md)).toEqual({});
  });

  it("returns {} without frontmatter or when malformed", () => {
    expect(getFrontmatterOptions("no frontmatter")).toEqual({});
    expect(getFrontmatterOptions("---\n: : :\n---\n")).toEqual({});
  });
});

describe("setFrontmatterOptions", () => {
  it("replaces an existing scalar option in place", () => {
    const next = setFrontmatterOptions(AGENT_MD, { temperature: 0.9 });
    expect(getFrontmatterOptions(next).temperature).toBe(0.9);
    expect(next).toContain("description: Strategic advisor");
    expect(next).toContain("You are Oracle.");
  });

  it("appends a new option key at the end of the block", () => {
    const next = setFrontmatterOptions(AGENT_MD, { reasoningEffort: "high" });
    expect(getFrontmatterOptions(next).reasoningEffort).toBe("high");
    // appended after the last existing key (tools block), before closing ---
    expect(next).toContain("reasoningEffort: high");
  });

  it("replaces a block-style mapping value with a single flow line", () => {
    const md = `---
model: a/one
thinking:
  type: enabled
  budget_tokens: 8000
---
body
`;
    const next = setFrontmatterOptions(md, { thinking: { effort: "low" } });
    expect(getFrontmatterOptions(next).thinking).toEqual({ effort: "low" });
    // the old indented child lines are gone
    expect(next).not.toContain("budget_tokens: 8000");
    expect(next).not.toContain("  type: enabled");
  });

  it("removes a key when the value is null", () => {
    const next = setFrontmatterOptions(AGENT_MD, { temperature: null });
    expect(getFrontmatterOptions(next)).toEqual({});
    expect(next).not.toContain("temperature:");
  });

  it("serializes objects as JSON flow (valid YAML)", () => {
    const next = setFrontmatterOptions(AGENT_MD, {
      thinking: { type: "enabled", budget_tokens: 8000 },
    });
    expect(getFrontmatterOptions(next).thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
  });

  it("quotes strings that would otherwise be coerced (e.g. 'true')", () => {
    const next = setFrontmatterOptions(AGENT_MD, { reasoningEffort: "true" });
    expect(getFrontmatterOptions(next).reasoningEffort).toBe("true");
  });

  it("returns the same content reference when options is empty", () => {
    expect(setFrontmatterOptions(AGENT_MD, {})).toBe(AGENT_MD);
  });

  it("returns the same content reference when nothing would change", () => {
    const md = "---\nmodel: a/one\nreasoningEffort: high\n---\nbody\n";
    expect(setFrontmatterOptions(md, { reasoningEffort: "high" })).toBe(md);
  });

  it("is byte-identical outside touched option/model lines", () => {
    const next = setFrontmatterOptions(AGENT_MD, { reasoningEffort: "high", temperature: 0.5 });
    const filter = (l: string) =>
      !l.startsWith("model:") && !l.startsWith("temperature:") && !l.startsWith("reasoningEffort:");
    expect(next.split("\n").filter(filter)).toEqual(AGENT_MD.split("\n").filter(filter));
  });

  it("does not interpret $-patterns in values", () => {
    const next = setFrontmatterOptions(AGENT_MD, { note: "weird/$&$'value" });
    // The value contains a single quote, so the serializer safely double-quotes
    // it — but the key assertion is that `$&` / `$'` are NOT interpreted as
    // regex backreferences (we splice, not replace). The literal value survives.
    expect(next).toContain("weird/$&$'value");
  });

  it("throws without frontmatter", () => {
    expect(() => setFrontmatterOptions("no frontmatter", { x: 1 })).toThrow(/frontmatter/);
  });
});
