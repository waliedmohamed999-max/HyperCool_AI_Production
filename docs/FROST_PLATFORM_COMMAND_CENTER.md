# Platform Command Center Chat ("Platform Frost") (Phase 7C)

`src/runtime/platform-frost.js` — `installPlatformFrostChat`, `listPlatformFrostMessages`,
`sendPlatformFrostMessage`.

## This is not tenant Frost

Platform Frost is a genuinely separate chat surface for platform administrators, restricted to
**platform-aggregate-only** data: tenant counts, system health, integration health, failed jobs,
dead letters, reauth counts, scheduler state. It can never reach a single tenant's business data
(leads, content, CRM records, workflows) — there is no code path from Platform Frost into any
tenant-scoped table.

## Why it deliberately does not reuse `createAgentRuntime()`

`AgentRuntime` (`runtime.js`) is built entirely around one real `tenant_id`: config lookup, tool
assignment resolution, approval gating, and `agent_runs` persistence are all tenant-scoped by
design. There is no "platform tenant" row, and there shouldn't be one — inventing one would
either weaken tenant isolation (a fake tenant with special privileges is still a tenant row other
code could accidentally query) or literally become a second, parallel agent system for a
different scope, which the Phase 7C spec explicitly forbids.

Instead, Platform Frost reuses the one genuinely tenant-agnostic layer that already exists:
`createLLMProvider(...).run()`, called directly with:

- A **fixed, 3-tool, read-only registry** (platform aggregate reads only — no write tools exist
  in this registry at all).
- Validation via `validateAgentDecision('platform_frost', ...)` against a new payload schema
  (`payload-schemas.js`: `{answer, data_sources}`) — deliberately **not** registered in
  `domain.js`'s `agents` array, so `platform_frost` can never appear as a tenant-selectable agent
  or show up in any tenant-facing agent list.

## Storage

Its own small, separate table (`platform_frost_messages`), not `command_messages` — a different
table for a different chat, matching the "never leak by shared storage" principle already used
for tenant isolation everywhere else in this codebase.

## Auditing

Every Platform Frost command is recorded via `recordPlatformAudit` — a platform-level audit
trail, separate from tenant `audit_logs`, so a platform admin's own actions are traceable without
mixing into any tenant's audit history.

## HTTP surface

```
GET  /api/platform/frost/messages     platform admin only
POST /api/platform/frost/messages     platform admin only — {text}
```

Both routes require the existing platform-admin check (the same one gating every other
`/api/platform/*` route) — a regular tenant owner/operator cannot reach this chat at all.

## Verified isolation (tests)

`tests/platform-frost.test.js` (3 tests):
1. A real aggregate answer is produced with no tenant PII anywhere in the response.
2. An honest "AI not configured" failure when no AI connection exists — never a fabricated
   answer.
3. Every Platform Frost command is audited.

The mandated Platform Chat E2E (spec item 90) additionally confirms, through a real browser
session: the widget shows real scheduler/health status, Platform Frost never leaks a seeded
tenant's business data (e.g. a specific lead name) into its answer even when a tool result would
technically make that data reachable in-process, and every command produces a platform audit row.

## UI

`public/pages/platform.js`'s `renderPlatformCommandCenter` adds a chat panel
(`#pfcc-chat-form` / `#pfcc-chat-messages`) using its own CSS classes
(`.pfcc-message-user` / `.pfcc-message-assistant`) — deliberately **not** reusing
`command-center.js`'s `.cmdc-message-*` classes, since both chats can be present in the DOM at
once (a `[hidden]` page's elements are not removed from the DOM) and a shared class name would
let a page-global selector accidentally pick up the wrong chat's bubbles.

## Known limitations

- Read-only: Platform Frost cannot take any configuration action on the platform's behalf yet
  (no write tools in its registry) — it answers questions and surfaces aggregate state only.
- Like tenant Frost, it depends on a configured AI connection; with none configured it degrades
  to an honest inline explanation rather than a broken chat.
