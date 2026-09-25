/**
 * Dialog flows: switch, view, edit, back, validate. Thin glue between
 * opencode's DialogSelect/DialogConfirm and the core stack operations —
 * decision logic lives in actions.ts / core, so this file stays presentational.
 */

import { atomicWriteJson } from "../core/atomic-write.js";
import type { RouterPaths } from "../core/paths.js";
import { StackFileSchema } from "../core/schema.js";
import {
  applyStack,
  back,
  getActiveStackName,
  listStacks,
  readStack,
  stackPath,
} from "../core/stack-manager.js";
import { readState } from "../core/state.js";
import { validateStack } from "../core/validator.js";
import { routingReasons } from "../routing-status.js";
import {
  type ModelTarget,
  applyModelEdit,
  collectHostModels,
  listModelTargets,
  targetLabel,
} from "./actions.js";
import type { RouterTuiApi, SelectOption } from "./host.js";
import type { RoutingStatus } from "./view.js";

export interface DialogDeps {
  readonly api: RouterTuiApi;
  readonly paths: RouterPaths;
  readonly refresh: () => void;
}

export function canOpenDialogs(api: RouterTuiApi): boolean {
  return Boolean(api.ui.DialogSelect && api.ui.dialog);
}

function toastError(api: RouterTuiApi, e: unknown): void {
  api.ui.toast({
    title: "agent-router",
    message: (e as Error).message ?? String(e),
    variant: "error",
  });
}

function routingSummary(status: RoutingStatus): string {
  const model = status.model
    ? `${status.model.providerID}/${status.model.id}${
        status.model.variant && status.model.variant !== "default"
          ? ` [${status.model.variant}]`
          : ""
      }`
    : "native model";
  const reason = status.reason
    ? (routingReasons[status.reason as keyof typeof routingReasons] ?? "Reason unknown")
    : "Reason unknown";
  return `${model} · ${reason}`;
}

function routingLabel(status: RoutingStatus): string {
  return status.mode === "automatic" ? "Automatic" : "Pinned";
}

/** Native TUI flow: query the RPC and change routing directly, without an LLM turn. */
export function openRoutingMode(api: RouterTuiApi): void {
  const sessionID = api.currentSessionID?.();
  const readRouting = api.readRouting;
  const controlRouting = api.controlRouting;
  if (!sessionID) {
    api.ui.toast({
      title: "agent-router",
      message: "Open a session before viewing or changing its routing mode.",
      variant: "warning",
    });
    return;
  }
  if (!readRouting || !controlRouting || !canOpenDialogs(api)) {
    api.ui.toast({
      title: "agent-router",
      message: "Session routing controls are unavailable in this TUI.",
      variant: "warning",
    });
    return;
  }

  void readRouting(sessionID)
    .then((status) => {
      if (!status) {
        api.ui.toast({
          title: "agent-router",
          message: "Routing status is unavailable for this session.",
          variant: "warning",
        });
        return;
      }
      const options: SelectOption[] = (["automatic", "pinned"] as const).map((mode) => ({
        title: mode === "automatic" ? "Automatic" : "Pinned",
        value: mode,
        description:
          mode === status.mode
            ? `Current · ${routingSummary(status)}`
            : mode === "automatic"
              ? "Resume automatic routing on the next explicit user turn"
              : "Freeze the current model for this session",
        onSelect: () => {
          api.ui.dialog?.clear();
          if (mode === status.mode) {
            api.ui.toast({
              title: "agent-router",
              message: `${routingLabel(status)} · ${routingSummary(status)}`,
              variant: "info",
            });
            return;
          }
          void controlRouting(sessionID, mode === "automatic" ? "auto" : "pin")
            .then((next) => {
              if (!next) throw new Error("The router did not return a routing status.");
              api.ui.toast({
                title: "agent-router",
                message:
                  next.mode === "automatic"
                    ? `Automatic routing resumes on the next user turn · ${routingSummary(next)}`
                    : `Pinned · ${routingSummary(next)}`,
                variant: "success",
              });
            })
            .catch((error) => toastError(api, error));
        },
      }));
      openSelect(api, {
        title: `Session routing · ${routingLabel(status)}`,
        options,
        current: status.mode,
      });
    })
    .catch((error) => toastError(api, error));
}

function openSelect(
  api: RouterTuiApi,
  props: Parameters<NonNullable<RouterTuiApi["ui"]["DialogSelect"]>>[0],
): void {
  const { DialogSelect, dialog } = api.ui;
  if (!DialogSelect || !dialog) return;
  dialog.replace(() => DialogSelect(props));
}

async function pickStack(
  deps: DialogDeps,
  title: string,
  onPick: (name: string, active: string | null) => void,
): Promise<void> {
  const [stacks, active] = await Promise.all([
    listStacks(deps.paths),
    getActiveStackName(deps.paths),
  ]);
  if (stacks.length === 0) {
    deps.api.ui.toast({
      title: "agent-router",
      message: "No stacks found — run `agent-router init` first.",
      variant: "warning",
    });
    return;
  }
  const options: SelectOption[] = stacks.map((name) => ({
    title: name,
    value: name,
    description: name === active ? "● active" : undefined,
    onSelect: () => onPick(name, active),
  }));
  openSelect(deps.api, { title, options, current: active ?? undefined });
}

