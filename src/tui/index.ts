/**
 * TUI plugin entry for agent-router (opencode >= 1.17).
 *
 * Loaded by opencode's TUI runtime via package.json `exports["./tui"]` and a
 * `tui.json` plugin[] entry (`agent-router init` writes it). Renders the
 * active stack into the sidebar, polls for external changes (CLI/agent
 * switches), and registers the /agent-* command set (switch, view, edit,
 * back, validate, status). Every host call is guarded so a TUI API change
 * degrades to missing features, never a crash — see host.ts for the
 * API-typing stance.
 */

import type { Context } from "@opencode/plugin/tui/context";
import { resolvePathsWithConfig } from "../core/config.js";
import { RoutingStatusOutput, RoutingStatusRpc } from "../routing-status.js";
import {
  type DialogDeps,
  canOpenDialogs,
  openBackConfirm,
  openRoutingMode,
  openStackEditor,
  openStackSwitcher,
  openStackViewer,
  openValidator,
} from "./dialogs.js";
import type { RouterTuiApi, TuiCommandEntry } from "./host.js";
import { type SolidRuntime, materialize } from "./render.js";
import { createRoutingPoller } from "./routing-poller.js";
import { createSidebarPoller, readStackSnapshot } from "./store.js";
import { type RoutingStatus, buildSidebarNodes } from "./view.js";

const POLL_INTERVAL_MS = 1500;
const SIDEBAR_ORDER = 850;

/**
 * TUI plugins have no visible stderr; opencode swallows console output. When
 * AGENT_ROUTER_TUI_DEBUG (legacy OMO_TUI_DEBUG) is set, append trace lines to
 * that file so failures inside tui() are diagnosable at all.
 */
function debugLog(message: string): void {
  const target = process.env.AGENT_ROUTER_TUI_DEBUG ?? process.env.OMO_TUI_DEBUG;
  if (!target) return;
  import("node:fs")
    .then((fs) => fs.appendFileSync(target, `${new Date().toISOString()} ${message}\n`))
    .catch(() => {});
}

async function importHostSolid(): Promise<SolidRuntime | null> {
  try {
    const mod = (await import("@opentui/solid")) as Record<string, unknown>;
    if (typeof mod.createElement !== "function") {
      debugLog("solid module lacks createElement — treating as unavailable");
      return null;
    }
    return mod as unknown as SolidRuntime;
  } catch (e) {
    debugLog(`solid import FAILED: ${(e as Error).message}`);
    return null;
  }
}

function buildCommands(api: RouterTuiApi, deps: DialogDeps, status: () => void): TuiCommandEntry[] {
  const commands: TuiCommandEntry[] = [
    {
      title: "agent-router: status",
      value: "agent-router.status",
      description: "Show the active agent-router stack",
      category: "agent-router",
      slash: { name: "agent-status" },
      onSelect: status,
    },
  ];
  if (canOpenDialogs(api) && api.currentSessionID && api.readRouting && api.controlRouting)
    commands.push({
      title: "agent-router: session routing",
      value: "agent-router.routing",
      description: "View or switch this session between automatic and pinned routing",
      category: "agent-router",
      slash: { name: "agent-routing" },
      onSelect: () => openRoutingMode(api),
    });
  if (!canOpenDialogs(api)) return commands;
  commands.push(
    {
      title: "agent-router: switch stack",
      value: "agent-router.switch",
      description: "Apply a different model stack to your agents",
      category: "agent-router",
      slash: { name: "agent-switch", aliases: ["ar"] },
      onSelect: () => openStackSwitcher(deps),
    },
    {
      title: "agent-router: view stack",
      value: "agent-router.view",
      description: "Inspect a stack's agent → model assignments",
      category: "agent-router",
      slash: { name: "agent-view" },
      onSelect: () => openStackViewer(deps),
    },
    {
      title: "agent-router: edit stack",
      value: "agent-router.edit",
      description: "Reassign a model inside a stack",
      category: "agent-router",
      slash: { name: "agent-edit" },
      onSelect: () => openStackEditor(deps),
    },
    {
      title: "agent-router: undo last switch",
      value: "agent-router.back",
      description: "Revert to the previously active stack",
      category: "agent-router",
      slash: { name: "agent-back" },
      onSelect: () => openBackConfirm(deps),
    },
    {
      title: "agent-router: validate stack",
      value: "agent-router.validate",
      description: "Check a stack's model IDs against reachable models",
      category: "agent-router",
      slash: { name: "agent-validate" },
      onSelect: () => openValidator(deps),
    },
  );
  return commands;
}

