/**
 * `agent-router` CLI entry point.
 *
 * One file, one tool — uses `cac` for arg parsing because it's tiny (~6kB
 * minified) and we don't need the bells and whistles of yargs/commander.
 *
 * Architecture:
 *   - Each subcommand is a small async function that calls into `core/`.
 *   - All stdout/stderr formatting lives here (the core throws typed errors;
 *     the CLI maps them to exit codes + human-readable output).
 *   - We never call `process.exit()` directly — we throw and let `main()`
 *     handle it. This makes the CLI testable via dynamic import.
 *
 * Exit codes (see `errors.ts`):
 *     0  success
 *     1  user error (bad args, refused destructive op)
 *     2  stack or agent file not found
 *     3  IO error
 *     4  schema or model-validation failed
 */

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cac } from "cac";
import { backupFiles } from "./core/backups.js";
import { resolvePathsWithConfig } from "./core/config.js";
import {
  IOError,
  ModelValidationError,
  RouterError,
  StackNotFoundError,
  UserError,
} from "./core/errors.js";
import { readAgentModels } from "./core/frontmatter.js";
import { listHistory } from "./core/history.js";
import {
  PLUGIN_REGISTRY_ENTRY,
  ensurePluginEntry,
  ensureTuiJsonPluginEntry,
  readOpencodeJson,
  removePluginEntry,
  writeOpencodeJson,
} from "./core/opencode-config.js";
import type { RouterPaths } from "./core/paths.js";
import { StackFileSchema } from "./core/schema.js";
import {
  applyStack,
  back,
  captureAgents,
  captureStack,
  exportStack,
  getActiveStackName,
  importStack,
  listStacks,
  readStack,
  readStackRaw,
  removeStack,
  stackPath,
} from "./core/stack-manager.js";
import { validateStack } from "./core/validator.js";
import { VERSION } from "./version.js";

/* ------------------------------------------------------------------------- *
 * helpers                                                                    *
 * ------------------------------------------------------------------------- */

const log = (...args: unknown[]): void => console.log(...args);
const err = (...args: unknown[]): void => console.error(...args);

/**
 * Format `[*] premium` style line for `list`. Uses an asterisk because
 * unicode bullet glyphs render inconsistently across terminal fonts.
 */
function formatStackListLine(name: string, isActive: boolean): string {
  return `${isActive ? "*" : " "} ${name}`;
}

/* ------------------------------------------------------------------------- *
 * subcommand implementations                                                 *
 * ------------------------------------------------------------------------- */

interface InitOptions {
  force?: boolean;
  noEditOpencodeJson?: boolean;
}

const INIT_CAPTURE_NAME = "default";

async function cmdInit(paths: RouterPaths, opts: InitOptions): Promise<void> {
  await mkdir(paths.stacksDir, { recursive: true });
  await mkdir(paths.historyDir, { recursive: true });

  const { readState, writeState } = await import("./core/state.js");
  const existing = await readState(paths.statePath);
  const stacks = await listStacks(paths);

  if ((!existing || opts.force) && stacks.length === 0) {
    try {
      const captured = await captureStack(paths, INIT_CAPTURE_NAME, { force: !!opts.force });
      await writeState(paths.statePath, {
        version: 1,
        active: INIT_CAPTURE_NAME,
        previousActive: null,
        lastSwitchedAt: new Date().toISOString(),
      });
      log(
        `agent-router: captured ${captured.agents} agent${captured.agents === 1 ? "" : "s"} from ${paths.agentsDir} → stacks/${INIT_CAPTURE_NAME}.json (active)`,
      );
    } catch (e) {
      if (e instanceof UserError) {
        log(`agent-router: no agents captured (${e.message})`);
        log(
          "  create agent .md files with a frontmatter `model:` line, then run `agent-router capture <name>`.",
        );
      } else {
        throw e;
      }
    }
  } else if (existing) {
    log(
      `agent-router: state already initialized (active="${existing.active}"); use --force to reset`,
    );
  }

  if (opts.noEditOpencodeJson) {
    log("agent-router: --no-edit-opencode-json passed; not editing opencode.json or tui.json");
    log(`  add this to opencode.json plugins[]: "${PLUGIN_REGISTRY_ENTRY}"`);
    log(`  add this to cli.json plugins[] (sidebar): "${PLUGIN_REGISTRY_ENTRY}"`);
    return;
  }

  await editOpencodeJson(paths);
  await editTuiJson(paths);
}

