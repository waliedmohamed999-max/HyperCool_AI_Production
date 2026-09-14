# Native Workflow Engine (Phase 7C)

`src/runtime/workflow-engine.js` — the one, canonical automation engine shared by both the
Workflow Builder UI (`public/pages/workflows.js`) and Frost chat (`create_workflow_draft` /
`activate_workflow` / `run_workflow_now` tools in `src/runtime/tools.js`).

## The core architectural rule

The Workflow Engine is **not** a second Agent Runtime, Tool Registry, Event Bus, Scheduler, or
Approval Engine. It only owns **definition + trigger + conditions + step graph + execution
state**. Actual work is always dispatched to the systems that already do it:

| Step type | Dispatches to |
|---|---|
| `AGENT` | `agentRuntime.run()` — the exact same runtime every other agent run uses |
| `TOOL` | `canUseTool` / `resolveToolConnection` / `tool.handler` — the same Tool Registry, executed as the real `frost_commander` identity |
| `APPROVAL` | `createApproval` — a real `agent_approvals` row (`action_type='workflow_step_approval'`), resumed via the exact same `POST /api/approvals/:id/decide` route every other approval uses |
| `CREATE_TASK` / `NOTIFY_INTERNAL` | `createEscalation` — this codebase's own Tasks model |
| `SCHEDULE` trigger | The existing `scheduler.js` tick (`tickWorkflowsForTenant`), not a new cron |
| `EVENT` trigger | The existing `events.js` EventBus (`installWorkflowEventTriggers`), never an invented event name |

No new tables duplicate `agent_runs`, `agent_approvals`, `escalations`, or `audit_logs`. The new
tables (`workflow_definitions`, `workflow_versions`, `workflow_runs`, `workflow_step_runs`) hold
**only** definition and execution-state data.

## Canonical concepts

- **WorkflowDefinition** — the stable identity (`id`, `tenant_id`, `status`, `draft_version_id`,
  `active_version_id`). Status: `DRAFT → ACTIVE ⇄ PAUSED → ARCHIVED`.
- **WorkflowVersion** — an immutable snapshot of `trigger` + `conditions` + `steps` once it
  becomes the active version. Editing an ACTIVE workflow creates a **new** version (next integer);
  editing a DRAFT workflow updates its one draft version in place (no version-number churn).
- **WorkflowRun** — one execution, pinned forever to `workflow_version_id` at start time. A
  version edit never changes an in-flight run's behavior.
- **WorkflowStepRun** — one step's execution record inside a run, including `agent_run_id` for
  AGENT steps (never `parent_run_id` — see below) so Live Operations can join back to the real
  `agent_runs` row.

## Step types

`AGENT`, `TOOL`, `CONDITION`, `DELAY`, `APPROVAL`, `CREATE_TASK`, `NOTIFY_INTERNAL`. This is the
complete list — `validateWorkflowSteps` rejects anything else, and Frost's own prompt
(`agents/frost_commander.md`) is written to only ever propose these seven.

## Triggers

`MANUAL`, `SCHEDULE` (`{frequency:'DAILY'|'WEEKLY', hour}`), `EVENT` (`{eventType}` — must be a
real, already-emitted event type from `EVENT_TYPES`, never invented).

## DAG execution model

Steps have `id`, `type`, `next:[]` (forward edges); `CONDITION` steps additionally have
`elseNext:[]`. `predecessorsOf(stepId, steps)` reverse-scans every `next`/`elseNext` to compute
predecessors. `validateWorkflowSteps` rejects cycles and dangling edges before a draft can even
be saved.

**AND-join with skip propagation**: a step becomes `READY` once all of its predecessors are
terminal and at least one is `COMPLETED`; it is `SKIPPED` if all predecessors are
`SKIPPED`/`CANCELLED`; otherwise it stays `WAITING`.

**Branch-aware skip**: for a `CONDITION` predecessor, `effectivePredecessorStatus()` checks
whether the specific edge taken (`next` = true-branch, `elseNext` = false-branch) matches the
condition's own stored boolean result. If it doesn't match, that edge counts as `SKIPPED` even
though the `CONDITION` step itself is `COMPLETED` — this is what makes true/false branches
mutually exclusive instead of both firing.

## Conditions (`src/runtime/workflow-conditions.js`)

Safe, declarative only — **no eval, no arbitrary JS**. Operators: `equals`, `not_equals`,
`greater_than`, `less_than`, `contains`, `exists`, `in`. Conditions combine via `all`/`any`
recursive combinators, validated by `validateCondition` before a workflow can be saved.

## Parallel-safety

`isSafeParallel = type==='CONDITION' || type==='AGENT'`. A ready batch of steps runs via
`Promise.all` only if *every* step in the batch is safe-parallel; otherwise the engine falls back
to one step at a time (`ready.slice(0,1)`). `CONFIGURATION`/`EXTERNAL_ACTION`-shaped work
(`TOOL`, `APPROVAL`, `CREATE_TASK`, `NOTIFY_INTERNAL`) is always sequential by default — this
mirrors the same classification `llmProvider.js`'s `runToolBatch()` already applies to same-turn
LLM tool_use blocks.

## DELAY — never sleeps the process

A `DELAY` step sets `next_execution_at` and returns immediately with the run in `WAITING` status.
The existing scheduler tick (`tickWorkflowsForTenant`) resumes it later by re-calling
`advanceWorkflowRun` — there is no `setTimeout`/blocking sleep anywhere in the engine.

