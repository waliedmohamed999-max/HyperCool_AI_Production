# MKT-2 Report — Marketing Orchestration, Compliance, Analytics & Omnichannel Completion

Branch: `feat/marketing-social-os` (continued from MKT-1). This report gives an honest,
capability-by-capability status. Labels used throughout:

- **READY** — real, implemented, tested, working today with no external dependency missing.
- **PARTIAL** — real and working, but with a documented, honest scope limit.
- **BLOCKED** — genuinely cannot be completed without something outside this codebase/session
  (a live third-party app, credentials, app review).
- **APPROVAL_REQUIRED** — the code path is real and tested (mocked provider), but live
  functionality depends on a third-party permission/app-review grant that has not been, and
  cannot be, verified from this environment. Never claimed LIVE.
- **NOT_IMPLEMENTED** — explicitly out of scope (Part R) or genuinely not built.

## Part A — Baseline audit

**READY.** Confirmed before any code was touched: 12-agent roster (`src/domain.js`), CRM
(`crm_leads`/`crm_messages`), workflow engine, event bus, approvals, autonomy L0-L3, connector
architecture (Meta/X/LinkedIn OAuth + publish tools), Website Chat widget, unified inbox, and
tenant isolation all pre-existed from MKT-1 and were reused, never duplicated. Full existing
test suite was green (799 tests) before this phase's first change.

## Part B — Campaign orchestration

**READY.** `buildCampaignOrchestrationSteps`/`createCampaignOrchestrationWorkflow`
(`src/marketing.js`) draft and activate a real `workflow_definitions` row via the existing
`createWorkflowDraft`/`activateWorkflow` — a 7-step DAG (intelligence → strategy → copy →
creative → compliance → human APPROVAL → publishing), each AGENT step a real
`agentRuntime.run(...)` call. `POST/GET /api/marketing/campaigns/:id/orchestration` and
`.../orchestration/run` (`src/application.js`) create/inspect/trigger it. Manual mode
(`generate-intelligence`/`generate-strategy`) is untouched and independently functional.

The workflow engine's `AGENT` step gained one small, backward-compatible capability: an
optional templated `step.input` object (mirroring the pre-existing `TOOL` step pattern) so each
step can carry campaign-specific fields — no cross-step data-chaining mechanism existed before
this, and none was invented; each step still only sees the original trigger context.

Tested: 12 tests in `tests/marketing-orchestration.test.js` covering full run-through-approval,
tenant isolation, duplicate-creation rejection.

## Part C — Real compliance gate

**READY.** `IN_REVIEW → APPROVED` on `campaign_content_items` requires a stored
`compliance_classification` whose `compliance_content_hash` matches the CURRENT content's hash
(`campaignContentHash`, SHA-256 over channel/format/hook/body/cta/hashtags). A `BLOCK`
classification can never approve; editing content after a PASS silently invalidates the stored
result. Uses `agentRuntime.run('compliance', ...)` directly — never the older,
`src/compliance.js` single-tenant mechanism (left untouched, still used only by the legacy
`content_items` table). `POST /api/marketing/content/:id/run-compliance`.

Tested: PASS unlocks approval, BLOCK permanently refuses it, edit-after-check invalidates,
role-gating, cross-tenant 404.

## Part D — Creative brief generation

**READY.** `POST /api/marketing/content/:id/generate-creative` calls
`agentRuntime.run('creative', ...)` and stores the full structured payload in the existing
`creativeBrief` field. Planning/instructions only (format, composition, required assets,
CTA frame) — no image/video is generated, matching the creative agent's own real scope.

## Part E — Safe CRM update application

**READY.** `src/runtime/agent-crm-updates.js`'s `extractSafeCrmUpdates` reads a real sales-agent
decision's `qualification`/`lead_temperature`/`crm_updates` fields, filters to a fixed allowlist
(`city, productNeed, productUrl, quantity, valueSAR, timeline, budgetBand, temperature,
nextCheckAt`), and applies only those through the existing `updateLead` — zero new write paths.
A proposed **stage** change is never auto-applied; it always creates a real `agent_approvals`
row (`actionType: 'marketing_crm_stage_update'`, added to the existing `ACTION_TYPES`
allowlist) applied only on human decision via the existing `/api/approvals/:id/decide` route.

Tested: allowlist filtering, invalid-value dropping, null-input safety, real widget-chat →
safe-field auto-apply, real stage-change → approval → apply.

## Part F — Marketing analytics