export function openStackSwitcher(deps: DialogDeps): void {
  void pickStack(deps, "Switch stack", (name, active) => {
    deps.api.ui.dialog?.clear();
    if (name === active) {
      deps.api.ui.toast({ title: "agent-router", message: `"${name}" is already active` });
      return;
    }
    deps.api.ui.toast({ title: "agent-router", message: `validating & switching to "${name}"…` });
    applyStack(deps.paths, name, { validate: true })
      .then((r) => {
        deps.refresh();
        deps.api.ui.toast({
          title: "agent-router",
          message: `switched to "${r.current}" — restart opencode to apply`,
          variant: "success",
        });
      })
      .catch((e) => toastError(deps.api, e));
  }).catch((e) => toastError(deps.api, e));
}

export function openStackViewer(deps: DialogDeps): void {
  void pickStack(deps, "View stack", (name) => {
    readStack(deps.paths, name)
      .then((stack) => {
        const rows = listModelTargets(stack);
        const options: SelectOption[] = rows.map((row) => ({
          title: targetLabel(row),
          value: targetLabel(row),
          description: row.model,
          onSelect: () => deps.api.ui.dialog?.clear(),
        }));
        openSelect(deps.api, { title: `stack: ${name}`, options });
      })
      .catch((e) => toastError(deps.api, e));
  }).catch((e) => toastError(deps.api, e));
}

export function openStackEditor(deps: DialogDeps): void {
  void pickStack(deps, "Edit stack", (name) => {
    readStack(deps.paths, name)
      .then((stack) => {
        const rows = listModelTargets(stack);
        const options: SelectOption[] = rows.map((row) => ({
          title: targetLabel(row),
          value: targetLabel(row),
          description: row.model,
          onSelect: () => openModelPicker(deps, name, row),
        }));
        openSelect(deps.api, { title: `edit ${name}: pick agent`, options });
      })
      .catch((e) => toastError(deps.api, e));
  }).catch((e) => toastError(deps.api, e));
}

function openModelPicker(deps: DialogDeps, stackName: string, row: ModelTarget): void {
  const models = collectHostModels(deps.api.state?.provider);
  if (models.length === 0) {
    deps.api.ui.dialog?.clear();
    deps.api.ui.toast({
      title: "agent-router",
      message: "Model catalog unavailable — edit the stack file via `agent-router edit` instead.",
      variant: "warning",
    });
    return;
  }
  const options: SelectOption[] = models.map((id) => ({
    title: id,
    value: id,
    onSelect: () => {
      deps.api.ui.dialog?.clear();
      saveModelEdit(deps, stackName, row, id).catch((e) => toastError(deps.api, e));
    },
  }));
  openSelect(deps.api, {
    title: `edit ${stackName}: ${targetLabel(row)}`,
    options,
    current: row.model,
  });
}

async function saveModelEdit(
  deps: DialogDeps,
  stackName: string,
  row: ModelTarget,
  model: string,
): Promise<void> {
  const stack = await readStack(deps.paths, stackName);
  const edited = StackFileSchema.parse(applyModelEdit(stack, row.agent, model));
  await atomicWriteJson(stackPath(deps.paths, stackName), edited);
  deps.refresh();
  const active = await getActiveStackName(deps.paths);
  const hint =
    active === stackName
      ? ` — run \`agent-router use ${stackName}\` + restart to apply to the agent files`
      : "";
  deps.api.ui.toast({
    title: "agent-router",
    message: `${stackName}: ${targetLabel(row)} → ${model}${hint}`,
    variant: "success",
  });
}

export function openBackConfirm(deps: DialogDeps): void {
  readState(deps.paths.statePath)
    .then((state) => {
      if (!state?.previousActive) {
        deps.api.ui.toast({ title: "agent-router", message: "No previous stack to revert to." });
        return;
      }
      const { DialogConfirm, dialog } = deps.api.ui;
      const revert = () => {
        dialog?.clear();
        back(deps.paths, 1)
          .then((r) => {
            deps.refresh();
            deps.api.ui.toast({
              title: "agent-router",
              message: `reverted to "${r.current}" — restart opencode to apply`,
              variant: "success",
            });
          })
          .catch((e) => toastError(deps.api, e));
      };
      if (!DialogConfirm || !dialog) {
        revert();
        return;
      }
      dialog.replace(() =>
        DialogConfirm({
          title: "agent-router",
          message: `Revert to "${state.previousActive}"?`,
          onConfirm: revert,
          onCancel: () => dialog.clear(),
        }),
      );
    })
    .catch((e) => toastError(deps.api, e));
}

export function openValidator(deps: DialogDeps): void {
  void pickStack(deps, "Validate stack", (name) => {
    deps.api.ui.dialog?.clear();
    deps.api.ui.toast({ title: "agent-router", message: `validating "${name}"…` });
    readStack(deps.paths, name)
      .then((stack) => validateStack(stack))
      .then((result) => {
        if (result.ok) {
          deps.api.ui.toast({
            title: "agent-router",
            message: `"${name}" ok — ${result.checked} model refs reachable`,
            variant: "success",
          });
          return;
        }
        const sample = result.missing
          .slice(0, 3)
          .map((m) => m.modelId)
          .join(", ");
        const extra = result.missing.length > 3 ? ` (+${result.missing.length - 3} more)` : "";
        deps.api.ui.toast({
          title: "agent-router",
          message: `"${name}": ${result.missing.length} unreachable — ${sample}${extra}`,
          variant: "warning",
        });
      })
      .catch((e) => toastError(deps.api, e));
  }).catch((e) => toastError(deps.api, e));
}
