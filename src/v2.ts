import { readFileSync } from "node:fs";
import type { Context } from "@opencode/plugin/promise/plugin";
import { z } from "zod";
import { resolvePathsWithConfig } from "./core/config.js";
import { createFailover } from "./core/failover.js";
import { RoutingEntrySchema } from "./core/schema.js";
import { captureAgents } from "./core/stack-manager.js";
import { AgentRouterPlugin } from "./plugin.js";
import { createQuotaFallback } from "./quota-fallback-v2.js";
import { createQuotaAdmission } from "./quota-v2.js";

const variant = (value: string | null | undefined) =>
  value === "default" ? undefined : (value ?? undefined);

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
      if (!parsed.success || !parsed.data.fallbacks?.length) return [];
      return [
        [
          id,
          {
            ...parsed.data,
            variant: variant(parsed.data.variant),
            fallbacks: parsed.data.fallbacks.map((entry) => ({
              ...entry,
              variant: variant(entry.variant),
            })),
          },
        ],
      ];
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
  const quota = createQuotaAdmission(ctx, routes, () => state() === initial);
  const quotaFallback =
    quota &&
    createQuotaFallback(
      ctx,
      routes,
      quota,
      () => state() === initial,
      (sessionID, agent, model, messageID) => {
        const id = messageID ?? turns.get(sessionID)?.id;
        if (!id) return;
        const message = {
          id,
          agent,
          model: {
            providerID: model.providerID,
            modelID: model.id,
            variant: variant(model.variant),
          },
        };
        failover.admit(sessionID, message);
        turns.set(sessionID, message);
        kinds.set(sessionID, "primary");
      },
    );
  if (quota) {
    await ctx.tool.transform((editor) => {
      const input = { type: "object", properties: {}, additionalProperties: false } as const;
      for (const action of ["pin", "auto"] as const)
        editor.add({
          name: `router_${action}`,
          description:
            action === "pin"
              ? "Only on an explicit user request: pin this session's current model and disable automatic quota/reactive routing. Takes no model or session arguments."
              : "Only on an explicit user request: resume quota-aware routing for this session on its NEXT explicit user turn. Does not send a prompt or switch immediately.",
          input,
          async execute(_input, context) {
            await quota.control(context.sessionID, action, async () => {
              quotaFallback?.stop(context.sessionID);
              turns.delete(context.sessionID);
              kinds.delete(context.sessionID);
              await failover.event({
                event: {
                  type: "session.next.model.switched",
                  properties: { sessionID: context.sessionID },
                },
              });
            });
            return { content: JSON.stringify(await quota.status(context.sessionID)) };
          },
        });
      editor.add({
        name: "router_routing_status",
        description:
          "Show this session's automatic/pinned routing mode, current model, and routing reason.",
        input,
        async execute(_input, context) {
          return { content: JSON.stringify(await quota.status(context.sessionID)) };
        },
      });
    });
  }
  const controller = new AbortController();
  const events = (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (!("sessionID" in event.data)) continue;
      const sessionID = String(event.data.sessionID);
      if (
        await quota?.event(
          sessionID,
          event.type,
          event.type === "session.model.selected" ? event.data.model : undefined,
        )
      )
        continue;
      if (
        [
          "session.model.selected",
          "session.agent.selected",
          "session.execution.interrupted",
          "session.deleted",
          "session.execution.succeeded",
          "session.execution.failed",
        ].includes(event.type)
      )
        quotaFallback?.stop(sessionID);
      if (!turns.has(sessionID)) continue;
      if (event.type === "session.model.selected") {
        const model = event.data.model;
        if (
          ownSelections.get(sessionID) ===
          `${model.providerID}/${model.id}#${variant(model.variant) ?? ""}`
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
  await ctx.session.hook("model.request", async (event) => {
    quotaFallback?.model(event);
    if (event.kind === "primary")
      await quotaFallback?.child(event.sessionID, event.agent, event.model);
    if (turns.has(event.sessionID)) kinds.set(event.sessionID, event.kind);
  });
  if (quota)
    await ctx.tool.hook("execute.before", async (event) => {
      const input = event.input as Record<string, unknown> | undefined;
      const automatic =
        event.tool === "subagent" &&
        input &&
        typeof input === "object" &&
        !["model", "sessionID", "session_id", "task_id"].some((key) => key in input) &&
        typeof input.agent === "string";
      await quota.child(event);
      if (event.tool === "subagent" && input && typeof input.agent === "string")
        quotaFallback?.ticket(
          event.id,
          event.sessionID,
          input.agent,
          typeof input.model === "string" ? input.model : undefined,
          automatic && typeof input.prompt === "string" ? input.prompt : undefined,
        );
    });
  if (quotaFallback) {
    await ctx.session.hook("http.request", (event) => quotaFallback.request(event));
    await ctx.session.hook("http.response", (event) => quotaFallback.response(event));
    await ctx.session.hook("experimental.ws.handshake", (event) =>
      quotaFallback.unsupported(event.sessionID),
    );
  }
  await ctx.session.hook("prompt", async (event) => {
    if (turns.get(event.sessionID)?.id === event.messageID) return;
    quotaFallback?.stop(event.sessionID);
    if (state() !== initial) {
      failover.disable();
      turns.clear();
      return;
    }
    const session = await ctx.session.get({ sessionID: event.sessionID });
    if (turns.get(event.sessionID)?.id === event.messageID) return;
    if (quota) {
      if (session.parentID && (await quota.isPinned(event.sessionID))) {
        turns.delete(event.sessionID);
        return;
      }
      const pending = failover.pending(event.sessionID);
      const selected = session.parentID
        ? session.model
        : await quota.main(
            event.sessionID,
            session,
            pending
              ? {
                  providerID: pending.providerID,
                  id: pending.modelID,
                  variant: pending.variant,
                }
              : undefined,
          );
      if (!selected || !session.agent || !routes[session.agent]) {
        turns.delete(event.sessionID);
        return;
      }
      const message = {
        id: event.messageID,
        agent: session.agent,
        model: {
          providerID: selected.providerID,
          modelID: selected.id,
          variant: variant(selected.variant),
        },
      };
      failover.admit(event.sessionID, message);
      if (!failover.active(event.sessionID)) return;
      turns.set(event.sessionID, message);
      if (!session.parentID) quotaFallback?.admit(event.sessionID, session.agent, selected);
      return;
    }
    if (!session.agent || !session.model || !routes[session.agent]) return;
    const message = {
      id: event.messageID,
      agent: session.agent,
      model: {
        providerID: session.model.providerID,
        modelID: session.model.id,
        variant: variant(session.model.variant),
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
    if (await quotaFallback?.retry(event)) return;
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
    quotaFallback?.dispose();
    await quota?.dispose();
    failover.disable();
    turns.clear();
    kinds.clear();
    ownSelections.clear();
    await events;
  };
}
