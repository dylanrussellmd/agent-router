/**
 * Hard-coded version string. Kept in sync with package.json by the publish
 * pipeline (`npm version` bumps both). We don't read package.json at runtime
 * because that would either pull a Node-specific JSON import flag or force a
 * filesystem read on plugin init in opencode's Bun runtime.
 */
export const VERSION = "1.0.1";
