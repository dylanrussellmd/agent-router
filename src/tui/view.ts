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

/** Live model selection observed for one agent in a session. */
export interface LiveSelection extends ModelAssignment {
  readonly agent: string;
}

/** Routing mode of the viewed session, as reported by the status service. */
export interface RoutingStatus {
  readonly mode: "automatic" | "pinned";
  readonly reason?: string | undefined;
  /** Epoch ms of the last quota evaluation behind the current mode, if tracked. */
  readonly checkedAt?: number | null | undefined;
}

export interface SidebarContext {
  /** Active stack when the TUI booted — differing means a restart is due. */
  readonly bootActive: string | null;
  readonly theme?: SidebarTheme | undefined;
  /** Only the agent/model from this sidebar's live session may be marked current. */
  readonly current?: (ModelAssignment & { readonly agent: string }) | undefined;
  /**
   * Selections of running direct children of the viewed session, at its location.
   * Conflicting models are all retained. The viewed session takes precedence.
   */
  readonly live?: readonly LiveSelection[] | undefined;
  readonly defaults?: readonly LiveSelection[] | undefined;
  /** Routing mode of the viewed session; omitted when no status source answers. */
  readonly routing?: RoutingStatus | undefined;
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

function quotaAge(checkedAt: number, now = Date.now()): string {
  return `${Math.max(0, Math.round((now - checkedAt) / 1000))}s ago`;
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
  if (ctx.routing) {
    const parts = [`Routing · ${ctx.routing.mode === "pinned" ? "Pinned" : "Automatic"}`];
    if (ctx.routing.reason) parts.push(ctx.routing.reason);
    parts.push(
      ctx.routing.checkedAt != null
        ? `quota ${quotaAge(ctx.routing.checkedAt)}`
        : "quota freshness unknown",
    );
    nodes.push(text(parts.join(" · "), { fg: theme.textMuted }));
  } else {
    nodes.push(text("Routing · unknown · freshness unknown", { fg: theme.textMuted }));
  }
  if (snapshot.agents.length === 0) {
    nodes.push(text("• (none)", { fg: theme.textMuted }));
  } else {
    nodes.push(text("Precedence ↓ · ● selected", { fg: theme.textMuted }));
    for (const assignment of snapshot.agents) {
      const chain = [assignment, ...(assignment.fallbacks ?? [])];
      const current = ctx.current?.agent === assignment.agent ? ctx.current : undefined;
      const children = (ctx.live ?? []).filter((entry) => entry.agent === assignment.agent);
      const configured = ctx.defaults?.find((entry) => entry.agent === assignment.agent);
      const selections = current
        ? [current]
        : children.length
          ? children
          : [configured ?? assignment];
      const unique = selections.filter(
        (entry, index) => selections.findIndex((other) => sameModel(entry, other)) === index,
      );
      const source = current
        ? "viewed session"
        : children.length
          ? `active children${unique.length > 1 ? " · multiple models" : ""}`
          : configured
            ? "native default"
            : "stack default";
      const modelRow = (model: ModelAssignment, active: boolean) =>
        text(`${active ? "● " : "  "}${modelLabel(model)}`, {
          fg: active ? theme.warning : theme.textMuted,
          attributes: active ? TEXT_ATTR_BOLD : 0,
          wrapMode: "char",
          width: "100%",
        });
      nodes.push({
        kind: "box",
        props: { flexDirection: "column", marginTop: 1 },
        children: [
          text(`${assignment.agent} · ${source}`, { fg: theme.text, attributes: TEXT_ATTR_BOLD }),
          {
            kind: "box",
            props: { flexDirection: "column", paddingLeft: 2 },
            children: [
              ...chain.map((model) =>
                modelRow(
                  model,
                  unique.some((selected) => sameModel(model, selected)),
                ),
              ),
              ...unique
                .filter((selected) => !chain.some((model) => sameModel(model, selected)))
                .map((selected) => modelRow(selected, true)),
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
