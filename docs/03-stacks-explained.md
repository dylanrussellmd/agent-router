# Stacks explained

A "stack" is a named bag of model assignments — one for each agent and category opencode knows about. Switching stacks swaps the whole set in one move.

`omo-router init` ships three to start. You can [make your own](./06-customizing.md) any time.

## premium

**The default after `init`.** Strong models on every tier:

| who | model |
|---|---|
| `sisyphus`, `metis`, `prometheus` | `anthropic/claude-opus-4-7` (max) |
| `oracle`, `momus`, `hephaestus` | `openrouter/openai/gpt-5.4` |
| `atlas`, `sisyphus-junior` | `anthropic/claude-sonnet-4-6` |
| `explore`, `multimodal-looker` | `google/gemini-3-flash-preview` |
| categories `visual-engineering`, `ultrabrain`, `deep`, `artistry`, `unspecified-high` | `google/gemini-3.1-pro-preview` |
| categories `quick`, `unspecified-low`, `writing` | `google/gemini-3-flash-preview` |

**Pick this when:** quality matters more than cost. Production work, deep thinking, anything where a cheaper model would lose nuance.

**Cost:** high. You're paying Anthropic / Google / OpenRouter directly.

## openrouter-cheap

**Same routing shape, every call through OpenRouter, downgraded tiers.** Single billing relationship; ~30–50% the cost of premium for similar workloads.

| who | model |
|---|---|
| `sisyphus`, `metis`, `prometheus` | `openrouter/anthropic/claude-sonnet-4-6` (instead of opus) |
| `oracle`, `momus` | `openrouter/openai/gpt-5.4` (kept — reasoning critical) |
| `atlas`, `sisyphus-junior` | `openrouter/anthropic/claude-haiku-4.5` (instead of sonnet) |
| `hephaestus` | `openrouter/openai/gpt-5.4-mini` |
| `explore`, `multimodal-looker` | `openrouter/google/gemini-2.5-flash` |
| categories `ultrabrain`, `deep` | `openrouter/openai/gpt-5.4` |
| categories `visual-engineering`, `quick`, `unspecified-low`, `writing` | `openrouter/google/gemini-2.5-flash` |
| categories `artistry`, `unspecified-high` | `openrouter/anthropic/claude-sonnet-4-6` / `openrouter/openai/gpt-5.4-mini` |

**Pick this when:** you're on a long-running task that doesn't need top-tier models, or you want a single bill from OpenRouter instead of three vendor bills.

**Quality trade-offs:** noticeably less depth on visual-engineering and deep tasks. Mostly indistinguishable on quick/writing work. Reasoning agents (oracle, momus) keep the strong model.

## free-only

**Designed to run for ~$0 on free quotas.** Gemini direct + free OpenRouter models.

| who | model |
|---|---|
| smart tiers (sisyphus, oracle, prometheus, metis, momus + smart categories) | `google/gemini-3.1-pro-preview` |
| fast tiers (everything else, plus `atlas`, `sisyphus-junior`, `explore`, `multimodal-looker`) | `google/gemini-2.5-flash` |
| `hephaestus` primary | `openrouter/openai/gpt-oss-120b:free` |
| reasoning fallbacks (oracle, momus, ultrabrain, deep) | `openrouter/openai/gpt-oss-120b:free` |

**Pick this when:** experimenting, learning, personal projects, or just curious. The Gemini free tier covers low-volume usage; OpenRouter's `:free` models fill in for reasoning fallbacks.

**Limits:** rate limits will catch up with you on heavy work. Quality is "good enough for prototyping" — not what you want for production.

## How they compare side-by-side

| | premium | openrouter-cheap | free-only |
|---|---|---|---|
| Cost | $$$ | $ | $0 (within quotas) |
| Bills | Anthropic + Google + OpenRouter | OpenRouter only | Google free tier + OpenRouter free models |
| Reasoning quality | High | High (oracle/momus kept on gpt-5.4) | Medium |
| Code quality | High | Medium-high | Medium |
| Speed | Mixed (Opus is slow) | Faster (Sonnet/Haiku/Flash) | Fastest (Flash) |
| Best for | Production | Long sessions, cost-aware work | Learning, experiments |

## Picking a stack

The simple version:

- **Daily driver:** `premium` (or `openrouter-cheap` if cost-sensitive)
- **Long iterative tasks:** `openrouter-cheap`
- **Side projects / learning:** `free-only`

Switch any time:

```bash
omo-router use openrouter-cheap
# restart opencode
```

Wrong call? Just go back:

```bash
omo-router back
# restart opencode
```

→ Next: [Switching stacks](./04-switching.md)
