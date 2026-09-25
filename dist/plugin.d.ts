import { z } from 'zod';
import { Context } from '@opencode/plugin/promise/plugin';

/** OpenCode 2.x model refs are readonly in context hooks; switch only at user admission. */
declare function setupV2(ctx: Context): Promise<() => Promise<void>>;

/**
 * Zod schemas for agent-router's own files.
 *
 * Two philosophies:
 *
 *   1. `state.json` and `config.json` are OURS — strict schema, fail closed.
 *      We control every byte; if malformed something corrupted it and we
 *      should refuse to proceed rather than silently rebuild and lose pointers.
 *
 *   2. `stacks/*.json` are user-authored. We validate only the shape we care
 *      about (an `agents` record whose entries carry a `model` string) and
 *      pass unknown keys through verbatim so future additions survive
 *      round-trips.
 */

declare const RoutingEntrySchema: z.ZodObject<{
    model: z.ZodString;
    variant: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    fallbacks: z.ZodOptional<z.ZodArray<z.ZodObject<{
        model: z.ZodString;
        variant: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
type RoutingEntry = z.infer<typeof RoutingEntrySchema>;

declare const Model: z.ZodObject<{
    providerID: z.ZodString;
    modelID: z.ZodString;
    variant: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
type Selection = z.infer<typeof Model>;
/** No network calls or disk writes: selection happens synchronously at next-turn admission. */
declare function createFailover(routes: Record<string, RoutingEntry>, notice: (message: string) => Promise<void>): {
    pending(sessionID: string): {
        providerID: string;
        modelID: string;
        variant?: string | undefined;
    } | undefined;
    active(sessionID: string): boolean;
    /** Register an admission already selected by a separate policy; no retry occurs. */
    admit(sessionID: string, message: {
        id: string;
        agent: string;
        model: Selection;
    }): void;
    disable(): void;
    message(input: {
        sessionID: string;
    }, output: {
        message: {
            id: string;
            agent: string;
            model: Selection;
        };
    }): Promise<void>;
    event(input: {
        event: unknown;
    }): Promise<void>;
};

/**
 * Validate that every model ID referenced by a stack file is reachable
 * through the user's current opencode auth.
 *
 * Strategy: shell out to `opencode models`, capture the line-per-id list,
 * compare to the IDs found in the stack. The model catalogue is
 * auth-state-dependent — a user without an Anthropic key won't see
 * `anthropic/...` IDs even though they exist on the registry — so this gives
 * us a real "will this work" answer instead of a registry sniff.
 *
 * For tests, callers can inject a fake `runOpencodeModels` that returns
 * canned text. See `tests/fixtures/opencode-models-output.txt`.
 */

interface ValidateOptions {
    /**
     * Override the model lister. Defaults to running `opencode models` via
     * `execFile`. Tests pass a static string.
     */
    readonly runOpencodeModels?: () => Promise<string>;
}

/**
 * opencode plugin entry for agent-router.
 *
 * What this exposes to opencode:
 *   - 6 tools the agent can call:
 *       router_status   — read state.json
 *       router_list     — list stacks
 *       router_use      — apply a stack (fires TUI toast on success)
 *       router_capture  — snapshot current frontmatter models into a stack
 *       router_validate — check model IDs against opencode's reachable list
 *       router_back     — undo last switch (fires TUI toast)
 *
 *   - One log line on init noting the active stack (via client.app.log).
 *
 * What this DOES NOT do:
 *   - We never fire `tui.toast.show` from plugin init. The toast hook is only
 *     reliably callable inside event/tool handler context per opencode docs.
 *   - We never rewrite agent files from a hook (only from tool calls).
 *
 * The `tool()` helper from `@opencode-ai/plugin` wraps our `args` zod shape +
 * `execute()` into the shape opencode wants. `execute()` must return either a
 * string or `{output: string, metadata?: object}`. We always return JSON in
 * `output` so the agent can parse our tool responses programmatically.
 */

interface PluginClientLike {
    app?: {
        log?: (input: {
            body: {
                service: string;
                level: "debug" | "info" | "warn" | "error";
                message: string;
                extra?: Record<string, unknown>;
            };
        }) => Promise<unknown>;
    };
    tui?: {
        showToast?: (input: {
            body: {
                message: string;
                variant: "info" | "success" | "warning";
                duration?: number;
            };
        }) => Promise<unknown>;
        toast?: {
            show?: (input: {
                body: {
                    message: string;
                    variant: "info" | "success" | "warning";
                };
            }) => Promise<unknown>;
        };
    };
}
declare const AgentRouterPlugin: (ctx: {
    client: PluginClientLike;
}, validateOptions?: ValidateOptions) => Promise<{
    event: (input: {
        event: unknown;
    }) => Promise<void>;
    "chat.message": (input: Parameters<ReturnType<typeof createFailover>["message"]>[0], output: Parameters<ReturnType<typeof createFailover>["message"]>[1]) => Promise<void>;
    tool: {
        router_status: {
            description: string;
            args: {};
            execute: (args: Record<string, never>) => Promise<{
                output: string;
                metadata: Record<string, unknown>;
            }>;
        };
        router_list: {
            description: string;
            args: {};
            execute: (args: Record<string, never>) => Promise<{
                output: string;
                metadata: Record<string, unknown>;
            }>;
        };
        router_use: {
            description: string;
            args: {
                name: z.ZodString;
                validate: z.ZodOptional<z.ZodBoolean>;
            };
            execute: (args: {
                name: string;
                validate?: boolean | undefined;
            }) => Promise<{
                output: string;
                metadata: Record<string, unknown>;
            }>;
        };
        router_capture: {
            description: string;
            args: {
                name: z.ZodString;
                force: z.ZodOptional<z.ZodBoolean>;
            };
            execute: (args: {
                name: string;
                force?: boolean | undefined;
            }) => Promise<{
                output: string;
                metadata: Record<string, unknown>;
            }>;
        };
        router_validate: {
            description: string;
            args: {
                name: z.ZodOptional<z.ZodString>;
                active: z.ZodOptional<z.ZodBoolean>;
            };
            execute: (args: {
                name?: string | undefined;
                active?: boolean | undefined;
            }) => Promise<{
                output: string;
                metadata: Record<string, unknown>;
            }>;
        };
        router_back: {
            description: string;
            args: {
                n: z.ZodOptional<z.ZodNumber>;
            };
            execute: (args: {
                n?: number | undefined;
            }) => Promise<{
                output: string;
                metadata: Record<string, unknown>;
            }>;
        };
    };
}>;
declare const _default: {
    id: string;
    setup: typeof setupV2;
};

export { AgentRouterPlugin, _default as default };
