# Investor Demo — Final Rehearsal Script

Prepared for the live investor presentation of the Frost Command Center. Three timed scripts
(7 / 12 / 20 minutes) sharing the same spine — each longer version is a superset of the shorter
one, so cutting a live demo short mid-flow only ever drops the *end* of the script, never breaks
the narrative in the middle.

## Before you walk in — the one thing that matters most

**This rehearsal found that no real AI provider key (Anthropic or OpenAI) is configured
anywhere in this environment** — not in `.env`, not in either demo tenant's connection vault.
Every "OpenAI Demo" / connection shown as `CONNECTED` for Nova and Vertex is a status-only
seed row with zero real credential behind it (by design, for demo safety). This means:

- Frost's chat (and Platform Frost's chat) will show an honest "AI not configured" message
  instead of an answer if you try to type a question live, with no real key present.
- A background scheduler tick (every 5 minutes, `SCHEDULER_INTERVAL_MS`) keeps retrying the
  automated follow-up sweep against the `followup` agent and keeps failing honestly
  (`ANTHROPIC_NOT_CONFIGURED`), which — left alone for more than a few minutes — reappears as a
  small number of fresh `FAILED` rows at the top of Live Operations.

**Do this before the actual investor session, in order:**
1. Add a real Anthropic (or OpenAI) API key to the environment the app runs from.
2. Restart the app process so the key takes effect.
3. Run `node scripts/demo-status.mjs` to confirm both tenants still look healthy, then clear any
   accumulated noise with the one-off cleanup shown in "Fallback readiness" below.
4. Do one full silent run-through of the 12-minute script yourself, live, right before people
   arrive — this both warms up caches and gives you a last honest look at the exact screens.

If a real key **cannot** be added in time, skip straight to "Fallback readiness" — the demo is
still genuinely presentable without live AI, just narrated slightly differently (see below).

## The story (say this in your own words, don't read it verbatim)

Companies run their operations across fragmented tools — a CRM here, a content calendar there,
spreadsheets for reporting, WhatsApp for customer follow-up, no single place that actually *acts*.
HyperCool unifies the data, the AI agents, the integrations, and the operational workflow in one
place — and **Frost** is the operating brain sitting on top of all of it. The proof isn't a slide:
it's one plain-language command turning into real multi-agent execution, with evidence you can
open behind every recommendation, and an action Frost can actually take — not just describe.

## Login

- URL: your local/staging HyperCool instance.
- Nova Store owner account, Vertex Solutions owner account (ask the project owner for current
  credentials — do not commit passwords to this file).
- Platform Admin account: the user configured in `PLATFORM_ADMIN_USERNAMES`.

---

## A. 7-Minute Version — the essential arc

| # | Screen | Click | Say | Expect | If AI is down |
|---|---|---|---|---|---|
| 1 | Login → Nova Dashboard | Log in as Nova owner | "This is Nova Store — a real multi-tenant workspace, live for 90 days of activity." | Dashboard with real KPIs, recent activity, revenue trend chart | Works identically — no AI dependency |
| 2 | Command Center | Click "غرفة القيادة" in the sidebar | "This is Frost — our operating brain. I can just ask it things in plain Arabic." | Chat panel, Live Operations feed, Suggestions panel all populated with real data | Same screen; skip step 3, narrate: "Frost's chat needs an AI key wired up in this environment — let me show you what it *does* with one" then jump to step 4 |
| 3 | Command Center chat | Type: "إيه أهم حاجة محتاجة انتباهي النهاردة؟" | (narrate while it runs) "Frost is reading real leads, approvals, and connection health right now — not a script." | A synthesized Arabic answer citing real numbers, with a "why" / evidence link | **AI-blocked fallback**: point at the Suggestions panel instead — "same underlying signal, computed live, no AI needed for this part" |
| 4 | Suggestions panel | Click "لماذا؟" (Why?) on any suggestion | "Every recommendation opens straight to the real record behind it." | Evidence drawer shows the exact lead/connection/approval row | Works identically |
| 5 | Workflows | Click "الأتمتة" → open the pre-created draft or create one live | "This is a real automation engine — trigger, conditions, steps — not a slideshow." | Draft → readiness check → Activate → Run Now → COMPLETED in ~1 second | Works identically — this entire flow has zero AI dependency |
| 6 | Live Operations (back on Command Center) | Point at the just-completed workflow run | "That's the same run, live, in the operations feed." | A green `COMPLETED` row for the workflow you just ran | Works identically |
| 7 | Workspace switch | Top-left switcher → Vertex Solutions | "Same platform, completely different business — B2B services instead of e-commerce — zero shared data." | Full page refresh: different KPIs, different pipeline, different team | Works identically |