## APPROVAL — the real Approval Engine, not a copy

An `APPROVAL` step creates a real `agent_approvals` row (`action_type='workflow_step_approval'`,
added to `ACTION_TYPES` in `approvals.js`) and pauses the run at `WAITING_APPROVAL`. It is
resumed by the exact same `POST /api/approvals/:id/decide` route every other approval in this
app uses; `application.js` detects an `agent_tool_send`-shaped approval whose `run_id` is
actually a `workflow_step_runs.id` and routes it to `resumeWorkflowApproval()` instead of
`agentRuntime.resumeToolApproval`.

## TOOL steps — same registry, same identity

`executeWorkflowToolStep()` is a second, thin call site for the same tool handler — it reuses
`canUseTool`, `resolveToolConnection`, and `createApproval` exactly like `runtime.js`'s own
`resumeToolApproval` already does independently for agent-run tool calls. Every workflow TOOL
step executes **as** the real `frost_commander` identity, at its real, existing permission level
— there is no separate "workflow" permission level.

## Cooperative cancellation — no fake hard-cancel

`requestCancelWorkflowRun` sets a `cancel_requested` flag, checked at the *top* of every
`advanceWorkflowRun` loop iteration, before any new step starts:

- A `WAITING` run (paused on a `DELAY`) cancels immediately and completely — all `PENDING` steps
  are also marked `CANCELLED` so nothing starts later.
- A `RUNNING` run (a step is actually executing right now, e.g. a live TOOL call) is left alone
  until its next natural advance-loop checkpoint. **There is no forced interruption of an
  in-flight external action** — see `docs/FROST_COMMAND_CANCELLATION.md`.

## Loop and delegation-depth protection

- **`MAX_AUTOMATION_DEPTH`** (default 5, env-configurable): an EVENT-triggered run carries
  `payload.__workflowDepth`; if starting it would exceed the limit, `startWorkflowRun` fails with
  a real audit entry (`WORKFLOW_LOOP_PROTECTION_TRIGGERED`) instead of silently looping forever.
- **`MAX_AGENT_DELEGATION_DEPTH`** is enforced *structurally*, not by a counter: the
  `delegate_to_agent` tool has `allowedAgents:['frost_commander']`, and none of its four delegate
  targets (performance/intelligence/leads/strategy) carry `delegate_to_agent` in their own tool
  list — a delegation chain deeper than 1 is architecturally impossible.

## Configurable limits (env, all optional — defaults shown)

| Env var | Default | Meaning |
|---|---|---|
| `MAX_WORKFLOW_STEPS` | 30 | Steps per workflow version |
| `MAX_PARALLEL_WORKFLOW_STEPS` | 5 | Fan-out branches from one step |
| `MAX_ACTIVE_WORKFLOWS_PER_TENANT` | 50 | Concurrently ACTIVE workflows per tenant |
| `MAX_AUTOMATION_DEPTH` | 5 | EVENT-triggered causation chain depth |

## Readiness before activation

`computeWorkflowReadiness(db, env, tenantId, version)` checks every `AGENT`/`TOOL` step's real
readiness (agent enabled, tool assigned, connection healthy — reusing
`evaluateAgentReadiness`/`evaluateAllToolsReadiness` from `agent-readiness.js`) and returns exact
block reasons; `activateWorkflow` refuses activation with a real 409 and the same block reasons
if `ready:false`. A tool restricted via `allowedAgents` to an agent not in the workflow's step
list is explicitly checked (not silently treated as "ready" by omission).

## HTTP surface

```
GET    /api/workflows/meta                     capabilities (step/trigger types, condition operators, event types)
GET    /api/workflows?status=                  list (any tenant member)
POST   /api/workflows                          create draft (owner/operator)
GET    /api/workflows/:id                      detail + active/draft version
PATCH  /api/workflows/:id                      update draft (owner/operator)
GET    /api/workflows/:id/readiness            block reasons
POST   /api/workflows/:id/activate             owner only
POST   /api/workflows/:id/pause                owner only
POST   /api/workflows/:id/resume               owner only
POST   /api/workflows/:id/archive              owner only
POST   /api/workflows/:id/run                  manual run (owner/operator)
GET    /api/workflows/:id/runs                 run history
GET    /api/workflow-runs/:id                  run + step detail
POST   /api/workflow-runs/:id/cancel           cooperative cancel (owner/operator)
```

Every route threads `session.tenantId`; every write is audited.

## Tests

`tests/workflow-engine.test.js` (14 tests: DAG validation, linear execution, readiness blocking,
CONDITION branching, DELAY pause/resume via scheduler tick, APPROVAL pause/resume/reject,
parallel AGENT AND-join, cancellation, versioning/pinning, tenant isolation, real EVENT trigger,
loop protection, SCHEDULE dedup, pause-blocks-start) and `tests/workflow-api.test.js` (7 HTTP
tests covering RBAC, activation readiness gating, manual run+cancel, tenant isolation, and a real
APPROVAL step decided through the actual `/api/approvals/:id/decide` route).

## Known limitation

Schedule dedup is computed from real `workflow_runs` history (`date(started_at)` /
`strftime('%Y-%W', started_at)`), not a cached "last fired" column — consistent with this
codebase's "derive, don't cache" discipline, but it means a tenant with an extremely large run
history pays a small query cost on every scheduler tick rather than an O(1) lookup.
