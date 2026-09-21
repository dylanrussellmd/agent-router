/**
 * Pure view model for the sidebar — no opentui imports, fully unit-testable.
 * `materialize` in render.ts turns these nodes into real opentui elements.
 */

import type { ModelAssignment, StackSnapshot } from "./store.js";

export interface ViewNode {
  readonly kind: "box" | "text";
  readonly props: Readonly<Record<string, unknown>>;
  readonly text?: string;
  readonly children?: readonly ViewNode[];
}

export interface SidebarTheme {
  readonly text?: unknown;
  readonly textMuted?: unknown;
  readonly warning?: unknown;
  readonly success?: unknown;
}

export interface SidebarContext {
  /** Active stack when the TUI booted — differing means a restart is due. */
  readonly bootActive: string | null;
  readonly theme?: SidebarTheme | undefined;
  /** Only the agent/model from this sidebar's live session may be marked current. */
  readonly current?: (ModelAssignment & { readonly agent: string }) | undefined;
}

/** Mirrors @opentui/core's TextAttributes.BOLD bitflag — opentui is host-provided and never imported here (see render.ts). */
const TEXT_ATTR_BOLD = 1;

function text(content: string, props: Record<string, unknown> = {}): ViewNode {
  return { kind: "text", props, text: content };
}

export function restartRequired(snapshot: StackSnapshot, ctx: SidebarContext): boolean {
  return snapshot.active !== ctx.bootActive;
}

function modelLabel(assignment: ModelAssignment): string {
  const variant = normalizeVariant(assignment.variant);
  return `${assignment.model}${variant ? ` [${variant}]` : ""}`;
}

function normalizeVariant(variant: string | null | undefined): string | undefined {
  return variant && variant !== "default" ? variant : undefined;
}

function sameModel(a: ModelAssignment, b: ModelAssignment): boolean {
  return a.model === b.model && normalizeVariant(a.variant) === normalizeVariant(b.variant);
}

export function buildSidebarNodes(snapshot: StackSnapshot, ctx: SidebarContext): ViewNode[] {
  const theme = ctx.theme ?? {};
  const nodes: ViewNode[] = [text("Agent Stacks", { fg: theme.text, attributes: TEXT_ATTR_BOLD })];

  if (snapshot.stacks.length === 0) {
    // Uninitialized: nothing on disk, surface the empty state.
    nodes.push(text(" ▣ (none)", { fg: theme.success }));
  } else {
    for (const name of snapshot.stacks) {
      const isActive = name === snapshot.active;
      nodes.push(
        text(`${isActive ? " ▣ " : " □ "}${name}`, {
          fg: isActive ? theme.success : theme.textMuted,
        }),
      );
    }
  }

  nodes.push(
    text(`Current Stack · ${snapshot.active ?? "(none)"}`, {
      fg: theme.text,
      attributes: TEXT_ATTR_BOLD,
      marginTop: 1,
    }),
  );
  if (snapshot.agents.length === 0) {
    nodes.push(text("• (none)", { fg: theme.textMuted }));
  } else {
    nodes.push(text("Precedence ↓ · ● current", { fg: theme.textMuted }));
    for (const assignment of snapshot.agents) {
      const chain = [assignment, ...(assignment.fallbacks ?? [])];
      const current = ctx.current?.agent === assignment.agent ? ctx.current : undefined;
      const selected = current ? chain.findIndex((model) => sameModel(model, current)) : -1;
      const modelRow = (model: ModelAssignment, active: boolean, external = false) =>
        text(`${active ? "● " : "  "}${external ? "Current · " : ""}${modelLabel(model)}`, {
          fg: active ? theme.success : theme.textMuted,
          attributes: active ? TEXT_ATTR_BOLD : 0,
          wrapMode: "char",
          width: "100%",
        });
      nodes.push({
        kind: "box",
        props: { flexDirection: "column", marginTop: 1 },
        children: [
          text(assignment.agent, { fg: theme.text, attributes: TEXT_ATTR_BOLD }),
          {
            kind: "box",
            props: { flexDirection: "column", paddingLeft: 2 },
            children: [
              ...chain.map((model, index) => modelRow(model, index === selected)),
              ...(current && selected === -1 ? [modelRow(current, true, true)] : []),
            ],
          },
        ],
      });
    }
  }

  if (restartRequired(snapshot, ctx)) {
    nodes.push(text(" ⟳ restart required", { fg: theme.warning }));
  }
  return nodes;
}