**Closing line:** "Everything you just saw — the automation, the evidence, the multi-tenant
isolation — is real, running code, not a mockup."

---

## B. 12-Minute Version — adds multi-agent depth and Company Brain

Everything in the 7-minute script, plus, inserted after step 4:

| # | Screen | Click | Say | Expect | If AI is down |
|---|---|---|---|---|---|
| 4a | Command Center chat | Type: "اعمل مراجعة تنفيذية كاملة للشركة" | "This one command fans out — Frost delegates to specialist agents in parallel." | Two or more real nested agent runs appear (performance / intelligence), each with its own result, before Frost synthesizes a final answer | **AI-blocked fallback**: open the Weekly Report page instead — "this is the same executive-review content, generated on a schedule instead of on-demand" |
| 4b | (same chat thread) | Scroll to the multi-agent trace | "Each of those is a real, separate agent run — you can open either one." | Clicking a delegated run shows its own real tool calls and output | N/A if using fallback |
| 4c | Company Brain | Click "المحتوى والمواقفات" → Company Brain tab | "This is what Frost actually knows about this specific business — identity, goals, customers, brand voice, rules — editable by the team, never invented by the AI." | Six populated sections (Identity/Goals/Customers/Products/Brand/Rules) | Works identically — pure data, no AI needed to *display* it |
| 4d | Command Center | Click the export icon on the last assistant message | "One click, and that becomes a shareable report — no secrets, ever." | A downloaded Markdown file with command/summary/evidence/timestamp | If step 4a used the fallback, export the Weekly Report's own PDF/Excel export instead |

Insert after step 5 (Workflow run):

| # | Screen | Click | Say | Expect |
|---|---|---|---|---|
| 5a | Attachments | Upload a small PDF/CSV in the Command Center chat | "Real documents become real context — nothing dumped blindly into a prompt." | File appears with real metadata; "Pin to Company Brain" creates a governed context item |
| 5b | Configuration | Change an agent's tool connection, approve it, then Undo | "Every configuration change here is reversible, and every step is audited." | Change → pending approval → approved → Undo → original connection restored |

**Closing line (12-min):** "This isn't five separate products glued together — it's one operating
layer, and every screen you saw pulls from the same real, governed data."

---

## C. 20-Minute Version — adds Vertex depth and the Platform/extensibility story

Everything in the 12-minute script, plus, after the workspace switch to Vertex:

| # | Screen | Click | Say | Expect | If AI is down |
|---|---|---|---|---|---|
| 7a | Vertex CRM | Open the Pipeline view | "B2B pipeline, not a retail funnel — different shape, same engine underneath." | Real stage-by-stage pipeline with a genuine mix of stages |
| 7b | Vertex — team workload | Escalations/Tasks view | "You can see who's overloaded — this is computed from real assignment data, not a guess." | A team member visibly carrying more open tasks than others |
| 7c | Vertex Command Center chat | Type: "راجع الـPipeline" / "مين عليه ضغط شغل؟" | "Same Frost, same command style, completely different business context." | Answers referencing Vertex's own real pipeline/workload | **AI-blocked fallback**: open the CRM Pipeline view and Escalations list directly — narrate the same numbers manually |
| 7d | Vertex Approvals | Approvals tab | "Every risky action pauses here first — no autonomous agent silently sends anything." | Pending approvals list, real reasons attached |

