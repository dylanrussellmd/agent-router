import { defineConfig } from "tsup";
import { chmod } from "node:fs/promises";
import path from "node:path";

/**
 * tsup config: bundle plugin, CLI, and TUI as ESM, and `chmod +x` the CLI
 * binary so `agent-router` is executable straight out of `npm install`.
 */
export default defineConfig({
  entry: {
    plugin: "src/plugin.ts",
    cli: "src/cli.ts",
    tui: "src/tui/index.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: false,
  // Self-contained bundles: tsup externalizes everything in `dependencies`
  // by default, so zod/cac must be forced inline via `noExternal` — otherwise
  // a partial dep install in opencode's plugin cache breaks every entry point
  // at load time (`Cannot find package 'zod'` → no sidebar/commands/toasts).
  // Only host-provided modules stay external: @opencode-ai/plugin (peer dep,
  // resolved by the opencode plugin loader) and @opentui/solid (provided by
  // the opencode TUI runtime).
  external: ["@opencode-ai/plugin", "@opentui/solid"],
  noExternal: ["zod", "cac"],
  async onSuccess() {
    // Add shebang + executable bit to dist/cli.js so the bin works.
    const { readFile, writeFile } = await import("node:fs/promises");
    const cliPath = path.resolve("dist/cli.js");
    const contents = await readFile(cliPath, "utf8");
    if (!contents.startsWith("#!/usr/bin/env node")) {
      await writeFile(cliPath, `#!/usr/bin/env node\n${contents}`, "utf8");
    }
    await chmod(cliPath, 0o755);
  },
});