/**
 * Register the TUI half in tui.json — opencode >= 1.17 loads TUI plugins
 * (sidebar, commands) from tui.json's `plugin` array, not opencode.json's.
 */
async function editTuiJson(paths: RouterPaths): Promise<void> {
  const exists = existsSync(paths.tuiJsonPath);
  if (exists) {
    await backupFiles(paths.opencodeBackupsDir, [paths.tuiJsonPath]);
  }
  const result = await ensureTuiJsonPluginEntry(paths.tuiJsonPath);
  if (result.added) {
    log(`agent-router: added "${PLUGIN_REGISTRY_ENTRY}" to cli.json plugins[] (sidebar support)`);
    return;
  }
  log("agent-router: tui.json already up to date");
}

/**
 * Ensure our plugin entry is in opencode.json (and drop the legacy
 * `@dylanrussell/omo-router` entry when found).
 */
async function editOpencodeJson(paths: RouterPaths): Promise<void> {
  const cfg = await readOpencodeJson(paths.opencodeJsonPath);
  if (!cfg) {
    log(`agent-router: ${paths.opencodeJsonPath} missing — skipping plugin edits.`);
    return;
  }

  const removed = removePluginEntry(cfg);
  const ensured = ensurePluginEntry(removed.config);

  if (!ensured.result.added && removed.result.removed.length === 0) {
    log("agent-router: opencode.json already up to date");
    return;
  }

  await backupFiles(paths.opencodeBackupsDir, [paths.opencodeJsonPath]);
  await writeOpencodeJson(paths.opencodeJsonPath, ensured.config);

  if (removed.result.removed.length) {
    log(
      `agent-router: removed legacy plugin entr${removed.result.removed.length === 1 ? "y" : "ies"}: ${removed.result.removed.join(", ")}`,
    );
  }
  if (ensured.result.added) {
    log(`agent-router: added "${PLUGIN_REGISTRY_ENTRY}" to opencode.json plugins[]`);
  }
}

async function cmdList(paths: RouterPaths): Promise<void> {
  const stacks = await listStacks(paths);
  if (stacks.length === 0) {
    log("(no stacks; run `agent-router init` or `agent-router capture <name>`)");
    return;
  }
  const active = await getActiveStackName(paths);
  for (const s of stacks) log(formatStackListLine(s, s === active));
}

async function cmdStatus(paths: RouterPaths): Promise<void> {
  const active = await getActiveStackName(paths);
  log(active ?? "(none)");
}

async function cmdShow(paths: RouterPaths, name: string): Promise<void> {
  const raw = await readStackRaw(paths, name);
  try {
    log(JSON.stringify(JSON.parse(raw), null, 2));
  } catch {
    process.stdout.write(raw);
  }
}

async function cmdCurrent(paths: RouterPaths): Promise<void> {
  const models = await readAgentModels(paths.agentsDir);
  const names = Object.keys(models).sort();
  if (names.length === 0) {
    log(`(no agent .md files with a \`model:\` line in ${paths.agentsDir})`);
    return;
  }
  const width = Math.max(...names.map((n) => n.length));
  for (const n of names) log(`${n.padEnd(width)}  ${models[n]}`);
}

interface UseOptions {
  noValidate?: boolean;
  forceInvalid?: boolean;
}