Then, switch to the Platform Admin account:

| # | Screen | Click | Say | Expect | If AI is down |
|---|---|---|---|---|---|
| 8a | Platform Dashboard | `#platform` | "This is the operator's view — every tenant, aggregated, never drilling into one company's customers by accident." | Tenant directory (3 rows), platform-wide health counters |
| 8b | Integration Builder | Scroll to "منشتة التكاملات" | "This is how we add a new integration — a builder, not a code deploy." | Connector list, versions, capabilities table |
| 8c | Connector Analytics | Open any connector's Analytics tab | "Real usage numbers per connector, across every tenant." | KPI cards with real counts |
| 8d | Platform Frost | Ask: "إيه أهم مشاكل المنصة؟" | "The platform has its own assistant — deliberately blind to any single tenant's business data." | Aggregate-only answer (dead-letter counts, unhealthy-connection counts) — never a customer name | **AI-blocked fallback**: point at the Platform Dashboard's own health cards instead — same numbers, no chat needed |

**Closing line (20-min):** "One codebase, one operating model, serving a retail e-commerce
business and a B2B services company identically well — and an operator layer that scales with
every tenant we add, without ever seeing their customers' data."

---

## Top 5 investor moments (say these out loud, don't rush past them)

1. **Frost answers with real company context** — not a canned demo response (needs live AI).
2. **Multiple agents work together, live, on one command** — visible nested execution, not an
   animation (needs live AI).
3. **Evidence opens right behind every recommendation** — click "لماذا؟" and see the actual
   record (works with or without AI).
4. **Frost creates and runs a real Workflow** — draft → activate → run → COMPLETED, in seconds,
   fully visible in Live Operations (zero AI dependency — this one is always safe to demo live).
5. **Nova → Vertex with zero data leakage** — same platform, two completely different
   businesses, instant proof of real multi-tenancy (zero AI dependency).

If AI cannot be configured before the session, lead with moments 3, 4, and 5 — they carry the
architecture story on their own, and are the three that are hardened, tested, and 100% reliable
regardless of AI availability.

## Screenshot-ready pages (verified clean in this rehearsal — zero console errors, correct RTL,
no overflow, no `undefined`/`null`/`NaN` visible)

Nova Dashboard · Frost Command Center · Multi-Agent trace (requires live AI to populate) ·
Workflow Builder · Live Operations · Company Brain · Vertex Pipeline · Integration Builder ·
Platform Dashboard.

## Fallback readiness

**If AI is genuinely unavailable during the live session**, the demo is still fully presentable
using only AI-independent screens: Dashboard, Daily Brief, Weekly Reports, Suggestions
(rule-based, not AI-generated), Company Brain, Workflows (create/activate/run — no AI involved
at all), Live Operations history, Integration Builder, and workspace switching. Do not retry a
live AI call repeatedly on stage if it fails once — narrate the fallback screen instead and move
on; repeated retries in front of an audience read as a broken product, not a network hiccup.

**One-time cleanup command** (run once, right before the session, if more than ~10 minutes have
passed since the last cleanup — the automated follow-up scheduler ticks every 5 minutes and will
honestly re-fail without a real AI key, leaving a few fresh rows at the top of Live Operations):

```js
// One-off, safe: only removes the specific known noise pattern, never touches real audit history.
const nova = db.prepare("SELECT id FROM tenants WHERE slug='nova-store-demo'").get();
const vertex = db.prepare("SELECT id FROM tenants WHERE slug='vertex-solutions-demo'").get();
db.prepare("DELETE FROM agent_runs WHERE tenant_id IN (?,?) AND agent_id='followup' AND status='FAILED' AND error='ANTHROPIC_NOT_CONFIGURED'").run(nova.id, vertex.id);
```

## Demo safety (verified)

No real WhatsApp sends, emails, social publishing, customer contact, inventory writes, or
payments are possible from either demo tenant: `demo:seed` never stores a real credential in the
vault for any seeded connection (verified by an automated test), so any attempted real external
action fails at credential resolution — before any network call is ever made.
