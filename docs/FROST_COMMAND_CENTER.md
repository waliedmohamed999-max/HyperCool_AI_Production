# Frost Command Center (Phases 7A – 7C)

The tenant-facing "operations room" sitting on top of the existing Frost Orchestrator, Agent
Runtime, Tool Registry, Connector Runtime, Event Bus, Approval Engine, Scheduler, Memory, CRM,
Content, and Reports systems. It is explicitly **not** a second copy of any of them — every
capability here dispatches to the real system that already does the work. See
`docs/WORKFLOW_ENGINE.md`, `docs/FROST_MULTI_AGENT.md`, `docs/FROST_PLATFORM_COMMAND_CENTER.md`,
`docs/FROST_COMMAND_CANCELLATION.md`, and `docs/FROST_AI_USAGE.md` for the deep dives referenced
throughout this overview.

## Layout

`public/pages/command-center.js` renders five areas: Frost Chat, Live Operations, Data & Context
(Data Inbox + Company Brain), Suggestions, and a System Map card that deep-links into Control
Center's existing Agent Map rather than re-implementing it.

## Frost Chat (`frost_commander`)

A real agent identity (`agents/frost_commander.md`) running through the exact same
`agentRuntime.run()` as every other agent — same permission checks (`levelOf` → `effectiveLevel`
→ `canUseTool`), same tool dispatch, same escalation/approval creation, same audit trail. No
hidden reasoning is stored or shown: only a fixed, human-readable step label per capability and
the final synthesized answer.

### Fixed capability list (Phase 7A base set)

| Capability | Real function | Type |
|---|---|---|
| `company.health.read` | `buildExecutiveReport` + connection health + open escalations/approvals | READ |
| `reports.weekly.read` | `buildExecutiveReport` | ANALYSIS |
| `crm.followups.read` | `listLeads`/`listFollowups` | READ |
| `integrations.health.read` | `listConnections` + health | READ |
| `agents.status.read` / `tools.status.read` | agent-readiness / tool-compatibility functions | READ |
| `context.search.read` | `context_items` query | READ |
| `agent.tool_connection.update` | tool-assignments update, preview + approval + audit | CONFIGURATION |
| `crm.followups.run_sweep` | `sweepFollowupGaps` | AUTOMATION |

A request that doesn't map to a real capability gets an honest "not available yet" answer —
never a fabricated one.

### Phase 7B additions

- **Multi-agent delegation** — `delegate_to_agent`, see `docs/FROST_MULTI_AGENT.md`.
- **Runbooks** — manual, reusable, human-triggered checklists (distinct from Workflows — see
  below).
- **Attachments** — chat file attachments stored as Base64-JSON (see "Attachment approach"
  below), pinnable into Company Brain context.
- **Undo** — reversible configuration changes via `configuration_history`, replaying the inverse
  change through the same real service (not a generic snapshot/restore).
- **Platform Command Center** — see `docs/FROST_PLATFORM_COMMAND_CENTER.md`.

### Phase 7C additions

- **Native Workflow Engine** — `create_workflow_draft`, `list_workflows`,
  `explain_workflow_failure`, `activate_workflow`, `run_workflow_now`, `pause_workflow_now` tools.
  Frost can draft a workflow from natural language but **never auto-activates** it — activation
  and running above L0 require explicit user action/approval. See `docs/WORKFLOW_ENGINE.md`.
- **AI Usage** — see `docs/FROST_AI_USAGE.md`.
- **Command Result Export** — a safe Markdown export per message
  (Command/Summary/Results/Evidence/Timestamp), built entirely from what is already on screen; a
  regex-based check confirms no secret-shaped string ever reaches the exported text. PDF export
  was evaluated and deferred (see Limitations).
- **Tenant-aware Quick Commands** — `deriveQuickCommandKeys(store, tenantId)` in
  `command-health.js` returns stable *keys* (never raw hardcoded phrases) based on real signals:
  a connected e-commerce integration (Salla/Zid, CONNECTED or DEGRADED) yields a commerce-focused
  set; a lead mix that is majority B2B yields a pipeline-focused set; otherwise a generic
  executive set. The frontend maps keys to localized phrases — nothing is hardcoded to a specific
  demo tenant name.
- **Suggestion → Workflow ("Automate")** — `suggestionWorkflowTemplate(suggestion)` generates a
  real draft workflow from a suggestion, but only for the one type currently supported
  (`high_value_lead_waiting`, using the real, already-emitted `LEAD_CREATED`/`LEAD_HOT` events);
  `automatable` is derived from `type` in `hydrate()`, not stored, so it can never drift from what
  the template function actually supports.

## Approvals

The chat's "Approval Required" card is a thin wrapper around the exact existing
`GET /api/approvals?status=PENDING` / `POST /api/approvals/:id/decide` routes — no new approval
table, no separate decision path.

## Live Operations

`GET /api/command/operations` merges `agent_runs` + `workflow_runs` + `audit_logs` into one
tenant-scoped, time-sorted feed, with a server-computed `cancellable` flag per row. The frontend
polls this while the panel is visible (paused when the tab is hidden) since no real-time
push (SSE/WebSocket) exists anywhere in this app — safe polling was an explicitly accepted v1
trade-off from the original Phase 7A scope decision.