export const tui = async (api: RouterTuiApi): Promise<void> => {
  debugLog("tui() entered");
  const solid = await importHostSolid();
  if (!solid) return;

  const paths = await resolvePathsWithConfig().catch(() => null);
  if (!paths) return;

  let snapshot = await readStackSnapshot(paths);
  const bootActive = snapshot.active;
  const viewContext = (sessionID?: string) => ({
    bootActive,
    theme: api.theme?.current,
    current: sessionID ? api.currentModel?.(sessionID) : undefined,
    live: sessionID ? api.liveSelections?.(sessionID) : undefined,
    defaults: api.configuredModels?.(),
    routing: sessionID ? api.currentRouting?.(sessionID) : undefined,
  });

  try {
    api.slots.register({
      order: SIDEBAR_ORDER,
      slots: {
        sidebar_content: (sessionID) => {
          return materialize(buildSidebarNodes(snapshot, viewContext(sessionID)), solid);
        },
      },
    });
    debugLog("slots.register ok");
  } catch (e) {
    debugLog(`slots.register FAILED: ${(e as Error).message}`);
    return;
  }
  api.renderer.requestRender();

  const applySnapshot = (next: typeof snapshot) => {
    snapshot = next;
    api.renderer.requestRender();
  };

  const refresh = () => {
    readStackSnapshot(paths)
      .then(applySnapshot)
      .catch(() => {});
  };

  const stopPolling = createSidebarPoller({
    read: () => readStackSnapshot(paths),
    intervalMs: POLL_INTERVAL_MS,
    initial: snapshot,
    onChange: (next, prev) => {
      applySnapshot(next);
      if (next.active !== prev.active) {
        const suffix = next.active === bootActive ? "" : " — restart opencode to apply";
        api.ui.toast({
          title: "agent-router",
          message: `stack → ${next.active ?? "(none)"}${suffix}`,
          variant: "info",
        });
      }
    },
  });

  const deps: DialogDeps = { api, paths, refresh };
  const status = () =>
    api.ui.toast({
      title: "agent-router",
      message: `active: ${snapshot.active ?? "(none)"} · stacks: ${snapshot.stacks.join(", ") || "(none)"}`,
      variant: "info",
    });

  try {
    api.command?.register(() => buildCommands(api, deps, status));
    debugLog(`commands registered (dialogs=${canOpenDialogs(api)})`);
  } catch (e) {
    debugLog(`command.register FAILED: ${(e as Error).message}`);
  }

  api.lifecycle.onDispose(stopPolling);
  debugLog(`tui() init complete — active=${snapshot.active ?? "(none)"}`);
};

