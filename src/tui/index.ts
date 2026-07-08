/**
 * TUI plugin entry for omo-router (opencode >= 1.17).
 *
 * Loaded by opencode's TUI runtime via package.json `exports["./tui"]` and a
 * `tui.json` plugin[] entry (`omo-router init` writes it). Renders the active
 * stack into the sidebar, polls for external changes (CLI/agent switches),
 * and registers the /omo-* command set (switch, view, edit, back, validate,
 * status). Every host call is guarded so a TUI API change degrades to
 * missing features, never a crash — see host.ts for the API-typing stance.
 */

import { resolvePathsWithConfig } from "../core/config.js";
import {
  type DialogDeps,
  canOpenDialogs,
  openBackConfirm,
  openStackEditor,
  openStackSwitcher,
  openStackViewer,
  openValidator,
} from "./dialogs.js";
import type { OmoTuiApi, TuiCommandEntry } from "./host.js";
import { type SolidRuntime, materialize } from "./render.js";
import { createSidebarPoller, readStackSnapshot } from "./store.js";
import { buildSidebarNodes } from "./view.js";

const POLL_INTERVAL_MS = 1500;
const SIDEBAR_ORDER = 850;

/**
 * TUI plugins have no visible stderr; opencode swallows console output. When
 * OMO_TUI_DEBUG is set, append trace lines to that file so failures inside
 * tui() are diagnosable at all.
 */
function debugLog(message: string): void {
  const target = process.env.OMO_TUI_DEBUG;
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

function buildCommands(api: OmoTuiApi, deps: DialogDeps, status: () => void): TuiCommandEntry[] {
  const commands: TuiCommandEntry[] = [
    {
      title: "omo: status",
      value: "omo.status",
      description: "Show the active omo-router stack",
      category: "omo-router",
      slash: { name: "omo-status" },
      onSelect: status,
    },
  ];
  if (!canOpenDialogs(api)) return commands;
  commands.push(
    {
      title: "omo: switch stack",
      value: "omo.switch",
      description: "Switch the active oh-my-openagent model stack",
      category: "omo-router",
      slash: { name: "omo-switch", aliases: ["omo"] },
      onSelect: () => openStackSwitcher(deps),
    },
    {
      title: "omo: view stack",
      value: "omo.view",
      description: "Inspect a stack's agent/category model assignments",
      category: "omo-router",
      slash: { name: "omo-view" },
      onSelect: () => openStackViewer(deps),
    },
    {
      title: "omo: edit stack",
      value: "omo.edit",
      description: "Reassign a model inside a stack",
      category: "omo-router",
      slash: { name: "omo-edit" },
      onSelect: () => openStackEditor(deps),
    },
    {
      title: "omo: undo last switch",
      value: "omo.back",
      description: "Revert to the previously active stack",
      category: "omo-router",
      slash: { name: "omo-back" },
      onSelect: () => openBackConfirm(deps),
    },
    {
      title: "omo: validate stack",
      value: "omo.validate",
      description: "Check a stack's model IDs against reachable models",
      category: "omo-router",
      slash: { name: "omo-validate" },
      onSelect: () => openValidator(deps),
    },
  );
  return commands;
}

export const tui = async (api: OmoTuiApi): Promise<void> => {
  debugLog("tui() entered");
  const solid = await importHostSolid();
  if (!solid) return;

  const paths = await resolvePathsWithConfig().catch(() => null);
  if (!paths) return;

  let snapshot = await readStackSnapshot(paths);
  const bootActive = snapshot.active;
  const viewContext = () => ({ bootActive, theme: api.theme?.current });

  try {
    api.slots.register({
      order: SIDEBAR_ORDER,
      slots: {
        sidebar_content: () => materialize(buildSidebarNodes(snapshot, viewContext()), solid),
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
          title: "omo-router",
          message: `stack → ${next.active ?? "(none)"}${suffix}`,
          variant: "info",
        });
      }
    },
  });

  const deps: DialogDeps = { api, paths, refresh };
  const status = () =>
    api.ui.toast({
      title: "omo-router",
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

const omoRouterTui = {
  id: "omo-router:tui",
  tui,
};

export default omoRouterTui;
