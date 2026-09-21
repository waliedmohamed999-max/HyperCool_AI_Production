# Frost merchant portal (`/client`)

A separate product surface for merchants/customers, built ON TOP of the platform's existing multi-tenant foundation
(tenants, tenant_memberships, agent_registry, tenant_agent_configs, agent_runs, agent_approvals, integration_connections +
credentials vault, audit). It does not duplicate any of them and adds no second authentication system.

Three domains, never mixed: **Platform admin** (`/app`, incl. `#customers`), **Merchant portal** (`/client`), **Partner portal** (`/partners`).
A person can be a partner and a merchant; each domain resolves its own context from the server session.

## Code map

| Area | Files |
|---|---|
| Domain | `src/client/{core,schema,catalog,plans,agents,accounts,tasks,support,context,views,workflows,oauth,admin,index}.js` |
| HTTP | `src/client/routes.js` → `/api/client/*` (merchant), `/api/client-admin/*` (platform admins) |
| OAuth providers (shared) | `src/integrations/oauth-providers.js` (adapts the existing `src/runtime/*-oauth.js`) |
| Access policy | `src/security/route-policy.js` (every `/api` route, default deny), `src/runtime/credential-policy.js` |
| Merchant SPA | `public/client.html`, `public/client-portal/*` (reuses `partner-portal/{ui,api,i18n}.js`, adds its own dictionary) |
| Admin page | `public/pages/customers.js`, hash `#customers`, locale domain `customers` |
| Tests | `tests/client-{core,portal,oauth,workflows,migrations}.test.js`, `tests/api-isolation.test.js`, `tests/route-policy.test.js`, `tests/dev-safety.test.js`, `tests/e2e/client-portal-journey.e2e.mjs` |

## Routes

Merchant pages (all serve `client.html`): `/client`, `/client/login|register|verify-email/:token|invite/:token|onboarding|dashboard|agents|agents/:id|tasks|workflows|approvals|integrations|analytics|team|notifications|billing|settings|support`.
Login uses the platform's own `POST /api/login`. Admin: `/app#customers` (Overview, Customers, Applications, Workspaces, Plans, Agents, Permissions, Usage, Integrations, Support sessions, Audit logs, Settings).

## Tenant isolation

