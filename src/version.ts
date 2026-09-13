/**
 * Hard-coded version string. Kept in sync with package.json by the publish
 * pipeline (`npm version` bumps both). Not read from package.json at runtime
 * to avoid a filesystem read on plugin init in opencode's Bun runtime.
 */
export const VERSION = "1.1.0";
