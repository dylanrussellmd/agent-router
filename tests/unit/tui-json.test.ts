import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PLUGIN_REGISTRY_ENTRY,
  ensureTuiJsonPluginEntry,
  readTuiJson,
} from "../../src/core/opencode-config.js";

describe("ensureTuiJsonPluginEntry", () => {
  let dir: string;
  let tuiJsonPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "omo-tui-json-"));
    tuiJsonPath = path.join(dir, "tui.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates tui.json with schema and plugin entry when absent", async () => {
    const result = await ensureTuiJsonPluginEntry(tuiJsonPath);
    expect(result.added).toBe(true);

    const written = JSON.parse(await readFile(tuiJsonPath, "utf8"));
    expect(written.$schema).toBe("https://opencode.ai/config.json");
    expect(written.plugin).toEqual([PLUGIN_REGISTRY_ENTRY]);
  });

  it("appends to an existing plugin array without touching other keys", async () => {
    await writeFile(
      tuiJsonPath,
      JSON.stringify({ theme: "tokyonight", plugin: ["oh-my-openagent@latest"] }),
    );

    const result = await ensureTuiJsonPluginEntry(tuiJsonPath);
    expect(result.added).toBe(true);

    const written = JSON.parse(await readFile(tuiJsonPath, "utf8"));
    expect(written.theme).toBe("tokyonight");
    expect(written.plugin).toEqual(["oh-my-openagent@latest", PLUGIN_REGISTRY_ENTRY]);
  });

  it("is idempotent", async () => {
    await ensureTuiJsonPluginEntry(tuiJsonPath);
    const second = await ensureTuiJsonPluginEntry(tuiJsonPath);
    expect(second.added).toBe(false);

    const written = JSON.parse(await readFile(tuiJsonPath, "utf8"));
    expect(written.plugin).toEqual([PLUGIN_REGISTRY_ENTRY]);
  });

  it("treats a versioned entry for the same package as present", async () => {
    await writeFile(tuiJsonPath, JSON.stringify({ plugin: ["@dylanrussell/omo-router@0.1.0"] }));

    const result = await ensureTuiJsonPluginEntry(tuiJsonPath);
    expect(result.added).toBe(false);
  });

  it("readTuiJson returns null when absent and rejects invalid JSON", async () => {
    expect(await readTuiJson(tuiJsonPath)).toBeNull();

    await writeFile(tuiJsonPath, "nope");
    await expect(readTuiJson(tuiJsonPath)).rejects.toThrow(/not valid JSON/);
  });
});
