# AI Provider Setup

The Agent Runtime (`src/runtime/`) talks to the LLM only through `src/runtime/llmProvider.js`
— no agent or route calls Anthropic/OpenAI directly. Two real providers are implemented
today, with the same contract (bounded tool-use loop, structured JSON output, one repair
attempt on invalid JSON, fails closed after that): **Anthropic** and **OpenAI**.

## 1. Anthropic setup

```dotenv
AI_PROVIDER=anthropic        # or leave unset — anthropic is the default
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-...   # an exact model ID available in your account
```

`AI_API_KEY`/`AI_DEFAULT_MODEL` are accepted as generic aliases when `AI_PROVIDER` is
anthropic (or unset) — set either the `ANTHROPIC_*` pair or the `AI_*` pair, not both.

## 2. OpenAI setup

```dotenv
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_DEFAULT_MODEL=gpt-...  # must support tool/function calling
```

## 3. Per-agent model override

`AI_PROVIDER`/`ANTHROPIC_MODEL`/`OPENAI_DEFAULT_MODEL` set the **account default** every
agent uses unless that specific agent has its own override. To pin one agent to a
different provider/model/sampling (e.g. a deterministic model for compliance, a more
creative one for copywriting):

```
POST /api/agents/compliance/model-config   (owner session required)
{ "provider": "openai", "model": "gpt-...", "temperature": 0, "maxTokens": 2048 }
```

Fields are independent — send only the ones you want to change; omit a field to leave it
as-is, or send `null` to clear an override back to the account default. `GET /api/agents`
returns each agent's current `modelConfig` and whether it's `WAITING_LLM` (that agent's
*effective* provider, not just the account default, is unconfigured).

## 4. Fallback (optional, off by default)

```dotenv
AI_PROVIDER_FALLBACK_ENABLED=true
```

Requires **both** providers configured. When a run's primary provider fails after its own
retry (network error, rate limit, invalid response — never a schema-validation failure,
which always retries on the *same* provider first), the run retries once on the other
provider before failing. `agent_runs.used_fallback` records whether this happened; the
run's `provider`/`model` columns always reflect whichever provider actually produced the
result.

## 5. Cost tracking

Every run records real `tokens_input`/`tokens_output` (from the provider's own response)
plus `provider`, `model`, and a content-derived `prompt_version` fingerprint (changes
automatically when an agent's prompt file changes — never a hand-typed version number).
`estimated_cost` stays honestly `null` until you fill in your own rates in
`PRICING_PER_MILLION_TOKENS` (`src/runtime/llmProvider.js`) — this codebase has no
verified-current price list for either provider and will not guess one.

`GET /api/agents/cost-summary?since=<ISO date>` (owner only) — grouped by agent/provider/model.

## 6. Health check

`POST /api/integrations/anthropic/test` and `POST /api/integrations/openai/test` (owner
only) — a light reachability check (lists models) against the configured credentials.
Returns `NOT_CONFIGURED`, `OK`, `AUTH_FAILED`, `RATE_LIMITED`, or `NETWORK_ERROR`. This
does **not** exercise structured output or tool-calling — the Agent Team page's "Test
Agent" button already does that with a real run (no external send; tools that need an
unconfigured integration honestly return `INTEGRATION_REQUIRED`).

## 7. Prompt injection

Every run's system prompt ends with an explicit instruction that runtime data (CRM notes,
website content, tool results) is DATA, never instructions — a message that tries to
change the agent's instructions, reveal secrets, or change permissions is expected to be
ignored, with `escalation_required` set and reason `PROMPT_INJECTION_ATTEMPT`. Verified in
`tests/runtime.test.js`.

## What is NOT built

- `stream()` — no streaming responses; every call is a single request/response.
- A third provider — the abstraction supports adding one (a new branch in
  `llmProvider.js`), but only Anthropic/OpenAI exist today.
- Per-agent `tools_enabled`/`structured_output` toggles from the original spec — every
  agent always gets its full allowed-tool list (permission-gated per level) and always
  requires structured output; there was no real use case yet for turning either off
  per-agent, so no dead config surface was added for it.
