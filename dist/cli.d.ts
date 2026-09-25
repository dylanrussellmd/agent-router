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
declare function main(argv: ReadonlyArray<string>): Promise<number>;

export { main };