async function cmdUse(paths: RouterPaths, name: string, opts: UseOptions): Promise<void> {
  const r = await applyStack(paths, name, {
    validate: !opts.noValidate,
    forceInvalid: opts.forceInvalid ?? false,
  });
  log(
    `Switched: ${r.previous ?? "(none)"} → ${r.current} (${r.changed.length} agent${r.changed.length === 1 ? "" : "s"} updated). Restart opencode for change to take effect.`,
  );
}

async function cmdBack(paths: RouterPaths, n: number, opts: UseOptions): Promise<void> {
  const r = await back(paths, n, {
    validate: !opts.noValidate,
    forceInvalid: opts.forceInvalid ?? false,
  });
  log(
    `Switched: ${r.previous ?? "(none)"} → ${r.current} (${r.changed.length} agent${r.changed.length === 1 ? "" : "s"} updated). Restart opencode for change to take effect.`,
  );
}

async function cmdCapture(paths: RouterPaths, name: string, force: boolean): Promise<void> {
  const r = await captureStack(paths, name, { force });
  log(`Captured ${r.agents} agent${r.agents === 1 ? "" : "s"} → ${r.path}`);
}

async function cmdHistory(paths: RouterPaths, limit: number): Promise<void> {
  const entries = await listHistory(paths.historyDir);
  if (entries.length === 0) {
    log("(no history)");
    return;
  }
  for (const e of entries.slice(0, limit)) {
    log(`${e.id}  ${e.fromStack} → ${e.toStack}`);
  }
}

interface ValidateCmdOptions {
  all?: boolean;
  active?: boolean;
}

async function cmdValidate(
  paths: RouterPaths,
  name: string | undefined,
  opts: ValidateCmdOptions,
): Promise<void> {
  const targets: Array<{ readonly name: string; readonly load: () => Promise<unknown> }> = [];
  if (opts.active) {
    targets.push({
      name: "(current frontmatter)",
      load: async () => {
        return { agents: await captureAgents(paths) };
      },
    });
  } else if (opts.all) {
    for (const n of await listStacks(paths)) {
      targets.push({ name: n, load: () => readStack(paths, n) });
    }
  } else {
    if (!name) throw new UserError("Specify a stack name, or pass --all or --active.");
    targets.push({ name, load: () => readStack(paths, name) });
  }

  let anyMissing = false;
  for (const t of targets) {
    const parsed = StackFileSchema.parse(await t.load());
    const r = await validateStack(parsed);
    if (r.ok) {
      log(`${t.name}: OK (${r.checked} model id${r.checked === 1 ? "" : "s"} checked)`);
    } else {
      anyMissing = true;
      err(`${t.name}: MISSING ${r.missing.length} model id${r.missing.length === 1 ? "" : "s"}:`);
      for (const m of r.missing) err(`  ${m.path.padEnd(48)} ${m.modelId}`);
    }
  }
  if (anyMissing) {
    err("");
    err(
      "Run `opencode auth list` to confirm provider auth, or `opencode models` to see the full reachable list.",
    );
    throw new ModelValidationError("(validation gate)", []);
  }
}

async function cmdRm(paths: RouterPaths, name: string, force: boolean): Promise<void> {
  await removeStack(paths, name, { force });
  log(`Removed stack "${name}"`);
}

async function cmdEdit(paths: RouterPaths, name: string): Promise<void> {
  const filePath = stackPath(paths, name);
  if (!existsSync(filePath)) {
    throw new StackNotFoundError(name, await listStacks(paths));
  }
  const editor = process.env.EDITOR && process.env.EDITOR.length > 0 ? process.env.EDITOR : "vi";
  const result = spawnSync(editor, [filePath], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new UserError(`Editor exited with status ${result.status}.`);
  }
  // Re-validate: warn if the user broke the schema, but don't block — they may
  // be mid-edit and want to fix it on a follow-up run.
  try {
    await readStack(paths, name);
  } catch (e) {
    err(`Warning: ${(e as Error).message}`);
  }
}

