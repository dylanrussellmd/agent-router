import assert from "node:assert/strict";

/** Minimum host version required by the V2 plugin API used by this package. */
export const MINIMUM_OPENCODE_VERSION = "2.0.8";

/** Accept supported OpenCode 2.x hosts without pinning tests to one patch release. */
export function assertSupportedOpenCodeVersion(version) {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version));
  assert.ok(match, `OpenCode must report a semantic version; received ${JSON.stringify(version)}`);

  const [, majorText, minorText, patchText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);

  assert.equal(major, 2, `This test suite targets OpenCode 2.x; received ${version}`);
  assert.ok(
    minor > 0 || patch >= 8,
    `OpenCode ${MINIMUM_OPENCODE_VERSION} or newer is required; received ${version}`,
  );
  return version;
}
