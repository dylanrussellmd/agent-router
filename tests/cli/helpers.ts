/**
 * CLI smoke-test harness.
 *
 * Spawns the CLI as a child process with a tmp `AGENT_ROUTER_HOME`, a tmp
 * agents dir (`AGENT_ROUTER_AGENTS_DIR`), and a tmp
 * `XDG_CONFIG_HOME/opencode/` so each test starts from clean state.
 *
 * We invoke the CLI via the source TypeScript entry through `tsx` — that way
 * we exercise the same code paths as the eventual built binary without
 * needing to run `tsup` in test setup.
 *
 * `opencode models` is faked by injecting a stub binary on PATH that prints
 * a deterministic model list. This makes the validation gate fully
 * reproducible regardless of the developer's local opencode auth state.
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "..", "..");
const CLI_ENTRY = path.join(REPO_ROOT, "src", "cli.ts");

/** Models the CLI tests expect to be reachable. */
export const FAKE_OPENCODE_MODELS = [
  "a/one",
  "b/two",
  "c/three",
  "openrouter/anthropic/claude-fable-5",
  "openrouter/openai/gpt-5.5",
];

export function agentMd(model: string, name: string): string {
  return `---\ndescription: ${name} agent\nmode: subagent\nmodel: ${model}\ntemperature: 0.1\n---\nYou are ${name}.\n`;
}

export interface CliFixture {
  /** AGENT_ROUTER_HOME for this run. */
  routerHome: string;
  /** AGENT_ROUTER_AGENTS_DIR for this run — pre-seeded with Omni + oracle. */
  agentsDir: string;
  /** Synthetic `~/.config` so opencode.json + tui.json land in tmp. */
  xdgHome: string;
  /** Resolved opencode config dir = `${xdgHome}/opencode`. */
  opencodeConfigDir: string;
  /** `${routerHome}/stacks`. */
  stacksDir: string;
  /** PATH-prepended dir holding the stub `opencode` binary. */
  binDir: string;
  /** Convenience: full env to pass to spawnSync. */
  env: NodeJS.ProcessEnv;
  /** Run the CLI with the given args. */
  run: (...args: string[]) => SpawnSyncReturns<string>;
  /** Cleanup all tmp dirs. */
  cleanup: () => void;
}

export function setupCliFixture(): CliFixture {
  const routerHome = mkdtempSync(path.join(tmpdir(), "ar-cli-home-"));
  const agentsDir = mkdtempSync(path.join(tmpdir(), "ar-cli-agents-"));
  const xdgHome = mkdtempSync(path.join(tmpdir(), "ar-cli-xdg-"));
  const binDir = mkdtempSync(path.join(tmpdir(), "ar-cli-bin-"));
  const opencodeConfigDir = path.join(xdgHome, "opencode");
  mkdirSync(opencodeConfigDir, { recursive: true });

  const stubScript = path.join(binDir, "opencode");
  writeFileSync(
    stubScript,
    `#!/usr/bin/env bash
if [ "$1" = "api" ]; then
  cat <<'EOF'
${FAKE_OPENCODE_MODELS.join("\n")}
EOF
  exit 0
fi
exit 0
`,
    { mode: 0o755 },
  );
  chmodSync(stubScript, 0o755);

  writeFileSync(path.join(agentsDir, "Omni.md"), agentMd("a/one", "Omni"));
  writeFileSync(path.join(agentsDir, "oracle.md"), agentMd("b/two", "oracle"));

  // Baseline opencode.json so init's auto-edit has something to work with —
  // includes the legacy omo-router entry init should remove.
  writeFileSync(
    path.join(opencodeConfigDir, "opencode.json"),
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugin: ["@dylanrussell/omo-router@latest"],
        default_agent: "Omni",
      },
      null,
      2,
    )}\n`,
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_ROUTER_HOME: routerHome,
    AGENT_ROUTER_AGENTS_DIR: agentsDir,
    XDG_CONFIG_HOME: xdgHome,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    NO_COLOR: "1",
    EDITOR: "/bin/true",
  };

  function run(...args: string[]): SpawnSyncReturns<string> {
    return spawnSync("npx", ["tsx", CLI_ENTRY, ...args], {
      env,
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });
  }

  return {
    routerHome,
    agentsDir,
    xdgHome,
    opencodeConfigDir,
    stacksDir: path.join(routerHome, "stacks"),
    binDir,
    env,
    run,
    cleanup: () => {
      const { rmSync } = require("node:fs");
      rmSync(routerHome, { recursive: true, force: true });
      rmSync(agentsDir, { recursive: true, force: true });
      rmSync(xdgHome, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    },
  };
}