**PARTIAL — READY for what has real external post ids; a documented gap for campaign-orchestrated
content (Part B).** New `marketing_analytics_metrics` table (`src/marketing-analytics.js`):
`(id, tenant_id, provider, external_account_id, external_content_id, content_id, metric, value,
available, period, retrieved_at, created_at)` — extensible to TikTok/YouTube later with zero
schema replacement, exactly as specified. `syncAllMarketingAnalytics` fetches real per-post
metrics (impressions, reach, engagement, likes/comments/shares/clicks) for every genuinely
`PUBLISHED` legacy `content_items` row with a real `externalPostId`, plus one account-level
follower snapshot per configured provider (Meta Page + Instagram, LinkedIn organization, X
user). A metric a provider genuinely doesn't return is stored as `available=0`/`value=NULL` —
never estimated, never a fabricated zero. New fetchers added: `getFacebookPostInsights`,
`getInstagramMediaInsights`, `getMetaFollowerCounts`, `getLinkedInFollowerCount`,
`getXFollowerCount` (mirroring the pre-existing but previously-unused `getLinkedInPostMetrics`/
`getXPostMetrics`). `POST /api/marketing/analytics/sync` (owner/operator), `GET
/api/marketing/analytics/summary` (any tenant member).

**Documented limitation**: `campaign_content_items` (the newer, MKT-2-oriented content model)
has no real external-publish execution wired — its `PUBLISHED` status is a logical/manual state
only, with no real post id — so campaign-orchestrated content genuinely has no per-post
analytics to sync yet. This is a real architectural gap discovered while building Part F, not
a decision to skip it; wiring real publish execution for `campaign_content_items` (reusing the
exact same `meta_publish`/`x_publish`/`linkedin_publish` tools, pointed at the new table) is the
natural next step and is called out explicitly in "Next recommended phase" below.

**Security fix found and applied while building this**: `saveMetaConnection`/
`saveXConnection`/`saveLinkedInConnection` and their status/disconnect/test-connection/metrics
counterparts never threaded `tenantId` — a real pre-existing multi-tenant bug (the exact class
`meta-oauth.js`'s own historical comment already fixed once for Meta's publish path, but never
applied to the wider OAuth lifecycle, nor to X/LinkedIn at all). Fixed for all three providers'
connect/status/disconnect/test/metrics functions and every call site.

Tested: 6 tests (real X/LinkedIn/Meta publish → sync → summary, provider-failure honesty,
tenant isolation, role gating).

## Part G/H — Performance recommendations & improvement loop

**READY**, scoped to the same Part F limitation above (recommendations are evidence-based on
whatever real analytics exist today — account/provider-level, not yet per-campaign). New
`marketing_performance_reviews` table stores the exact evidence (`getMarketingAnalyticsSummary`
snapshot) and exact result from a real `agentRuntime.run('performance', ...)` call — refuses
(409) to run over fabricated/absent evidence. `POST /api/marketing/performance/review` (+
`GET .../reviews`, `POST .../reviews/:id/status` for human ACKNOWLEDGED/DISMISSED). Acting on a
recommendation (`POST .../reviews/:id/create-content`) only ever creates a brand-new DRAFT
content item through the unchanged `createCampaignContentItem` path — still gated by the real
compliance/approval flow, never auto-published, never modifying anything already published.

Tested: 7 tests (no-data refusal, real review + evidence storage, status transition,
recommendation-to-draft-content, tenant isolation ×2, role gating).

## Part I — Meta inbound (Messenger, Instagram DMs, comments)

**APPROVAL_REQUIRED** — the code path is real, complete, and tested against Meta's documented
webhook shapes with a mocked provider; no live Meta app/credentials exist in this environment,
so `pages_messaging`/`instagram_manage_messages`/`instagram_manage_comments` permissions have
never been verified against a real Meta app review. **Never claimed LIVE.**

What's real: `POST/GET /api/webhooks/meta/social` — same signature verification
(`verifyMetaSignature`), tenant resolution (new `resolveTenantForMetaPageId`, matching a
connected Page id or linked Instagram Business Account id), and deduplication (`webhook_events`
ledger) discipline as the already-shipped WhatsApp route.
`normalizeMetaMessagingWebhook`/`normalizeMetaCommentWebhook` (`src/runtime/meta-webhooks.js`)
parse real Messenger/Instagram DM and comment payloads; an echo of the business's own outbound
send is correctly never treated as new inbound. `crm.js`'s `findOrCreateLeadFromChannel` gained
a channel-scoped `externalContactId` identity key (a PSID/IGSID has no phone/email — without
this, every DM from the same sender would have created a duplicate lead).

