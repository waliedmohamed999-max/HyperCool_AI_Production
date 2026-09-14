# Frost Multi-Agent Delegation (Phase 7B, hardened in Phase 7C)

`delegate_to_agent` tool in `src/runtime/tools.js`, invoked by `frost_commander`.

## What it is

`frost_commander` (the Command Center's chat agent) can delegate part of a request to one of four
specialist agents — `performance`, `intelligence` (competitor/trend), `leads`, `strategy` — by
calling `delegate_to_agent({agent, objective})`. Each delegated call is a **real, nested agent
run** through the exact same `agentRuntime.run()` every top-level agent run uses: its own system
prompt (that agent's own `agents/*.md` file), its own tool list, its own `agent_runs` row.

This is not a second orchestrator. `frost_commander` simply calls a tool; the tool's handler
calls `agentRuntime.run()` for the target agent and returns that run's decision as the tool
result, exactly like any other tool call. Fan-out to multiple agents in one command (e.g.
"اعمل خطة نمو للشهر القادم" → delegates to both `performance` and `intelligence`) runs both
delegate calls through the same `Promise.all`-vs-sequential parallel-safety classification
described in `docs/WORKFLOW_ENGINE.md` — a batch of `AGENT`-type tool calls in the same LLM turn
is safe to run concurrently.

## Delegation depth — capped structurally, not by a counter (Phase 7C hardening)

Rather than tracking a numeric depth counter that could be bypassed by a bug in the counting
logic, delegation depth is capped by the tool registry itself:

- `delegate_to_agent`'s own metadata carries `allowedAgents:['frost_commander']` — **only**
  `frost_commander` may call it.
- None of the four delegate targets (`performance`, `intelligence`, `leads`, `strategy`) have
  `delegate_to_agent` in their own tool list.

The result: a delegation chain deeper than 1 hop is architecturally impossible — a delegated
agent has no tool that could delegate further, regardless of what the LLM might otherwise be
prompted to attempt. This is verified directly in `tests/tool-parallel-safety.test.js`
("`delegate_to_agent` structurally absent from `performance` agent's tool list").

## `parent_run_id` — real linkage, not a display trick

Each delegated run's `agent_runs.parent_run_id` points at the delegating `frost_commander` run,
using the same column that has existed (dormant) since Phase 2 and was activated for this purpose
in Phase 7B. Live Operations and the run-detail timeline use this to show the real parent → child
relationship. Workflow AGENT steps deliberately pass `parentRunId:null` instead — a workflow run
is not itself an agent run, so there is no meaningful "parent agent run" to link to; that
relationship is tracked instead via `workflow_step_runs.agent_run_id`.

## Content-router testing pattern

Because a delegated agent's system prompt is completely distinct text from `frost_commander`'s
own prompt, E2E mocks match on a short, unique phrase from the delegated agent's own prompt file
(`AGENT_TURN_MARKERS` in the E2E scripts) rather than relying on request ordering — this makes the
mock immune to however many other real background agent runs (e.g. one triggered by an unrelated
seeded event) happen to interleave with the delegation.

## Known limitation

Delegation is a single request/response round trip per delegated agent — there is no
back-and-forth negotiation between `frost_commander` and a delegate within one command; if a
delegate's answer is insufficient, `frost_commander` must decide from the tool result alone
(escalate, ask the user, or answer with what it has), the same as it would with any other tool
result.
