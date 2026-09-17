# Marketing & Social Operating Module (Phase MKT-1)

A department view assembled from existing HyperCool systems, not a second platform. This
document is the architectural audit and reuse plan required before any new schema was added
(the actual code comments cross-reference this file).

## Audit — what already existed (verified via full-repo grep and code reading, not assumed)

| Capability the spec asked for | Real, pre-existing implementation | Verdict |
|---|---|---|
| 12 named agents (Frost, Content Strategy, Copywriting, Creative, Compliance, Publishing, Lead Gen, Conversation & Closing, Follow-up, Intelligence, Performance, Memory) | `src/domain.js`'s `agents` array — `frost`, `strategy`, `copy`, `creative`, `compliance`, `publishing`, `leads`, `sales`, `followup`, `intelligence`, `performance`, `memory` | 100% already exists, exact match |
| Unified Inbox / conversation model | `src/crm.js`'s `crm_leads` + `crm_messages` tables, `findOrCreateLeadFromChannel`, `recordChannelMessage`, `updateMessageStatus` — already supports WhatsApp/Email/Instagram/Facebook/X/LinkedIn/Phone channels, real idempotency via `externalMessageId`, real delivery-status tracking | Already a complete omnichannel message model — reused as-is, `WebsiteChat` added as one more channel string |
| WhatsApp integration | `src/runtime/whatsapp.js`, real Cloud API send/template sync | Real, LIVE |
| Meta (Facebook Pages + Instagram) | `src/runtime/meta-oauth.js` — real OAuth2 (Facebook Login for Business), resolves Page + Instagram Business Account + WhatsApp Business Account in one flow; `meta_publish` tool | Real, LIVE for publishing/messaging; no real capability for reading analytics or ingesting comments/DMs (see Limitations) |
| X (Twitter) | Real OAuth2 + PKCE (`src/runtime/x-oauth.js`), `x_publish` tool | Real, LIVE for publishing; no analytics-fetch tool |
| LinkedIn | Real OAuth2 (`src/runtime/linkedin-oauth.js`), `linkedin_publish` tool (Company Page only) | Real, LIVE for publishing; no analytics-fetch tool |
| TikTok, YouTube, HubSpot, Google Drive | Grepped the entire repository (`src/`, `public/`) — zero real implementation of any kind, not even a placeholder row in `integration_definitions.js` | NOT_IMPLEMENTED — never claimed otherwise anywhere in the UI |
| Canva | `integration_definitions.js` explicitly lists it `isAvailable:0` with its own comment confirming no real implementation exists | NOT_IMPLEMENTED, already honestly labeled before this phase |
| Workflow engine, event bus, canonical events | `src/runtime/workflow-engine.js`, `src/runtime/events.js` (`EVENT_TYPES` already includes `CUSTOMER_MESSAGE_RECEIVED`, `LEAD_CREATED`, `LEAD_QUALIFIED`, `LEAD_HOT`, `CONTENT_APPROVED`, `CONTENT_PUBLISHED`, `FOLLOWUP_DUE`, `COMPETITOR_SIGNAL_FOUND`) | Fully sufficient for every Marketing workflow example in the spec — no new event type needed |
| Approval Engine, autonomy L0-L3 | `src/runtime/approvals.js`, `src/autonomy.js` | Reused as-is — no second approval or autonomy model |
| Company Brain | `src/runtime/context-items.js`'s `brain_*` types, surfaced in Command Center | Reused as-is — Marketing deep-links to it (`#command-center`) rather than duplicating brand/audience/rules storage |
| Content approval workflow | `src/content.js` + `src/domain.js` (`content_items` table, DRAFT→REVIEWED→APPROVED) | A real, working system, but modelled as ONE flat post type (Instagram/Facebook/X/LinkedIn only, no campaign linkage, no channel-specific fields) — too narrow for the spec's richer content model; **kept untouched**, a NEW parallel table added instead (see below) rather than retrofitting it and risking the existing Content & Approvals page |
| Analytics (reach, engagement) | `src/reporting.js:46`'s own comment: "no store analytics, ad spend or social engagement are connected, so those stay null rather than guessed" | Confirmed: genuinely unavailable everywhere in this codebase — Marketing Overview shows this honestly (`reach: null, engagement: null`), never estimates |
| Website chat widget | Grepped for `widget`/`embed` — no real hits (only coincidental keyword matches in unrelated files) | Genuinely missing — built new, minimal, real (see below) |
| CORS / cross-origin support | `src/application.js` had a blanket same-origin rejection for every route (`req.headers.origin !== publicUrl.origin` → 403) — correct for a session-cookie SPA, but incompatible with an embeddable widget | A narrow, explicit carve-out added for exactly one route (`/api/public/widget/*`); every other route's same-origin gate is untouched |

