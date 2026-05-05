/**
 * `omo-router` / `omo` CLI entry point.
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
 *     2  stack/history not found
 *     3  IO error
 *     4  schema or model-validation failed
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cac } from "cac";
import { atomicWriteFile } from "./core/atomic-write.js";
import { backupFiles } from "./core/backups.js";
import {
  IOError,
  ModelValidationError,
  OmoError,
  StackNotFoundError,
  UserError,
} from "./core/errors.js";
import { listHistory } from "./core/history.js";
import {
  PLUGIN_REGISTRY_ENTRY,
  ensureOpenrouterModels,
  ensurePluginEntry,
  readOpencodeJson,
  writeOpencodeJson,
} from "./core/opencode-config.js";
import { type OmoPaths, resolvePaths } from "./core/paths.js";
import {
  addStack,
  back,
  exportStack,
  getActiveStackName,
  importStack,
  listStacks,
  readStack,
  readStackRaw,
  removeStack,
  restoreFromHistory,
  stackPath,
  switchTo,
} from "./core/stack-manager.js";
import { readState } from "./core/state.js";
import { collectModelRefs, validateStack } from "./core/validator.js";
import { VERSION } from "./version.js";

const SEED_NAMES = ["premium", "openrouter-cheap", "free-only"] as const;

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

/**
 * Read seed JSON from the bundled `seeds/` directory. We try multiple
 * locations because the dist layout differs between dev (`src/seeds/`) and
 * published (`dist/seeds/`); in dev we run via `tsx` or `vitest`.
 */
function findSeedsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Published layout: dist/cli.js with sibling dist/seeds/.
  const distSeeds = path.join(here, "seeds");
  if (existsSync(distSeeds)) return distSeeds;
  // Dev layout: src/cli.ts with sibling src/seeds/.
  const devSeeds = path.join(here, "seeds");
  if (existsSync(devSeeds)) return devSeeds;
  // Fallback: walk up to repo root.
  const repoSeeds = path.join(here, "..", "src", "seeds");
  if (existsSync(repoSeeds)) return repoSeeds;
  throw new IOError("Could not locate bundled seeds directory.");
}

/* ------------------------------------------------------------------------- *
 * subcommand implementations                                                 *
 * ------------------------------------------------------------------------- */

interface InitOptions {
  force?: boolean;
  noEditOpencodeJson?: boolean;
}

async function cmdInit(paths: OmoPaths, opts: InitOptions): Promise<void> {
  await mkdir(paths.stacksDir, { recursive: true });
  await mkdir(paths.historyDir, { recursive: true });

  const seedsDir = findSeedsDir();
  let dropped = 0;
  for (const name of SEED_NAMES) {
    const dest = path.join(paths.stacksDir, `${name}.json`);
    if (existsSync(dest) && !opts.force) continue;
    await copyFile(path.join(seedsDir, `${name}.json`), dest);
    dropped += 1;
  }
  log(
    `omo-router: dropped ${dropped} seed stack${dropped === 1 ? "" : "s"} into ${paths.stacksDir}`,
  );

  const existing = await readState(paths.statePath);
  if (!existing || opts.force) {
    // Set premium active and copy it to oh-my-openagent.json.
    if (existsSync(paths.liveConfigPath)) {
      await backupFiles(paths.opencodeBackupsDir, [paths.liveConfigPath]);
    }
    const premiumRaw = readFileSync(path.join(paths.stacksDir, "premium.json"), "utf8");
    await atomicWriteFile(paths.liveConfigPath, premiumRaw);
    const { writeState } = await import("./core/state.js");
    await writeState(paths.statePath, {
      version: 1,
      active: "premium",
      previousActive: null,
      lastSwitchedAt: new Date().toISOString(),
      lastSnapshottedFrom: null,
    });
    log(`omo-router: active stack set to "premium" → ${paths.liveConfigPath}`);
  } else {
    log(
      `omo-router: state already initialized (active="${existing.active}"); use --force to reset`,
    );
  }

  if (opts.noEditOpencodeJson) {
    log("omo-router: --no-edit-opencode-json passed; not editing opencode.json");
    log(`  add this to opencode.json plugin[]: "${PLUGIN_REGISTRY_ENTRY}"`);
    return;
  }

  await editOpencodeJson(paths);
}

