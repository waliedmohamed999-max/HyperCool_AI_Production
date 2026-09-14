# Workflow Run Cancellation — Cooperative, Never Fake (Phase 7C)

`requestCancelWorkflowRun` in `src/runtime/workflow-engine.js`.

## The honesty rule

A "Cancel" button in software can lie in one of two ways: it can silently do nothing while
claiming success, or it can forcibly kill an in-flight external action (an already-sent WhatsApp
message, a half-written CRM update) leaving the outside world in an inconsistent state that the
UI doesn't know about. This engine does neither. Cancellation here is **cooperative**: it tells
the run to stop *before its next step*, and is explicit about what it can and cannot undo.

## How it works

`requestCancelWorkflowRun(db, runId, user, tenantId)` sets a `cancel_requested=1` flag on the
`workflow_runs` row and writes a real audit entry. That flag is checked at the **top** of every
`advanceWorkflowRun` loop iteration — i.e. before any new step is allowed to start.

| Run state when cancel is requested | What happens |
|---|---|
| `WAITING` (paused on a `DELAY` step) | Cancels **immediately and completely** — no external work was in flight. All still-`PENDING` steps are also marked `CANCELLED` so nothing starts later, even if the scheduler tick fires again. |
| `WAITING_APPROVAL` | Same as above — nothing was executing, only waiting on a human decision. |
| `RUNNING` (a step, e.g. a live TOOL call, is genuinely executing right now) | **Left alone until its natural checkpoint.** The engine does not attempt to abort an in-flight `fetch`/tool call. Once that step finishes (success or failure), the *next* `advanceWorkflowRun` iteration sees `cancel_requested` and stops before starting anything new. |

This is the same trade-off this codebase already makes everywhere else external actions are
involved (see `resumeToolApproval` in `runtime.js` — an approved tool call is never partially
aborted mid-flight either). It is "no fake hard-cancel," not "no cancel."

## What the UI shows

The Workflow Builder's run detail table marks a run cancellable
(`['PENDING','RUNNING','WAITING','WAITING_APPROVAL','CANCEL_REQUESTED'].includes(status)`) and
calls `POST /api/workflow-runs/:id/cancel`. Command Center's Live Operations feed shows the same
`cancellable` flag (computed server-side in `/api/command/operations`) on workflow-run rows, so a
user never sees a cancel affordance for a run that has already reached a terminal state.

## Verified behavior (tests)

- `tests/workflow-engine.test.js`: a `WAITING` (DELAY) run cancels immediately; no `PENDING` step
  is ever left to run later; the run's final status is genuinely `CANCELLED`, not `COMPLETED`.
- `tests/e2e/command-center-journey.e2e.mjs` (Cancel E2E, spec item 89): drives a real DELAY
  workflow through the actual Workflow Builder UI — "شغّل الآن" (Run Now) → confirms `WAITING` via
  a real DB read → clicks "إيقاف التشغيلة" (cancel) → confirms via direct DB query that
  `workflow_runs.status='CANCELLED'` and that no step ever reached `COMPLETED` after the cancel.

## Known limitation

If a `RUNNING` step is a genuinely long-lived external call (e.g. a slow third-party API), the
run stays cancellable-in-name but not cancellable-in-fact until that call resolves one way or
the other. There is no timeout-based forced abort — adding one would mean guessing whether a
still-pending external side effect actually happened, which this codebase's own "never simulate
success, never guess an outcome" discipline (see `STATUS_UNKNOWN` handling in the X/LinkedIn
publishing connectors) explicitly rules out.