## What was actually new (minimal, additive)

1. **`marketing_campaigns`** and **`campaign_content_items`** tables (`src/marketing.js`) — the
   one genuinely missing concept: a named campaign container, and a richer content item
   (channel/format/objective/hook/CTA/hashtags/creative brief/schedule) than the existing
   `content_items` table models. `marketing_assets` table exists in schema for future asset
   tracking but is not yet wired to any UI in this v1 pass (see Limitations).
2. **`website_widgets`** table + `src/runtime/website-widget.js` — public widget config,
   origin allowlist, per-(widget,ip) rate limiting, and the real inbound/outbound message
   recording that reuses `findOrCreateLeadFromChannel`/`recordChannelMessage` exactly like
   WhatsApp/Email already do.
3. **`WebsiteChat`** added to `crm.js`'s channel whitelist — a one-line, additive change to an
   existing array, not a new messaging system.
4. **5 new built-in runbooks** appended to `runtime/runbooks.js`'s existing list (Monthly
   Marketing Plan, Weekly Content Plan, Campaign Launch Checklist, Competitor Review, Social
   Inbox Review) — same runbook mechanism (a saved command string through the existing
   `frost_commander` pipeline), not a new automation engine.
5. **`public/pages/marketing.js`** — one page module (Overview / Campaigns / Content Studio /
   Social Calendar / Unified Inbox / Website Widget tabs), following the exact conventions
   every other page module already uses (`tabs()`, `table()`, `badge()`, `promptDrawer()`).
   Publishing health, Integrations, Brand, and Leads/Deals deep-link into Control Center,
   Platform, Command Center, and CRM respectively rather than duplicating those pages.
6. **`public/widget-embed.js`** — a small, dependency-free, publicly-servable embed script
   (spec Part 87) with no secret in it, only the widget's public, non-secret id.

## Campaign generation flow — what "real multi-agent delegation" means here

`POST /api/marketing/campaigns/:id/generate-intelligence` and `.../generate-strategy` call
`agentRuntime.run('intelligence' | 'strategy', {input: <real campaign fields>, tenantId})` —
the exact same agent runtime every other agent run in this app goes through (readiness checks,
tool access, audit, tenant isolation). If the tenant's AI provider is not configured or the
call fails, the campaign's `strategy`/`intelligence` JSON columns simply stay `null` and the UI
shows a real empty state — never a fabricated plan.

This is scoped as **explicit, human-paced steps per campaign stage** (a user opens a campaign
and clicks "Generate Strategy", then separately "Generate Intelligence") rather than one silent
end-to-end Frost → Intelligence → Strategy → Copy → Creative → Compliance → Approval → Publish →
Analytics chain. Building the full seven-agent automatic pipeline correctly — with a real
compliance gate wired per content item, real creative-brief generation via the Creative agent,
and real automatic publishing through the existing `meta_publish`/`x_publish`/`linkedin_publish`
tools once approved — is a substantial follow-up in its own right; wiring two real agent calls
end-to-end (with real audit, real readiness checks, real honest failure) proves the same
integration pattern without overclaiming a fully automated pipeline that wasn't fully built.

