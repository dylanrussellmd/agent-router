/**
 * Structural slice of opencode's TuiPluginApi.
 *
 * Deliberately NOT imported from `@opencode-ai/plugin/tui`: those declarations
 * drag in @opentui/keymap + @opentui/solid types we don't ship, and pinning to
 * them couples us to one host version. Everything here is optional-guarded at
 * the call site so an API change degrades features instead of crashing.
 */

export interface ToastInput {
  readonly title?: string;
  readonly message: string;
  readonly variant?: "info" | "success" | "warning" | "error";
}

export interface TuiCommandEntry {
  readonly title: string;
  readonly value: string;
  readonly description?: string;
  readonly category?: string;
  readonly slash?: { readonly name: string; readonly aliases?: readonly string[] };
  readonly onSelect?: () => void;
}

export interface SelectOption<Value = unknown> {
  readonly title: string;
  readonly value: Value;
  readonly description?: string | undefined;
  readonly category?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly onSelect?: (() => void) | undefined;
}

export interface SelectProps<Value = unknown> {
  readonly title: string;
  readonly placeholder?: string | undefined;
  readonly options: readonly SelectOption<Value>[];
  readonly current?: Value | undefined;
  readonly onSelect?: ((option: SelectOption<Value>) => void) | undefined;
}

export interface ConfirmProps {
  readonly title: string;
  readonly message: string;
  readonly onConfirm?: () => void;
  readonly onCancel?: () => void;
}

export interface DialogStack {
  replace(render: () => unknown, onClose?: () => void): void;
  clear(): void;
  setSize?(size: "medium" | "large" | "xlarge"): void;
}

export interface OmoTuiApi {
  readonly slots: {
    register(plugin: { order?: number; slots: Record<string, () => unknown> }): unknown;
  };
  readonly renderer: { requestRender(): void };
  readonly ui: {
    toast(input: ToastInput): void;
    DialogSelect?(props: SelectProps): unknown;
    DialogConfirm?(props: ConfirmProps): unknown;
    dialog?: DialogStack;
  };
  readonly command?: { register(cb: () => TuiCommandEntry[]): unknown };
  readonly lifecycle: { onDispose(fn: () => void | Promise<void>): unknown };
  readonly theme?: { readonly current?: Record<string, unknown> };
  readonly state?: { readonly provider?: unknown };
}
