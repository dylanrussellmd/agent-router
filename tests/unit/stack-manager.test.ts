import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentFileError,
  ModelValidationError,
  StackNotFoundError,
  UserError,
  ValidationError,
} from "../../src/core/errors.js";
import { getFrontmatterModel, getFrontmatterOptions } from "../../src/core/frontmatter.js";
import { listHistory } from "../../src/core/history.js";
import type { RouterPaths } from "../../src/core/paths.js";
import { resolvePaths } from "../../src/core/paths.js";
import {
  applyStack,
  back,
  captureStack,
  exportStack,
  getActiveStackName,
  importStack,
  listStacks,
  readStack,
  removeStack,
  stackPath,
} from "../../src/core/stack-manager.js";
import { readState } from "../../src/core/state.js";

const ALLOW_ALL = { runOpencodeModels: async () => "a/one\nb/two\nc/three\n" };

function agentMd(model: string, name: string): string {
  return `---\ndescription: ${name} agent\nmode: subagent\nmodel: ${model}\ntemperature: 0.1\n---\nYou are ${name}.\n`;
}

let root: string;
let paths: RouterPaths;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "ar-sm-"));
  paths = resolvePaths({
    opencodeConfigDir: path.join(root, "opencode"),
    routerHome: path.join(root, "router"),
    agentsDir: path.join(root, "agents"),
    env: {},
  });
  mkdirSync(paths.agentsDir, { recursive: true });
  mkdirSync(paths.stacksDir, { recursive: true });
  writeFileSync(path.join(paths.agentsDir, "Omni.md"), agentMd("a/one", "Omni"));
  writeFileSync(path.join(paths.agentsDir, "oracle.md"), agentMd("b/two", "oracle"));
  writeFileSync(path.join(paths.agentsDir, "notes.md"), "# not an agent\n");
  writeFileSync(
    stackPath(paths, "cheap"),
    JSON.stringify({ agents: { Omni: { model: "c/three" }, oracle: { model: "c/three" } } }),
  );
  writeFileSync(
    stackPath(paths, "premium"),
    JSON.stringify({ agents: { Omni: { model: "a/one" }, oracle: { model: "b/two" } } }),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function agentModel(name: string): string | null {
  return getFrontmatterModel(readFileSync(path.join(paths.agentsDir, `${name}.md`), "utf8"));
}

function agentOptions(name: string): Record<string, unknown> {
  return getFrontmatterOptions(readFileSync(path.join(paths.agentsDir, `${name}.md`), "utf8"));
}

function agentRaw(name: string): string {
  return readFileSync(path.join(paths.agentsDir, `${name}.md`), "utf8");
}

describe("listStacks / readStack", () => {
  it("lists stack names sorted", async () => {
    expect(await listStacks(paths)).toEqual(["cheap", "premium"]);
  });

  it("returns [] for a missing stacks dir", async () => {
    const p = resolvePaths({ stacksDir: path.join(root, "missing"), env: {} });
    expect(await listStacks(p)).toEqual([]);
  });

  it("throws StackNotFoundError with available names", async () => {
    await expect(readStack(paths, "ghost")).rejects.toBeInstanceOf(StackNotFoundError);
  });

  it("throws ValidationError for malformed stacks", async () => {
    writeFileSync(stackPath(paths, "broken"), "{nope");
    await expect(readStack(paths, "broken")).rejects.toBeInstanceOf(ValidationError);
    writeFileSync(stackPath(paths, "empty"), JSON.stringify({ agents: {} }));
    await expect(readStack(paths, "empty")).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("applyStack", () => {
  it("rewrites frontmatter models and updates state", async () => {
    const r = await applyStack(paths, "cheap", { validateOptions: ALLOW_ALL });
    expect(r.current).toBe("cheap");
    expect(r.previous).toBeNull();
    expect([...r.changed].sort()).toEqual(["Omni", "oracle"]);
    expect(r.restartRequired).toBe(true);
    expect(agentModel("Omni")).toBe("c/three");
    expect(agentModel("oracle")).toBe("c/three");
    expect(await getActiveStackName(paths)).toBe("cheap");
  });

  it("preserves the rest of the agent file byte-for-byte", async () => {
    const before = readFileSync(path.join(paths.agentsDir, "oracle.md"), "utf8");
    await applyStack(paths, "cheap", { validateOptions: ALLOW_ALL });
    const after = readFileSync(path.join(paths.agentsDir, "oracle.md"), "utf8");
    expect(after.split("\n").filter((l) => !l.startsWith("model:"))).toEqual(
      before.split("\n").filter((l) => !l.startsWith("model:")),
    );
  });

  it("skips writes for agents already on the target model", async () => {
    const r = await applyStack(paths, "premium", { validateOptions: ALLOW_ALL });
    expect(r.changed).toEqual([]);
  });

  it("fails strictly when an agent file is missing — nothing written", async () => {
    writeFileSync(
      stackPath(paths, "ghostly"),
      JSON.stringify({ agents: { Omni: { model: "c/three" }, ghost: { model: "c/three" } } }),
    );
    await expect(
      applyStack(paths, "ghostly", { validateOptions: ALLOW_ALL }),
    ).rejects.toBeInstanceOf(AgentFileError);
    expect(agentModel("Omni")).toBe("a/one");
    expect(await getActiveStackName(paths)).toBeNull();
  });

  it("fails strictly when an agent file has no model line", async () => {
    writeFileSync(path.join(paths.agentsDir, "modelless.md"), "---\ndescription: x\n---\nbody\n");
    writeFileSync(
      stackPath(paths, "nomodel"),
      JSON.stringify({ agents: { modelless: { model: "a/one" } } }),
    );
    await expect(
      applyStack(paths, "nomodel", { validateOptions: ALLOW_ALL }),
    ).rejects.toBeInstanceOf(AgentFileError);
  });

  it("gates on model validation by default", async () => {
    writeFileSync(
      stackPath(paths, "unreachable"),
      JSON.stringify({ agents: { Omni: { model: "not/real" } } }),
    );
    await expect(
      applyStack(paths, "unreachable", { validateOptions: ALLOW_ALL }),
    ).rejects.toBeInstanceOf(ModelValidationError);
    expect(agentModel("Omni")).toBe("a/one");
  });

  it("bypasses the gate with validate:false or forceInvalid", async () => {
    writeFileSync(
      stackPath(paths, "unreachable"),
      JSON.stringify({ agents: { Omni: { model: "not/real" } } }),
    );
    const r = await applyStack(paths, "unreachable", {
      validate: false,
      validateOptions: ALLOW_ALL,
    });
    expect(r.current).toBe("unreachable");
    const r2 = await applyStack(paths, "premium", {
      forceInvalid: true,
      validateOptions: ALLOW_ALL,
    });
    expect(r2.current).toBe("premium");
  });

  it("records the displaced mapping in history (capture-shaped)", async () => {
    await applyStack(paths, "cheap", { validateOptions: ALLOW_ALL });
    const entries = await listHistory(paths.historyDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.fromStack).toBe("(none)");
    expect(entries[0]?.toStack).toBe("cheap");
    const content = JSON.parse(readFileSync(entries[0]?.path ?? "", "utf8"));
    expect(content.agents.Omni.model).toBe("a/one");
    expect(content.agents.oracle.model).toBe("b/two");
    expect(content.agents.notes).toBeUndefined();
  });

  it("tracks previousActive across switches", async () => {
    await applyStack(paths, "premium", { validateOptions: ALLOW_ALL });
    await applyStack(paths, "cheap", { validateOptions: ALLOW_ALL });
    const state = await readState(paths.statePath);
    expect(state?.active).toBe("cheap");
    expect(state?.previousActive).toBe("premium");
  });
});

describe("back", () => {
  it("reverts to the previous stack", async () => {
    await applyStack(paths, "premium", { validateOptions: ALLOW_ALL });
    await applyStack(paths, "cheap", { validateOptions: ALLOW_ALL });
    const r = await back(paths, 1, { validateOptions: ALLOW_ALL });
    expect(r.current).toBe("premium");
    expect(agentModel("Omni")).toBe("a/one");
  });

  it("throws UserError with no previous stack", async () => {
    await expect(back(paths, 1)).rejects.toBeInstanceOf(UserError);
  });

  it("walks history for n > 1", async () => {
    await applyStack(paths, "premium", { validateOptions: ALLOW_ALL });
    await new Promise((r) => setTimeout(r, 5));
    await applyStack(paths, "cheap", { validateOptions: ALLOW_ALL });
    await new Promise((r) => setTimeout(r, 5));
    await applyStack(paths, "premium", { validateOptions: ALLOW_ALL });
    const r = await back(paths, 2, { validateOptions: ALLOW_ALL });
    expect(r.current).toBe("premium");
  });

  it("rejects n beyond history depth", async () => {
    await applyStack(paths, "premium", { validateOptions: ALLOW_ALL });
    await applyStack(paths, "cheap", { validateOptions: ALLOW_ALL });
    await expect(back(paths, 99, { validateOptions: ALLOW_ALL })).rejects.toBeInstanceOf(UserError);
  });
});

describe("captureStack", () => {
  it("snapshots current frontmatter models, skipping non-agent files", async () => {
    const r = await captureStack(paths, "snap");
    expect(r.agents).toBe(2);
    const stack = await readStack(paths, "snap");
    // The fixture's `temperature: 0.1` is a provider option, so capture now
    // transcribes it alongside model. Reserved keys (description/mode) are not.
    expect(stack.agents).toEqual({
      Omni: { model: "a/one", temperature: 0.1 },
      oracle: { model: "b/two", temperature: 0.1 },
    });
  });

  it("refuses to overwrite without force", async () => {
    await captureStack(paths, "snap");
    await expect(captureStack(paths, "snap")).rejects.toBeInstanceOf(UserError);
    await expect(captureStack(paths, "snap", { force: true })).resolves.toBeDefined();
  });

  it("rejects invalid names", async () => {
    await expect(captureStack(paths, "bad name!")).rejects.toBeInstanceOf(UserError);
  });

  it("throws when no agents are found", async () => {
    const p = resolvePaths({
      agentsDir: path.join(root, "empty-agents"),
      stacksDir: paths.stacksDir,
      routerHome: paths.routerHome,
      env: {},
    });
    mkdirSync(p.agentsDir, { recursive: true });
    await expect(captureStack(p, "nothing")).rejects.toBeInstanceOf(UserError);
  });
});

describe("applyStack — option transcription", () => {
  it("writes option keys from the stack entry into frontmatter", async () => {
    writeFileSync(
      stackPath(paths, "effort"),
      JSON.stringify({
        agents: {
          Omni: { model: "a/one", reasoningEffort: "high", thinking: { budget_tokens: 8000 } },
        },
      }),
    );
    await applyStack(paths, "effort", { validateOptions: ALLOW_ALL });
    expect(agentModel("Omni")).toBe("a/one");
    expect(agentOptions("Omni")).toMatchObject({
      temperature: 0.1, // preserved — stack didn't name it
      reasoningEffort: "high",
      thinking: { budget_tokens: 8000 },
    });
  });

  it("does not write reserved framework keys even if present in the stack entry", async () => {
    writeFileSync(
      stackPath(paths, "reserved"),
      JSON.stringify({
        agents: {
          Omni: { model: "a/one", description: "should not clobber", permission: { edit: "deny" } },
        },
      }),
    );
    await applyStack(paths, "reserved", { validateOptions: ALLOW_ALL });
    expect(agentOptions("Omni")).not.toHaveProperty("description");
    expect(agentOptions("Omni")).not.toHaveProperty("permission");
    // original description line intact
    expect(agentRaw("Omni")).toContain("description: Omni agent");
  });

  it("removes an option when the stack entry sets it to null", async () => {
    // Seed temperature-free agent via a stack that sets temperature then nulls it.
    writeFileSync(
      stackPath(paths, "set"),
      JSON.stringify({ agents: { oracle: { model: "b/two", reasoningEffort: "high" } } }),
    );
    await applyStack(paths, "set", { validateOptions: ALLOW_ALL });
    expect(agentOptions("oracle").reasoningEffort).toBe("high");
    writeFileSync(
      stackPath(paths, "clear"),
      JSON.stringify({ agents: { oracle: { model: "b/two", reasoningEffort: null } } }),
    );
    await applyStack(paths, "clear", { validateOptions: ALLOW_ALL });
    expect(agentOptions("oracle")).not.toHaveProperty("reasoningEffort");
  });

  it("leaves existing options untouched when the stack entry has none", async () => {
    writeFileSync(
      stackPath(paths, "modelonly"),
      JSON.stringify({ agents: { Omni: { model: "b/two" } } }),
    );
    await applyStack(paths, "modelonly", { validateOptions: ALLOW_ALL });
    expect(agentModel("Omni")).toBe("b/two");
    // temperature: 0.1 from fixture survives a model-only stack
    expect(agentOptions("Omni")).toMatchObject({ temperature: 0.1 });
  });

  it("is idempotent: applying the same stack twice writes nothing the second time", async () => {
    writeFileSync(
      stackPath(paths, "idem"),
      JSON.stringify({ agents: { Omni: { model: "b/two", reasoningEffort: "high" } } }),
    );
    const first = await applyStack(paths, "idem", { validateOptions: ALLOW_ALL });
    expect(first.changed).toEqual(["Omni"]);
    const second = await applyStack(paths, "idem", { validateOptions: ALLOW_ALL });
    expect(second.changed).toEqual([]);
  });

  it("preserves everything outside touched option/model lines byte-for-byte", async () => {
    const before = agentRaw("oracle");
    writeFileSync(
      stackPath(paths, "touch"),
      JSON.stringify({ agents: { oracle: { model: "b/two", reasoningEffort: "medium" } } }),
    );
    await applyStack(paths, "touch", { validateOptions: ALLOW_ALL });
    const after = agentRaw("oracle");
    const filter = (l: string) =>
      !l.startsWith("model:") && !l.startsWith("reasoningEffort:") && !l.startsWith("temperature:");
    expect(after.split("\n").filter(filter)).toEqual(before.split("\n").filter(filter));
  });

  it("capture then apply round-trips options", async () => {
    // Seed options via apply, then capture and re-apply on a clean agent.
    writeFileSync(
      stackPath(paths, "seed"),
      JSON.stringify({
        agents: {
          oracle: { model: "b/two", reasoningEffort: "high", thinking: { effort: "low" } },
        },
      }),
    );
    await applyStack(paths, "seed", { validateOptions: ALLOW_ALL });
    await captureStack(paths, "roundtrip", { force: true });
    const captured = await readStack(paths, "roundtrip");
    expect(captured.agents.oracle).toMatchObject({
      model: "b/two",
      reasoningEffort: "high",
      thinking: { effort: "low" },
      temperature: 0.1,
    });
    // Wipe options by nulling, then re-apply captured stack to restore them.
    writeFileSync(
      stackPath(paths, "wipe"),
      JSON.stringify({
        agents: {
          oracle: { model: "b/two", reasoningEffort: null, thinking: null, temperature: null },
        },
      }),
    );
    await applyStack(paths, "wipe", { validateOptions: ALLOW_ALL });
    expect(agentOptions("oracle")).toEqual({});
    await applyStack(paths, "roundtrip", { validateOptions: ALLOW_ALL });
    expect(agentOptions("oracle")).toMatchObject({
      reasoningEffort: "high",
      thinking: { effort: "low" },
      temperature: 0.1,
    });
  });
});

describe("removeStack / importStack / exportStack", () => {
  it("removes a non-active stack", async () => {
    await removeStack(paths, "cheap");
    expect(await listStacks(paths)).toEqual(["premium"]);
  });

  it("refuses to remove the active stack without force", async () => {
    await applyStack(paths, "cheap", { validateOptions: ALLOW_ALL });
    await expect(removeStack(paths, "cheap")).rejects.toBeInstanceOf(UserError);
    await removeStack(paths, "cheap", { force: true });
    expect(await listStacks(paths)).toEqual(["premium"]);
  });

  it("imports and exports byte-identical copies", async () => {
    const src = path.join(root, "incoming.json");
    writeFileSync(src, JSON.stringify({ agents: { Omni: { model: "b/two" } } }));
    await importStack(paths, "imported", src);
    expect((await readStack(paths, "imported")).agents.Omni?.model).toBe("b/two");

    const out = path.join(root, "exported", "out.json");
    await exportStack(paths, "imported", out);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8")).toBe(readFileSync(src, "utf8"));
  });

  it("import refuses to overwrite without force", async () => {
    const src = path.join(root, "incoming.json");
    writeFileSync(src, JSON.stringify({ agents: { Omni: { model: "b/two" } } }));
    await expect(importStack(paths, "premium", src)).rejects.toBeInstanceOf(UserError);
    await importStack(paths, "premium", src, { force: true });
  });
});
