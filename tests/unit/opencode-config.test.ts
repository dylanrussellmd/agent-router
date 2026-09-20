import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_PLUGIN_NPM_NAME,
  PLUGIN_REGISTRY_ENTRY,
  ensurePluginEntry,
  ensureTuiJsonPluginEntry,
  readOpencodeJson,
  removePluginEntry,
  writeOpencodeJson,
} from "../../src/core/opencode-config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ar-occfg-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ensurePluginEntry", () => {
  it("preserves V2 package options and recognizes version-pinned object entries", () => {
    const input = {
      plugins: [{ package: "@dylanrussell/agent-router@2.0.0", options: { custom: true } }],
    };
    expect(ensurePluginEntry(input).config).toEqual(input);
    expect(ensurePluginEntry(input).result.added).toBe(false);
  });
  it("adds the entry when absent", () => {
    const { config, result } = ensurePluginEntry({ plugin: ["other@latest"] });
    expect(result.added).toBe(true);
    expect(config.plugins).toEqual(["other@latest", PLUGIN_REGISTRY_ENTRY]);
  });

  it("is idempotent", () => {
    const first = ensurePluginEntry({ plugin: [] });
    const second = ensurePluginEntry(first.config);
    expect(second.result.added).toBe(false);
    expect(second.config.plugins).toEqual(first.config.plugins);
  });

  it("treats version-pinned entries as present", () => {
    const { result } = ensurePluginEntry({
      plugin: ["@dylanrussell/agent-router@1.0.0"],
    });
    expect(result.added).toBe(false);
  });

  it("creates the plugin array when missing", () => {
    const { config } = ensurePluginEntry({});
    expect(config.plugins).toEqual([PLUGIN_REGISTRY_ENTRY]);
  });
});

describe("removePluginEntry", () => {
  it("removes the legacy omo-router entry regardless of version tag", () => {
    const { config, result } = removePluginEntry({
      plugin: ["@dylanrussell/omo-router@latest", "keep@latest"],
    });
    expect(result.removed).toEqual(["@dylanrussell/omo-router@latest"]);
    expect(config.plugin).toEqual(["keep@latest"]);
  });

  it("no-ops when absent", () => {
    const input = { plugin: ["keep@latest"] };
    const { config, result } = removePluginEntry(input);
    expect(result.removed).toEqual([]);
    expect(config).toBe(input);
  });

  it("removes an arbitrary named package", () => {
    const { config } = removePluginEntry({ plugin: ["foo@1.2.3", "bar"] }, "foo");
    expect(config.plugin).toEqual(["bar"]);
  });

  it("exports the legacy name it targets by default", () => {
    expect(LEGACY_PLUGIN_NPM_NAME).toBe("@dylanrussell/omo-router");
  });
});

describe("read/writeOpencodeJson", () => {
  it("returns null for a missing file", async () => {
    expect(await readOpencodeJson(path.join(dir, "nope.json"))).toBeNull();
  });

  it("preserves unrelated keys through a round-trip", async () => {
    const p = path.join(dir, "opencode.json");
    writeFileSync(
      p,
      JSON.stringify({
        plugin: ["a"],
        default_agent: "Omni",
        provider: { openrouter: { models: { x: {} } } },
      }),
    );
    const cfg = await readOpencodeJson(p);
    expect(cfg).not.toBeNull();
    const { config } = ensurePluginEntry(cfg ?? {});
    await writeOpencodeJson(p, config);
    const after = JSON.parse(readFileSync(p, "utf8"));
    expect(after.default_agent).toBe("Omni");
    expect(after.provider.openrouter.models.x).toEqual({});
    expect(after.plugins).toContain(PLUGIN_REGISTRY_ENTRY);
  });
});

describe("ensureTuiJsonPluginEntry", () => {
  it("creates tui.json when absent", async () => {
    const p = path.join(dir, "tui.json");
    const result = await ensureTuiJsonPluginEntry(p);
    expect(result.added).toBe(true);
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    expect(parsed.plugins).toEqual([PLUGIN_REGISTRY_ENTRY]);
    expect(parsed.$schema).toBeDefined();
  });

  it("is idempotent", async () => {
    const p = path.join(dir, "tui.json");
    await ensureTuiJsonPluginEntry(p);
    const second = await ensureTuiJsonPluginEntry(p);
    expect(second.added).toBe(false);
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    expect(parsed.plugins).toHaveLength(1);
  });

  it("swaps the legacy omo-router entry for the new one", async () => {
    const p = path.join(dir, "tui.json");
    writeFileSync(p, JSON.stringify({ plugin: ["@dylanrussell/omo-router@latest"] }));
    await ensureTuiJsonPluginEntry(p);
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    expect(parsed.plugins).toEqual([PLUGIN_REGISTRY_ENTRY]);
  });
});
