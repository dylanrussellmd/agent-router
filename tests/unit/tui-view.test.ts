import { describe, expect, it } from "vitest";
import { type SolidRuntime, materialize } from "../../src/tui/render.js";
import { type AgentAssignment, type StackSnapshot, snapshotKey } from "../../src/tui/store.js";
import { type ViewNode, buildSidebarNodes, restartRequired } from "../../src/tui/view.js";

const AGENTS: AgentAssignment[] = [];

function allText(nodes: readonly ViewNode[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.text === undefined ? [] : [node.text]),
    ...allText(node.children ?? []),
  ]);
}

const snap = (
  active: string | null,
  stacks: string[] = [],
  agents: AgentAssignment[] = AGENTS,
): StackSnapshot => ({
  active,
  stacks,
  agents,
  key: snapshotKey(active, stacks, agents),
});

describe("buildSidebarNodes", () => {
  it("lists every stack — active checked green, inactive muted unchecked", () => {
    const nodes = buildSidebarNodes(snap("premium", ["cheap", "premium"]), {
      bootActive: "premium",
    });
    const texts = nodes.map((n) => n.text);
    expect(texts[0]).toBe("Agent Stacks");
    expect(texts).toContain(" ▣ premium");
    expect(texts).toContain(" □ cheap");
    // stack count summary was replaced by the per-stack list
    expect(texts.some((t) => /^ \d+ stacks?$/.test(t ?? ""))).toBe(false);
  });

  it("shows (none) when uninitialized", () => {
    const nodes = buildSidebarNodes(snap(null), { bootActive: null });
    expect(nodes.map((n) => n.text)).toContain(" ▣ (none)");
  });

  it("lists all stacks as muted unchecked when no active stack is set", () => {
    const nodes = buildSidebarNodes(snap(null, ["a", "b"]), { bootActive: null });
    const texts = nodes.map((n) => n.text);
    expect(texts).toContain(" □ a");
    expect(texts).toContain(" □ b");
    expect(texts.some((t) => t?.startsWith(" ▣ "))).toBe(false);
  });

  it("adds restart badge only when active differs from boot", () => {
    const same = buildSidebarNodes(snap("a", ["a"]), { bootActive: "a" });
    expect(same.map((n) => n.text)).not.toContain(" ⟳ restart required");

    const switched = buildSidebarNodes(snap("b", ["a", "b"]), { bootActive: "a" });
    expect(switched.map((n) => n.text)).toContain(" ⟳ restart required");
  });

  it("applies theme colors — active green, inactive muted, header text, warning", () => {
    const theme = { text: "TEXT", textMuted: "MUTED", warning: "WARN", success: "OK" };
    const nodes = buildSidebarNodes(snap("b", ["a", "b"]), { bootActive: "a", theme });
    expect(nodes[0].props.fg).toBe("TEXT");
    expect(nodes.find((n) => n.text === " ▣ b")?.props.fg).toBe("OK");
    expect(nodes.find((n) => n.text === " □ a")?.props.fg).toBe("MUTED");
    expect(nodes.find((n) => n.text === " ⟳ restart required")?.props.fg).toBe("WARN");
  });

  it("groups each agent with its primary model and labels routing as configured", () => {
    const agents = [
      { agent: "build", model: "gpt-5" },
      { agent: "explorer", model: "claude-opus" },
    ];
    const nodes = buildSidebarNodes(snap("s", ["s"], agents), { bootActive: "s" });
    const headerIdx = nodes.findIndex((n) => n.text === "Current Stack");
    expect(headerIdx).toBeGreaterThan(0);
    expect(nodes[headerIdx + 1].text).toBe("Configured routing");
    const line1 = nodes[headerIdx + 2];
    const line2 = nodes[headerIdx + 3];
    expect(line1.kind).toBe("box");
    expect(line1.props.flexDirection).toBe("column");
    expect(allText([line1])).toEqual(["•", "build", "Primary → gpt-5"]);
    expect(allText([line2])).toEqual(["•", "explorer", "Primary → claude-opus"]);
  });

  it("renders ordered fallback models and explicit variants under their own agent", () => {
    const agents = [
      {
        agent: "omni",
        model: "a/primary",
        variant: "medium",
        fallbacks: [{ model: "b/backup", variant: "high" }, { model: "c/last" }],
      },
      { agent: "explorer", model: "a/fast", variant: null, fallbacks: [] },
    ];
    const nodes = buildSidebarNodes(snap("s", ["s"], agents), { bootActive: "s" });
    const groups = nodes.filter((node) => node.kind === "box");
    expect(allText([groups[0]])).toEqual([
      "•",
      "omni",
      "Primary → a/primary [medium]",
      "Fallback 1 → b/backup [high]",
      "Fallback 2 → c/last",
    ]);
    expect(allText([groups[1]])).toEqual(["•", "explorer", "Primary → a/fast"]);
    expect(groups[0].children?.[1]?.props.paddingLeft).toBe(2);
    expect(allText(nodes).some((label) => /undefined|null|running/i.test(label))).toBe(false);
  });

  it("renders every fallback up to the schema limit without truncating model IDs", () => {
    const fallbacks = Array.from({ length: 8 }, (_, i) => ({
      model: `provider/organization/long-model-name-${i}`,
    }));
    const texts = allText(
      buildSidebarNodes(snap("s", ["s"], [{ agent: "omni", model: "a/p", fallbacks }]), {
        bootActive: "s",
      }),
    );
    expect(texts.filter((label) => label.startsWith("Fallback "))).toEqual(
      fallbacks.map((fallback, i) => `Fallback ${i + 1} → ${fallback.model}`),
    );
  });

  it("shows (none) under Current Stack when the active stack has no agents", () => {
    const nodes = buildSidebarNodes(snap(null), { bootActive: null });
    const texts = nodes.map((n) => n.text);
    const headerIdx = texts.indexOf("Current Stack");
    expect(texts[headerIdx + 1]).toBe("• (none)");
  });

  it("highlights agent names while keeping primary and fallback details muted", () => {
    const theme = { text: "TEXT", textMuted: "MUTED", success: "OK" };
    const agents = [{ agent: "build", model: "gpt-5", fallbacks: [{ model: "a/backup" }] }];
    const nodes = buildSidebarNodes(snap("s", ["s"], agents), { bootActive: "s", theme });
    const headerIdx = nodes.findIndex((n) => n.text === "Current Stack");
    const line = nodes[headerIdx + 2];
    expect(line.kind).toBe("box");
    const heading = line.children?.[0];
    expect(heading?.children?.[0]?.props.flexShrink).toBe(0);
    expect(heading?.children?.[0]?.props.style).toEqual({ fg: "OK" });
    expect(heading?.children?.[1]?.props.fg).toBe("TEXT");
    expect(heading?.children?.[1]?.props.attributes).toBe(1);
    expect(line.children?.[1]?.children?.map((node) => node.props.fg)).toEqual(["MUTED", "MUTED"]);
    expect(nodes.find((n) => n.text === "Current Stack")?.props.fg).toBe("TEXT");
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
    // Agent Stacks header + active stack line + Current Stack header + (none)
    expect(root.children).toHaveLength(4);
    const first = root.children[0] as FakeNode;
    expect(first.tag).toBe("text");
    expect(first.children).toContain("Agent Stacks");
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

  it("materializes nested primary and fallback rows", () => {
    const solid = fakeSolid();
    const root = materialize(
      buildSidebarNodes(
        snap("s", ["s"], [{ agent: "omni", model: "a/p", fallbacks: [{ model: "b/f" }] }]),
        { bootActive: "s" },
      ),
      solid,
    ) as FakeNode;
    const group = root.children[4] as FakeNode;
    const routing = group.children[1] as FakeNode;
    expect(routing.props.paddingLeft).toBe(2);
    expect(routing.children.map((child) => (child as FakeNode).children)).toEqual([
      ["Primary → a/p"],
      ["Fallback 1 → b/f"],
    ]);
  });
});
