/**
 * Path resolution for omo-router.
 *
 * Two roots matter:
 *   1. `opencodeConfigDir` — where `oh-my-openagent.json` and `opencode.json` live.
 *      Default: `${XDG_CONFIG_HOME:-~/.config}/opencode`.
 *
 *   2. `omoHome` — where omo-router stores its own state (stacks, history, state.json).
 *      Default: `${opencodeConfigDir}/omo-router`.
 *      Override: `OMO_ROUTER_HOME` env var (used by tests to redirect to tmp).
 *
 *   3. `liveConfigPath` — the active `oh-my-openagent.json` that omo-router
 *      writes on every switch.
 *      Default: `${opencodeConfigDir}/oh-my-openagent.json`.
 *      Override: `OMO_ROUTER_LIVE_CONFIG` env var. Use this when the live config
 *      is managed elsewhere (e.g. a dotfiles dir that opencode symlinks back
 *      into `~/.config/opencode`). Writing through the override keeps the
 *      symlink intact instead of `rename(2)` clobbering it into a real file.
 *
 * Tests rely on `OMO_ROUTER_HOME` to fully isolate from the user's real config.
 * Production code relies on the default. Never hard-code paths elsewhere — go
 * through `resolvePaths()` so the override always wins.
 */

import { homedir } from "node:os";
import path from "node:path";

export interface OmoPaths {
  /** Directory housing `opencode.json` + `oh-my-openagent.json`. */
  readonly opencodeConfigDir: string;
  /** `${opencodeConfigDir}/opencode.json`. */
  readonly opencodeJsonPath: string;
  /**
   * `${opencodeConfigDir}/tui.json` — opencode's TUI config. Since opencode
   * 1.17 the TUI loads its plugins from THIS file's `plugin` array, not from
   * `opencode.json`. `init` patches both so the sidebar half of omo-router
   * loads alongside the server half.
   */
  readonly tuiJsonPath: string;
  /**
   * The live router target — the `oh-my-openagent.json` written on every
   * switch. Defaults to `${opencodeConfigDir}/oh-my-openagent.json`; override
   * with `OMO_ROUTER_LIVE_CONFIG` (or `options.liveConfigPath`).
   */
  readonly liveConfigPath: string;
  /** Directory `${opencodeConfigDir}/.backups` for installer-style backups. */
  readonly opencodeBackupsDir: string;
  /** Root for omo-router state (overridable via `OMO_ROUTER_HOME`). */
  readonly omoHome: string;
  /** `${omoHome}/state.json`. */
  readonly statePath: string;
  /** `${omoHome}/stacks` — directory of named stack files. */
  readonly stacksDir: string;
  /** `${omoHome}/history` — rolling switch history. */
  readonly historyDir: string;
}

export interface ResolvePathsOptions {
  /**
   * Override `opencodeConfigDir`. Used by tests that don't want to touch
   * `~/.config/opencode`. When set, `omoHome` defaults to `${this}/omo-router`
   * unless `omoHome` is also overridden.
   */
  readonly opencodeConfigDir?: string;
  /** Direct override for `omoHome`. Wins over both default and OMO_ROUTER_HOME. */
  readonly omoHome?: string;
  /**
   * Direct override for `liveConfigPath`. Wins over both the default and
   * `OMO_ROUTER_LIVE_CONFIG`.
   */
  readonly liveConfigPath?: string;
  /**
   * Optional environment map for testability. Production callers omit this and
   * we read from `process.env`.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Compute all paths used by omo-router. Pure — no filesystem I/O.
 *
 * Resolution order for `omoHome`:
 *   1. `options.omoHome` (explicit param) — wins.
 *   2. `OMO_ROUTER_HOME` env var.
 *   3. `${opencodeConfigDir}/omo-router`.
 *
 * Resolution order for `opencodeConfigDir`:
 *   1. `options.opencodeConfigDir` (explicit param).
 *   2. `${XDG_CONFIG_HOME}/opencode` if `XDG_CONFIG_HOME` set.
 *   3. `~/.config/opencode`.
 *
 * Resolution order for `liveConfigPath`:
 *   1. `options.liveConfigPath` (explicit param) — wins.
 *   2. `OMO_ROUTER_LIVE_CONFIG` env var.
 *   3. `${opencodeConfigDir}/oh-my-openagent.json`.
 */
export function resolvePaths(options: ResolvePathsOptions = {}): OmoPaths {
  const env = options.env ?? process.env;

  const opencodeConfigDir =
    options.opencodeConfigDir ??
    path.join(env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "opencode");

  const omoHome =
    options.omoHome ?? env.OMO_ROUTER_HOME ?? path.join(opencodeConfigDir, "omo-router");

  const liveConfigPath =
    options.liveConfigPath ??
    env.OMO_ROUTER_LIVE_CONFIG ??
    path.join(opencodeConfigDir, "oh-my-openagent.json");

  return {
    opencodeConfigDir,
    opencodeJsonPath: path.join(opencodeConfigDir, "opencode.json"),
    tuiJsonPath: path.join(opencodeConfigDir, "tui.json"),
    liveConfigPath,
    opencodeBackupsDir: path.join(opencodeConfigDir, ".backups"),
    omoHome,
    statePath: path.join(omoHome, "state.json"),
    stacksDir: path.join(omoHome, "stacks"),
    historyDir: path.join(omoHome, "history"),
  };
}