## Website Chat Widget — how the reply is generated

An inbound widget message calls `agentRuntime.run('sales', {input: {channel:'WebsiteChat', ...}})`
— the exact same agent and pipeline a real WhatsApp message already goes through. The `sales`
agent's own payload schema already includes `reply_ar`/`reply_en` fields; the widget handler
uses that field directly and records it as a real OUTBOUND `WebsiteChat` message, then returns
it synchronously in the same HTTP response (the visitor is watching the same window, so there is
no need for an async "wait for a queued reply" round-trip the way a WhatsApp reply would need).
If AI is not configured, `run.output` is `null` and the endpoint honestly reports
`aiAvailable:false` with no reply text — the real lead and inbound message are still recorded.

**Known, documented scope boundary**: the sales agent decision's `crm_updates` field is not
auto-applied to the lead in this pass (no existing consumer of that field exists anywhere in the
codebase either — grepped and confirmed) — inventing an auto-apply mechanism un-audited felt
riskier than leaving qualification data visible in the run record for a human to act on through
the existing CRM update form, consistent with how the rest of the system already works.

## A real pre-existing bug fixed along the way

While verifying the new Marketing route's header rendering, `app-shell.js`'s locale-refresh
loop (`el.querySelector('p').textContent=routeDescription(key)`) was found to match the
`.eyebrow` `<p>` first (document order), silently overwriting the shared brand eyebrow with
each route's own description on every locale refresh — confirmed across **all 16 pre-existing
routes**, not something introduced by this phase. Fixed with a more specific selector
(`p:not(.eyebrow)`). Full regression re-confirmed green after the fix.

## Reuse discipline confirmed, item by item (spec's own "no duplication" checklist)

- No second orchestrator: Frost/`frost_commander` untouched; campaign generation calls the
  same `agentRuntime.run()` any other agent call uses.
- No second CRM: `crm_leads`/`crm_messages` reused entirely; zero new lead/contact table.
- No second workflow engine: zero new workflow tables; only new built-in runbook entries.
- No second inbox/event bus: `EVENT_TYPES` unchanged; `CUSTOMER_MESSAGE_RECEIVED` reused.
- No duplicate agents: zero new agent ids; existing 12 reused for every capability.
- No external n8n or third-party automation dependency introduced.

## Exact limitations (honest, not silently dropped)

- **TikTok, YouTube, HubSpot, Google Drive, Canva**: NOT_IMPLEMENTED — no code exists for any
  of them. The Marketing UI never shows a connected state for these.
- **Meta/X/LinkedIn analytics**: publishing works; there is no real tool anywhere that reads
  back reach/engagement/impressions from these providers. Marketing Overview shows this
  honestly (`reach: null, engagement: null`) rather than estimating.
- **Instagram/Facebook inbound (comments/DMs)**: only WhatsApp has a real inbound webhook
  normalizer (`normalizeWhatsAppWebhook`). "Community mode" (comment/DM reply) is real for
  WhatsApp and the new Website Chat widget only — not for Instagram/Facebook engagement.
- **Full automated campaign pipeline**: two real agent-call stages (Intelligence, Strategy) are
  wired; Copywriting/Creative/Compliance/auto-Publish per campaign stage are not yet chained
  automatically — content items are created and advanced through status manually via the
  Content Studio UI, reusing the exact same real agents' capabilities where a user chooses to
  invoke them (not built as an automatic campaign-stage trigger in this pass).
- **`marketing_assets` table**: exists in schema, not yet wired to any UI (no asset upload/
  browse flow built in this pass) — Google Drive folder-pattern storage (spec Part 49) is not
  applicable since no Drive connector exists.
- **Calendar view**: List view only; Month/Week grid views are not built.
- **A/B testing, ad platform read/write**: not built — no ad connector exists to support either.
- **crm_updates auto-apply**: qualification data from a sales-agent decision is visible in the
  run record but not automatically written to the lead (see above).