const agentRouterTui = {
  id: "agent-router:tui",
  async setup(ctx: Context) {
    const solid = await importHostSolid();
    if (!solid) return;
    const cleanups: Array<() => void | Promise<void>> = [];
    const { createEffect, onCleanup } = await import("solid-js");
    let statusSession: string | undefined;
    let statusValue: RoutingStatus | undefined;
    let targetLocation = ctx.location;
    let targetClient = ctx.client;
    let targetKey = "";
    let statusOwner: object | undefined;
    const [revision, updateRevision] = ctx.storage.memory("sidebar-revision", {
      initial: { value: 0 },
    });
    const statusPoller = createRoutingPoller<RoutingStatus>({
      read: async (sessionID, signal) => {
        const location = targetLocation ?? ctx.data.location.default();
        const value = await targetClient
          .rpc(RoutingStatusRpc)
          .status({ sessionID }, { location, signal });
        const parsed = RoutingStatusOutput.safeParse(value);
        return parsed.success && parsed.data.sessionID === sessionID ? parsed.data : undefined;
      },
      publish: (id, value) => {
        statusSession = id;
        statusValue = value;
        updateRevision((draft) => {
          draft.value++;
        });
        ctx.renderer.requestRender();
      },
    });
    cleanups.push(() => statusPoller.dispose());
    const api: RouterTuiApi = {
      slots: {
        register: ({ slots }) => {
          for (const render of Object.values(slots)) {
            cleanups.push(
              ctx.ui.slot({
                append: "sidebar.content",
                render: (input) => {
                  const owner = {};
                  createEffect(() => {
                    const route = ctx.ui.router.current();
                    if (route.type !== "session" || route.sessionID !== input.sessionID) {
                      if (statusOwner === owner) {
                        statusOwner = undefined;
                        statusPoller.select(undefined);
                      }
                      return;
                    }
                    statusOwner = owner;
                    const location = ctx.location ?? ctx.data.location.default();
                    const key = JSON.stringify(location);
                    if (key !== targetKey || targetClient !== ctx.client)
                      statusPoller.select(undefined);
                    targetKey = key;
                    targetLocation = location;
                    targetClient = ctx.client;
                    statusPoller.select(input.sessionID);
                  });
                  onCleanup(() => {
                    if (statusOwner === owner) {
                      statusOwner = undefined;
                      statusPoller.select(undefined);
                    }
                  });
                  const node = solid.createElement("box");
                  solid.setProp(node, "flexDirection", "column");
                  solid.insert(node, () => {
                    void revision.value;
                    return render(input.sessionID);
                  });
                  return node as never;
                },
              }),
            );
          }
        },
      },
      renderer: {
        requestRender: () => {
          updateRevision((draft) => {
            draft.value++;
          });
          ctx.renderer.requestRender();
        },
      },
      ui: {
        toast: (input) => ctx.ui.toast.show(input),
        dialog: {
          replace: (render) => {
            render();
          },
          clear: () => ctx.ui.dialog.clear(),
        },
        DialogSelect: (props) => {
          void ctx.ui.dialog
            .select({
              title: props.title,
              options: props.options.map((option) => ({
                title: option.title,
                value: option.value,
                ...(option.description ? { description: option.description } : {}),
                ...(option.category ? { category: option.category } : {}),
                ...(option.disabled !== undefined ? { disabled: option.disabled } : {}),
              })),
              current: props.current,
            })
            .then((value) => {
              const option = props.options.find((option) => option.value === value);
              if (option) {
                option.onSelect?.();
                props.onSelect?.(option);
              }
            });
          return null;
        },
        DialogConfirm: (props) => {
          void ctx.ui.dialog.confirm({ title: props.title, message: props.message }).then((yes) => {
            if (yes) props.onConfirm?.();
            else props.onCancel?.();
          });
          return null;
        },
      },
      command: {
        register: (build) =>
          cleanups.push(
            ctx.ui.slot({
              append: "app",
              render: () => {
                // Keymap.Provider is available only under a mounted UI owner.
                ctx.keymap.layer(() => ({
                  mode: "global",
                  commands: build().map((command) => ({
                    id: command.value,
                    title: command.title,
                    group: command.category ?? "agent-router",
                    palette: true,
                    ...(command.slash
                      ? {
                          slash: {
                            name: command.slash.name,
                            aliases: [...(command.slash.aliases ?? [])],
                          },
                        }
                      : {}),
                    run: () => command.onSelect?.(),
                  })),
                }));
                return null;
              },
            }),
          ),
      },
      lifecycle: { onDispose: (cleanup) => cleanups.push(cleanup) },
      currentRouting: (id) => (id === statusSession ? statusValue : undefined),
      currentSessionID: () => {
        const route = ctx.ui.router.current();
        return route.type === "session" ? route.sessionID : undefined;
      },
      readRouting: async (sessionID) => {
        const location = targetLocation ?? ctx.data.location.default();
        const value = await targetClient.rpc(RoutingStatusRpc).status({ sessionID }, { location });
        const parsed = RoutingStatusOutput.safeParse(value);
        return parsed.success && parsed.data.sessionID === sessionID ? parsed.data : undefined;
      },
      controlRouting: async (sessionID, action) => {
        const location = targetLocation ?? ctx.data.location.default();
        const value = await targetClient
          .rpc(RoutingStatusRpc)
          .control({ sessionID, action }, { location });
        const parsed = RoutingStatusOutput.safeParse(value);
        return parsed.success && parsed.data.sessionID === sessionID ? parsed.data : undefined;
      },
      theme: {
        get current() {
          return {
            text: ctx.theme.text.default,
            textMuted: ctx.theme.text.subdued,
            warning: ctx.theme.text.feedback.warning.default,
            success: ctx.theme.text.feedback.success.default,
          };
        },
      },
      currentModel: (sessionID) => {
        const session = ctx.data.session.get(sessionID);
        if (!session?.agent || !session.model) return undefined;
        return {
          agent: session.agent,
          model: `${session.model.providerID}/${session.model.id}`,
          variant: session.model.variant ?? null,
        };
      },
      liveSelections: (sessionID) => {
        // Only running direct children of the viewed parent, at its location.
        // Preserve conflicts: several children can select different models.
        const sessions = ctx.data.session;
        if (typeof sessions.list !== "function" || typeof sessions.status !== "function") return [];
        try {
          const parent = sessions.get(sessionID);
          if (!parent?.location) return [];
          const selections: import("./view.js").LiveSelection[] = [];
          for (const session of sessions.list()) {
            if (session.parentID !== sessionID || !session.agent || !session.model) continue;
            if (session.location?.directory !== parent.location.directory) continue;
            if (sessions.status(session.id) !== "running") continue;
            const { agent, model } = session;
            selections.push({
              agent,
              model: `${model.providerID}/${model.id}`,
              variant: model.variant ?? null,
            });
          }
          return selections;
        } catch {
          return [];
        }
      },
      configuredModels: () =>
        (ctx.data.location.agent?.list(ctx.location) ?? []).flatMap((agent) =>
          agent.model
            ? [
                {
                  agent: agent.name,
                  model: `${agent.model.providerID}/${agent.model.id}`,
                  variant: agent.model.variant ?? null,
                },
              ]
            : [],
        ),
      state: {
        get provider() {
          const models = ctx.data.location.model.list(ctx.location) ?? [];
          return [...new Set(models.map((model) => model.providerID))].map((id) => ({
            id,
            models: Object.fromEntries(
              models.filter((model) => model.providerID === id).map((model) => [model.id, model]),
            ),
          }));
        },
      },
    };
    await tui(api);
    return async () => {
      for (const cleanup of cleanups.reverse()) await cleanup();
    };
  },
};

export default agentRouterTui;
