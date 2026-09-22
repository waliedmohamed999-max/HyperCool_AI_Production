# Control Center UI (Multi-Tenant Phase 4C-2)

> **Phase 6D update**: the Integrations tab is now explicitly catalog-driven — it groups provider
> cards by their real, live `category` (from `GET /api/control-center/summary`'s
> `integrations.providers`, itself sourced from `listIntegrationDefinitions(db)`, never a
> hardcoded per-provider list) and shows each provider's real capabilities/status. A `DRAFT`
> dynamic connector is filtered out server-side before it ever reaches this page; a `DISABLED`
> one shows an honest badge instead of vanishing. "Add Connection" for any connector outside the
> existing Salla/Anthropic/OpenAI flows now opens a real, working Generic Connection UI keyed off
> the connector's actual auth type, instead of the previous silent no-op. See
> `docs/INTEGRATION_MARKETPLACE.md`.

A real, tenant-scoped dashboard over the Phase 4B/4B.1/4C-1 backend — never a redesign or a
duplicate of it. No new business logic exists in the frontend; every number, badge, and status
shown here is read verbatim from real APIs.

## Route

`#control-center` (hash route, matching this app's existing SPA convention — there is no
server-side routing at all; every "page" is a `[data-page]` section toggled by
`public/app.js`'s `showPage()`). Registered in `public/components/layout/app-shell.js`'s
`ROUTE_ICONS` exactly like every other page. Visible in the sidebar only for `owner`/`operator`
(`#nav-control-center`, hidden by default, unhidden in `app.js`'s `render()` — same pattern as
the existing `#nav-users`). A `reviewer` who navigates to the hash directly still gets a real
403 from the backend (`GET /api/control-center/summary` is `authorize(session,['owner',
'operator'])`), never a silently-empty page.

Requires an authenticated session with a resolved active workspace, through the exact same
centralized resolution Phase 4C-1 already built (`application.js`'s per-request
`resolveTenantForUser` call) — this route adds no separate auth/tenant-resolution logic at
all. A multi-membership user with no active selection sees the existing Workspace Selection
gate (`docs/WORKSPACE_SELECTION.md`) before ever reaching this page, unchanged.

## Data source: one real aggregation endpoint

`GET /api/control-center/summary` (`src/runtime/control-center.js`, `authorize(session,
['owner','operator'])`) computes, live, on every call, from `session.tenantId` alone:

- **agents**: for all 12 real `AgentDefinition`s, `enabled` (same tenant-config-then-legacy-
  registry fallback `runtime.js` itself uses) and `status` from the real
  `evaluateAgentReadiness` (Phase 4B) — **never** `enabled=true => READY`. Counts:
  `total/enabled/ready/partial/blocked/disabled`.
- **tools**: the real `ToolDefinition` catalog count (`available`/`unavailable` — only Canva is
  honestly `unavailable`; `salla_syncOrders` is real), plus a live tally of every
  `ToolReadinessService` status (`evaluateAllToolsReadiness`, Phase 4B.1) across all 12 agents
  — this is what "how many tool assignments have a capability/connection problem right now"
  actually means, since readiness is inherently per-`(agent, tool)`, not tool-global.
- **integrations**: the real `IntegrationDefinition` catalog joined with this tenant's real
  `IntegrationConnection` rows, carrying the honest `connectionMode` (`MULTI`/`SINGLE`/
  `UNAVAILABLE` — Phase 4B.1's `connectionModeFor`).
- **aiProviders**: this tenant's real Anthropic/OpenAI connections, each with the real list of
  agent ids whose `TenantAgentConfig.ai_connection_id` points at it (never a fabricated "usage"
  metric).
- **workspace**: the real `Tenant` row's safe fields (name/slug/locale/timezone/status/AI
  defaults/safety ceiling) plus the caller's own role.

One call, reused by all six tabs — never N+1 fetches from the browser for the overview itself
(Phase 4B's own "avoid N+1" principle). Drill-down drawers (agent detail, tool's compatible-
connections list) make their own real, on-demand calls only when actually opened.

## Tabs

1. **Overview** — real KPI cards (connected/unhealthy connections, agents ready/partial/
   blocked, configured AI providers, tools available) plus a **Needs Attention** list, each row
   traced to a real blocked agent, a real optional-tool gap, or a real unhealthy connection —
   never invented — each clickable to jump to the relevant tab/drawer.
2. **Integrations** — one card per real `IntegrationDefinition`, honest `connectionMode` badge,
   real per-provider connection list. "Add" is offered **only** where the backend genuinely
   supports it today: Salla (real multi-store OAuth, `GET /api/integrations/oauth/salla/start`)
   and Anthropic/OpenAI (real test-then-store API-key flow, `PUT /api/integrations/connections/
   :id/credential`). A `SINGLE`-mode provider with an existing connection shows
   "يدعم اتصالًا واحدًا حاليًا" / "Supports one connection currently", never an "Add another"
   button; Canva shows "غير متاح حاليًا" / "Unavailable", never a connect flow.
3. **AI Providers** — real Anthropic/OpenAI connections for this tenant, with the real agents
   using each (via `TenantAgentConfig`).
4. **Agent Connections** — all 12 real agents, filterable/searchable by real readiness status,
   opening a drawer with **Overview** (enable toggle, readiness, blockers/warnings),
   **AI Model** (`PATCH /api/agents/:id/config` — connection/model/temperature/max tokens/
   timeout, options limited to this tenant's own AI connections, never a foreign one),
   **Tools** (`GET /api/agents/:id/tools`, `PUT/DELETE /api/agents/:id/tools/:toolId` — a
   connection selector fed **only** from `GET /api/tools/:slug/connections`, which is already
   tenant+provider filtered server-side; a `capabilityGranted:false` option is shown but
   disabled with a "صلاحية ناقصة" hint rather than hidden, per Phase 4B.1), and **Readiness**
   (the full real `evaluateAgentReadiness` breakdown).
5. **Health & Readiness** — one real table of every connection's real status (all 8 real
   `IntegrationConnection.status` values — `CONNECTED/DEGRADED/ERROR/TOKEN_EXPIRED/
   PERMISSION_MISSING/DISCONNECTED/CONNECTING/NOT_CONFIGURED` — never collapsed to
   Online/Offline), and one real table of every agent's readiness.
6. **Workspace Settings** — the real, read-only `Tenant` fields already returned by the summary
   endpoint. No new update API was added for this tab (Part 52's explicit allowance) — the
   existing `PATCH /api/tenant/ai-default` / `PATCH /api/tenant/safety-ceiling` routes remain
   the way to change those two fields, from the Agent/AI drawers where they're already wired.

## Backend-authoritative validation

Every mutation (agent config PATCH, tool assignment PUT/DELETE, connection create/credential/
test/disconnect/set-default) is a direct call to the real Phase 4B/4A endpoint — this UI adds
no client-side authority. A `CONNECTION_PROVIDER_MISMATCH`/`CONNECTION_CAPABILITY_MISSING`
rejection from the backend is caught and shown as a localized, specific toast
(`localizeAssignmentError`) rather than a raw error string, but the backend's decision is never
second-guessed or bypassed client-side.

## Workspace switching

Control Center holds no state of its own across a switch: `renderControlCenter()` is called
fresh, from scratch, as part of `app.js`'s existing full `render()` cycle — the same cycle that
already re-runs completely after `PUT /api/workspaces/active` (Phase 4C-1). There is no
separate cache to invalidate (confirmed by test: `control-center.test.js`'s workspace-switch
test asserts the summary's `integrations.configuredProviders` and `workspace.id` both change
correctly across a real switch, reading actual response bodies, not just status codes).

**Async race guard**: a local `renderGeneration` counter is incremented at the start of every
`renderControlCenter()` call; if a slower, now-superseded fetch resolves after a newer render
already started (e.g., two rapid workspace switches), its result is discarded rather than
painted over the current workspace's DOM (Part 55).

## Security boundary

- The summary endpoint's only tenant input is `session.tenantId` — never a request
  body/query/header value (verified: `docs/WORKSPACE_SELECTION.md`'s spoofing tests already
  cover this centralized resolution point; the Control Center adds no second one).
- Verified by test that the summary response never contains a token, API key, secret, or
  vault payload string.
- The AI-connection "Add" form clears its password-type input immediately after reading it for
  the one synchronous submit call; the key is never persisted in any JS variable beyond that.
- A tool's connection selector only ever lists connections `GET /api/tools/:slug/connections`
  already scoped to this tenant + the tool's exact provider — the frontend cannot present a
  foreign-tenant or wrong-provider connection as an option even by construction.

## Provider limitation truthfulness (Phase 4B.1 truth, unchanged)

| Provider | Mode shown | "Add" offered |
|---|---|---|
| Salla | Multiple connections | Yes — real OAuth |
| Anthropic / OpenAI | Multiple connections | Yes — real API-key flow |
| WhatsApp / Meta / Microsoft 365 / X / LinkedIn | Single connection | No — manage existing only |
| Canva | Unavailable | No — no connect flow shown at all |

## Deferred / simplified in this pass

- A dedicated **Credentials** sub-tab (rotate/replace/expiry detail) was not built as a
  separate drawer tab: no `GET` endpoint currently returns vault credential metadata outside a
  `PUT .../credential` response, and adding one purely for display was judged unnecessary
  scope for this pass — connection `status`/`lastHealthCheck`/`lastErrorMessageSafe` (already
  real, already shown) cover the practical "is this connection usable" question today.
- A separate **Capabilities matrix** sub-tab was folded into the Tools tab's per-tool
  `capabilityGranted` indicator on the connection selector, rather than a standalone view —
  the same real fact, shown where it's actionable.
- **Activity/Usage** history per connection was not built (would require a new query surface
  over `agent_tool_calls` filtered by `connection_id`, not requested elsewhere in this phase and
  not free to add safely in the remaining scope).
- Workspace Invitations / Member Management: explicitly out of scope for this phase (Phase
  4C-3, per this phase's own instructions) — not built, not referenced.
- Tenant creation / onboarding UI: not built in this phase — see Phase 4C-4 update below.

## Phase 4C-4 update: Guided Workspace Onboarding attention item

The Overview tab's "Needs Attention" list now includes one real row when this workspace's
guided setup (`#onboarding`, `GET /api/onboarding`) is not yet `COMPLETED` — same pattern as
every other attention item here (a real blocked agent, a real unhealthy connection), jumping
straight to the wizard. See `docs/WORKSPACE_ONBOARDING.md` for the full wizard design; it is a
separate page reusing this page's own summary endpoint and existing Add-Connection flows,
adding no new business logic.

## A real, severe bug this phase's audit found and fixed (pre-existing, from Phase 4C-1)

This app has **no general static file server** — `application.js` serves only files explicitly
listed in a `files` whitelist object. Phase 4C-1 added `public/components/workspace-switcher.js`
and `public/locales/{ar,en}/workspace.json` but never added them to this whitelist, so both
404'd in the real server. Since `app.js` statically imports the switcher module, this 404 threw
during module evaluation and **silently broke the entire frontend for every user** — nothing
in `#protected` ever rendered, and this was invisible to the previous phase's own testing
because that testing exercised the backend (real HTTP `fetch` calls, which don't execute
`<script type=module>` imports) rather than a real browser. Caught here via this phase's
pre-flight `npm run test:ui` smoke run. Fixed by adding the two missing entries to the
whitelist (`src/application.js`); re-verified with a full real-browser Playwright run (login →
dashboard → Control Center → all 6 tabs → agent drawer → workspace switch), zero console/page
errors.

## Phase 4C-3 update: Team (Members + Invitations) + a second real bug this phase's own real-browser testing found

Workspace Settings now includes a **Team** section (owner only) — see
`docs/WORKSPACE_INVITATIONS.md` / `docs/WORKSPACE_MEMBERS.md`.

Building and testing it (by actually clicking Save, not just loading pages) surfaced a second
real, severe bug from Phase 4C-2 itself: `app.js`'s shared `api(path, body)` helper only ever
sends `GET` (no body) or `POST` (with a body) — it has no way to request `PATCH`/`PUT`/`DELETE`.
Every Phase 4C-2 call that needed one of those (agent config `PATCH`, tool assignment `PUT`,
connection credential `PUT`) was silently sending `POST` instead, which the backend's exact-
method route matching correctly rejected with a `404` — meaning **every "Save" action in the
Agent Connections drawer built in Phase 4C-2 was actually broken**, invisible to that phase's
own testing because it only verified pages *loaded*, never that a save *persisted*. Fixed by
giving `api()` an optional third `method` argument (every 2-argument call site keeps its exact
original behavior) and, separately, fixing `control-center.js`'s own internal `api()` pass-
through wrapper, which was dropping that same third argument before forwarding to the real one
— a second copy of the identical bug. Re-verified with a real Playwright run that actually
fills a field, clicks Save, confirms the network request is a `200` on the correct method, and
re-opens the drawer after a reload to confirm the value persisted.
