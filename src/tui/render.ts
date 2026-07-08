/**
 * Materialize ViewNodes via @opentui/solid's imperative runtime.
 *
 * `SolidRuntime` is structural on purpose: opencode's host provides
 * @opentui/solid at runtime (we never bundle it), and depending on its
 * published types would pin us to a version the host may not match.
 */

import type { ViewNode } from "./view.js";

export interface SolidRuntime {
  createElement(tag: string): unknown;
  insert(parent: unknown, child: unknown): unknown;
  setProp(node: unknown, name: string, value: unknown): unknown;
}

export function materialize(nodes: readonly ViewNode[], solid: SolidRuntime): unknown {
  const root = solid.createElement("box");
  solid.setProp(root, "flexDirection", "column");
  for (const node of nodes) {
    solid.insert(root, materializeNode(node, solid));
  }
  return root;
}

function materializeNode(node: ViewNode, solid: SolidRuntime): unknown {
  const element = solid.createElement(node.kind);
  for (const [name, value] of Object.entries(node.props)) {
    if (value !== undefined) solid.setProp(element, name, value);
  }
  if (node.kind === "text") {
    solid.insert(element, node.text ?? "");
  }
  for (const child of node.children ?? []) {
    solid.insert(element, materializeNode(child, solid));
  }
  return element;
}