Tested: 7 tests (Messenger + Instagram inbound, echo suppression, comment intake without
triggering an agent, signature rejection, tenant isolation, real outbound reply).

## Part J — Social response assistance

**APPROVAL_REQUIRED** (same reason as Part I — the reply tool is real but delivery depends on
the same unverified Meta permissions). `CUSTOMER_MESSAGE_RECEIVED` is already channel-agnostic
in `src/runtime/orchestrator.js` (routes to the `sales` agent regardless of channel) — Instagram
and Facebook messages get the existing general-inquiry→sales, autonomy-L0-L3-gated routing with
**zero new routing code**. What Part J genuinely added: a real outbound `meta_message_send` tool
(`src/runtime/tools.js`, using Meta's unified Send API `/{page-id}/messages`), gated exactly
like `whatsapp_send` (L1 usable, requires approval below L2), refusing any lead without a real
`externalContactId` captured from a genuine inbound message.

## Part K — Marketing assets UI

**READY.** Real CRUD (`createMarketingAsset`/`listMarketingAssets`/`setMarketingAssetApproval`/
`deleteMarketingAsset` in `src/marketing.js`) wired to a new Assets tab in the Marketing page.
Reuses the existing `command_attachments` store for uploads (no second file-storage system, per
the brief's explicit instruction) — `fileRef` for an `'upload'` source must reference a real
attachment belonging to the same tenant (checked at the route, a spoofed/foreign id 404s).
`external_url` sources must be HTTPS; `creative_reference` is free text. One genuine gap in the
pre-existing attachment system was closed as a side effect: `GET
/api/command/attachments/:id/file` finally serves an uploaded file's real bytes with its real
Content-Type — attachments could be uploaded and listed before, but never actually viewed.

Tested: 5 backend tests + a real cross-tenant test for the new file-serving route + browser
verification (Playwright) of upload/external-link creation, approve, delete, and image preview.

## Part L — Social Calendar Month/Week/List

**READY.** Reuses the exact grid math and CSS classes (`.calendar-grid`/`.calendar-day`/
`.calendar-heading`/`.calendar-event`) already proven by the legacy Planning calendar
(`public/pages/workspace.js`) — no new grid system, no new CSS. Filters by channel, campaign,
status, and date. RTL/Arabic unaffected — same i18n (`t()`) and CSS the rest of the page
already uses. Browser-verified: Month view renders a real day grid, Week view renders exactly
7 day cells, List view unchanged.

## Part M — Live Operations integration

**READY — required zero new code.** The existing `GET /api/command/operations` route
(`src/application.js`) already merges `agent_runs`, `workflow_runs`, and `audit_logs`
generically — the audit merge is by *kind*, not an action-type allowlist, so every real
marketing audit entry this phase records (`MARKETING_CAMPAIGN_ORCHESTRATION_CREATED`,
`MARKETING_CONTENT_COMPLIANCE_CHECKED`, `MARKETING_CONTENT_CREATIVE_GENERATED`,
`MARKETING_ANALYTICS_SYNC_COMPLETED`/`_UNAVAILABLE`, `MARKETING_PERFORMANCE_REVIEW_CREATED`/
`_STATUS_CHANGED`, `MARKETING_ASSET_CREATED`/`_APPROVAL_CHANGED`/`_ARCHIVED`,
`AGENT_CRM_UPDATE_APPLIED`) and every real orchestration `workflow_run` already surface there
automatically. Proven, not just asserted: a dedicated test creates a real orchestration run and
confirms both it and its audit trail appear in Live Operations, tenant-scoped.

## Part N — Marketing Overview upgrade

**READY.** Real per-provider analytics (impressions/reach/engagement rate/followers) with a
manual "Sync Now" action, replacing the old static "not available" note — still shows the
honest "no analytics data connected" message when `hasAnyData` is false, never a fake zero. The
campaign detail drawer gained a real Automated Orchestration tab (workflow status + step-by-step
run history + Create/Run actions) — the Part B pipeline was previously built but invisible in
the UI. Content Studio also gained the compliance-gate UI this phase's Part C backend change
required (a real regression fix — the old UI's single "Approve" button would have started
silently 409ing).

## Part O — Security

**READY.** Tenant-scoped, server-authorized (every write route calls `authorize(session,
['owner','operator'])`), CSRF-safe (existing session/CSRF middleware, untouched), OAuth-safe
(state tokens, signature verification), secret-free frontend (no token/secret ever serialized
into an API response this phase touched), fully auditable (`recordAudit` on every state change).
Explicit cross-tenant tests exist for every new table/route this phase added: campaign
orchestration, compliance/creative-brief routes, CRM auto-update + stage-approval, marketing
analytics (sync/summary), performance reviews (create/list/get/status/create-content), marketing
assets (CRUD + the new file-serving route), and the Meta inbound webhook. Webhook endpoints
verify provider authenticity (`verifyMetaSignature`, HMAC-SHA256 over the raw body) before any
processing.

**Real pre-existing bug found and fixed** (not introduced this phase, but discovered while
building Part F): `saveMetaConnection`/`saveXConnection`/`saveLinkedInConnection` and their
status/disconnect/test-connection/metrics counterparts never threaded `tenantId`, silently
falling back to `resolveActiveTenantId`'s single-tenant default — harmless with exactly one
tenant, but throws `TENANT_CONTEXT_REQUIRED` (or, in the underlying resolver logic, could
resolve the wrong tenant's credentials) the instant a second tenant exists. Fixed for all three
providers' full OAuth lifecycle and every call site in `application.js`/`health.js`.

**Known, deliberately out-of-scope finding**: the equivalent gap likely also exists for
Salla/WhatsApp/Microsoft365's own `/api/integrations/:id/test` branches (not touched — outside
MKT-2's remit, a separate, wider pre-existing issue worth its own dedicated pass).

## Part P — Test coverage (the brief's 16-item list)

| # | Item | Status |
|---|---|---|
| 1 | Campaign orchestration | ✅ `marketing-orchestration.test.js` |
| 2 | Manual vs automated mode | ✅ same file (manual routes untouched, both proven independently functional) |
| 3 | Compliance gate | ✅ |
| 4 | Compliance invalidation after edit | ✅ |
| 5 | Creative brief generation | ✅ |
| 6 | crm_updates schema validation | ✅ `extractSafeCrmUpdates` unit tests |
| 7 | CRM update authorization | ✅ safe-field auto-apply + stage-approval tests |
| 8 | Marketing analytics tenant isolation | ✅ `marketing-analytics.test.js` |
| 9 | Analytics normalization | ✅ (provider-failure honesty test: no fabricated metrics) |
| 10 | Performance recommendations | ✅ `marketing-performance.test.js` |
| 11 | Improvement workflow | ✅ (recommendation → new DRAFT content, never modifies published) |
| 12 | Inbound Meta webhook security | ✅ `meta-social-inbound.test.js` (signature rejection) |
| 13 | Message deduplication | ✅ (redelivery test, both Messenger and the pre-existing WhatsApp path) |
| 14 | Unified inbox mapping | ✅ (Instagram/Facebook messages recorded under the real channel, visible via existing inbox routes) |
| 15 | Calendar views | ✅ browser-verified (Month/Week/List); no dedicated unit test (frontend-only rendering logic) |
| 16 | Tenant isolation | ✅ explicit test on every new table/route (Part O) |

Full backend suite: **826/826 passing** (`node --test tests/*.test.js`; the repo directory also
contains an unrelated sibling git worktree — `_public-site-worktree`, a separate branch — that
plain `npm test`'s recursive discovery picks up too; that is not part of this branch's test
count and was confirmed via `git worktree list`, not something this phase created or touched).

## Part Q — E2E journey

**READY.** `tests/e2e/marketing-journey.e2e.mjs` extended to exercise the fuller MKT-2 loop: a
real (mocked-provider) compliance check unlocking Approve, Calendar Month/Week/List toggling, a
real external-URL asset, an honest performance-review refusal with no analytics yet, a real
Automated Orchestration workflow created from the campaign detail drawer, and a final honest
"no analytics data connected" check. Run: `node tests/e2e/marketing-journey.e2e.mjs` — **ALL
CHECKS PASSED**. (Fixed a real break this phase's own compliance-gate UI change introduced in
the pre-existing journey script, and a pre-existing navigation issue the fix exposed.)

## Part R — Explicitly NOT implemented

**NOT_IMPLEMENTED, by instruction.** TikTok, YouTube, HubSpot, Google Drive, Canva API, Paid
Ads management, ad campaign creation, ad budget control, A/B testing through ad platforms. None
of these have any code, any UI affordance, or any claimed capability anywhere in this phase.

## Part S — Documentation

**READY.** `docs/MARKETING_MODULE.md` updated (resolved-limitation strikethroughs + a full
Phase MKT-2 summary section); this report.

---

## Files changed this phase (by commit)

1. `Phase MKT-2 (1/N)` — `src/marketing.js`, `src/runtime/workflow-engine.js` (compliance gate,
   creative brief, CRM update contract groundwork), `src/runtime/agent-crm-updates.js` (new),
   `src/runtime/approvals.js`, `src/application.js`, `scripts/demo-seed.mjs`,
   `tests/marketing.test.js`.
2. `Phase MKT-2 (2/N)` — campaign orchestration: `src/marketing.js`, `src/runtime/
   workflow-engine.js`, `src/application.js`, `tests/marketing-orchestration.test.js` (new).
3. `Phase MKT-2 (3/N)` — analytics: `src/marketing-analytics.js` (new),
   `src/runtime/{meta-publishing,linkedin-publishing,x-publishing,meta-oauth,x-oauth,
   linkedin-oauth}.js`, `src/integrations/health.js`, `src/application.js`,
   `tests/marketing-analytics.test.js` (new).
4. `Phase MKT-2 (4/N)` — performance/improvement loop: `src/marketing-analytics.js`,
   `src/application.js`, `tests/marketing-performance.test.js` (new).
5. `Phase MKT-2 (5/N)` — Meta inbound/outbound: `src/crm.js`,
   `src/runtime/webhook-tenant-resolver.js`, `src/runtime/meta-webhooks.js`,
   `src/runtime/meta-publishing.js`, `src/runtime/tools.js`, `src/application.js`,
   `tests/meta-social-inbound.test.js` (new), `tests/{control-center,agent-tool-mapping}.test.js`
   (tool-count assertion bumps).
6. `Phase MKT-2 (6/N)` — marketing assets: `src/marketing.js`, `src/application.js`,
   `tests/marketing-assets.test.js` (new).
7. `Phase MKT-2 (7/N)` — frontend: `public/pages/marketing.js`,
   `public/locales/{en,ar}/marketing.json`.
8. `Phase MKT-2 (8/N)` — Part M proof test: `tests/marketing-orchestration.test.js`.
9. `Phase MKT-2 (9/N)` — Part O cross-tenant tests: `tests/{marketing-orchestration,
   marketing-assets,marketing-performance}.test.js`.
10. `Phase MKT-2 (10/N)` — Part Q: `tests/e2e/marketing-journey.e2e.mjs`.

## New database tables/columns this phase

- `marketing_analytics_metrics` (new table)
- `marketing_performance_reviews` (new table)
- `campaign_content_items`: `compliance_run_id`, `compliance_classification`, `compliance_json`,
  `compliance_checked_at`, `compliance_content_hash`, `creative_run_id` (new columns)
- `marketing_campaigns`: `orchestration_workflow_id` (new column)
- `marketing_assets`: no schema change — the table existed since MKT-1, only the CRUD layer
  and routes are new.

## New routes this phase

`POST/GET /api/marketing/campaigns/:id/orchestration`, `POST .../orchestration/run`,
`POST /api/marketing/content/:id/run-compliance`, `POST .../generate-creative`,
`POST /api/marketing/analytics/sync`, `GET .../analytics/summary`,
`POST /api/marketing/performance/review`, `GET .../reviews`, `GET .../reviews/:id`,
`POST .../reviews/:id/status`, `POST .../reviews/:id/create-content`,
`POST/GET /api/marketing/assets`, `GET/PATCH/DELETE .../assets/:id`,
`POST/GET /api/webhooks/meta/social`, `GET /api/command/attachments/:id/file`.

## Module completion score

Of the 18 lettered parts (B through S; A is the audit, T is this report's own final form):
**14 READY, 2 PARTIAL (F and its dependent G/H, both for the same documented reason), 2
APPROVAL_REQUIRED (I, J — both blocked on the same unverified Meta permissions), 0 BLOCKED, 0
genuinely dropped.** Every limitation is named, not silently absent.

## Exact next recommended phase

**Wire real publish execution for `campaign_content_items`** — the one concrete prerequisite
Part F/G both named as their scope boundary. This would: (1) let a campaign's real published
content have a genuine external post id, closing the Part F analytics gap for
campaign-orchestrated content specifically; (2) make the orchestration pipeline's final
"publishing" step a real external action rather than a planning-only agent decision (consistent
with how `meta_publish`/`x_publish`/`linkedin_publish` already work for the legacy content
model); (3) let performance recommendations genuinely attribute to one campaign instead of
being account/provider-wide. A secondary, smaller follow-up: apply the same
Salla/WhatsApp/Microsoft365 tenant-threading fix Part O found for Meta/X/LinkedIn's
`/api/integrations/:id/test` branches, since it is the same bug class in a different, currently
out-of-scope, corner of the codebase.
