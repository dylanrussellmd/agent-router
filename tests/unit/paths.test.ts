import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePaths } from "../../src/core/paths.js";

describe("resolvePaths", () => {
  it("derives everything from XDG_CONFIG_HOME by default", () => {
    const p = resolvePaths({ env: { XDG_CONFIG_HOME: "/x" } });
    expect(p.opencodeConfigDir).toBe("/x/opencode");
    expect(p.opencodeJsonPath).toBe("/x/opencode/opencode.json");
    expect(p.tuiJsonPath).toBe("/x/opencode/cli.json");
    expect(p.agentsDir).toBe("/x/opencode/agents");
    expect(p.routerHome).toBe("/x/opencode/agent-router");
    expect(p.statePath).toBe("/x/opencode/agent-router/state.json");
    expect(p.stacksDir).toBe("/x/opencode/agent-router/stacks");
    expect(p.historyDir).toBe("/x/opencode/agent-router/history");
    expect(p.opencodeBackupsDir).toBe("/x/opencode/.backups");
  });

  it("falls back to ~/.config without XDG_CONFIG_HOME", () => {
    const p = resolvePaths({ env: {} });
    expect(p.opencodeConfigDir).toContain(path.join(".config", "opencode"));
  });

  it("AGENT_ROUTER_HOME overrides routerHome (and stacksDir follows)", () => {
    const p = resolvePaths({ env: { XDG_CONFIG_HOME: "/x", AGENT_ROUTER_HOME: "/rh" } });
    expect(p.routerHome).toBe("/rh");
    expect(p.statePath).toBe("/rh/state.json");
    expect(p.stacksDir).toBe("/rh/stacks");
  });

  it("legacy OMO_ROUTER_HOME still works as a fallback", () => {
    const p = resolvePaths({ env: { XDG_CONFIG_HOME: "/x", OMO_ROUTER_HOME: "/legacy" } });
    expect(p.routerHome).toBe("/legacy");
  });

  it("AGENT_ROUTER_HOME beats OMO_ROUTER_HOME", () => {
    const p = resolvePaths({
      env: { AGENT_ROUTER_HOME: "/new", OMO_ROUTER_HOME: "/legacy" },
    });
    expect(p.routerHome).toBe("/new");
  });

  it("AGENT_ROUTER_AGENTS_DIR overrides agentsDir", () => {
    const p = resolvePaths({ env: { XDG_CONFIG_HOME: "/x", AGENT_ROUTER_AGENTS_DIR: "/ag" } });
    expect(p.agentsDir).toBe("/ag");
  });

  it("AGENT_ROUTER_STACKS_DIR overrides stacksDir only", () => {
    const p = resolvePaths({ env: { XDG_CONFIG_HOME: "/x", AGENT_ROUTER_STACKS_DIR: "/st" } });
    expect(p.stacksDir).toBe("/st");
    expect(p.historyDir).toBe("/x/opencode/agent-router/history");
  });

  it("explicit options win over env", () => {
    const p = resolvePaths({
      agentsDir: "/opt-agents",
      stacksDir: "/opt-stacks",
      routerHome: "/opt-home",
      env: {
        AGENT_ROUTER_AGENTS_DIR: "/env-agents",
        AGENT_ROUTER_STACKS_DIR: "/env-stacks",
        AGENT_ROUTER_HOME: "/env-home",
      },
    });
    expect(p.agentsDir).toBe("/opt-agents");
    expect(p.stacksDir).toBe("/opt-stacks");
    expect(p.routerHome).toBe("/opt-home");
  });
});