/**
 * Apply the two opencode.json mutations init does:
 *   1. ensure plugin entry present
 *   2. ensure provider.openrouter.models contains every openrouter/<id> our
 *      seeds reference (stripped of the `openrouter/` prefix per
 *      opencode.json convention).
 */
async function editOpencodeJson(paths: OmoPaths): Promise<void> {
  const cfg = await readOpencodeJson(paths.opencodeJsonPath);
  if (!cfg) {
    log(`omo-router: ${paths.opencodeJsonPath} missing — skipping plugin/whitelist edits.`);
    return;
  }

  // Collect openrouter/* IDs across all seeds.
  const seedsDir = findSeedsDir();
  const wantOpenrouter = new Set<string>();
  for (const name of SEED_NAMES) {
    const text = readFileSync(path.join(seedsDir, `${name}.json`), "utf8");
    const stack = JSON.parse(text);
    for (const ref of collectModelRefs(stack)) {
      if (ref.modelId.startsWith("openrouter/")) {
        wantOpenrouter.add(ref.modelId.slice("openrouter/".length));
      }
    }
  }

  const ensured = ensurePluginEntry(cfg);
  const ensuredModels = ensureOpenrouterModels(ensured.config, [...wantOpenrouter]);

  if (!ensured.result.added && ensuredModels.result.added.length === 0) {
    log("omo-router: opencode.json already up to date");
    return;
  }

  await backupFiles(paths.opencodeBackupsDir, [paths.opencodeJsonPath]);
  await writeOpencodeJson(paths.opencodeJsonPath, ensuredModels.config);

  if (ensured.result.added) {
    log(`omo-router: added "${PLUGIN_REGISTRY_ENTRY}" to opencode.json plugin[]`);
  }
  if (ensuredModels.result.added.length) {
    log(
      `omo-router: added ${ensuredModels.result.added.length} model id${ensuredModels.result.added.length === 1 ? "" : "s"} to provider.openrouter.models:`,
    );
    for (const id of ensuredModels.result.added) log(`  + ${id}`);
  }
}

async function cmdList(paths: OmoPaths): Promise<void> {
  const stacks = await listStacks(paths);
  if (stacks.length === 0) {
    log("(no stacks; run `omo-router init`)");
    return;
  }
  const active = await getActiveStackName(paths);
  for (const s of stacks) log(formatStackListLine(s, s === active));
  if (active?.startsWith("(restored:")) {
    log("");
    log(`active is a restored snapshot: ${active}`);
    log("run `omo-router use <name>` to bind to a named stack again.");
  }
}

async function cmdStatus(paths: OmoPaths): Promise<void> {
  const active = await getActiveStackName(paths);
  log(active ?? "(none)");
}

async function cmdShow(paths: OmoPaths, name: string): Promise<void> {
  const raw = await readStackRaw(paths, name);
  // Re-format for consistent output, but if the file is malformed just dump as-is.
  try {
    log(JSON.stringify(JSON.parse(raw), null, 2));
  } catch {
    process.stdout.write(raw);
  }
}

interface UseOptions {
  noSnapshotBack?: boolean;
  noValidate?: boolean;
  forceInvalid?: boolean;
}

async function cmdUse(paths: OmoPaths, name: string, opts: UseOptions): Promise<void> {
  const r = await switchTo(paths, name, {
    snapshotBack: !opts.noSnapshotBack,
    validate: !opts.noValidate,
    forceInvalid: opts.forceInvalid ?? false,
  });
  log(
    `Switched: ${r.previous ?? "(none)"} → ${r.current}. Restart opencode for change to take effect.`,
  );
  if (r.snapshottedFrom) {
    log(`(snapshotted live drift back to stacks/${r.snapshottedFrom}.json)`);
  }
}

