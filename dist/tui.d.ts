import { Context } from '@opencode/plugin/tui/context';

/**
 * Snapshot + polling layer for the TUI sidebar.
 *
 * Polling (not fs.watch): agent-router writes state.json atomically via
 * temp-file + rename, and Bun's fs.watch drops the rename-to-target event
 * (verified: Bun 1.3.14 reports only the temp file, Node reports both), so a
 * watcher filtered on "state.json" never fires inside opencode. A 1.5s poll
 * of two tiny reads is the reliable alternative.
 */

interface ModelAssignment {
    readonly model: string;
    readonly variant?: string | null | undefined;
}

/**
 * Pure view model for the sidebar — no opentui imports, fully unit-testable.
 * `materialize` in render.ts turns these nodes into real opentui elements.
 */

interface SidebarTheme {
    readonly text?: unknown;
    readonly textMuted?: unknown;
    readonly warning?: unknown;
    readonly success?: unknown;
}
/** Live model selection observed for one agent in a session. */
interface LiveSelection extends ModelAssignment {
    readonly agent: string;
}
/** Routing mode of the viewed session, as reported by the status service. */
interface RoutingStatus {
    readonly mode: "automatic" | "pinned";
    readonly model?: {
        readonly providerID: string;
        readonly id: string;
        readonly variant?: string | undefined;
    } | null | undefined;
    readonly reason?: string | undefined;
    /** Epoch ms of the last quota evaluation behind the current mode, if tracked. */
    readonly checkedAt?: number | null | undefined;
    readonly validUntil?: number | null | undefined;
}
interface SidebarContext {
    /** Active stack when the TUI booted — differing means a restart is due. */
    readonly bootActive: string | null;
    readonly theme?: SidebarTheme | undefined;
    /** Only the agent/model from this sidebar's live session may be marked current. */
    readonly current?: (ModelAssignment & {
        readonly agent: string;
    }) | undefined;
    /**
     * Selections of running direct children of the viewed session, at its location.
     * Conflicting models are all retained. The viewed session takes precedence.
     */
    readonly live?: readonly LiveSelection[] | undefined;
    readonly defaults?: readonly LiveSelection[] | undefined;
    /** Routing mode of the viewed session; omitted when no status source answers. */
    readonly routing?: RoutingStatus | undefined;
}

/**
 * Structural slice of opencode's TuiPluginApi.
 *
 * Deliberately NOT imported from `@opencode-ai/plugin/tui`: those declarations
 * drag in @opentui/keymap + @opentui/solid types we don't ship, and pinning to
 * them couples us to one host version. Everything here is optional-guarded at
 * the call site so an API change degrades features instead of crashing.
 */
interface ToastInput {
    readonly title?: string;
    readonly message: string;
    readonly variant?: "info" | "success" | "warning" | "error";
}
interface TuiCommandEntry {
    readonly title: string;
    readonly value: string;
    readonly description?: string;
    readonly category?: string;
    readonly slash?: {
        readonly name: string;
        readonly aliases?: readonly string[];
    };
    readonly onSelect?: () => void;
}
interface SelectOption<Value = unknown> {
    readonly title: string;
    readonly value: Value;
    readonly description?: string | undefined;
    readonly category?: string | undefined;
    readonly disabled?: boolean | undefined;
    readonly onSelect?: (() => void) | undefined;
}
interface SelectProps<Value = unknown> {
    readonly title: string;
    readonly placeholder?: string | undefined;
    readonly options: readonly SelectOption<Value>[];
    readonly current?: Value | undefined;
    readonly onSelect?: ((option: SelectOption<Value>) => void) | undefined;
}
interface ConfirmProps {
    readonly title: string;
    readonly message: string;
    readonly onConfirm?: () => void;
    readonly onCancel?: () => void;
}
interface DialogStack {
    replace(render: () => unknown, onClose?: () => void): void;
    clear(): void;
    setSize?(size: "medium" | "large" | "xlarge"): void;
}
interface RouterTuiApi {
    readonly slots: {
        register(plugin: {
            order?: number;
            slots: Record<string, (sessionID?: string) => unknown>;
        }): unknown;
    };
    readonly renderer: {
        requestRender(): void;
    };
    readonly ui: {
        toast(input: ToastInput): void;
        DialogSelect?(props: SelectProps): unknown;
        DialogConfirm?(props: ConfirmProps): unknown;
        dialog?: DialogStack;
    };
    readonly command?: {
        register(cb: () => TuiCommandEntry[]): unknown;
    };
    readonly lifecycle: {
        onDispose(fn: () => void | Promise<void>): unknown;
    };
    readonly theme?: {
        readonly current?: Record<string, unknown>;
    };
    readonly state?: {
        readonly provider?: unknown;
    };
    readonly currentModel?: (sessionID: string) => SidebarContext["current"];
    readonly currentRouting?: (sessionID: string) => RoutingStatus | undefined;
    readonly currentSessionID?: () => string | undefined;
    readonly readRouting?: (sessionID: string) => Promise<RoutingStatus | undefined>;
    readonly controlRouting?: (sessionID: string, action: "pin" | "auto") => Promise<RoutingStatus | undefined>;
    readonly configuredModels?: () => readonly LiveSelection[];
    /** Running direct-child selections at the viewed parent's location; retain conflicts. */
    readonly liveSelections?: ((sessionID: string) => readonly LiveSelection[]) | undefined;
}

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

declare const tui: (api: RouterTuiApi) => Promise<void>;
declare const agentRouterTui: {
    id: string;
    setup(ctx: Context): Promise<(() => Promise<void>) | undefined>;
};

export { agentRouterTui as default, tui };
