import { readFileSync } from "node:fs";
import type { Context } from "@opencode/plugin/promise/plugin";
import { z } from "zod";
import { resolvePathsWithConfig } from "./core/config.js";
import { createFailover } from "./core/failover.js";
import { RoutingEntrySchema } from "./core/schema.js";
import { captureAgents } from "./core/stack-manager.js";
import { AgentRouterPlugin } from "./plugin.js";

/** 2.0.8: model refs are readonly in context hooks; switch only at user admission. */
export async function setupV2(ctx: Context) {
  const legacy = await AgentRouterPlugin(
    { client: {} } as Parameters<typeof AgentRouterPlugin>[0],
    {
      runOpencodeModels: async () => JSON.stringify(await ctx.model.list()),
    },
  );
  await ctx.tool.transform((editor) => {
    for (const [name, definition] of Object.entries(legacy.tool ?? {})) {
      editor.add({
        name,
        description: definition.description,
        input: z.toJSONSchema(z.object(definition.args)),
        async execute(input) {
          const execute = definition.execute as (
            args: Record<string, unknown>,
          ) => Promise<{ output: string }>;
          const result = await execute(z.object(definition.args).parse(input));
          return { content: typeof result === "string" ? result : result.output };
        },
      });
    }
  });
  const paths = await resolvePathsWithConfig();
  const state = () => {
    try {
      return readFileSync(paths.statePath, "utf8");
    } catch {
      return undefined;
    }
  };
  const initial = state();
  const captured = await captureAgents(paths);
  const routes = Object.fromEntries(
    Object.entries(captured).flatMap(([id, entry]) => {
      const parsed = RoutingEntrySchema.safeParse({
        model: entry.model,
        variant: entry.variant,
        fallbacks: entry.fallbacks,
      });
      return parsed.success && parsed.data.fallbacks?.length ? [[id, parsed.data]] : [];
    }),
  );
  const failover = createFailover(routes, async (message) => {
    console.warn(message);
  });
  const turns = new Map<
    string,
    {
      id: string;
      agent: string;
      model: { providerID: string; modelID: string; variant?: string | undefined };
    }
  >();
  const kinds = new Map<string, string>();
  const ownSelections = new Map<string, string>();
  const controller = new AbortController();
  const events = (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (!("sessionID" in event.data)) continue;
      const sessionID = String(event.data.sessionID);
      if (!turns.has(sessionID)) continue;
      if (event.type === "session.model.selected") {
        const model = event.data.model;
        if (
          ownSelections.get(sessionID) === `${model.providerID}/${model.id}#${model.variant ?? ""}`
        ) {
          ownSelections.delete(sessionID);
          continue;
        }
      }
      if (
        [
          "session.model.selected",
          "session.agent.selected",
          "session.execution.interrupted",
          "session.deleted",
        ].includes(event.type)
      ) {
        await failover.event({
          event: { type: "session.next.model.switched", properties: { sessionID } },
        });
        turns.delete(sessionID);
        kinds.delete(sessionID);
      }
    }
  })().catch((error) => {
    if (!controller.signal.aborted) console.warn("agent-router event subscription failed", error);
  });
  await ctx.session.hook("model.request", (event) => {
    if (turns.has(event.sessionID)) kinds.set(event.sessionID, event.kind);
  });
  await ctx.session.hook("prompt", async (event) => {
    if (turns.get(event.sessionID)?.id === event.messageID) return;
    if (state() !== initial) {
      failover.disable();
      turns.clear();
      return;
    }
    const session = await ctx.session.get({ sessionID: event.sessionID });
    if (!session.agent || !session.model || !routes[session.agent]) return;
    const message = {
      id: event.messageID,
      agent: session.agent,
      model: {
        providerID: session.model.providerID,
        modelID: session.model.id,
        variant: session.model.variant,
      },
    };
    const before = JSON.stringify(message.model);
    await failover.message({ sessionID: event.sessionID }, { message });
    if (!failover.active(event.sessionID)) {
      turns.delete(event.sessionID);
      return;
    }
    if (before !== JSON.stringify(message.model)) {
      const latest = await ctx.session.get({ sessionID: event.sessionID });
      if (
        !failover.active(event.sessionID) ||
        latest.agent !== session.agent ||
        JSON.stringify(latest.model) !== JSON.stringify(session.model)
      ) {
        await failover.event({
          event: {
            type: "session.next.model.switched",
            properties: { sessionID: event.sessionID },
          },
        });
        turns.delete(event.sessionID);
        return;
      }
      ownSelections.set(
        event.sessionID,
        `${message.model.providerID}/${message.model.modelID}#${message.model.variant ?? ""}`,
      );
      try {
        await ctx.session.switchModel({
          sessionID: event.sessionID,
          model: {
            providerID: message.model.providerID,
            id: message.model.modelID,
            ...(message.model.variant ? { variant: message.model.variant } : {}),
          },
        });
      } catch (error) {
        ownSelections.delete(event.sessionID);
        throw error;
      }
    }
    turns.set(event.sessionID, message);
  });
  await ctx.session.hook("retry", async (event) => {
    const turn = turns.get(event.sessionID);
    if (
      !turn ||
      kinds.get(event.sessionID) !== "primary" ||
      turn.agent !== event.agent ||
      turn.model.providerID !== event.model.providerID ||
      turn.model.modelID !== event.model.id
    )
      return;
    if (!event.decision.retry || ![429, 500, 502, 503, 504].includes(event.error.status ?? 0))
      return;
    // Veto same-turn replay. The core queues a selection, never a prompt or tool.
    event.decision = { retry: false };
    await failover.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            sessionID: event.sessionID,
            role: "assistant",
            parentID: turn.id,
            agent: turn.agent,
            ...turn.model,
            error: {
              name: "APIError",
              data: { statusCode: event.error.status, isRetryable: true },
            },
          },
        },
      },
    });
  });
  return async () => {
    controller.abort();
    failover.disable();
    turns.clear();
    kinds.clear();
    ownSelections.clear();
    await events;
  };
}
