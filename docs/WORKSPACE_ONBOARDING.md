# Workspace Onboarding (Multi-Tenant Phase 4C-4)

A guided wizard that helps the Owner of an **existing** workspace finish configuring it from
inside the dashboard, with no code or database edits. This phase never creates a new tenant,
never adds an email field, and never depends on a platform email service — see
[`docs/TENANT_SECURITY_MODEL.md`](TENANT_SECURITY_MODEL.md) for why this codebase's identity
model is username-only.

## What this phase deliberately does NOT build

- **No email verification of any kind.** `users` has no email column; nothing here adds one.
- **No claim that invitations are "verified by email."** Phase 4C-3's invitations remain
  authorized purely by possession of a secure, hashed, single-use bearer token — unchanged.
- **No automated email delivery.** There is no real platform email service; this phase adds
  none.
- **No New Company / New Tenant creation flow.** `createTenant()` (Phase 3.5) already exists
  and is reused as-is; nothing here calls it or exposes a route that would.
- **No Customer Self-Service Signup.** Every user reaching this wizard is already an
  authenticated member of the workspace being configured.

## Route

`#onboarding` (hash route, registered in `public/components/layout/app-shell.js`'s
`ROUTE_ICONS` exactly like `#control-center`). Visible in the sidebar only for `owner`/
`operator` (`#nav-onboarding`, same visibility rule and same 403-on-direct-navigation behavior
as Control Center — the backend's `authorize(session,['owner','operator'])` is the real gate,
not the hidden nav link). A `reviewer` gets a real 403 from every onboarding route.

## Data model: `workspace_onboarding` (one new, tiny table)

```sql
CREATE TABLE workspace_onboarding (
 tenant_id TEXT PRIMARY KEY,
 current_step TEXT NOT NULL DEFAULT 'company',
 skipped_steps TEXT NOT NULL DEFAULT '[]',
 started_at TEXT NOT NULL,
 completed_at TEXT,
 updated_at TEXT NOT NULL
);
```

This table stores **only** the three things that have no other real source: which step the
owner is currently on, which optional steps were explicitly skipped, and the start/completion
timestamps. It never stores a step's actual READY/NOT_STARTED state — that would be exactly the
kind of client-assertable flag this codebase's entire Phase 4B/4B.1/4C-2 effort was built to
avoid ("never `enabled=true => READY`"). A row is created lazily, only on the first real mutation
(`updateOnboardingState`) — a plain `GET /api/onboarding` on a workspace that never opened the
wizard returns a computed `NOT_STARTED` view without ever writing a row (verified by test).

## Steps and how each one's state is derived (never a stored checkbox)

