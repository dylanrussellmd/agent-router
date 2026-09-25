import { describe, expect, it } from "vitest";
import { assertSupportedOpenCodeVersion } from "../../scripts/lib/opencode-version.mjs";

describe("native OpenCode host-version guard", () => {
  it.each(["2.0.8", "2.0.14", "2.0.15", "2.1.0", "2.99.0"])(
    "accepts supported 2.x host %s",
    (version) => {
      expect(assertSupportedOpenCodeVersion(version)).toBe(version);
    },
  );

  it.each(["1.18.29", "2.0.7", "3.0.0", "unknown"])("rejects unsupported host %s", (version) => {
    expect(() => assertSupportedOpenCodeVersion(version)).toThrow();
  });
});
