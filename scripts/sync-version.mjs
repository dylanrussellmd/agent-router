#!/usr/bin/env node
/**
 * sync-version — keep src/version.ts in lockstep with package.json.
 *
 * Runs as the `version` npm lifecycle hook during `npm version <bump>`:
 * after package.json is bumped but BEFORE the automatic git commit, so the
 * src/version.ts change is staged and committed together with package.json.
 *
 * Manual use: `node scripts/sync-version.mjs`.
 *
 * Why a script and not `node -e "..."`: the hook runs in CI and on every
 * contributor's machine, so it needs to be readable, escapable, and
 * unit-checkable. The template below mirrors src/version.ts byte-for-byte
 * except for the VERSION value.
 */

import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = pkg.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
  process.stderr.write(`sync-version: invalid or missing package.json "version": ${String(version)}\n`);
  process.exit(1);
}

const out = `/**
 * Hard-coded version string. Kept in sync with package.json by the publish
 * pipeline (\`npm version\` bumps both). Not read from package.json at runtime
 * to avoid a filesystem read on plugin init in opencode's Bun runtime.
 */
export const VERSION = "${version}";
`;

writeFileSync(new URL("../src/version.ts", import.meta.url), out, "utf8");
process.stdout.write(`sync-version: src/version.ts → ${version}\n`);