* The workspace is derived on the server from the caller's `client_members` rows (`resolveClientContext`); a tenant id in a body, query or header is never read.
* Every table row and every query carries `tenant_id`; ids of other tenants answer 404.
* Merchant-only accounts cannot reach the legacy workspace API at all (`MERCHANT_USE_CLIENT_PORTAL`): the merchant gate is driven by `src/security/route-policy.js`. This is a second layer — each legacy route is also correct on its own (next section).
* Credentials go through the existing vault (AES-256-GCM, `INTEGRATION_ENCRYPTION_KEY`); keys are tested before saving and never returned.
* **Credentials never cross workspaces.** Static tokens in the server environment (`SALLA_ACCESS_TOKEN`, `META_ACCESS_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `MICROSOFT_ACCESS_TOKEN`, `X_BEARER_TOKEN`, `LINKEDIN_ACCESS_TOKEN`, …) belong to the operator's own (default) workspace only (`src/runtime/credential-policy.js`). Every resolver, health test, readiness check and status display is given the tenant id; another workspace without its own connection sees "not connected", it never acts through the operator's page/mailbox/store.

## Merchant OAuth

Routes (all under the merchant session, `integrations.manage`, the `client.integrations` entitlement and a writable account):

```text
POST /api/client/integrations/:provider/connect      -> {authorizeUrl}     (never a redirect: needs CSRF)
GET  /api/client/integrations/:provider/callback     <- the provider's redirect
GET  /api/client/integrations/:provider/status       tokens are never included
POST /api/client/integrations/:provider/disconnect   {connectionId?} (needed when a provider has several stores)
```

`:provider` is one of `salla, zid, meta, microsoft365, x, linkedin` (WhatsApp is the WhatsApp side of the Meta login). The exchange, the token storage and the encryption are the existing provider modules and stores; `src/integrations/oauth-providers.js` only adapts them.

* **State**: `token.signature`. The token is 192 random bits stored **hashed** in `oauth_states` with the workspace, the initiating user, the provider, an optional connection to reconnect, the AES-encrypted PKCE verifier, a 10-minute expiry and single use. The signature is an HMAC over (token, tenant, user, provider) keyed from `INTEGRATION_ENCRYPTION_KEY` and is verified **before** the state is consumed.
* **Tenant binding**: the tenant and the person come from the session at *start* and are stored server side; the callback never reads a tenant from the request. A state cannot be pointed at another workspace, a foreign connection id answers 404, and when a session cookie does arrive with the callback it must belong to the initiating person (checked before the state is consumed, so somebody else's browser cannot burn it).
* **No session on the callback**: the provider sends the browser back cross-site, so the `SameSite=Strict` session cookie is not sent (and `Sec-Fetch-Site: cross-site` would be refused). The callback is therefore an explicit, narrow exception in the cross-site guard for `GET /api/client/integrations/<provider>/callback` navigations only; its authority is the signed state. It re-authorizes the person named by the state (still an active member holding `integrations.manage`, workspace still writable, plan still includes integrations).
* **Verification**: the token is verified against the provider (Salla product call with the merchant's own token; Zid store profile; Microsoft/X/LinkedIn profile calls; Meta must expose a Page or a WhatsApp account) **before** anything is stored, then the stored connection is health-checked again. A failure reports a clear reason and leaves nothing behind (no connection row, no credential). A new connection that fails the post-check is rolled back.
* **Refresh**: refresh tokens are stored encrypted and honoured (Salla/Zid/X/Microsoft, and now LinkedIn when LinkedIn issued one). Meta long-lived tokens have no refresh token: an expired one shows `reauthorize`.
* **Errors** go back to `/client/integrations?oauth=error&provider=…&reason=…` (`state_invalid|state_used|state_expired|denied|not_permitted|account_blocked|provider_error|verification_failed|limit_reached|session_mismatch`) and success to `?oauth=success`; the page renders a clear message either way.
* **Audit** (`client_audit_logs`): `CLIENT_INTEGRATION_OAUTH_STARTED`, `…_CONNECTED`, `…_RECONNECTED`, `…_DISCONNECTED`, `…_OAUTH_FAILED` (reason + safe code; never a token).
* **Permission**: `integrations.manage` (owner, admin and manager roles, not a hard-coded owner). Support sessions can never start a flow (`SUPPORT_FORBIDDEN:oauth_connect`); view-only sessions cannot disconnect either.
* **Availability is honest**: `GET /api/client/integrations` returns `availability.state` = `available | unavailable | coming_soon` with the reason (`provider_not_configured`, `encryption_key_missing`, `https_required`, `not_implemented`). The page renders a connect button only for `available`.
* **Disconnect** deletes the vault credential / `integration_credentials` row and marks the connection `DISCONNECTED`; agents can no longer resolve a token.

Redirect URIs to register in each provider's console (one per provider, using the production `PUBLIC_ORIGIN`):

```text
{PUBLIC_ORIGIN}/api/client/integrations/salla/callback
{PUBLIC_ORIGIN}/api/client/integrations/zid/callback
{PUBLIC_ORIGIN}/api/client/integrations/meta/callback
{PUBLIC_ORIGIN}/api/client/integrations/microsoft365/callback
{PUBLIC_ORIGIN}/api/client/integrations/x/callback
{PUBLIC_ORIGIN}/api/client/integrations/linkedin/callback
```

The provider app credentials are the ones the dashboard flow already uses (`SALLA_CLIENT_ID/SECRET`, `ZID_…`, `META_APP_ID/SECRET`, `MICROSOFT_CLIENT_ID/SECRET`, `X_CLIENT_ID/SECRET`, `LINKEDIN_CLIENT_ID/SECRET`); the deployment-wide `*_REDIRECT_URI` values are not used by the merchant flow.

## Legacy `/api` review (authorization per route)

Every route declared in `src/application.js` has an explicit access class in `src/security/route-policy.js`; a path that is not listed is refused (default deny) and `tests/route-policy.test.js` fails when a route is added without an entry. The table below is generated from that file (`node scripts/route-policy-table.mjs --write`) and checked by the test suite.

<!-- route-policy:start -->
| Route group | Routes | Access class | Workspace roles accepted (union over methods) |
|---|---:|---|---|
| `/api/account/…` | 3 | authenticated_user | — |
| `/api/account/…` | 1 | public | — |
| `/api/agent-connection-map/…` | 1 | workspace_member | owner, operator |
| `/api/agents/…` | 12 | workspace_member | owner, operator |
| `/api/agents/…` | 2 | platform_operator | owner |
| `/api/ai/…` | 2 | workspace_member | owner, operator |
| `/api/approvals/…` | 2 | workspace_member | owner |
| `/api/auth/…` | 3 | public | — |
| `/api/automation/…` | 3 | internal | — |
| `/api/brief/…` | 1 | workspace_member | owner |
| `/api/calendar/…` | 1 | workspace_member | owner, operator |
| `/api/client-admin/…` | 1 | platform_admin | — |
| `/api/client/…` | 1 | merchant | — |
| `/api/command/…` | 32 | workspace_member | owner, operator |
| `/api/connections/…` | 1 | platform_operator | — |
| `/api/content/…` | 5 | workspace_member | owner, operator, reviewer |
| `/api/control-center/…` | 1 | workspace_member | owner, operator |
| `/api/crm/…` | 9 | workspace_member | owner, operator |
| `/api/escalations/…` | 2 | workspace_member | owner |
| `/api/frost/…` | 2 | workspace_member | any member |
| `/api/frost/…` | 3 | platform_operator | owner |
| `/api/integrations/…` | 4 | workspace_member | owner, operator |
| `/api/integrations/<provider>/… (legacy per-provider OAuth)` | 21 | workspace_member | owner, operator |
| `/api/integrations/connections/…` | 24 | workspace_member | owner, operator |
| `/api/integrations/custom-connectors/…` | 7 | workspace_member | owner |
| `/api/integrations/oauth/…` | 2 | workspace_member | owner |
| `/api/invitations/…` | 1 | authenticated_user | — |
| `/api/invitations/…` | 2 | public | — |
| `/api/login/…` | 1 | public | — |
| `/api/logout/…` | 1 | public | — |
| `/api/marketing/…` | 28 | workspace_member | owner, operator |
| `/api/memory/…` | 4 | workspace_member | owner, operator |
| `/api/onboarding/…` | 3 | workspace_member | owner, operator |
| `/api/partners/…` | 1 | platform_admin | — |
| `/api/partners/…` | 1 | partner | — |
| `/api/planning/…` | 1 | workspace_member | any member |
| `/api/platform/…` | 42 | platform_admin | — |
| `/api/preferences/…` | 1 | authenticated_user | — |
| `/api/products/…` | 1 | workspace_member | any member |
| `/api/public/…` | 1 | public | — |
| `/api/reports/…` | 3 | workspace_member | owner |
| `/api/salla/…` | 1 | workspace_member | owner |
| `/api/schedule/…` | 3 | workspace_member | owner |
| `/api/setup/…` | 1 | public | — |
| `/api/signup/…` | 1 | public | — |
| `/api/state/…` | 1 | workspace_member | any member |
| `/api/team/…` | 1 | workspace_member | owner |
| `/api/tenant/…` | 2 | workspace_member | owner |
| `/api/tool-compatibility/…` | 1 | workspace_member | owner, operator |
| `/api/tools/…` | 2 | workspace_member | owner, operator |
| `/api/users/…` | 2 | workspace_member | owner |
| `/api/webhooks/…` | 2 | workspace_member | owner |
| `/api/webhooks/…` | 6 | webhook | — |
| `/api/whatsapp/…` | 2 | workspace_member | owner, operator |
| `/api/workflow-runs/…` | 2 | workspace_member | owner, operator |
| `/api/workflows/…` | 10 | workspace_member | owner, operator |
| `/api/workspaces/…` | 3 | authenticated_user | — |
| `/api/workspaces/…` | 5 | workspace_member | owner |
| `/health*` | 3 | public | — |

| Access class | Protection applied |
|---|---|
| public | No session. Abuse controls where relevant: per-IP rate limits, single-use hashed tokens, widget origin allow-list, no account enumeration. |
| webhook | Not a session route: the caller is authenticated by its own signature/secret; the tenant is resolved from the verified external id, never from the payload. |
| internal | Shared automation token (`x-hypercool-token`); iterates every eligible tenant itself. |
| authenticated_user | Session (+ CSRF for writes). Acts on the caller's own account or invitation only. The only authenticated routes a merchant-only account may reach. |
| workspace_member | Session + CSRF (writes) + active membership of the workspace; the **role held in that workspace** (not the account-wide `users.role`) is checked per method by the handler; every query is scoped by the server-resolved `tenant_id`; another workspace's id answers 404. Closed to merchant-only accounts (`MERCHANT_USE_CLIENT_PORTAL`). |
| platform_operator | Platform-global state: platform admin (`PLATFORM_ADMIN_USERNAMES`) or the owner of the operator's own (default) workspace, checked centrally before the handler, plus the handler's own role check. |
| platform_admin | Allow-listed platform administrators only (`PLATFORM_ADMIN_USERNAMES`), checked centrally before the handler. |
| partner | Own module (`src/partners/routes.js`): public application/config routes, partner session routes, and staff routes under `/admin/`. |
| merchant | Own module (`src/client/routes.js`): tenant from `client_members` or a validated support session; permission + plan entitlement + account state per route; support mode read-only server side. |
<!-- route-policy:end -->

The per-method role requirement stays in each handler (`authorize(session,[…])`); the central layer adds default deny, `platform_admin`/`platform_operator`, the any-member floor and the merchant gate.

### Findings fixed in this pass

| Route(s) | Problem | Fix |
|---|---|---|
| every `authorize()` route | authorization used the account-wide `users.role`; every public signup is `owner`, so an owner of workspace A invited as *operator* to B kept owner rights in B | the role held **in the active workspace** (`tenant_memberships.role`) is used for the request |
| `GET /api/users`, `GET /api/team/dashboard` | listed every account on the platform (usernames, names, last login) to any workspace owner | a workspace owner sees the accounts of their own workspace; only the operator sees the directory |
| `POST /api/users` | any workspace owner could create platform accounts | operator only (workspaces grow through invitations) |
| `POST /api/users/:id/(role\|suspend\|reactivate\|remove\|reset-access\|revoke-sessions)` | **account takeover**: an owner of any workspace could reset the password of, suspend or delete any account, including other workspaces' owners and platform admins | allowed only on accounts that belong to the caller's workspace **alone** and are not platform admins; anything else answers 404; a role change also updates the workspace role |
| `POST /api/agents/reseed`, `POST /api/agents/:id/model-config`, `POST /api/agents/:id/enabled` (registry part) | any owner could rewrite the agent registry shared by every workspace | operator only (a workspace uses `/config` for its own overrides; `enabled` still toggles the workspace's own config) |
| `GET /api/agents/cost-summary` | platform-wide cost and usage | scoped to the caller's workspace unless operator |
| `POST /api/frost/(pause\|resume\|run-now)` | any owner could pause every workspace's autonomy or force a global cycle | operator only; `GET /api/frost/daily-brief` scoped to the workspace |
| `GET /api/connections` | server environment/provider status | operator only |
| `GET /api/memory/usage` | tool-call outputs of every workspace | scoped to the workspace |
| `GET /api/crm` (`staff`) | listed staff of every workspace | members of the workspace only |
| `POST /api/integrations/:id/test` | tested the server's own AI/Salla/WhatsApp/Microsoft credentials | a workspace tests its own connection with its own credential |
| `/api/integrations/salla/*`, `/api/integrations/microsoft/*`, Microsoft webhook fetch | status/save/disconnect/subscription/message fetch resolved "the" tenant (default) instead of the caller's | tenant id threaded through |
| integration status, agent readiness, sales/weekly dashboards | any workspace's connection made every workspace look "configured"; static tokens counted for everybody | scoped per tenant; static tokens only for the operator's workspace |
| `syncWhatsAppTemplates` | read another workspace's Meta metadata | scoped |
| connection health tests (Salla, Anthropic, OpenAI, WhatsApp, Microsoft) | fell back to server env credentials | each connection is tested with its own credential |
| `/api/platform/*` | relied on each handler | central platform-admin gate |

`tests/api-isolation.test.js` proves these over HTTP with two ordinary workspaces, a merchant, the operator and a platform admin: a sweep of every workspace `GET` route for another workspace's marked data, IDOR attempts by id, account-takeover attempts, platform-global routes, default deny and the workspace-scoped role.

Known limit (pre-existing, not changed here): the dashboard's own per-provider OAuth callbacks (`/api/integrations/<provider>/oauth/callback`) were designed around a session cookie and a same-site request; a real provider redirect is cross-site (blocked by the `Sec-Fetch-Site` guard and by `SameSite=Strict`). The merchant flow above handles this explicitly; the dashboard flows have only ever been exercised with direct calls in tests and should be re-verified with a real provider before relying on them.

## Plans → agents (seven layers, first failure wins)

`platform availability → admin per-workspace override → plan entitlement → account state → onboarding/AI/integration readiness → usage limits → approval policy`.
The role permission (`agents.run`, `tasks.create`, …) is checked by the routes per user. The same gate is injected into the agent runtime
(`createAgentRuntime({runGate})`), so a plan-locked agent cannot run through the scheduler or a direct legacy call either.
Entitlements: `client.dashboard|analytics|integrations|team|workflows|approvals|export` and `agent.<id>` for the 12 agents; limits: `users, integrations, workflows, tasks_per_month, agent_runs_per_month`.
Admin overrides (`allow|deny|inherit`, limits) layer on top of the plan and are audited with a reason.

The registry holds 13 rows: the 12 delegated agents plus `frost_commander` (Command Center chat assistant). Only the 12 are sold and gated.

### Entitlements that were removed (nothing is offered without a real feature or measurement)

* `client.api_access` – there is no customer API, so the entitlement is gone from the catalogue, the plans, the admin UI and validation (an admin can no longer set it). A real API (scoped/hashed keys, rotation, revocation, rate limits, audit) is a separate feature.
* `storage_mb` – merchants have no file storage in the portal, so nothing is measurable; removed from limits, usage, plans, UI and validation.
* `retention_days` – nothing enforces a retention period today; removed for the same reason.
* Existing databases are cleaned once by `retireUnbackedKeys()` at boot (plan JSON and tenant overrides), idempotent.

`tests/client-portal.test.js` asserts that every limit shown to a merchant is a measured number and that the removed keys are rejected.

## Workflow templates («قوالب سير العمل»)

The portal does **not** offer free-form workflow authoring. A merchant picks a code-reviewed template (`src/client/workflows.js`) and fills bounded inputs: name, an objective (plain text ≤ 500 characters, template braces stripped), and the trigger (manual, or daily/weekly at an hour). The server builds the step graph and creates it through the platform's own workflow engine (same validation, versions, readiness, execution and approvals).

* Templates: content creation with compliance review, campaign planning, lead follow-up, weekly performance review. None uses `TOOL` steps; the sensitive ones end in a human `APPROVAL` step before anything leaves the workspace.
* Creation checks the plan/admin controls for every agent in the template (`AGENT_LOCKED_BY_PLAN`, `AGENT_DISABLED_BY_ADMIN`, …) and the plan's `workflows` limit; a new workflow is a **draft**.
* Editing rebuilds the graph from the template with the new inputs (an active workflow gets a new draft version, as in the engine); workflows that did not come from a portal template are not editable here.
* Activation and runs additionally need the workspace to be ready (onboarding, agent usable, AI configured, integrations, usage). The exact blockers are returned as `details.blockers`.
* Execution: `AGENT` steps go through the agent runtime (so the run gate applies), `APPROVAL` steps appear in the portal's approval centre, runs can be cancelled; runs and steps are tenant-scoped.
* A workspace whose account is not operational (limited/suspended/cancelled/archived) starts no run at all: creation is refused by the writable-state guard and the engine itself refuses scheduled/event runs (`startGate`).

## Account lifecycle

Account: `pending, trial, active, limited, past_due, suspended, cancelled, archived`. Workspace: `onboarding, ready, restricted, suspended, archived`.
Trial/period end → `limited` (reads work, new tasks/runs stop, nothing is deleted); a grace period → `past_due` (operational); renewal restores.
Suspension revokes all member sessions, pauses queued tasks and workflows; approval mode (`registration_mode=approval`) keeps new accounts `pending` until approved.
The platform's own env trial clock is cleared for merchant tenants so it can never suspend them behind the portal.
A limited/suspended workspace cannot start an OAuth flow, and cannot finish one that was started before.

## Tasks and approvals

`draft → queued → (waiting_for_approval | waiting_for_integration) → running → completed | failed | cancelled | paused`.
Before anything runs: access layers, blocked/allowed actions, then the approval policy (`manual` = always, `approval_required` = medium/high risk, `limited_autonomy` = high risk; the strictest of catalog default, merchant choice, onboarding default and admin-forced level). Approval creates an `agent_approvals` row (`client_task_execution`); approving runs it. A task is `completed` only if the run completed and no tool call failed; missing AI provider → `failed: AI_NOT_CONFIGURED`, missing tools → `waiting_for_integration`. No fake output anywhere. Scheduled tasks run from a timer and lazily on requests.

## Team

Roles `workspace_owner, workspace_admin, manager, operator, analyst, viewer` with permissions `agents.view|configure|run, tasks.create|cancel, approvals.review, integrations.manage, team.manage, analytics.view, billing.manage, settings.manage, audit.view`.
Invitations reuse the platform's invitation engine (single-use, email-bound); the portal role is stored in `client_invitation_roles`. User limit comes from the plan. Last-owner protection, ownership transfer (owner only, target must be verified, typed workspace name).

## Support mode («الدخول بوضع الدعم»)

Not an impersonated login. The admin keeps their own session and additionally holds a short-lived `hc_support` cookie whose SHA-256 is bound to (admin, workspace, level).
The portal API re-validates it on every request (expiry, revocation, the admin still authorized, `SUPPORT_ACCESS_USERNAMES`). Levels: `view_only` (server rejects every write), `limited` (manager permissions), `extended` (admin permissions). Never possible in support mode: password/email/ownership changes, leaving the workspace, or authorizing a third-party account (OAuth).
Sensitive actions (approvals, disconnecting integrations, role/status changes, revoking invitations, archiving workflows) need `confirmSupport`. A reason (10+ chars) is mandatory, a ticket optionally (`support_ticket_required`), duration is capped (`support_max_minutes`), one active session per admin.
Every request is logged (`client_support_events`, append-only); actions are audited with `performed_by_admin`, `on_behalf_of_user`, `support_session_id`, `reason`. The customer is notified at start/end and sees the sessions and their actions in `/client/support`. Any platform admin can revoke.

## Environment

| Variable | Purpose |
|---|---|
| `SUPPORT_ACCESS_USERNAMES` | optional narrowing of who may open support sessions |
| `PLATFORM_ADMIN_USERNAMES` | platform admins (customers section, support mode, `/api/platform/*`) |
| `INTEGRATION_ENCRYPTION_KEY` | credential vault and the OAuth state signature (required for any connection) |
| `PUBLIC_ORIGIN` | HTTPS origin; the merchant OAuth callback URLs are built from it |
| `SALLA_CLIENT_ID/SECRET`, `ZID_CLIENT_ID/SECRET`, `META_APP_ID/SECRET`, `MICROSOFT_CLIENT_ID/SECRET`, `X_CLIENT_ID/SECRET`, `LINKEDIN_CLIENT_ID/SECRET` | the platform's provider apps; a provider without them is shown as unavailable |
| `ALLOW_PUBLIC_SIGNUP`, `ALLOW_SELF_SERVICE_WORKSPACE_CREATION`, pilot limits, CAPTCHA | reused by merchant registration |
| `PLATFORM_MAIL_*` / `PLATFORM_RESEND_API_KEY` | invitation, verification and support-session notices (best effort; in-app notifications are the durable channel) |

## Database (additive) and migrations

`client_settings, client_plans, client_profiles, client_subscriptions, client_tenant_overrides, client_agent_platform, client_agent_settings, client_onboarding, client_members, client_invitation_roles, client_tasks, client_usage_events, client_notifications, client_workflow_meta, client_audit_logs (append-only), client_admin_notes, client_support_sessions, client_support_events (append-only)`.
Plus one value added to the approval types (`client_task_execution`), the `runGate` parameter of `createAgentRuntime`, and the optional `startGate` of the workflow deps. No existing table is altered.

* `installClientPortal(db)` is idempotent (a second install changes nothing; the starter plans are seeded once).
* `uninstallClient(db)` drops the client tables **except the evidence tables** (`client_audit_logs`, `client_support_sessions`, `client_support_events`, with their append-only triggers): the audit trail and support-access history are retained. `uninstallClient(db,{dropAudit:true})` removes them too. Reinstalling reattaches to the retained evidence.
* `tests/client-migrations.test.js` covers a fresh database, install twice, an existing database with core, partner and merchant data (reopen, removal, reinstall, full removal: nothing else changes, no orphan tables/triggers, `PRAGMA foreign_key_check` clean) and the retired-key cleanup.

## Local preview data (never in production)

`ALLOW_DEV_SEED=1 npm run dev:preview` starts the app on a **throwaway** database (`%TEMP%/frost-dev-preview`, never `./data`) with one account per surface. Passwords are generated when the script starts and printed to that terminal only; there is no fixed password anywhere in the repository. The script refuses to run without `ALLOW_DEV_SEED=1`, with `NODE_ENV=production`, with `PUBLIC_ORIGIN` set, or against a directory that is not empty and not a previous preview.
Preview accounts are recognisable (`devseed_*` usernames, `@preview.invalid` addresses): `npm run production:check` fails when the database holds any (and when it holds the investor-demo user/tenants), and the server logs `DEV_PREVIEW_ACCOUNTS_PRESENT_IN_PRODUCTION` at boot in production. Nothing in the application seeds demo data by itself.

## Known limits

Starter plans have price 0 and are assigned by staff (no merchant checkout/payment exists). Meta long-lived tokens cannot be refreshed without a new sign-in. LinkedIn refresh works only for apps LinkedIn enrolled in programmatic refresh tokens. Workflows are template-based by design (no free-form graph editor). The provider-side revocation of a token on disconnect is not implemented (the credential is deleted here; revoke it in the provider's console if required). The merchant OAuth flows were verified against scripted providers and in a real browser with a scripted provider redirect, not against the live provider consoles.
