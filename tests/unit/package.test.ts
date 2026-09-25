import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("published plugin dependencies", () => {
  it("requires the SDK imported by the server bundle on clean installs", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    expect(manifest.peerDependencies["@opencode/plugin"]).toBe("^2.0.8");
    expect(manifest.exports["./tui"].import).toBe("./dist/tui.js");
  });

  it("ships ready-to-load bundles without Git-dependency preparation hooks", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    expect(manifest.scripts.bundle).toBe("tsup");
    expect(manifest.scripts.build).toBeUndefined();
    expect(manifest.scripts.prepare).toBeUndefined();
    for (const bundle of ["plugin.js", "tui.js", "cli.js"])
      expect(readFileSync(new URL(`../../dist/${bundle}`, import.meta.url), "utf8")).toContain(
        "sourceMappingURL",
      );
  });
});