| Step | Required? | Derived from |
|---|---|---|
| `company` | No | Always `READY` — informational display of the real `Tenant` row only |
| `ai` | **Yes** | `READY` iff this tenant has a real `CONNECTED` Anthropic/OpenAI connection (`buildControlCenterSummary`'s `aiProviders`) |
| `commerce` | No, skippable | `READY` iff a healthy (`CONNECTED`/`DEGRADED`) Salla connection exists |
| `messaging` | No, skippable | `READY` iff any of WhatsApp/Meta/X/LinkedIn has a healthy connection |
| `productivity` | No, skippable | `READY` iff Microsoft 365 has a healthy connection |
| `agents` | No | Informational only — shows the real `agents.ready` count from Control Center's summary; never blocks |
| `safety` | No | Always `READY` — a real, read-only snapshot (see below) |
| `systemCheck` | No | Always `READY` — the finish action itself is what's gated |

**Only `ai` is genuinely required.** This is not an invented gate: every one of the 12 real
agents' own readiness already hard-depends on a configured AI provider
(`AI_NOT_CONFIGURED` in `agent-readiness.js`) — the wizard just surfaces that same real
dependency as a named step instead of inventing a new rule.

`POST`/`PATCH complete:true` is **rejected server-side with 409** if the `ai` step is not
genuinely `READY` at the moment of the call — the frontend cannot mark onboarding complete by
asserting it; `updateOnboardingState` recomputes every step live before deciding (see
`src/onboarding.js`, `canComplete`).

A skipped optional step automatically returns to `READY` the moment a real healthy connection
appears for it — `skipped_steps` never overrides a real positive signal, only supplies a status
for as long as nothing real exists yet (verified by test:
"a skipped optional step becomes READY again automatically").

## API

- `GET /api/onboarding` — `owner`/`operator`. Returns `{status, currentStep, steps[], startedAt,
  completedAt}`, `status` one of `NOT_STARTED`/`IN_PROGRESS`/`COMPLETED`.
- `PATCH /api/onboarding` — **owner only**. Body may include any of `currentStep`, `skipStep`,
  `unskipStep`, `complete:true`, `reopen:true`. Every field is validated and re-derives state
  before acting; returns the same shape as `GET`.
- `GET /api/onboarding/safety` — `owner`/`operator`. Real, read-only snapshot: each agent's
  current autonomy level (all `L0` for a fresh tenant — the safe default, never changed by this
  wizard), the tenant's `maxAgentLevel` safety ceiling, and every production-safety feature flag
  from `runtime/feature-flags.js` (`ENABLE_EXTERNAL_MESSAGING`, `ENABLE_EXTERNAL_PUBLISHING`,
  `ENABLE_AUTOMATED_FOLLOWUPS`, `ENABLE_SCHEDULED_PUBLISHING`, `ENABLE_L2_AUTONOMY`,
  `ENABLE_L3_AUTONOMY`) read straight from `env`, exactly as they actually are.
- `POST /api/onboarding/preset` — **owner only**. `{aiConnectionId, agentIds?}`. For every
  targeted agent (default: all 12) that has **no existing** `aiConnectionId` override, assigns
  the given connection via the same, already-audited `updateTenantAgentConfig` used everywhere
  else. Never overrides an agent's prior explicit choice, never changes autonomy level, never
  enables an external send/publish tool. `aiConnectionId` is validated to belong to the caller's
  own tenant and be a real AI-provider connection (`validateAiConnection`, pre-existing) — a
  connection id from another tenant is rejected with 400, never leaked or attachable.

No new endpoint was added for adding an AI/Salla connection: the wizard's "AI provider" and
"Commerce" steps call the exact same `POST /api/integrations/connections` +
`PUT .../credential` / `GET /api/integrations/oauth/salla/start` routes Phase 4C-2's Control
Center already uses — this page adds no new business logic, only a guided view over what
already exists and is already tested.

## Frontend

`public/pages/onboarding.js` (+ `public/locales/{ar,en}/onboarding.json`). A step rail built
with the existing `tabs()` UI primitive (same component Control Center's tab bar and agent
drawer already use) — each tab's label carries the step's real, live state
(`READY`/`NOT_STARTED`/`SKIPPED`) read straight from `GET /api/onboarding`, never a locally
tracked flag. Reopening the page (including after a full reload) re-fetches and resumes exactly
where the real state says the workspace is — there is no "wizard progress" cached anywhere in
the browser.

Only the **owner**'s tab clicks persist `currentStep` server-side (`PATCH
{currentStep}`, best-effort/fire-and-forget); an **operator** can browse every step read-only
without ever calling the owner-only `PATCH` route (matches `docs/WORKSPACE_INVITATIONS.md`'s
existing RBAC bar for workspace-level settings).

**Control Center integration**: `renderControlCenter()` now also fetches `GET /api/onboarding`
alongside its existing summary call and, if `status!=='COMPLETED'`, adds one real "Needs
Attention" row ("لم يكتمل الإعداد الموجّه لهذه المنشأة بعد") that jumps straight to `#onboarding`
— the same pattern already used for every other real attention item (blocked agent, unhealthy
connection), never a separate invented banner system.

## Audit events

`WORKSPACE_ONBOARDING_STARTED` (first mutation ever on a tenant), `WORKSPACE_ONBOARDING_
STEP_COMPLETED` (leaving a step that was genuinely `READY`), `WORKSPACE_ONBOARDING_
STEP_SKIPPED`, `WORKSPACE_ONBOARDING_COMPLETED`, `WORKSPACE_ONBOARDING_REOPENED`,
`WORKSPACE_ONBOARDING_PRESET_APPLIED` — all tenant-scoped via the existing `recordAudit(db,
entry, tenantId)`, visible in the existing Operations Log.

## Security boundary

- Every route resolves `tenantId` exclusively from `session.tenantId` (the existing centralized,
  spoofing-tested resolution from Phase 4C-1) — never from a request body/query/header value.
- `PATCH /api/onboarding` and `POST /api/onboarding/preset` are owner-only; `GET` routes accept
  `owner`/`operator`; a `reviewer` is refused entirely (403) — verified by test.
- A suspended tenant is unreachable through the exact same fail-closed resolution every other
  route already uses — no separate suspension check was added or could be bypassed here.
- `applyRecommendedPreset` rejects a connection id belonging to a different tenant (400) —
  verified by test (`Preset rejects a connection from another tenant`) — so this endpoint can
  never be used to attach a foreign tenant's AI credential to this tenant's agents.
- `reopen:true` only clears `completed_at`; it never resets or deletes any connection, credential,
  agent config, or skip history (verified by test).

## Tests

`tests/workspace-onboarding.test.js` (13 tests, real HTTP against a real isolated SQLite DB,
same harness pattern as `control-center.test.js`/`workspace-invitations.test.js`): NOT_STARTED
never persists a row on GET, derived (never stored) status for the AI step, the required-AI
completion blocker, optional skip/unskip and its auto-recovery to READY, reopen without any
side-effects on real data, full cross-tenant isolation (including a second tenant completing
its own onboarding never affecting the first), RBAC for owner/operator/reviewer, invalid step
id and unskippable-required-step rejection, the recommended preset's "never override an
existing choice" and cross-tenant-connection-rejection behavior, the real safety snapshot, and
suspended-tenant unreachability.

A real-browser Playwright journey (run during this phase's own QA, not committed as a permanent
script — see `docs/CONTROL_CENTER_UI.md`'s existing note on why some journeys are exercised via
a temporary script rather than the long-running `scripts/ui-qa.mjs`) exercised the entire flow
end-to-end against the real backend with a stubbed-only-at-the-network-boundary Anthropic test
call (never a fake status stored client-side): login → open the wizard → add a real AI
connection through the real form → confirm the AI step turns `READY` from the server's own
response, not a locally-set flag → apply the recommended preset → skip Commerce → finish → the
completion banner appears → reload → the completion persists → Control Center's attention item
for onboarding disappears. Zero console/page errors.
