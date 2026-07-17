import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliFixture, setupCliFixture } from "./helpers.js";

let fx: CliFixture;

beforeEach(() => {
  fx = setupCliFixture();
});

afterEach(() => {
  fx.cleanup();
});

describe("agent-router init", () => {
  it("captures current models into a default stack and registers the plugin", () => {
    const r = fx.run("init");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("captured 2 agents");

    const stack = JSON.parse(readFileSync(path.join(fx.stacksDir, "default.json"), "utf8"));
    expect(stack.agents).toEqual({
      Omni: { model: "a/one", temperature: 0.1 },
      oracle: { model: "b/two", temperature: 0.1 },
    });

    const opencodeJson = JSON.parse(
      readFileSync(path.join(fx.opencodeConfigDir, "opencode.json"), "utf8"),
    );
    expect(opencodeJson.plugin).toContain("@dylanrussell/agent-router@latest");
    expect(opencodeJson.plugin).not.toContain("@dylanrussell/omo-router@latest");
    expect(opencodeJson.default_agent).toBe("Omni");

    const tuiJson = JSON.parse(readFileSync(path.join(fx.opencodeConfigDir, "tui.json"), "utf8"));
    expect(tuiJson.plugin).toContain("@dylanrussell/agent-router@latest");

    expect(existsSync(path.join(fx.routerHome, "history"))).toBe(true);
  });

  it("is idempotent", () => {
    expect(fx.run("init").status).toBe(0);
    const second = fx.run("init");
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already initialized");
    const opencodeJson = JSON.parse(
      readFileSync(path.join(fx.opencodeConfigDir, "opencode.json"), "utf8"),
    );
    expect(opencodeJson.plugin.filter((p: string) => p.includes("agent-router"))).toHaveLength(1);
  });

  it("--no-edit-opencode-json leaves configs alone", () => {
    const r = fx.run("init", "--no-edit-opencode-json");
    expect(r.status).toBe(0);
    const opencodeJson = JSON.parse(
      readFileSync(path.join(fx.opencodeConfigDir, "opencode.json"), "utf8"),
    );
    expect(opencodeJson.plugin).toEqual(["@dylanrussell/omo-router@latest"]);
    expect(existsSync(path.join(fx.opencodeConfigDir, "tui.json"))).toBe(false);
  });
});

describe("agent-router list/status/show/current", () => {
  it("list shows the active marker", () => {
    fx.run("init");
    const r = fx.run("list");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("* default");
  });

  it("list hints when no stacks exist", () => {
    const r = fx.run("list");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no stacks");
  });

  it("status prints the active name or (none)", () => {
    expect(fx.run("status").stdout.trim()).toBe("(none)");
    fx.run("init");
    expect(fx.run("status").stdout.trim()).toBe("default");
  });

  it("show pretty-prints a stack", () => {
    fx.run("init");
    const r = fx.run("show", "default");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).agents.Omni.model).toBe("a/one");
  });

  it("show for a missing stack exits 2", () => {
    fx.run("init");
    const r = fx.run("show", "ghost");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not found");
  });

  it("current prints the frontmatter mapping", () => {
    const r = fx.run("current");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Omni");
    expect(r.stdout).toContain("a/one");
    expect(r.stdout).toContain("oracle");
  });

  it("path prints every resolved path", () => {
    const r = fx.run("path");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(fx.routerHome);
    expect(r.stdout).toContain(fx.agentsDir);
  });
});
