import { describe, expect, it } from "vitest";
import { type SolidRuntime, materialize } from "../../src/tui/render.js";
import { type StackSnapshot, snapshotKey } from "../../src/tui/store.js";
import { buildSidebarNodes, restartRequired } from "../../src/tui/view.js";

const snap = (active: string | null, stacks: string[] = []): StackSnapshot => ({
  active,
  stacks,
  key: snapshotKey(active, stacks),
});

describe("buildSidebarNodes", () => {
  it("renders title, active stack, and stack count", () => {
    const nodes = buildSidebarNodes(snap("premium", ["cheap", "premium"]), {
      bootActive: "premium",
    });
    const texts = nodes.map((n) => n.text);
    expect(texts[0]).toBe("omo-router");
    expect(texts).toContain(" ▣ premium");
    expect(texts).toContain(" 2 stacks");
  });

  it("shows (none) when uninitialized", () => {
    const nodes = buildSidebarNodes(snap(null), { bootActive: null });
    expect(nodes.map((n) => n.text)).toContain(" ▣ (none)");
  });

  it("adds restart badge only when active differs from boot", () => {
    const same = buildSidebarNodes(snap("a", ["a"]), { bootActive: "a" });
    expect(same.map((n) => n.text)).not.toContain(" ⟳ restart required");

    const switched = buildSidebarNodes(snap("b", ["a", "b"]), { bootActive: "a" });
    expect(switched.map((n) => n.text)).toContain(" ⟳ restart required");
  });

  it("uses singular form for one stack", () => {
    const nodes = buildSidebarNodes(snap("a", ["a"]), { bootActive: "a" });
    expect(nodes.map((n) => n.text)).toContain(" 1 stack");
  });

  it("applies theme colors when provided", () => {
    const theme = { textMuted: "MUTED", warning: "WARN", success: "OK" };
    const nodes = buildSidebarNodes(snap("b", ["b"]), { bootActive: "a", theme });
    expect(nodes[0].props.fg).toBe("MUTED");
    expect(nodes.find((n) => n.text === " ⟳ restart required")?.props.fg).toBe("WARN");
  });
});

describe("restartRequired", () => {
  it("false at boot, true after a switch, false after switching back", () => {
    expect(restartRequired(snap("a"), { bootActive: "a" })).toBe(false);
    expect(restartRequired(snap("b"), { bootActive: "a" })).toBe(true);
    expect(restartRequired(snap("a"), { bootActive: "a" })).toBe(false);
  });
});

describe("materialize", () => {
  type FakeNode = {
    tag: string;
    props: Record<string, unknown>;
    children: Array<FakeNode | string>;
  };

  const fakeSolid = (): SolidRuntime & { roots: FakeNode[] } => {
    const roots: FakeNode[] = [];
    return {
      roots,
      createElement(tag: string) {
        const node: FakeNode = { tag, props: {}, children: [] };
        roots.push(node);
        return node;
      },
      insert(parent: unknown, child: unknown) {
        (parent as FakeNode).children.push(child as FakeNode | string);
      },
      setProp(node: unknown, name: string, value: unknown) {
        (node as FakeNode).props[name] = value;
      },
    };
  };

  it("wraps nodes in a column box and inserts text content", () => {
    const solid = fakeSolid();
    const root = materialize(
      buildSidebarNodes(snap("premium", ["premium"]), { bootActive: "premium" }),
      solid,
    ) as FakeNode;

    expect(root.tag).toBe("box");
    expect(root.props.flexDirection).toBe("column");
    expect(root.children).toHaveLength(3);
    const first = root.children[0] as FakeNode;
    expect(first.tag).toBe("text");
    expect(first.children).toContain("omo-router");
  });

  it("skips undefined props", () => {
    const solid = fakeSolid();
    const root = materialize(
      buildSidebarNodes(snap("a", ["a"]), { bootActive: "a" }),
      solid,
    ) as FakeNode;
    const first = root.children[0] as FakeNode;
    expect("fg" in first.props).toBe(false);
  });
});
