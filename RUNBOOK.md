# Frost — Operations Runbook

## Incident Severity

| Level | Definition | Examples |
|---|---|---|
| **SEV1** | Critical outage, data loss risk, or security incident | Process down, database corrupted, credentials leaked, auth bypass discovered |
| **SEV2** | Major workflow broken, no safe workaround | Content approval pipeline stuck, CRM lead creation failing |
| **SEV3** | Partial integration issue, workaround exists | Salla sync failing, one agent stuck at FAILED |
| **SEV4** | Minor / cosmetic, non-blocking | UI text issue, non-critical translation missing |

## What To Do When...

### AI provider (Anthropic) is down or credentials expired
- **Symptom**: `GET /health/ready` shows `"llm":"not_configured"` even though a key is set, or agent runs finish `FAILED` with `error` containing `CREDENTIALS_REJECTED`/`NETWORK_OR_TIMEOUT`/`RATE_LIMITED` (`src/runtime/llmProvider.js`'s real error taxonomy).
- **Impact**: content drafting, compliance checks, and agent runs stop. **CRM, team management, calendar, and manual workflows are unaffected** — nothing in this app requires the LLM to be up for core operation.
- **Action**: check the Anthropic account/key. Rotate `ANTHROPIC_API_KEY` in the host's env, restart the process (`SYSTEM_MODE` and everything else is unaffected by a restart — migrations are idempotent).
- Severity: SEV3 (degraded, not down) unless it blocks a time-sensitive approval — then SEV2.

### WhatsApp/Meta/Microsoft/X/LinkedIn misbehaving (real connectors — see DEPLOYMENT.md §9)
- **Fastest mitigation, no credential changes needed**: set `ENABLE_EXTERNAL_MESSAGING=false` (WhatsApp/email sends) and/or `ENABLE_EXTERNAL_PUBLISHING=false` (Meta/X/LinkedIn publishes) in `.env` and restart — this blocks every agent-driven send/publish tool instantly across every platform at once (`src/runtime/feature-flags.js`), without touching any OAuth connection. Manual human sends from the CRM UI are unaffected by this flag on purpose.
- **X token expired/revoked**: `POST /api/integrations/x/test` returns `AUTH_FAILED`; reconnect via `GET /api/integrations/x/oauth/start`. The static `X_BEARER_TOKEN` cannot substitute for this — it is read-only by design (X's API rejects app-only tokens on `POST /2/tweets`).
- **LinkedIn permission missing**: `POST /api/integrations/linkedin/test` returns `CONFIGURED_NO_ORGANIZATION` — the identity connected fine but no Company Page was resolved, almost always because the app isn't yet approved for LinkedIn's Community Management API product, or the connected account isn't an admin of the target Page. See `docs/LINKEDIN_INTEGRATION_SETUP.md`.
- **Microsoft mail stopped arriving**: check `GET /api/integrations/microsoft/oauth/status` for `lastRenewalError` in the stored subscription metadata — the scheduler renews automatically but only if the OAuth connection itself is still valid.
- If the Integrations page shows an unexpected status for any of these, also check `.env` for a typo in the variable name.
- Severity: SEV3 (a single channel down); SEV2 if it blocks a time-sensitive B2B quote reply.

### Salla sync fails
- **Symptom**: `POST /api/salla/sync` returns an error; Integrations page shows the Salla card in `ERROR`.
- **Action**: check `SALLA_ACCESS_TOKEN`/OAuth validity via `POST /api/integrations/salla/test`. Product/price/stock data simply goes stale — nothing else breaks (agents reading `get_current_price`/`get_stock` will serve the last successfully synced snapshot, honestly timestamped, never a fabricated live value).
- Severity: SEV3.

### Publishing fails
- Check `GET /api/planning`'s job list for a `BLOCKED`/`FAILED`/`STATUS_UNKNOWN` status and `blockReason`/audit entry (`X_PUBLISH_FAILED`, `LINKEDIN_PUBLISH_FAILED`, etc. in Operations Log).
- **`STATUS_UNKNOWN`**: a genuine timeout/network failure with no confirmed outcome — never blindly retried (would risk a duplicate post). A P2 escalation is opened automatically for human review; check the target platform directly (X/LinkedIn) for whether the post actually went through before manually retrying.
- **`FAILED`**: a real API rejection — the audit entry's error code (`AUTH_FAILED`/`PERMISSION_MISSING`/`RATE_LIMIT`/`INVALID_CONTENT`) says why; content stays `APPROVED` and safe to re-attempt once fixed (still protected by the same idempotency check — an item that somehow did publish will short-circuit to `ALREADY_PUBLISHED` instead of double-posting).
- Severity: SEV3; SEV2 if it's a time-sensitive campaign.

### Queue stuck
- Not applicable — there is no queue. If background work seems stuck, check the scheduler instead (`GET /api/frost/status` → `schedulerRunning`).

### Database slow / locked
- SQLite in WAL mode allows concurrent readers with one writer; a "database is locked" error usually means a long-running write transaction. Check `store.mutate()` callers aren't doing slow work (network calls) inside a transaction — none should be, by design (`src/store.js`'s `mutate()` wraps only synchronous state mutation).
- If it persists: `PRAGMA integrity_check` against the live file (read-only connection, do not lock the writer) to rule out corruption.
- Severity: SEV1 if writes are failing app-wide, SEV3 if isolated/transient.

### Webhook invalid
- No webhook receiver exists yet — see DEPLOYMENT.md. If you've since built one, verify signature-checking and idempotency (`provider_event_id` dedup) were added per Phase 8 of the original ask before treating any inbound payload as trusted.

### Agent run loop / stuck
- Every agent run is bounded (`maxTurns` in `src/runtime/llmProvider.js`'s tool-use loop) — a true infinite loop shouldn't be possible. A "stuck" run more likely means `status='RUNNING'` with no `finished_at` after a crash mid-run.
- **Action**: `GET /api/agents/:id/runs` to find it, then use `POST /api/frost/pause` to stop new autonomous runs while you investigate; the pause gate stops both the scheduler and event-triggered orchestration immediately (tested).
- Severity: SEV2 if it's consuming API quota unbounded, SEV3 otherwise.

### High AI cost
- `agent_runs` already records `tokens_input`, `tokens_output`, and `estimated_cost` per run. Query it directly:
  `SELECT agent_id, SUM(estimated_cost), COUNT(*) FROM agent_runs WHERE started_at >= date('now','-1 day') GROUP BY agent_id;`
- The per-user LLM rate limiter (20 calls/10 min on `/api/ai/draft`, compliance checks, and manual agent runs — `src/application.js`) caps runaway *manual* usage; the follow-up sweep's per-tick lead count is currently uncapped (see Blockers in the final report) — if cost spikes trace back to it, temporarily lower `SCHEDULER_INTERVAL_MS`'s effective frequency or pause via `/api/frost/pause`.
- Severity: SEV2 (money, not data).

### Failed migration
- Migrations here are additive-only `ALTER TABLE`/`CREATE INDEX IF NOT EXISTS` run at every startup — a "failed migration" means the process failed to start. Check the startup log for the exact SQL error, restore from the last backup if the file is now in an inconsistent state, and never hand-edit the schema outside the code path.
- Severity: SEV1 (process down).

### Critical compliance issue (bad claim published, medical/price claim slipped through)
- The compliance agent BLOCKs on detected issues and records them (`compliance_runs` table) — a slip-through means either the check wasn't run or a human overrode it at approval. Pull `GET /api/content/:id/compliance` for that item's full check history, and `GET /api/audit` (Operations Log) for who approved it and when — every approval is attributed to a real user id, never anonymous.
- Severity: SEV1 if published externally (not currently possible — no real publish connector exists); SEV2 if only internally visible.

## Backup Failure Alert
If `npm run backup` (or your cron wrapper around it) exits non-zero, or the script's own integrity check fails and it deletes the bad backup, **this must be logged somewhere a human will see it** — pipe cron's output to the Operations Log's audit trail or your monitoring email, since nothing in-app currently surfaces a failed backup on its own. Treat two consecutive failed backups as SEV2.
