import { defineConfig } from "tsup";
import { chmod } from "node:fs/promises";
import path from "node:path";

/**
 * tsup config: bundle plugin and CLI as ESM, copy seed JSON files,
 * and `chmod +x` the CLI binary so `omo-router` and `omo` are executable
 * straight out of `npm install`.
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
  // Bundle our deps; mark opencode plugin types as external (peer dep) and
  // @opentui/solid as external (the opencode TUI host provides it at runtime).
  external: ["@opencode-ai/plugin", "@opentui/solid"],
  // Copy seed JSON into dist/seeds so the published package can read them.
  // tsup's `loader` covers code; for static assets we use a custom hook.
  async onSuccess() {
    const { cp } = await import("node:fs/promises");
    await cp(
      path.resolve("src/seeds"),
      path.resolve("dist/seeds"),
      { recursive: true }
    );
    // Add shebang + executable bit to dist/cli.js so the bins work.
    const { readFile, writeFile } = await import("node:fs/promises");
    const cliPath = path.resolve("dist/cli.js");
    const contents = await readFile(cliPath, "utf8");
    if (!contents.startsWith("#!/usr/bin/env node")) {
      await writeFile(cliPath, `#!/usr/bin/env node\n${contents}`, "utf8");
    }
    await chmod(cliPath, 0o755);
  },
});
