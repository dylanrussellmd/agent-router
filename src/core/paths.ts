/**
 * Path resolution for agent-router.
 *
 * Three roots matter:
 *   1. `opencodeConfigDir` — where `opencode.json`, `tui.json`, and the
 *      native `agents/` directory live.
 *      Default: `${XDG_CONFIG_HOME:-~/.config}/opencode`.
 *
 *   2. `agentsDir` — the directory of agent `.md` files whose frontmatter
 *      `model:` lines agent-router rewrites.
 *      Default: `${opencodeConfigDir}/agents`.
 *      Override: `AGENT_ROUTER_AGENTS_DIR` env var, or `agentsDir` in
 *      config.json (see config.ts).
 *
 *   3. `routerHome` — machine-local state (state.json, history).
 *      Default: `${opencodeConfigDir}/agent-router`.
 *      Override: `AGENT_ROUTER_HOME` env var (`OMO_ROUTER_HOME` is honored as
 *      a legacy fallback for one release).
 *
 * Stacks are config, history is state — so `stacksDir` is separately
 * overridable (`AGENT_ROUTER_STACKS_DIR` env / `stacksDir` in config.json),
 * letting users keep stacks in a dotfiles-managed location while history
 * stays machine-local. Default: `${routerHome}/stacks`.
 *
 * Tests rely on the env overrides to fully isolate from the user's real
 * config. Never hard-code paths elsewhere — go through `resolvePaths()`.
 */

import { homedir } from "node:os";
import path from "node:path";

export interface RouterPaths {
  /** Directory housing `opencode.json`, `tui.json`, and `agents/`. */
  readonly opencodeConfigDir: string;
  /** `${opencodeConfigDir}/opencode.json`. */
  readonly opencodeJsonPath: string;
  /**
   * `${opencodeConfigDir}/tui.json` — opencode's TUI config. Since opencode
   * 1.17 the TUI loads its plugins from THIS file's `plugin` array, not from
   * `opencode.json`. `init` patches both so the sidebar half of agent-router
   * loads alongside the server half.
   */
  readonly tuiJsonPath: string;
  /** Directory of agent `.md` files (frontmatter `model:` lines are the live target). */
  readonly agentsDir: string;
  /** Directory `${opencodeConfigDir}/.backups` for installer-style backups. */
  readonly opencodeBackupsDir: string;
  /** Root for agent-router state (overridable via `AGENT_ROUTER_HOME`). */
  readonly routerHome: string;
  /** `${routerHome}/state.json`. */
  readonly statePath: string;
  /** Directory of named stack files (overridable via `AGENT_ROUTER_STACKS_DIR`). */
  readonly stacksDir: string;
  /** `${routerHome}/history` — rolling switch history. */
  readonly historyDir: string;
}

export interface ResolvePathsOptions {
  /**
   * Override `opencodeConfigDir`. Used by tests that don't want to touch
   * `~/.config/opencode`.
   */
  readonly opencodeConfigDir?: string;
  /** Direct override for `routerHome`. Wins over both default and env. */
  readonly routerHome?: string;
  /** Direct override for `agentsDir`. Wins over both default and env. */
  readonly agentsDir?: string;
  /** Direct override for `stacksDir`. Wins over both default and env. */
  readonly stacksDir?: string;
  /**
   * Optional environment map for testability. Production callers omit this and
   * we read from `process.env`.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Compute all paths used by agent-router. Pure — no filesystem I/O.
 *
 * Resolution order (each): explicit option → env var → default.
 *   - `routerHome`: `AGENT_ROUTER_HOME` (legacy `OMO_ROUTER_HOME`) → `${opencodeConfigDir}/agent-router`
 *   - `agentsDir`:  `AGENT_ROUTER_AGENTS_DIR` → `${opencodeConfigDir}/agents`
 *   - `stacksDir`:  `AGENT_ROUTER_STACKS_DIR` → `${routerHome}/stacks`
 */
export function resolvePaths(options: ResolvePathsOptions = {}): RouterPaths {
  const env = options.env ?? process.env;

  const opencodeConfigDir =
    options.opencodeConfigDir ??
    path.join(env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "opencode");

  const routerHome =
    options.routerHome ??
    env.AGENT_ROUTER_HOME ??
    env.OMO_ROUTER_HOME ??
    path.join(opencodeConfigDir, "agent-router");

  const agentsDir =
    options.agentsDir ?? env.AGENT_ROUTER_AGENTS_DIR ?? path.join(opencodeConfigDir, "agents");

  const stacksDir =
    options.stacksDir ?? env.AGENT_ROUTER_STACKS_DIR ?? path.join(routerHome, "stacks");

  return {
    opencodeConfigDir,
    opencodeJsonPath: path.join(opencodeConfigDir, "opencode.json"),
    tuiJsonPath: path.join(opencodeConfigDir, "cli.json"),
    agentsDir,
    opencodeBackupsDir: path.join(opencodeConfigDir, ".backups"),
    routerHome,
    statePath: path.join(routerHome, "state.json"),
    stacksDir,
    historyDir: path.join(routerHome, "history"),
  };
}
