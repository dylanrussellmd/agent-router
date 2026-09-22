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
  const routing = [
    {
      agent: "build",
      model: "a/primary",
      fallbacks: [{ model: "b/fallback", variant: "high" }, { model: "c/last" }],
    },
    { agent: "explorer", model: "b/fallback", variant: "high" },
  ];
  const theme = { text: "TEXT", textMuted: "MUTED", warning: "ORANGE", success: "SELECTED" };
  const rows = (nodes: ViewNode[]) =>
    nodes.filter((n) => n.kind === "box").flatMap((n) => n.children?.[1]?.children ?? []);

  it("highlights the live agent's fallback orange without changing precedence", () => {
    const nodes = buildSidebarNodes(snap("s", ["s"], routing), {
      bootActive: "s",
      theme,
      current: { agent: "build", model: "b/fallback", variant: "high" },
    });
    expect(rows(nodes).map((n) => n.text)).toEqual([
      "  a/primary",
      "● b/fallback [high]",
      "  c/last",
      "● b/fallback [high]",
    ]);
    expect(rows(nodes).map((n) => n.props.fg)).toEqual(["MUTED", "ORANGE", "MUTED", "ORANGE"]);
    expect(rows(nodes)[1]?.props.attributes).toBe(1);
    expect(rows(nodes).every((n) => n.props.wrapMode === "char" && n.props.width === "100%")).toBe(
      true,
    );
  });

  it("marks every agent's configured primary orange when no live selection is visible", () => {
    const nodes = buildSidebarNodes(snap("s", ["s"], routing), { bootActive: "s", theme });
    expect(rows(nodes).map((n) => n.text)).toEqual([
      "● a/primary",
      "  b/fallback [high]",
      "  c/last",
      "● b/fallback [high]",
    ]);
    expect(rows(nodes).map((n) => n.props.fg)).toEqual(["ORANGE", "MUTED", "MUTED", "ORANGE"]);
    expect(rows(nodes).map((n) => n.props.attributes)).toEqual([1, 0, 0, 1]);
  });

  it("prefers active child selections for other agents", () => {
    const nodes = buildSidebarNodes(snap("s", ["s"], routing), {
      bootActive: "s",
      theme,
      live: [
        { agent: "explorer", model: "b/fallback", variant: "high" },
        { agent: "build", model: "c/last" },
      ],
    });
    expect(rows(nodes).map((n) => n.text)).toEqual([
      "  a/primary",
      "  b/fallback [high]",
      "● c/last",
      "● b/fallback [high]",
    ]);
    expect(rows(nodes).map((n) => n.props.fg)).toEqual(["MUTED", "MUTED", "ORANGE", "ORANGE"]);
  });

  it("gives the viewed session's selection precedence over children with the same agent", () => {
    const nodes = buildSidebarNodes(snap("s", ["s"], routing), {
      bootActive: "s",
      theme,
      current: { agent: "build", model: "a/primary" },
      live: [{ agent: "build", model: "c/last" }],
    });
    expect(rows(nodes).map((n) => n.text)).toEqual([
      "● a/primary",
      "  b/fallback [high]",
      "  c/last",
      "● b/fallback [high]",
    ]);
  });

  it("appends an explicit external current model, including mismatched variants", () => {
    for (const current of [
      { agent: "build", model: "external/org/model", variant: "high" },
      { agent: "build", model: "b/fallback", variant: "low" },
    ]) {
      const nodes = buildSidebarNodes(snap("s", ["s"], routing), {
        bootActive: "s",
        theme,
        current,
      });
      expect(
        rows(nodes)
          .slice(0, 3)
          .map((n) => n.props.fg),
      ).toEqual(["MUTED", "MUTED", "MUTED"]);
      expect(rows(nodes)[3]?.text).toBe(`● ${current.model} [${current.variant}]`);
      expect(rows(nodes)[3]?.props.fg).toBe("ORANGE");
    }
  });

  it("appends an external child selection without hiding the configured chain", () => {
    const nodes = buildSidebarNodes(snap("s", ["s"], routing), {
      bootActive: "s",
      theme,
      live: [{ agent: "explorer", model: "external/org/model" }],
    });
    expect(rows(nodes).map((n) => n.text)).toEqual([
      "● a/primary",
      "  b/fallback [high]",
      "  c/last",
      "  b/fallback [high]",
      "● external/org/model",
    ]);
    expect(rows(nodes)[4]?.props.fg).toBe("ORANGE");
  });

  it("normalizes default variants in both selection and labels", () => {
    for (const configured of [undefined, null, "default"]) {
      for (const live of [undefined, null, "default"]) {
        const nodes = buildSidebarNodes(
          snap("s", ["s"], [{ agent: "build", model: "a/model", variant: configured }]),
          {
            bootActive: "s",
            current: { agent: "build", model: "a/model", variant: live },
          },
        );
        expect(rows(nodes).map((n) => n.text)).toEqual(["● a/model"]);
      }
    }
  });
  it("marks every distinct active child model without choosing an arbitrary winner", () => {
    const nodes = buildSidebarNodes(snap("s", ["s"], routing), {
      bootActive: "s",
      theme,
      live: [
        { agent: "build", model: "a/primary" },
        { agent: "build", model: "c/last" },
        { agent: "build", model: "c/last" },
      ],
    });
    expect(allText(nodes)).toContain("build · active children · multiple models");
    expect(
      rows(nodes)
        .slice(0, 3)
        .map((n) => n.props.fg),
    ).toEqual(["ORANGE", "MUTED", "ORANGE"]);
  });

  it("uses the native configured model before the stack primary", () => {
    const nodes = buildSidebarNodes(snap("s", ["s"], routing), {
      bootActive: "s",
      theme,
      defaults: [{ agent: "build", model: "b/fallback", variant: "high" }],
    });
    expect(allText(nodes)).toContain("build · native default");
    expect(
      rows(nodes)
        .slice(0, 3)
        .map((n) => n.props.fg),
    ).toEqual(["MUTED", "ORANGE", "MUTED"]);
  });
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

  it("leaves one blank row between Agent Stacks and Current Stack", () => {
    for (const snapshot of [snap(null), snap("premium", ["cheap", "premium"])]) {
      const nodes = buildSidebarNodes(snapshot, { bootActive: snapshot.active });
      const index = nodes.findIndex((node) => node.text?.startsWith("Current Stack ·"));
      expect(nodes[index].props.marginTop).toBe(1);
      expect(nodes[index - 1].props.marginBottom ?? 0).toBe(0);
    }
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

  it("groups each agent with its primary model and labels the marks as live or configured", () => {
    const agents = [
      { agent: "build", model: "gpt-5" },
      { agent: "explorer", model: "claude-opus" },
    ];
    const nodes = buildSidebarNodes(snap("s", ["s"], agents), { bootActive: "s" });
    const headerIdx = nodes.findIndex((n) => n.text?.startsWith("Current Stack ·"));
    expect(headerIdx).toBeGreaterThan(0);
    expect(nodes[headerIdx + 2].text).toBe("Precedence ↓ · ● selected");
    const line1 = nodes[headerIdx + 3];
    const line2 = nodes[headerIdx + 4];
    expect(line1.kind).toBe("box");
    expect(line1.props.flexDirection).toBe("column");
    expect(allText([line1])).toEqual(["build · stack default", "● gpt-5"]);
    expect(allText([line2])).toEqual(["explorer · stack default", "● claude-opus"]);
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
      "omni · stack default",
      "● a/primary [medium]",
      "  b/backup [high]",
      "  c/last",
    ]);
    expect(allText([groups[1]])).toEqual(["explorer · stack default", "● a/fast"]);
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
    expect(texts.filter((label) => label.startsWith("  provider/"))).toEqual(
      fallbacks.map((fallback) => `  ${fallback.model}`),
    );
  });

  it("shows (none) under Current Stack when the active stack has no agents", () => {
    const nodes = buildSidebarNodes(snap(null), { bootActive: null });
    const texts = nodes.map((n) => n.text);
    const headerIdx = texts.indexOf("Current Stack · (none)");
    expect(texts[headerIdx + 2]).toBe("• (none)");
  });

  it("highlights agent names, marks the configured primary orange, keeps fallbacks muted", () => {
    const theme = { text: "TEXT", textMuted: "MUTED", warning: "ORANGE", success: "OK" };
    const agents = [{ agent: "build", model: "gpt-5", fallbacks: [{ model: "a/backup" }] }];
    const nodes = buildSidebarNodes(snap("s", ["s"], agents), { bootActive: "s", theme });
    const headerIdx = nodes.findIndex((n) => n.text?.startsWith("Current Stack ·"));
    const line = nodes[headerIdx + 3];
    expect(line.kind).toBe("box");
    const heading = line.children?.[0];
    expect(heading?.props.fg).toBe("TEXT");
    expect(heading?.props.attributes).toBe(1);
    expect(line.children?.[1]?.children?.map((node) => node.props.fg)).toEqual(["ORANGE", "MUTED"]);
    expect(nodes.find((n) => n.text?.startsWith("Current Stack ·"))?.props.fg).toBe("TEXT");
  });

  it("reports unknown status and freshness unless supplied by a status source", () => {
    const agents = [{ agent: "build", model: "gpt-5" }];
    const without = buildSidebarNodes(snap("s", ["s"], agents), { bootActive: "s" });
    expect(allText(without)).toContain("Routing · unknown · freshness unknown");

    const automatic = buildSidebarNodes(snap("s", ["s"], agents), {
      bootActive: "s",
      routing: { mode: "automatic", reason: "primary_available" },
    });
    const headerIdx = automatic.findIndex((n) => n.text?.startsWith("Current Stack ·"));
    expect(automatic[headerIdx + 1].text).toBe(
      "Routing · Automatic · primary_available · quota freshness unknown",
    );
    expect(automatic[headerIdx + 1].props.fg).toBeUndefined();

    const pinned = buildSidebarNodes(snap("s", ["s"], agents), {
      bootActive: "s",
      theme: { textMuted: "MUTED" },
      routing: { mode: "pinned", reason: "explicit_pin", checkedAt: Date.now() - 30_000 },
    });
    const pinnedHeaderIdx = pinned.findIndex((n) => n.text?.startsWith("Current Stack ·"));
    expect(pinned[pinnedHeaderIdx + 1].text).toBe(
      "Routing · Pinned · explicit_pin · quota 30s ago",
    );
    expect(pinned[pinnedHeaderIdx + 1].props.fg).toBe("MUTED");
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
    // Stack headings, routing availability, and empty-agent placeholder.
    expect(root.children).toHaveLength(5);
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
    const group = root.children[5] as FakeNode;
    const routing = group.children[1] as FakeNode;
    expect(routing.props.paddingLeft).toBe(2);
    expect(routing.children.map((child) => (child as FakeNode).children)).toEqual([
      ["● a/p"],
      ["  b/f"],
    ]);
  });
});
