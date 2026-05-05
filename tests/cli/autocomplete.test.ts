import { exec } from "node:child_process";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const execAsync = promisify(exec);

describe("CLI Autocomplete", () => {
  beforeAll(async () => {
    // Ensure the test environment has the seed stacks dropped in the mock
    // config directory before asserting on completion resolution.
    await execAsync("npx tsx src/cli.ts init");
  });

  it("dynamically returns stacks for the 'completion-resolve' command", async () => {
    const { stdout } = await execAsync("npx tsx src/cli.ts completion-resolve");

    expect(stdout).toContain("premium");
    expect(stdout).toContain("openrouter-cheap");
    expect(stdout).toContain("free-only");
  });
});
