# Agent Readiness (Multi-Tenant Phase 4B)

`src/runtime/agent-readiness.js` — `AgentReadinessService` + `ToolReadinessService`.

## Health vs Readiness — read this first

**Connection Health (Phase 4A) is a different question from Agent Readiness (Phase 4B).** A
connection can be perfectly `CONNECTED` while an agent is still `BLOCKED`, because it has the
wrong (or no) assignment, is disabled, or its AI provider isn't configured. Readiness is never
a stored badge — every status returned by `evaluateAgentReadiness`/`evaluateToolReadiness` is
derived, on the spot, from `tenant_agent_configs`, `agent_tool_assignments`,
`integration_connections`, and the vault. An agent is never reported `READY` just because
`enabled=true` (verified by test: "Readiness: a disabled agent is DISABLED, never READY just
because it exists").

## ToolReadiness states

| Status | Meaning |
|---|---|
| `READY` | Tool resolves cleanly — no assignment (legacy pass-through and either no integration or the legacy static/env path is configured), or a healthy resolved connection |
| `CONNECTION_REQUIRED` | `CONNECTION_NOT_FOUND`, `CONNECTION_PROVIDER_MISMATCH`, `CONNECTION_SELECTION_REQUIRED`, or the legacy static path is genuinely unconfigured |
| `CONNECTION_UNHEALTHY` | An explicitly assigned connection exists but is not `CONNECTED`/`DEGRADED` |
| `CONNECTION_CAPABILITY_MISSING` | *(Phase 4B.1)* The connection is the right provider and healthy, but its real granted OAuth scopes don't cover what this tool needs — see `docs/CONNECTION_AWARE_RUNTIME.md`'s capability enforcement section. Never folded into `CONNECTION_REQUIRED`: an operator needs to know "reconnect with more permissions" is different from "connect something at all" |
| `DISABLED` | The tool's own assignment is disabled, or `ToolDefinition.isAvailable=false` (no real tool is in this state today — every one of the 51 tools is implemented) |
| `PERMISSION_BLOCKED` | *(reserved — permission-level blocking is reported at the agent run level via `FORBIDDEN`/`WAITING_APPROVAL`, not duplicated here)* |

## AgentReadiness states

| Status | When |
|---|---|
| `DISABLED` | `TenantAgentConfig.enabled=false` |
| `BLOCKED` | AI required but no healthy AI connection/env default, OR any **required** tool is not `READY` |
| `PARTIAL` | Every required tool is `READY`, but at least one **optional** tool is not |
| `READY` | Everything required is genuinely usable right now |

Response shape (matches the original spec exactly):

```json
{
  "status": "PARTIAL",
  "required": {"ai": "READY", "tools": "READY"},
  "optional_missing": ["whatsapp_send"],
  "blockers": [],
  "warnings": ["whatsapp_send غير جاهز (اتصال غير مُعد) — الوكيل يعمل بدونها"]
}
```

`blockers` always carries a machine-readable reason (`AI_NOT_CONFIGURED`,
`REQUIRED_TOOL_CONNECTION_REQUIRED:get_lead`, `AGENT_DISABLED`, …); `warnings` is the
human/Arabic-readable mirror of `optional_missing`, for a future UI, never used for gating.

## Required vs optional semantics (Phase 69, decided explicitly)

Disabling an **optional** tool (e.g. WhatsApp for Sales) leaves the agent `PARTIAL` — it still
runs, told explicitly (via `unavailable_optional_tools` in its input context) which tools it
must not pretend exist. Disabling a **required** tool moves the agent to `BLOCKED` and the
run never spends AI tokens (Phase 34 precheck, below). This is the one place in this phase
where an explicit design choice had to be made among several plausible readings of the spec;
documented here rather than left ambiguous.

## Run precheck (Phase 34, `runtime.js`)

Before the LLM is ever called, `runtime.run()` calls `evaluateAgentReadiness` and returns
`AGENT_NOT_READY` immediately if any **required** tool is blocked — no token spend. The
AI-provider-not-configured case is deliberately **not** pre-blocked the same way: the LLM
provider itself already fails closed at zero cost with a more specific error
(`OPENAI_NOT_CONFIGURED` / `ANTHROPIC_NOT_CONFIGURED` from `llmProvider.js`); a generic
`AGENT_NOT_READY` here would only make that less precise.

## Partial execution (Phase 35)

A run with only optional tools missing still executes. Its system prompt is appended with:
`The following optional tools are not currently available (not configured for this
workspace) and must not be treated as usable: <list>.` — so the model is told, in-band, never
left to discover a `FORBIDDEN`/`INTEGRATION_REQUIRED` failure mid-conversation and improvise
around it.

## API

`GET /api/agents/:agentId/readiness` (owner/operator) — `application.js`, wraps
`evaluateAgentReadiness` directly; no cached/stored readiness anywhere.

*(Phase 4B.1)* `GET /api/agents/:agentId/tools` now also returns a `readiness` field per tool
(via `evaluateAllToolsReadiness`, which was built in Phase 4B but never actually wired into a
route until this pass) — `status`/`reason` only, no credential. `GET /api/tools/:id/connections`
returns a `capabilityGranted` boolean per candidate connection (`scopes` itself is already
non-secret metadata, unchanged) — so a UI can show, per connection option, whether it actually
covers what the tool needs before an operator picks it, not just that it's the right provider.

## Tests

`tests/agent-tool-mapping.test.js`: "Readiness: a disabled agent is DISABLED, never READY just
because it exists"; "Readiness: an optional tool with no configured provider makes the agent
PARTIAL, never BLOCKED"; "ToolReadiness: DISABLED for any tool the registry marks
not-implemented, regardless of tenant config" (simulated directly, since no real tool is
currently in that state).
