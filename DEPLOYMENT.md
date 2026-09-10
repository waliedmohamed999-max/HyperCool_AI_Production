# HyperCool — Deployment Guide

## 1. Architecture (as it actually exists in this codebase)

**Monolith, single Node.js process, no separate frontend build.**

- Entry point for shared/LiteSpeed-style cPanel hosting: `app.cjs` (CommonJS, `require()`-loadable) → dynamically imports `src/application.js`'s `startServer()`.
- Entry point for a plain Node host (Docker, systemd, PM2, etc.): `src/server.js` → same `startServer()`.
- `src/application.js` is the entire backend: one `http.createServer` handling both the JSON API (`/api/*`) and static file serving (the `public/` frontend — plain ES modules, no bundler, no build step beyond a syntax check).
- **Database**: a single SQLite file (`node:sqlite`, WAL mode) at `DATA_DIR/hypercool.sqlite`. No separate DB server, no ORM.
- **Background jobs**: an in-process `setInterval` loop (`src/runtime/scheduler.js`), not a queue. Runs the daily brief, weekly report, and follow-up sweep on the same process that serves HTTP requests.
- **Queue / Redis**: none exist. There is no `bullmq`/`redis` dependency anywhere in this repo.
- **Webhooks**: no inbound webhook receiver endpoint exists yet (checked: no `/api/webhooks/*` route). `SALLA_WEBHOOK_SECRET` is only read for the Integrations page's "configured" flag today — building the real receiver is future work, not something this pass fabricated.
- **Static assets**: served directly by the same process from `public/`, matched against an explicit allowlist map in `application.js` (no wildcard directory serving).

This means: **one process to deploy, one file to back up, one port to health-check.** There is nothing to horizontally scale without first adding a shared session/lock store — see §10.

## 2. Prerequisites

- Node.js ≥ 24.11.0 (uses `node:sqlite`, still experimental — expect the startup warning, it's harmless).
- A persistent directory for `DATA_DIR`, outside whatever folder your host replaces on each deploy.
- (Optional, per integration) real credentials — see `.env.example`.

## 3. Environment Configuration

Copy `.env.example` to `.env` and fill in what you have. **Nothing is required for the core app to start** — CRM, content, team management, and the dashboard all work with zero configured integrations. Missing optional-integration variables are logged clearly at startup (`REQUIRED_FOR_OPTIONAL_INTEGRATION — ...`), never a crash.

Set `SYSTEM_MODE=PRODUCTION_SAFE` for your first launch — see §8.

## 4. Database Setup & Migrations

There is no separate migration command. Every table/index is created with `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, and every column added since first release is added with a guarded `ALTER TABLE ... ADD COLUMN` (checked against `pragma_table_info` first). **All of this runs automatically, in order, every time the process starts** (`openStore()` in `src/store.js`, plus each domain module's own `install*(db)` call in `createApp()`). Migrations are additive-only — nothing in this codebase drops a column or table.

**Migration checklist before any deploy that changes schema:**
1. Confirm the new migration is additive (`ADD COLUMN`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`) — never a `DROP`/destructive `ALTER`.
2. Test it against a **copy** of production data first (`cp` the `.sqlite`/`-wal`/`-shm` files to a scratch path, point `DATA_DIR` at the copy, start the app, confirm `PRAGMA integrity_check` still reports `ok` and existing rows survive).
3. Back up production (`npm run backup`) immediately before restarting with the new code.
4. Restart, then re-run `PRAGMA integrity_check` against the real `DATA_DIR` and confirm the owner account still logs in.

## 5. Build & Start

```
npm run build   # node --check on all 3 entry points — fails fast on a syntax error
npm test        # 149 tests, must be green
npm start       # node app.cjs — starts the server and the in-process scheduler
```

No bundler, no transpile step. The "build" is a syntax check, by design (plain ES modules served as-is).

## 6. Health Checks

- `GET /health`, `GET /health/live` — process liveness, no auth. Always `200` if the process can respond at all.
- `GET /health/ready` — `200` + `{"status":"ready"}` if the database is reachable; `503` + `{"status":"not_ready"}` otherwise. Also reports `dependencies.scheduler`, `dependencies.llm`, and `dependencies.integration_*` (`configured`/`not_configured`) — **an unconfigured optional integration never fails readiness**, only a broken database does.

Point your load balancer / uptime monitor's liveness probe at `/health/live` and readiness probe at `/health/ready`.

## 7. Backups & Restore

```
npm run backup                       # backs up $DATA_DIR to $DATA_DIR/backups (or set DATA_DIR/BACKUP_DIR)
node scripts/backup.mjs <dataDir> <backupDir>
node scripts/restore.mjs <backup-file> [dataDir]
```

- `backup.mjs` uses SQLite's `VACUUM INTO` (atomic, safe against a live WAL writer — never a torn file copy), then verifies `PRAGMA integrity_check` on the copy before keeping it. Retention: last 7 daily, last 4 weekly, last 3 monthly.
- `restore.mjs` verifies the backup's integrity **before** touching anything, moves the current live file aside (never deletes it), restores, then re-verifies. Both scripts were run end-to-end against a scratch database this session, including a simulated corruption + restore, and produced a verified `integrity_check: ok` result at every step.
- Schedule `npm run backup` daily via cron/Task Scheduler/your host's job runner — nothing in-process runs it automatically today.
- **Restore is documented above and was tested on a throwaway database. It was deliberately not run against real production data — do that only when you actually need it, or once against a copy if you want the extra confidence.**

## 8. Launch Safety (`SYSTEM_MODE`)

`SYSTEM_MODE=PRODUCTION_SAFE` caps every agent's effective autonomy at **L1** at execution time, regardless of what's stored in the audited autonomy ledger — an owner can still view/set L2/L3 in the Team/Agents UI, it simply won't take effect until `SYSTEM_MODE` is raised (or unset). This is a real, tested runtime gate (`src/runtime/permissions.js:effectiveLevel`), not cosmetic. Leave it unset in development/staging so existing test/manual-QA flows keep working unmodified.

**Recommended rollout:** launch with `SYSTEM_MODE=PRODUCTION_SAFE`. After each agent has ≥14 clean days (the app already computes this — `GET /api/agents/:id/health`), an owner can deliberately raise `SYSTEM_MODE` or promote that agent's stored level.

## 9. Integration Activation Order

1. **Anthropic** — everything else (compliance checks, content drafts, agent runs) needs this first.
2. **Salla** — product/price/stock data other agents read.
3. WhatsApp, Meta, Microsoft 365, X, LinkedIn, Canva — **none have real connector code yet**; setting their tokens only makes the Integrations page's status accurate, it does not enable real sending/publishing (every send/publish tool handler is currently a hard-coded stub — see `src/runtime/tools.js`). Do not deploy expecting these to work; they're honestly reported as `NOT_CONFIGURED`/blocked either way.

## 10. Known Single-Instance Limits (be aware before scaling out)

- Login rate limiting and the AI-call rate limiter are in-memory `Map`s — fine for one process, reset on restart, **not shared** if you ever run more than one instance behind a load balancer.
- The scheduler has no cross-instance lock — running two instances would double-fire the daily brief/weekly report/follow-up sweep. Stay single-instance, or add a lock before scaling out.
