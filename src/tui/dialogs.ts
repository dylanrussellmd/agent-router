/**
 * Dialog flows: switch, view, edit, back, validate. Thin glue between
 * opencode's DialogSelect/DialogConfirm and the core stack operations —
 * decision logic lives in actions.ts / core, so this file stays presentational.
 */

import { atomicWriteJson } from "../core/atomic-write.js";
import type { OmoPaths } from "../core/paths.js";
import { StackFileSchema } from "../core/schema.js";
import {
  back,
  getActiveStackName,
  listStacks,
  readStack,
  stackPath,
  switchTo,
} from "../core/stack-manager.js";
import { readState } from "../core/state.js";
import { validateStack } from "../core/validator.js";
import {
  type ModelTarget,
  applyModelEdit,
  collectHostModels,
  listModelTargets,
  targetLabel,
} from "./actions.js";
import type { OmoTuiApi, SelectOption } from "./host.js";

export interface DialogDeps {
  readonly api: OmoTuiApi;
  readonly paths: OmoPaths;
  readonly refresh: () => void;
}

export function canOpenDialogs(api: OmoTuiApi): boolean {
  return Boolean(api.ui.DialogSelect && api.ui.dialog);
}

function toastError(api: OmoTuiApi, e: unknown): void {
  api.ui.toast({
    title: "omo-router",
    message: (e as Error).message ?? String(e),
    variant: "error",
  });
}

function openSelect(
  api: OmoTuiApi,
  props: Parameters<NonNullable<OmoTuiApi["ui"]["DialogSelect"]>>[0],
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
      title: "omo-router",
      message: "No stacks found — run `omo-router init` first.",
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
      deps.api.ui.toast({ title: "omo-router", message: `"${name}" is already active` });
      return;
    }
    deps.api.ui.toast({ title: "omo-router", message: `validating & switching to "${name}"…` });
    switchTo(deps.paths, name, { snapshotBack: true, validate: true })
      .then((r) => {
        deps.refresh();
        deps.api.ui.toast({
          title: "omo-router",
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
          title: targetLabel(row.ref),
          value: targetLabel(row.ref),
          description: describeTarget(row),
          onSelect: () => deps.api.ui.dialog?.clear(),
        }));
        openSelect(deps.api, { title: `stack: ${name}`, options });
      })
      .catch((e) => toastError(deps.api, e));
  }).catch((e) => toastError(deps.api, e));
}

function describeTarget(row: ModelTarget): string {
  return row.fallbackCount > 0 ? `${row.model} (+${row.fallbackCount} fallback)` : row.model;
}

export function openStackEditor(deps: DialogDeps): void {
  void pickStack(deps, "Edit stack", (name) => {
    readStack(deps.paths, name)
      .then((stack) => {
        const rows = listModelTargets(stack);
        const options: SelectOption[] = rows.map((row) => ({
          title: targetLabel(row.ref),
          value: targetLabel(row.ref),
          description: describeTarget(row),
          onSelect: () => openModelPicker(deps, name, row),
        }));
        openSelect(deps.api, { title: `edit ${name}: pick entry`, options });
      })
      .catch((e) => toastError(deps.api, e));
  }).catch((e) => toastError(deps.api, e));
}

function openModelPicker(deps: DialogDeps, stackName: string, row: ModelTarget): void {
  const models = collectHostModels(deps.api.state?.provider);
  if (models.length === 0) {
    deps.api.ui.dialog?.clear();
    deps.api.ui.toast({
      title: "omo-router",
      message: "Model catalog unavailable — edit the stack file via `omo-router edit` instead.",
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
    title: `edit ${stackName}: ${targetLabel(row.ref)}`,
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
  const edited = StackFileSchema.parse(applyModelEdit(stack, row.ref, model));
  await atomicWriteJson(stackPath(deps.paths, stackName), edited);
  deps.refresh();
  const active = await getActiveStackName(deps.paths);
  const hint =
    active === stackName
      ? ` — run \`omo use ${stackName}\` + restart to apply to the live config`
      : "";
  deps.api.ui.toast({
    title: "omo-router",
    message: `${stackName}: ${targetLabel(row.ref)} → ${model}${hint}`,
    variant: "success",
  });
}

export function openBackConfirm(deps: DialogDeps): void {
  readState(deps.paths.statePath)
    .then((state) => {
      if (!state?.previousActive) {
        deps.api.ui.toast({ title: "omo-router", message: "No previous stack to revert to." });
        return;
      }
      const { DialogConfirm, dialog } = deps.api.ui;
      const revert = () => {
        dialog?.clear();
        back(deps.paths, 1)
          .then((r) => {
            deps.refresh();
            deps.api.ui.toast({
              title: "omo-router",
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
          title: "omo-router",
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
    deps.api.ui.toast({ title: "omo-router", message: `validating "${name}"…` });
    readStack(deps.paths, name)
      .then((stack) => validateStack(stack))
      .then((result) => {
        if (result.ok) {
          deps.api.ui.toast({
            title: "omo-router",
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
          title: "omo-router",
          message: `"${name}": ${result.missing.length} unreachable — ${sample}${extra}`,
          variant: "warning",
        });
      })
      .catch((e) => toastError(deps.api, e));
  }).catch((e) => toastError(deps.api, e));
}