## Data & Context

- **Data Inbox** — `GET /api/command/inbox` merges six real, timestamped sources (leads,
  follow-ups, content, escalations, connections, webhook events) — no fabricated rows.
- **Company Brain** — governed context items (`context_items` table) covering
  Identity/Goals/Customers/Products/Brand/Rules, each with real `source`/`created_by`/
  `confidence`/`status` columns. External-sourced context (`source≠'manual'`) is never silently
  overwritten by a chat command — only an authorized human edit changes it, and that edit is
  audited.

## Suggestions

A fixed, evidence-backed v1 rule set (overdue follow-up, unhealthy connection, stale pending
approval, low stock, high-value lead waiting) computed fresh from real state, upserted by a
deterministic id so an already-Accepted/Dismissed suggestion doesn't reappear. Each has an
Evidence drawer showing the exact real records behind the claim, plus Accept/Dismiss/Ask
Frost/Create Task/Automate actions.

## Runbooks vs. Workflows — kept deliberately distinct

| | Runbook | Workflow |
|---|---|---|
| Trigger | Manual, human-initiated | MANUAL, SCHEDULE, or EVENT |
| Persistence | A reusable template/checklist | A persistent, triggerable automation |
| Execution | One-shot, run when a human decides to | Runs on its own once ACTIVE |

They share no backend table — conflating them would either make Runbooks silently automatic
(surprising) or make Workflows require a human to remember to run them (defeats the point).

## Attachment approach — audited and corrected (Release Hardening pass)

**Correction to an earlier version of this document**: attachments are **not** stored as a
Base64-JSON blob in the database. That description only ever applied to the upload *transport*
(`src/runtime/attachments.js`): the client POSTs `{filename, mimeType, contentBase64}` as JSON
because no multipart-parsing dependency exists in this codebase, and adding one for this alone
would be new, security-sensitive surface for a v1 feature. Once received, the server:

1. Validates `mimeType` against a fixed allowlist — PDF, CSV, XLSX, DOCX, TXT, PNG, JPG only
   (`ALLOWED_TYPES`) — and rejects anything else with `415`.
2. Decodes the Base64 payload and rejects it above `MAX_ATTACHMENT_BYTES` (8MB) with `413`; the
   HTTP route itself also bounds the raw request body at `MAX_ATTACHMENT_BYTES*1.4 + 8KB` before
   that check ever runs, so an oversized upload never even fully buffers.
3. Writes the **decoded bytes to a real file** under a **tenant-scoped directory**
   (`data/attachments/<tenantId>/`), named `<random UUID>.<ext>` — never the user-supplied
   filename. The extension is taken from the *validated* MIME type, never from the client's
   filename, so a disguised executable can't ride in on a trusted-looking extension.
4. Keeps the human-readable filename only as DB metadata (`command_attachments.filename`, itself
   passed through `safeBasename()` — no path separators, no `..`, bounded length) — it is never
   used to construct a filesystem path.
5. Only ever reads file *content* back for the two plain-text MIME types (`text/plain`,
   `text/csv`), capped at 20,000 characters, for Frost to reason about. PDF/DOCX/XLSX/PNG/JPG are
   tracked with real metadata only — their binary content is never blindly dumped into an LLM
   prompt (kept honest rather than sending garbled bytes as "text").

This means path traversal, executable upload, and MIME/extension spoofing are all structurally
prevented (allowlist + random on-disk name + MIME-derived extension), independent of whatever a
client claims about the file. See `docs/FROST_COMMAND_CENTER.md`'s Release Hardening findings for
the one real gap this audit found: there is currently no download/serve route for the original
binary — an uploaded file can be referenced and pinned to Company Brain, but not fetched back out
through the app. This is a legitimate feature gap for a future pass, not a security issue.

## Tenant isolation & RBAC

Every table/route follows the same `tenant_id` discipline as the rest of this codebase. RBAC:
any tenant member for READ/ANALYSIS commands; `owner`/`operator` for anything that plans a
CONFIGURATION/AUTOMATION capability or writes a workflow; `owner` only for workflow
activate/pause/resume/archive.

## Known limitations (honest, not silently dropped)

1. **Bulk campaign dry-run / mass send** — no bulk-send/audience-targeting tool exists in this
   codebase; the chat answers honestly that this capability isn't available rather than
   simulating it.
2. **PDF export** — evaluated and deferred; only Markdown export shipped. PDF generation would
   have required a new rendering dependency for marginal benefit over Markdown.
3. **No real-time push** — Live Operations uses safe polling, not SSE/WebSocket (none exists
   anywhere in this app).
4. **Suggestion → Workflow** currently supports exactly one suggestion type
   (`high_value_lead_waiting`); other suggestion types honestly refuse automation rather than
   producing an incorrect workflow.
5. **Base64-JSON attachments** remain the storage approach — adequate for today's use case, not a
   general-purpose file manager (see above).
