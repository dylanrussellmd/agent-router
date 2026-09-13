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

import { z } from "zod";

export const FallbackSchema = z
  .object({
    model: z.string().regex(/^[^/\s]+\/\S+$/, "Expected provider/model"),
    variant: z.string().min(1).optional(),
  })
  .strict();

export const RoutingEntrySchema = z
  .object({
    model: z.string().min(1),
    variant: z.string().min(1).nullable().optional(),
    fallbacks: z.array(FallbackSchema).max(8).optional(),
  })
  .strict();
export type RoutingEntry = z.infer<typeof RoutingEntrySchema>;

/* ------------------------------------------------------------------------- *
 * state.json                                                                 *
 * ------------------------------------------------------------------------- */

export const StateFileSchema = z
  .object({
    version: z.literal(1),
    active: z.string().min(1),
    previousActive: z.string().min(1).nullable(),
    lastSwitchedAt: z.string().min(1),
    fallbackAgents: z.record(z.string(), RoutingEntrySchema).optional(),
  })
  .strict();

export type StateFile = z.infer<typeof StateFileSchema>;

/* ------------------------------------------------------------------------- *
 * stack files                                                                *
 * ------------------------------------------------------------------------- */

/**
 * The smallest commitment a stack entry makes: it must have a `model` string.
 * Except router-owned `fallbacks`, other keys are provider pass-through options (`reasoningEffort`,
 * `thinking`, `temperature`, …) that agent-router transcribes to the agent
 * file's frontmatter alongside `model`. Unknown keys ride along unchanged so
 * future additions survive round-trips; reserved opencode framework keys
 * (`description`, `permission`, `tools`, …) are filtered out by the apply
 * path and never written to frontmatter.
 */
export const AgentEntrySchema = z
  .object({
    model: z.string().min(1),
    variant: z.string().min(1).nullable().optional(),
    fallbacks: z.array(FallbackSchema).max(8).optional(),
  })
  .passthrough();

export type AgentEntry = z.infer<typeof AgentEntrySchema>;

/**
 * A stack maps agent names (the `<name>.md` files in the agents dir) to the
 * model each should run on. `apply` rewrites each file's frontmatter `model:`
 * line to match; `capture` builds one of these from the current frontmatter.
 */
export const StackFileSchema = z
  .object({
    agents: z.record(z.string(), AgentEntrySchema),
  })
  .passthrough()
  .refine((s) => Object.keys(s.agents).length > 0, {
    message: "Stack file must map at least one agent in `agents`.",
  });

export type StackFile = z.infer<typeof StackFileSchema>;

/* ------------------------------------------------------------------------- *
 * config.json (agent-router's own settings — strict, fail closed)            *
 * ------------------------------------------------------------------------- */

export const ConfigFileSchema = z
  .object({
    /** Where the agent .md files live. Default: `${opencodeConfigDir}/agents`. */
    agentsDir: z.string().min(1).optional(),
    /** Where named stacks live. Default: `${routerHome}/stacks`. */
    stacksDir: z.string().min(1).optional(),
  })
  .strict();

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

/**
 * Loose schema for `opencode.json` / `tui.json`. We only read/edit `plugin`
 * (array). Everything else is preserved.
 */
export const OpencodeJsonSchema = z
  .object({
    plugin: z.array(z.string()).optional(),
  })
  .passthrough();

export type OpencodeJson = z.infer<typeof OpencodeJsonSchema>;
