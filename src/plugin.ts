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

import { readFileSync } from "node:fs";
import { z } from "zod";
import { setupV2 } from "./v2.js";
const tool = Object.assign(
  <T extends z.ZodRawShape>(definition: {
    description: string;
    args: T;
    execute: (
      args: z.infer<z.ZodObject<T>>,
    ) => Promise<{ output: string; metadata: Record<string, unknown> }>;
  }) => definition,
  { schema: z },
);
import { resolvePathsWithConfig } from "./core/config.js";
import { RouterError } from "./core/errors.js";
import { createFailover } from "./core/failover.js";
import { readAgentModels } from "./core/frontmatter.js";
import type { RouterPaths } from "./core/paths.js";
import { RoutingEntrySchema, StackFileSchema } from "./core/schema.js";
import {
  applyStack,
  back as backCore,
  captureAgents,
  captureStack,
  getActiveStackName,
  listStacks,
  readStack,
} from "./core/stack-manager.js";
import { type ValidateOptions, validateStack } from "./core/validator.js";
import { VERSION } from "./version.js";

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
      body: { message: string; variant: "info" | "success" | "warning"; duration?: number };
    }) => Promise<unknown>;
    toast?: {
      show?: (input: {
        body: { message: string; variant: "info" | "success" | "warning" };
      }) => Promise<unknown>;
    };
  };
}

/**
 * Try to fire a TUI toast. The hook isn't always available (different
 * opencode versions, headless test runs, etc.) — silently fall back to
 * structured logging so a missing toast never blocks the actual switch.
 */
async function safeToast(
  client: PluginClientLike,
  message: string,
  variant: "info" | "success" | "warning" = "success",
): Promise<void> {
  try {
    if (client.tui?.showToast) {
      const result = await client.tui.showToast({ body: { message, variant, duration: 15000 } });
      if (result && typeof result === "object" && "error" in result && result.error)
        throw result.error;
      return;
    }
    if (client.tui?.toast?.show) {
      await client.tui.toast.show({ body: { message, variant } });
      return;
    }
  } catch {
    // fall through to log
  }
  await client.app
    ?.log?.({
      body: { service: "agent-router", level: "info", message: `[toast-fallback] ${message}` },
    })
    .catch(() => {
      /* really truly silent now */
    });
}

/**
 * Stringify a tool result so opencode renders it as the agent's tool output.
 * `output` is the displayed string; `metadata` is structured data the agent
 * can reason over without re-parsing.
 */
function ok(value: unknown): { output: string; metadata: Record<string, unknown> } {
  return { output: JSON.stringify(value, null, 2), metadata: value as Record<string, unknown> };
}

/** Convert one of our typed errors into a tool-friendly response. */
function errOut(e: unknown): { output: string; metadata: { error: string } } {
  const msg =
    e instanceof RouterError
      ? `${e.name}: ${e.message}`
      : `${(e as Error).name ?? "Error"}: ${(e as Error).message}`;
  return { output: JSON.stringify({ error: msg }, null, 2), metadata: { error: msg } };
}

/* ------------------------------------------------------------------------- *
 * plugin definition                                                          *
 * ------------------------------------------------------------------------- */