async function cmdImport(
  paths: RouterPaths,
  name: string,
  file: string,
  force: boolean,
): Promise<void> {
  await importStack(paths, name, path.resolve(file), { force });
  log(`Imported "${file}" → stacks/${name}.json`);
}

async function cmdExport(paths: RouterPaths, name: string, file: string): Promise<void> {
  await exportStack(paths, name, path.resolve(file));
  log(`Exported stacks/${name}.json → "${file}"`);
}

function cmdPath(paths: RouterPaths): void {
  for (const [k, v] of Object.entries(paths)) log(`${k.padEnd(22)} ${v as string}`);
}

/* ------------------------------------------------------------------------- *
 * cac wiring                                                                 *
 * ------------------------------------------------------------------------- */

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const cli = cac("agent-router");
  const paths = await resolvePathsWithConfig();

  cli
    .command("init", "create state dirs, capture current models, register the plugin")
    .option("--force", "overwrite existing state")
    .option("--no-edit-opencode-json", "do not modify opencode.json or tui.json")
    .action(async (opts: { force?: boolean; editOpencodeJson?: boolean }) => {
      const passthrough: InitOptions = {};
      if (opts.force !== undefined) passthrough.force = opts.force;
      if (opts.editOpencodeJson === false) passthrough.noEditOpencodeJson = true;
      await cmdInit(paths, passthrough);
    });

  cli.command("list", "list available stacks (* marks active)").action(() => cmdList(paths));
  cli.command("status", "print active stack name").action(() => cmdStatus(paths));
  cli
    .command("current", "print the agent → model mapping currently in frontmatter")
    .action(() => cmdCurrent(paths));
  cli
    .command("show <name>", "print a stack file as pretty JSON")
    .action((n: string) => cmdShow(paths, n));

  cli
    .command("use <name>", "apply a stack to the agent files (validates first)")
    .alias("apply")
    .option("--no-validate", "skip the pre-apply model validation")
    .option("--force-invalid", "apply even if validation finds missing models")
    .action(async (n: string, opts: { validate?: boolean; forceInvalid?: boolean }) => {
      const passthrough: UseOptions = {};
      if (opts.validate === false) passthrough.noValidate = true;
      if (opts.forceInvalid !== undefined) passthrough.forceInvalid = opts.forceInvalid;
      await cmdUse(paths, n, passthrough);
    });

  cli
    .command("capture <name>", "snapshot current frontmatter models into a new stack")
    .option("--force", "overwrite an existing stack")
    .action((n: string, opts: { force?: boolean }) => cmdCapture(paths, n, !!opts.force));

  cli
    .command("back", "undo the last N switches")
    .option("-n <n>", "how many switches to undo", { default: 1 })
    .option("--no-validate", "skip the pre-apply model validation")
    .option("--force-invalid", "apply even if validation finds missing models")
    .action(async (opts: { n: number; validate?: boolean; forceInvalid?: boolean }) => {
      const passthrough: UseOptions = {};
      if (opts.validate === false) passthrough.noValidate = true;
      if (opts.forceInvalid !== undefined) passthrough.forceInvalid = opts.forceInvalid;
      await cmdBack(paths, opts.n ?? 1, passthrough);
    });

  cli
    .command("history", "list recent switches (newest first)")
    .option("--limit <n>", "max entries to show", { default: 20 })
    .action((opts: { limit: number }) => cmdHistory(paths, opts.limit ?? 20));

  cli
    .command(
      "validate [name]",
      "verify model IDs in a stack are reachable via current opencode auth",
    )
    .option("--all", "validate every stack")
    .option("--active", "validate the models currently in agent frontmatter")
    .action((name: string | undefined, opts: { all?: boolean; active?: boolean }) =>
      cmdValidate(paths, name, opts),
    );

  cli
    .command("rm <name>", "delete a stack")
    .option("--force", "delete even if active")
    .action((n: string, opts: { force?: boolean }) => cmdRm(paths, n, !!opts.force));

  cli
    .command("edit <name>", "open a stack in $EDITOR (fallback `vi`)")
    .action((n: string) => cmdEdit(paths, n));

  cli
    .command("import <name> <file>", "copy <file> into stacks/<name>.json")
    .option("--force", "overwrite an existing stack")
    .action((n: string, f: string, opts: { force?: boolean }) =>
      cmdImport(paths, n, f, !!opts.force),
    );

  cli
    .command("export <name> <file>", "copy stacks/<name>.json to <file>")
    .action((n: string, f: string) => cmdExport(paths, n, f));

  cli.command("path", "print all paths used by agent-router").action(() => cmdPath(paths));

  cli.command("completion", "print instructions for installing shell autocomplete").action(() => {
    log("To install autocomplete for agent-router, run one of the following:\n");
    log(
      "ZSH:\n  agent-router completion-script zsh > ~/.agent-router-completion.zsh\n  echo 'source ~/.agent-router-completion.zsh' >> ~/.zshrc\n",
    );
    log(
      "BASH:\n  agent-router completion-script bash > ~/.agent-router-completion.bash\n  echo 'source ~/.agent-router-completion.bash' >> ~/.bashrc\n",
    );
    log(
      "FISH:\n  agent-router completion-script fish > ~/.config/fish/completions/agent-router.fish\n",
    );
  });

  cli
    .command("completion-script <shell>", "Generate the completion script for your shell")
    .action((shell: string) => {
      if (shell === "zsh") {
        log(
          `
#compdef agent-router

_agent_router() {
  local -a commands
  commands=(
    'init:create state dirs, capture current models, register the plugin'
    'list:list available stacks'
    'status:print active stack name'
    'current:print the current agent → model mapping'
    'show:print a stack file as pretty JSON'
    'use:apply a stack to the agent files'
    'capture:snapshot current models into a new stack'
    'back:undo the last N switches'
    'history:list recent switches'
    'validate:verify model IDs'
    'rm:delete a stack'
    'edit:open a stack in $EDITOR'
    'import:copy file into stacks'
    'export:copy stack to file'
    'path:print all paths'
  )

  if (( CURRENT == 2 )); then
    _describe -t commands 'commands' commands
  else
    local cmd=\${words[2]}
    case $cmd in
      show|use|validate|rm|edit|export)
        local -a stacks
        stacks=($(agent-router completion-resolve))
        _describe -t stacks 'stacks' stacks
        ;;
    esac
  fi
}

compdef _agent_router agent-router
        `.trim(),
        );
      } else if (shell === "bash") {
        log(
          `
_agent_router() {
  local cur prev commands stacks
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="init list status current show use capture back history validate rm edit import export path completion"

  if [[ \${COMP_CWORD} == 1 ]]; then
    COMPREPLY=( $(compgen -W "\${commands}" -- \${cur}) )
    return 0
  fi

  case "\${prev}" in
    show|use|validate|rm|edit|export)
      stacks=$(agent-router completion-resolve 2>/dev/null)
      COMPREPLY=( $(compgen -W "\${stacks}" -- \${cur}) )
      ;;
  esac
  return 0
}

complete -F _agent_router agent-router
        `.trim(),
        );
      } else if (shell === "fish") {
        log(
          `
function _agent_router_needs_command
  set cmd (commandline -opc)
  if test (count $cmd) -eq 1
    return 0
  end
  return 1
end

function _agent_router_using_command
  set cmd (commandline -opc)
  if test (count $cmd) -gt 1
    if test $cmd[2] = $argv[1]
      return 0
    end
  end
  return 1
end

complete -f -c agent-router -n '_agent_router_needs_command' -a init -d 'create state dirs, capture current models, register the plugin'
complete -f -c agent-router -n '_agent_router_needs_command' -a list -d 'list available stacks'
complete -f -c agent-router -n '_agent_router_needs_command' -a status -d 'print active stack name'
complete -f -c agent-router -n '_agent_router_needs_command' -a current -d 'print the current agent → model mapping'
complete -f -c agent-router -n '_agent_router_needs_command' -a show -d 'print a stack file as pretty JSON'
complete -f -c agent-router -n '_agent_router_needs_command' -a use -d 'apply a stack to the agent files'
complete -f -c agent-router -n '_agent_router_needs_command' -a capture -d 'snapshot current models into a new stack'
complete -f -c agent-router -n '_agent_router_needs_command' -a back -d 'undo the last N switches'
complete -f -c agent-router -n '_agent_router_needs_command' -a history -d 'list recent switches'
complete -f -c agent-router -n '_agent_router_needs_command' -a validate -d 'verify model IDs'
complete -f -c agent-router -n '_agent_router_needs_command' -a rm -d 'delete a stack'
complete -f -c agent-router -n '_agent_router_needs_command' -a edit -d 'open a stack in $EDITOR'
complete -f -c agent-router -n '_agent_router_needs_command' -a import -d 'copy file into stacks'
complete -f -c agent-router -n '_agent_router_needs_command' -a export -d 'copy stack to file'
complete -f -c agent-router -n '_agent_router_needs_command' -a path -d 'print all paths'

complete -f -c agent-router -n '_agent_router_using_command show' -a '(agent-router completion-resolve)'
complete -f -c agent-router -n '_agent_router_using_command use' -a '(agent-router completion-resolve)'
complete -f -c agent-router -n '_agent_router_using_command validate' -a '(agent-router completion-resolve)'
complete -f -c agent-router -n '_agent_router_using_command rm' -a '(agent-router completion-resolve)'
complete -f -c agent-router -n '_agent_router_using_command edit' -a '(agent-router completion-resolve)'
complete -f -c agent-router -n '_agent_router_using_command export' -a '(agent-router completion-resolve)'
        `.trim(),
        );
      } else {
        err("Unsupported shell. Supported: bash, zsh, fish");
        process.exit(1);
      }
    });

  cli
    .command("completion-resolve", "Internal command used by shell autocomplete")
    .action(async () => {
      try {
        const stacks = await listStacks(paths);
        log(stacks.join("\n"));
      } catch {
        // Silently fail during completion
      }
    });

  cli.help();
  cli.version(VERSION);

  try {
    cli.parse([process.argv[0] ?? "node", process.argv[1] ?? "agent-router", ...argv], {
      run: false,
    });
    if (cli.matchedCommand) {
      await cli.runMatchedCommand();
    } else if (
      argv.length > 0 &&
      !argv.includes("--help") &&
      !argv.includes("-h") &&
      !argv.includes("--version") &&
      !argv.includes("-v")
    ) {
      cli.outputHelp();
      return 1;
    }
    return 0;
  } catch (e) {
    if (e instanceof RouterError) {
      err(`error: ${e.message}`);
      if (e instanceof ModelValidationError && e.missing.length > 0) {
        err("");
        for (const m of e.missing) err(`  ${m.path.padEnd(48)} ${m.modelId}`);
      }
      const ctor = e.constructor as { exitCode?: number };
      return ctor.exitCode ?? 1;
    }
    err(`unexpected error: ${(e as Error).message}`);
    return 1;
  }
}

// Detect direct invocation. We can't simply compare `import.meta.url` to
// `process.argv[1]` — npm-installed bins live behind a symlink so the two
// paths differ after Node loads the file. Compare via `realpathSync` on both
// sides; both should resolve to the same dist/cli.js.
function isInvokedAsScript(): boolean {
  if (!import.meta.url.startsWith("file:")) return false;
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(argv1));
  } catch {
    return false;
  }
}

if (isInvokedAsScript()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      err(e);
      process.exit(1);
    },
  );
}

export { main };
