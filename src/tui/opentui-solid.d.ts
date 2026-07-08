/**
 * Ambient declaration for the host-provided @opentui/solid module.
 *
 * opencode's TUI injects this module at runtime (Bun runtime-plugin support),
 * and the injection only intercepts LITERAL import specifiers — a computed
 * `import(name)` falls through to filesystem resolution and fails. So the
 * import in index.ts must stay literal, which requires this declaration
 * since we deliberately do not depend on @opentui/solid's published types.
 */
declare module "@opentui/solid" {
  export function createElement(tag: string): unknown;
  export function insert(parent: unknown, child: unknown): unknown;
  export function setProp(node: unknown, name: string, value: unknown): unknown;
}