export const AgentRouterPlugin = async (
  ctx: { client: PluginClientLike },
  validateOptions?: ValidateOptions,
) => {
  const paths: RouterPaths = await resolvePathsWithConfig();
  const client = ctx.client as unknown as PluginClientLike;
  const stateBytes = () => {
    try {
      return readFileSync(paths.statePath, "utf8");
    } catch {
      return undefined;
    }
  };
  const initialState = stateBytes();
  const captured = await captureAgents(paths).catch(() => ({}));
  const routes = Object.fromEntries(
    Object.entries(captured).flatMap(([agent, entry]) => {
      const parsed = RoutingEntrySchema.safeParse({
        model: entry.model,
        variant: entry.variant,
        fallbacks: entry.fallbacks,
      });
      return parsed.success && parsed.data.fallbacks?.length ? [[agent, parsed.data]] : [];
    }),
  );
  const failover = createFailover(routes, async (message) => {
    await client.app
      ?.log?.({ body: { service: "agent-router", level: "warn", message } })
      .catch(() => {});
    await safeToast(client, message, "warning");
  });

  // Init log. Best-effort — never throw from plugin init.
  await client.app
    ?.log?.({
      body: {
        service: "agent-router",
        level: "info",
        message: "init",
        extra: {
          version: VERSION,
          active: (await getActiveStackName(paths).catch(() => null)) ?? "(none)",
          routerHome: paths.routerHome,
        },
      },
    })
    .catch(() => {
      /* logging must not block plugin startup */
    });

  return {
    event: failover.event,
    "chat.message": async (
      input: Parameters<ReturnType<typeof createFailover>["message"]>[0],
      output: Parameters<ReturnType<typeof createFailover>["message"]>[1],
    ) => {
      // A CLI/TUI apply invalidates startup routing. Do not race it with an SDK model write.
      if (stateBytes() !== initialState) failover.disable();
      await failover.message(input, output);
    },
    tool: {
      router_status: tool({
        description:
          "Report the active agent-router stack, the current agent → model frontmatter mapping, and all available stacks.",
        args: {},
        async execute() {
          try {
            const [active, available, current] = await Promise.all([
              getActiveStackName(paths),
              listStacks(paths),
              readAgentModels(paths.agentsDir),
            ]);
            return ok({ active, available, current });
          } catch (e) {
            return errOut(e);
          }
        },
      }),

      router_list: tool({
        description: "List all agent-router stacks with isActive flags.",
        args: {},
        async execute() {
          try {
            const [active, available] = await Promise.all([
              getActiveStackName(paths),
              listStacks(paths),
            ]);
            return ok(available.map((name) => ({ name, isActive: name === active })));
          } catch (e) {
            return errOut(e);
          }
        },
      }),

      router_use: tool({
        description:
          "Apply an agent-router stack: rewrite each agent file's frontmatter model. Validates model IDs first. Restart opencode for changes to take effect.",
        args: {
          name: tool.schema.string().describe("Stack name to apply (see router_list)."),
          validate: tool.schema
            .boolean()
            .optional()
            .describe("Default true. Reject the switch if any model ID is unreachable."),
        },
        async execute(args) {
          try {
            failover.disable();
            const r = await applyStack(paths, args.name, {
              validate: args.validate ?? true,
              ...(validateOptions ? { validateOptions } : {}),
            });
            await safeToast(
              client,
              `agent-router: switched to "${r.current}". Restart opencode for change to take effect.`,
            );
            return ok({
              previous: r.previous,
              current: r.current,
              changed: r.changed,
              restartRequired: true,
            });
          } catch (e) {
            return errOut(e);
          }
        },
      }),

      router_capture: tool({
        description:
          "Snapshot the current agent → model frontmatter mapping into a named agent-router stack.",
        args: {
          name: tool.schema.string().describe("Name for the new stack."),
          force: tool.schema
            .boolean()
            .optional()
            .describe("Default false. Overwrite an existing stack of the same name."),
        },
        async execute(args) {
          try {
            const r = await captureStack(paths, args.name, { force: args.force ?? false });
            return ok({ name: r.name, path: r.path, agents: r.agents });
          } catch (e) {
            return errOut(e);
          }
        },
      }),

      router_validate: tool({
        description:
          "Validate that every model ID in a stack (or the current frontmatter) is reachable through current opencode auth.",
        args: {
          name: tool.schema.string().optional().describe("Stack name; omit when using `active`."),
          active: tool.schema
            .boolean()
            .optional()
            .describe("Validate the models currently in agent frontmatter instead."),
        },
        async execute(args) {
          try {
            let stack: unknown;
            if (args.active) {
              stack = { agents: await captureAgents(paths) };
            } else if (args.name) {
              stack = await readStack(paths, args.name);
            } else {
              return errOut(new Error("Pass `name` or `active: true`."));
            }
            const r = await validateStack(StackFileSchema.parse(stack), validateOptions);
            return ok({
              ok: r.ok,
              checked: r.checked,
              missing: r.missing.map((m) => ({ path: m.path, modelId: m.modelId })),
            });
          } catch (e) {
            return errOut(e);
          }
        },
      }),

      router_back: tool({
        description:
          "Undo the last N agent-router switches (default 1). Restart opencode for changes to take effect.",
        args: {
          n: tool.schema.number().optional().describe("How many switches to undo."),
        },
        async execute(args) {
          try {
            failover.disable();
            const r = await backCore(paths, args.n ?? 1);
            await safeToast(
              client,
              `agent-router: reverted to "${r.current}". Restart opencode for change to take effect.`,
            );
            return ok({
              previous: r.previous,
              current: r.current,
              restartRequired: true,
            });
          } catch (e) {
            return errOut(e);
          }
        },
      }),
    },
  };
};

export default { id: "agent-router", setup: setupV2 };
