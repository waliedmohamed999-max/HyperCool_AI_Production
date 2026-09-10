# Hyper Cool — AI CMO & Sales Agent System
## Project Scope Document

| | |
|---|---|
| **Project name** | Hyper Cool AI CMO (هايبركول — المدير التسويقي الذكي) |
| **Owner / sponsor** | Dr. Alaa Al-Aydarous |
| **Brand** | Hyper Cool / هايبركول — Sports recovery & performance equipment, Saudi Arabia |
| **Base** | Al Khobar, Eastern Province |
| **Version** | v1.0 — 8 September 2026 |
| **Model** | Same architecture as the HADER AI CMO system (Atheer's build), re-pointed at Hyper Cool commerce and sales |

---

## 1. Purpose

Hyper Cool needs a marketing and sales function that runs every day without a full-time team. This project builds a supervised multi-agent system that:

1. Produces and publishes **one post per day** across Instagram, X and Facebook, and **three posts per week** on LinkedIn.
2. Generates **B2B leads** from LinkedIn, Instagram and X, with a verified buying trigger for each one.
3. **Answers customers** on WhatsApp and social DMs, qualifies them, quotes them and pushes toward a closed deal.
4. **Follows up** by email and WhatsApp until the deal is won, lost, or parked with a date.
5. **Learns** — every result feeds back into what gets written and who gets targeted next.

The human owner approves; the agents do the work. Nothing publishes or sends without passing an approval gate until each agent has earned autonomy (Section 8).

---

## 2. Brand assets and accounts in scope

### 2.1 Verified links

| Asset | Link | Status |
|---|---|---|
| Online store (Salla) | https://hyper-cool.com | Verified |
| Store — English | https://hyper-cool.com/en | Verified |
| Blog | https://hyper-cool.com/blog | Verified |
| About us | https://hyper-cool.com/من-نحن/page-1110607204 | Verified |
| Instagram (primary) | https://www.instagram.com/hypercool.sa/ | Verified — 1,465 followers, 83 posts |
| Instagram (second handle) | https://www.instagram.com/hypercoolsa/ | Exists — **confirm which is primary; retire or redirect the other** |
| X (Twitter) | https://x.com/HypercoolSA | Verified — ~123 posts |
| LinkedIn (company) | https://www.linkedin.com/company/hyper-cool/ | Verified |
| YouTube | https://www.youtube.com/@HyperCool-SA | Verified |
| WhatsApp Business | https://wa.me/966566709071 | Verified |
| Phone | +966 56 670 9071 | Verified |
| VAT number | 312444470900003 | Verified (store footer) |
| **Facebook page** | — | **NOT VERIFIED.** No public page found. Either supply the URL or Phase 0 creates one and links it to the Meta Business account. |
| TikTok / Snapchat | — | **NOT VERIFIED.** Confirm whether these exist. Both matter in the Saudi consumer market. |

### 2.2 Product category pages (used by the agents for links and CTAs)

| Category | Link |
|---|---|
| Cold plunge / ice baths — all | https://hyper-cool.com/-/c493905676 |
| Chillers | https://hyper-cool.com/-/c693307101 |
| Ice baths | https://hyper-cool.com/-/c1851780900 |
| Cold plunge accessories | https://hyper-cool.com/-/c1951818638 |
| Home saunas | https://hyper-cool.com/-/c715554887 |
| Compression therapy | https://hyper-cool.com/-/c1449709121 |
| Performance products | https://hyper-cool.com/-/c1216917587 |
| Infrared therapy | https://hyper-cool.com/-/c1659175338 |
| HBOT — hyperbaric oxygen | https://hyper-cool.com/-/c250823237 |
| Cryotherapy | https://hyper-cool.com/-/c1212666795 |
| For Business (B2B) | https://hyper-cool.com/-/c42141186 |
| Offers | https://hyper-cool.com/offers |

Every post, DM reply and email must land on one of these URLs or a specific product page. No bare "DM us for price" without a link.

---

## 3. The agent org chart

```
                      Dr. Alaa  —  Owner / approval authority
                                  │
                        ┌─────────┴─────────┐
                        │   CMO AGENT       │   orchestrator, daily package,
                        │   "Frost"         │   weekly report, escalation
                        └─────────┬─────────┘
        ┌──────────────┬──────────┼───────────┬──────────────────┐
        │              │          │           │                  │
   CONTENT POD    SALES POD   INTELLIGENCE   PERFORMANCE      MEMORY
        │              │          POD           POD              │
  ┌─────┴─────┐  ┌─────┴──────┐   │             │          Memory &
  │ Strategy  │  │ Lead Gen   │  Competitor   Performance   Learning
  │ Copy (AR/EN)│ │ Conversation│  & Trend     & Growth      Agent
  │ Creative  │  │  (WhatsApp/ │  Intelligence   Agent
  │ Brand &   │  │   DMs)      │    Agent
  │ Compliance│  │ Follow-up   │
  │ Publishing│  │  (Email)    │
  └───────────┘  └────────────┘
```

Twelve agents. Names are placeholders — rename to match the HADER convention if you want one house style across both companies.

### 3.1 Content pod — produces the daily post

| # | Agent | Does | Does NOT |
|---|---|---|---|
| 1 | **Content Strategy** | Builds the 30-day calendar: pillar, product, segment, platform, CTA for each slot. Maps posts to launches, seasons (Ramadan, marathons, Saudi Games), and stock. | Write final copy. |
| 2 | **Copywriting (AR/EN)** | Writes the caption in Saudi-market Arabic first, English second. Hook, body, CTA, hashtags, link. LinkedIn version rewritten for B2B, never copy-pasted. | Invent specs, prices or claims. |
| 3 | **Creative** | Visual brief or Canva-generated asset: which product photo, which template, reel script and shot list, on-brand colours and logo. | Publish. |
| 4 | **Brand & Compliance Fact-Check** | Hard gate. Checks every price against the store, every spec against the product page, every link resolves, and **kills any medical/therapeutic claim** that Hyper Cool is not authorised to make (see 9.2). | Approve its own exceptions. |
| 5 | **Publishing & Scheduling** | Queues approved posts to the right platform at the right time, enforces the cadence rules, logs the live URL. | Publish anything unapproved. |

### 3.2 Sales pod — the part Hyper Cool doesn't have today

| # | Agent | Does | Does NOT |
|---|---|---|---|
| 6 | **Lead Generation** — LinkedIn, Instagram, X | Builds target lists by segment with a **dated buying trigger** for each (new facility, funded expansion, new CEO, tournament, competitor installing kit). Scores fit 1–5. Finds the route in — named executive, or the role plus the real procurement channel (Etimad, NUPCO, the design consultant). Delivers rows into the CRM sheet with a source link on every row. | Scrape LinkedIn, automate connection requests, or log into LinkedIn on your behalf. It hands you **search URLs you click yourself**. |
| 7 | **Conversation & Closing** — WhatsApp, IG DM, FB Messenger, X DM, LinkedIn inbox | First response inside 5 minutes. Greets, qualifies (individual vs facility, product, city, budget band, timeline), sends the right product link, answers the standard objections, prepares the quotation, books the call, and hands hot deals to a human with a one-line brief. | Discount beyond the approved band, promise delivery dates it can't verify, or make medical claims. |
| 8 | **Follow-up** — email + WhatsApp | Owns the sequences: quote sent → no reply, abandoned cart, post-demo, post-purchase (upsell accessories, service contract), dormant lead re-activation, and the "or should I check back next budget cycle?" close-out. Runs from Microsoft 365 email. | Send more than the agreed number of touches, or contact anyone who opted out. |

### 3.3 Intelligence, performance and memory

| # | Agent | Does |
|---|---|---|
| 9 | **Competitor & Trend Intelligence** | Watches °CRYO, MECOTEC, Art of Cryo, Kula Recovery (Dubai), and Saudi operators like Cryo Infinity Jeddah, UCRYO, Formation, Recovery Lab. Tracks Arabic search terms and what is trending in Saudi fitness/wellness. Feeds the calendar. |
| 10 | **Performance & Growth** | Pulls post metrics, store analytics, DM volume, conversion. Tells you what worked and what to stop doing. Recommends next week's mix. |
| 11 | **Memory & Learning** | The permanent brand memory: approved claims, price list, objection library, winning hooks, customer FAQs, lost-deal reasons. Every agent reads from it; it gets updated weekly. |
| 12 | **CMO Agent (orchestrator)** | Runs the daily cycle, assembles the approval package, resolves conflicts between agents, escalates, and writes the weekly report. Your single point of contact. |

---

## 4. Publishing cadence — the rule set

**One post per day. Seven per week. LinkedIn gets three of them, rewritten.**

| Day | Instagram | X | Facebook | LinkedIn |
|---|---|---|---|---|
| Sunday | ✅ | ✅ | ✅ | ✅ (B2B rewrite) |
| Monday | ✅ | ✅ | ✅ | — |
| Tuesday | ✅ | ✅ | ✅ | ✅ (B2B rewrite) |
| Wednesday | ✅ | ✅ | ✅ | — |
| Thursday | ✅ | ✅ | ✅ | ✅ (B2B rewrite) |
| Friday | ✅ | ✅ | ✅ | — |
| Saturday | ✅ | ✅ | ✅ | — |

**Weekly content mix (the 7 posts):** 3 educational · 2 product or offer · 1 social proof / installation · 1 engagement, reel or UGC.

**The 3 LinkedIn posts:** 1 sector insight (gyms, clubs, hospitals, hotels) · 1 installation or case study · 1 technical authority piece. Written for procurement and owners, not consumers.

**Language:** Arabic-first on Instagram, X, Facebook. Bilingual on LinkedIn. Arabic is written as a Saudi marketer writes it, not as translated English.

**Content pillars:** the science of recovery · product spotlight · segment use-case · social proof and installations · offers and bundles · service, parts and warranty inside the Kingdom (the one thing importers can't match) · athlete and creator collaborations.

---

## 5. The daily operating cycle

| Time | What happens |
|---|---|
| 07:00 | Intelligence sweep: competitor moves, trends, overnight DMs, new orders, abandoned carts. |
| 08:00 | **Approval package** lands on your WhatsApp and email: tomorrow's post (AR + EN + visual + link), yesterday's numbers, new qualified leads, and any conversation that needs a human decision. |
| by 12:00 | You approve, edit or reject. One reply. |
| 12:00 → | Publishing agent schedules. Follow-up agent fires the day's sequences. |
| All day | Conversation agent handles WhatsApp and DMs live, escalating anything outside its rules. |
| 17:00 | Day log written to memory. |
| Thursday | Weekly report + next week's calendar for approval. Thursday is the approval deadline for the week ahead. |

---

## 6. Technical architecture

| Layer | Choice | Notes |
|---|---|---|
| Reasoning core | Claude (Anthropic API) | One system prompt per agent, shared brand-memory file. |
| Build environment | Claude Code / Cowork | Agents defined as skills + scheduled tasks. |
| Orchestration | Native in-process runtime (`src/runtime/`) | As built: internal event bus, Frost orchestrator, scheduler, approvals and escalations all run inside the app's own backend — no external automation platform. Two optional token-gated HTTP endpoints (`/api/automation/*`) exist only as a redundant external trigger for hosting environments that can't guarantee a long-running process; any caller works, none is required. |
| Instagram + Facebook | Meta Graph API — Instagram Platform, Pages API, Instagram Messaging API | Requires a Professional/Business account, a Meta Business app, and app review for messaging permissions. |
| X | X API | Posting tier required; DM access is a separate scope. |
| LinkedIn | LinkedIn Marketing / Community Management API | Company-page posting only. **No personal-profile automation.** |
| WhatsApp | WhatsApp Business Platform (Cloud API) direct, or via a BSP — Unifonic, 360dialog, Twilio | Outbound outside the 24-hour service window requires **pre-approved message templates**. This is the single biggest schedule risk. |
| Store | Salla APIs and webhooks | Products, prices, stock, orders, abandoned carts. |
| Email | Microsoft 365 / Graph API | Already connected. |
| CRM | Start with `HyperCool_Saudi_Leads.xlsx` → move to Google Sheets or HubSpot free | Needs to be multi-user and live before the sales pod goes on. |
| Creative | Canva Connect API + brand kit | |
| Logs & calendar | Google Sheets | Content calendar, publish log, conversation log, approval audit trail. |

---

## 7. Phases and timeline

Eight weeks, sequential, each phase gated on the previous one working.

| Phase | Weeks | Scope | Exit criterion |
|---|---|---|---|
| **0 — Foundation** | Week 0 | Accounts and API access, Meta Business setup, Facebook page decision, brand kit, price list, approved-claims list, objection library, CRM live. | Every account authenticated with least-privilege access. |
| **1 — Content pod** | 1–2 | Agents 1–5. Daily post produced and published with manual approval on every item. | 14 consecutive days published on schedule, zero factual corrections needed. |
| **2 — Conversation agent** | 3–4 | Agent 7 on WhatsApp + Instagram DM. Every reply human-approved before sending. | 50 conversations handled, first-response under 5 min in working hours. |
| **3 — Lead generation** | 4–5 | Agent 6 on LinkedIn, Instagram, X. CRM rows with sourced triggers. | 40 qualified leads delivered, 100% with a source link, zero fabrications. |
| **4 — Follow-up** | 6 | Agent 8. Email + WhatsApp sequences, templates approved. | All six sequences live and logged. |
| **5 — Intelligence & learning** | 7 | Agents 9–11. Weekly report auto-generated. | Report produced without human assembly. |
| **6 — Autonomy & handover** | 8 | Dial up autonomy per Section 8. Write the SOP. Train the operator. | Owner spends under 30 minutes a day on the whole system. |

---

## 8. Autonomy ladder

Each agent moves up one level at a time, and only after a clean run.

| Level | Rule |
|---|---|
| L0 | Agent drafts. Human approves every item before it leaves. |
| L1 | Human approves the weekly calendar; agent publishes within it. Replies still approved individually. |
| L2 | Agent replies freely inside the approved script and price list; escalates anything outside it. |
| L3 | Agent runs the day; human reviews the log after the fact. |

Promotion requires: 14 days clean at the current level, zero compliance breaches, and no customer complaint traced to the agent. Any breach drops it back one level immediately.

---

## 9. Hard constraints

### 9.1 Absolute prohibitions

- No fabricated company, executive, URL, date, number or reference. If it can't be verified, it is written as `NOT VERIFIED` and said out loud. A fake contact costs more than a missing one.
- No LinkedIn scraping, no automated connection requests, no logging into personal accounts.
- No auto-DM blasts on Instagram or X — this gets the accounts restricted, and the accounts are the asset.
- No discount, no delivery date, no stock promise outside what the price list and Salla say.
- No contacting anyone who has opted out.

### 9.2 Claims and regulatory

- **HBOT and cryotherapy claims are the risk.** Hyperbaric chambers sold with therapeutic claims require SFDA Medical Device Marketing Authorization plus a licensed Saudi Authorised Representative. Wellness-positioned equipment sold without therapeutic claims may sit outside scope — but that needs a written scoping determination per SKU, not an assumption.
- Until that exists, the compliance agent blocks any copy that claims to treat, cure or diagnose a condition. Performance, recovery and comfort language only.
- Never bluff SFDA status in a B2B conversation. Biomedical engineering verifies registration at acceptance, and getting caught there ends the account.
- Public-sector buyers go through Etimad (portal.etimad.sa); public healthcare through NUPCO. Registration is a prerequisite, not a formality.

### 9.3 Data

- Customer conversations contain personal data. Store only what the sale needs, in the CRM, not scattered across agent logs.
- Every credential in a secrets store, never in a prompt.

---

## 10. KPIs

Proposed targets for month 3 — confirm or adjust before Phase 1.

| KPI | Target |
|---|---|
| Posts published on schedule | 30/month, 100% compliance |
| LinkedIn posts | 12/month |
| First response time — WhatsApp & DM | < 5 min in working hours, < 30 min outside |
| Conversations handled | ≥ 100/month |
| New qualified leads (fit ≥ 3, sourced trigger) | ≥ 40/month |
| Decision-maker meetings booked | ≥ 8/month |
| Quotations sent | ≥ 15/month |
| Instagram followers | +15%/month |
| LinkedIn company followers | +100/month |
| Store sessions from social | +30%/month |
| Closed deals | B2C orders + ≥ 2 B2B deals/month |
| Escalations the agent got wrong | 0 compliance breaches |

---

## 11. Deliverables

1. Twelve agent definitions with system prompts, tools and guardrails.
2. Orchestration: native in-process runtime with approval routing (as built — no Make/n8n dependency).
3. Brand memory file: voice, approved claims, price list, objection library, FAQ.
4. 30-day content calendar, pre-loaded.
5. WhatsApp message templates, submitted and approved.
6. Six email/WhatsApp follow-up sequences, AR + EN.
7. CRM workbook or HubSpot pipeline, live and populated.
8. Daily approval package format and weekly report template.
9. Operator SOP in Arabic + a two-hour handover session.
10. Autonomy log and compliance audit trail.

---

## 12. Out of scope (v1)

Paid media buying and ad budget management · TikTok and Snapchat (add in v2 once confirmed) · influencer contracting and payment · Arabic SEO rebuild of the Salla store · video production beyond scripts and simple edits · replacing a human sales closer on deals above SAR 100,000 · anything touching SFDA registration itself.

---

## 13. Open questions — needed before Phase 0 closes

1. Which Instagram handle is primary — `@hypercool.sa` or `@hypercoolsa`? The other should be retired or redirected.
2. Does a Facebook page exist? If not, do we create one, or drop Facebook from the daily rotation?
3. Are TikTok and Snapchat in or out? For Saudi B2C recovery products they may outperform Facebook.
4. Who is the human escalation point when a deal goes hot outside your hours?
5. What discount band can the conversation agent offer without asking?
6. Do we have written SFDA scoping for the HBOT and cryotherapy lines, or do we position everything as wellness for now?
7. Is the WhatsApp number +966 56 670 9071 already on the WhatsApp Business Platform, or is it on the consumer Business app? Migration takes time and the number can only live in one place.

---

*Prepared for Hyper Cool. All links verified against live sources on 8 September 2026 except where marked NOT VERIFIED.*