async function cmdBack(paths: OmoPaths, n: number, opts: UseOptions): Promise<void> {
  const r = await back(paths, n, {
    snapshotBack: !opts.noSnapshotBack,
    validate: !opts.noValidate,
    forceInvalid: opts.forceInvalid ?? false,
  });
  log(
    `Switched: ${r.previous ?? "(none)"} → ${r.current}. Restart opencode for change to take effect.`,
  );
}

async function cmdHistory(paths: OmoPaths, limit: number): Promise<void> {
  const entries = await listHistory(paths.historyDir);
  if (entries.length === 0) {
    log("(no history)");
    return;
  }
  for (const e of entries.slice(0, limit)) {
    log(`${e.id}  ${e.fromStack} → ${e.toStack}`);
  }
}

async function cmdRestore(paths: OmoPaths, id: string): Promise<void> {
  const r = await restoreFromHistory(paths, id);
  log(
    `Restored history entry ${r.id} into ${paths.liveConfigPath}. Restart opencode for change to take effect.`,
  );
  log(`active is now "${(await readState(paths.statePath))?.active ?? "?"}". `);
  log("Run `omo-router use <name>` to re-bind to a named stack.");
}

interface ValidateOptions {
  all?: boolean;
  active?: boolean;
}

async function cmdValidate(
  paths: OmoPaths,
  name: string | undefined,
  opts: ValidateOptions,
): Promise<void> {
  const targets: Array<{ readonly name: string; readonly path: string }> = [];
  if (opts.active) {
    if (!existsSync(paths.liveConfigPath)) {
      throw new UserError(`No live config at ${paths.liveConfigPath}.`);
    }
    targets.push({ name: "(active)", path: paths.liveConfigPath });
  } else if (opts.all) {
    for (const n of await listStacks(paths)) {
      targets.push({ name: n, path: stackPath(paths, n) });
    }
  } else {
    if (!name) throw new UserError("Specify a stack name, or pass --all or --active.");
    targets.push({ name, path: stackPath(paths, name) });
  }

  let anyMissing = false;
  for (const t of targets) {
    const raw = await readFile(t.path, "utf8").catch((e: Error) => {
      throw new IOError(`Failed to read ${t.path}: ${e.message}`);
    });
    const parsed = JSON.parse(raw);
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

interface AddOptions {
  fromActive?: boolean;
  from?: string;
  force?: boolean;
}

async function cmdAdd(paths: OmoPaths, name: string, opts: AddOptions): Promise<void> {
  await addStack(paths, name, {
    ...(opts.fromActive !== undefined ? { fromActive: opts.fromActive } : {}),
    ...(opts.from !== undefined ? { fromFile: path.resolve(opts.from) } : {}),
    ...(opts.force !== undefined ? { force: opts.force } : {}),
  });
  log(`Added stack "${name}" → ${stackPath(paths, name)}`);
}

async function cmdRm(paths: OmoPaths, name: string, force: boolean): Promise<void> {
  await removeStack(paths, name, { force });
  log(`Removed stack "${name}"`);
}

async function cmdEdit(paths: OmoPaths, name: string): Promise<void> {
  const filePath = stackPath(paths, name);
  if (!existsSync(filePath)) {
    throw new StackNotFoundError(name, await listStacks(paths));
  }
  const editor = process.env.EDITOR && process.env.EDITOR.length > 0 ? process.env.EDITOR : "vi";
  // Run synchronously, foregrounded — same TTY as the parent so the editor renders.
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
  paths: OmoPaths,
  name: string,
  file: string,
  force: boolean,
): Promise<void> {
  await importStack(paths, name, path.resolve(file), { force });
  log(`Imported "${file}" → stacks/${name}.json`);
}

async function cmdExport(paths: OmoPaths, name: string, file: string): Promise<void> {
  await exportStack(paths, name, path.resolve(file));
  log(`Exported stacks/${name}.json → "${file}"`);
}

function cmdPath(paths: OmoPaths): void {
  for (const [k, v] of Object.entries(paths)) log(`${k.padEnd(22)} ${v as string}`);
}

/* ------------------------------------------------------------------------- *
 * cac wiring                                                                 *
 * ------------------------------------------------------------------------- */

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const cli = cac("omo-router");
  const paths = resolvePaths();

  cli
    .command("init", "create state dirs, drop seeds, set premium active, edit opencode.json")
    .option("--force", "overwrite existing state")
    .option("--no-edit-opencode-json", "do not modify opencode.json")
    .action(async (opts: { force?: boolean; editOpencodeJson?: boolean }) => {
      const passthrough: InitOptions = {};
      if (opts.force !== undefined) passthrough.force = opts.force;
      if (opts.editOpencodeJson === false) passthrough.noEditOpencodeJson = true;
      await cmdInit(paths, passthrough);
    });

  cli.command("list", "list available stacks (* marks active)").action(() => cmdList(paths));
  cli.command("status", "print active stack name").action(() => cmdStatus(paths));
  cli
    .command("show <name>", "print a stack file as pretty JSON")
    .action((n: string) => cmdShow(paths, n));

  cli
    .command("use <name>", "switch active stack (validates first)")
    .option("--no-snapshot-back", "do not save current oh-my-openagent.json back to source stack")
    .option("--no-validate", "skip the pre-switch model validation")
    .option("--force-invalid", "switch even if validation finds missing models")
    .action(
      async (
        n: string,
        opts: { snapshotBack?: boolean; validate?: boolean; forceInvalid?: boolean },
      ) => {
        const passthrough: UseOptions = {};
        if (opts.snapshotBack === false) passthrough.noSnapshotBack = true;
        if (opts.validate === false) passthrough.noValidate = true;
        if (opts.forceInvalid !== undefined) passthrough.forceInvalid = opts.forceInvalid;
        await cmdUse(paths, n, passthrough);
      },
    );

  cli
    .command("back", "undo the last N switches")
    .option("-n <n>", "how many switches to undo", { default: 1 })
    .option("--no-snapshot-back", "do not save current oh-my-openagent.json back to source stack")
    .option("--no-validate", "skip the pre-switch model validation")
    .option("--force-invalid", "switch even if validation finds missing models")
    .action(
      async (opts: {
        n: number;
        snapshotBack?: boolean;
        validate?: boolean;
        forceInvalid?: boolean;
      }) => {
        const passthrough: UseOptions = {};
        if (opts.snapshotBack === false) passthrough.noSnapshotBack = true;
        if (opts.validate === false) passthrough.noValidate = true;
        if (opts.forceInvalid !== undefined) passthrough.forceInvalid = opts.forceInvalid;
        await cmdBack(paths, opts.n ?? 1, passthrough);
      },
    );

  cli
    .command("history", "list recent switches (newest first)")
    .option("--limit <n>", "max entries to show", { default: 20 })
    .action((opts: { limit: number }) => cmdHistory(paths, opts.limit ?? 20));

  cli
    .command("restore <id>", "restore oh-my-openagent.json from a history entry")
    .action((id: string) => cmdRestore(paths, id));

  cli
    .command(
      "validate [name]",
      "verify model IDs in a stack are reachable via current opencode auth",
    )
    .option("--all", "validate every stack")
    .option("--active", "validate the live oh-my-openagent.json")
    .action((name: string | undefined, opts: { all?: boolean; active?: boolean }) =>
      cmdValidate(paths, name, opts),
    );

  cli
    .command("add <name>", "create a new stack")
    .option("--from-active", "snapshot current oh-my-openagent.json into the new stack")
    .option("--from <file>", "read content from this file")
    .option("--force", "overwrite an existing stack")
    .action((n: string, opts: { fromActive?: boolean; from?: string; force?: boolean }) =>
      cmdAdd(paths, n, opts),
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

  cli.command("path", "print all paths used by omo-router").action(() => cmdPath(paths));

  cli.help();
  cli.version(VERSION);

  try {
    cli.parse([process.argv[0] ?? "node", process.argv[1] ?? "omo-router", ...argv], {
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
    if (e instanceof OmoError) {
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
