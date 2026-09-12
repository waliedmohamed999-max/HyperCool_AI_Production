# Pilot Support Playbook (Phase 5, Part 35)

Common real support situations during the pilot, and the actual, verified mechanism behind
each — not a generic script. Every reference here points at real code/behavior already built
and tested in earlier phases, not a guess.

## "I never got the verification email"

- Confirm `PLATFORM_MAIL_TRANSPORT` on the real server is **not** `capture` (that transport
  never sends — it only stores the body in `platform_mail_outbox` for local testing, per
  `docs/PILOT_LAUNCH_CHECKLIST.md`). A real pilot must use `PLATFORM_RESEND_API_KEY` +
  `PLATFORM_MAIL_FROM`.
- The user can trigger a fresh send themselves — the workspace-selection gate's
  "verify your email first" state has a real, working resend button
  (`components/workspace-switcher.js`).
- Check spam/junk — no code-side control over this.

## "My AI key says invalid" / an agent won't run

- The connection test result (`Control Center` → AI connection) reports the real provider
  rejection, never a generic failure — ask the user for the exact status shown.
- `evaluateAgentReadiness` (`src/runtime/agent-readiness.js`) is the real source of truth for
  why a specific agent isn't `READY` — check `GET /api/agents/:id/health` for that tenant.

## "Salla OAuth failed"

- The OAuth callback route surfaces the real, safe error code — never a raw provider stack.
- Confirm the pilot tenant's Salla app credentials/redirect URI match `PUBLIC_ORIGIN` exactly —
  a mismatch is the most common real-world cause.

## "An agent is blocked / a capability is missing"

- `readiness.optional_missing` (surfaced to the model itself, Part 35 of an earlier phase) is
  also visible to a human via the agent's own health/readiness view — the same real signal.
- Confirm the required tool's connection is actually `CONNECTED` (not `DEGRADED`/`ERROR`) via
  Control Center.

## "My trial expired" / "My workspace says suspended"

- `getTrialStatus()` (`src/tenancy.js`) is the real, live-derived state — never a stale flag.
  Confirm what it actually reports for that tenant via `#platform` → tenant detail.
- Data is never deleted on expiry — confirm this explicitly to the user (see
  `docs/TRIAL_EXPERIENCE.md`).
- Only a Platform Admin can extend a trial or reactivate a suspended tenant (`#platform`) — both
  actions are audited (`TRIAL_EXTENDED`, tenant status change).

## "My invitation link expired / doesn't work"

- Invitation tokens are real, single-use, and expiring (`src/invitations.js`) — the owner must
  send a new one; there is no "resend the same link" path by design (a new token is always
  issued).
- Confirm the invitee is using the exact emailed link — a copy/paste error is the most common
  real-world cause of an "invalid token" report.

## General diagnostic starting point for ANY report

1. `GET /health/ready` — is the core system healthy right now?
2. `#platform` → tenant detail for the affected tenant — real, live state, not a guess.
3. The structured request logs' `request_id` for the specific failing request, if the user can
   provide roughly when it happened.
