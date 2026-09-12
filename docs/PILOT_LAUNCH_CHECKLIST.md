# Pilot Launch Checklist (Multi-Tenant Phase 4C-7)

Companion to `docs/PILOT_RUNBOOK.md`. Work through this once, before onboarding the first real
pilot company.

## Before Launch

- [ ] `npm run production:check` shows **no BLOCKER**.
- [ ] `npm test` — all tests passing (470/470 at the end of this phase).
- [ ] `npm run build` passes.
- [ ] `npm run backup` succeeds, `integrity_check: ok`.
- [ ] A real restore drill performed at least once on a scratch copy (see
      `docs/PILOT_RUNBOOK.md`'s own drill for the reference procedure/timings).
- [ ] `PUBLIC_ORIGIN` set to the real HTTPS domain.
- [ ] `INTEGRATION_ENCRYPTION_KEY` set (32-byte hex/base64).
- [ ] Decide and set `ALLOW_PUBLIC_SIGNUP` / `ALLOW_SELF_SERVICE_WORKSPACE_CREATION`
      (invite-only vs. open, per the actual pilot's intent).
- [ ] Decide and set `PLATFORM_ADMIN_USERNAMES` — at least one real operator account.
- [ ] Decide on Bot Protection: configure `CAPTCHA_PROVIDER`/`TURNSTILE_SECRET_KEY` if the
      pilot is open to public signup at any real scale; acceptable to leave disabled for a
      small, known, invite-only pilot.
- [ ] Review recommended feature flags (`docs/PILOT_RUNBOOK.md`'s section) and set explicitly.
- [ ] `TRIAL_DAYS` / `SELF_SERVICE_MAX_OWNED_WORKSPACES` / `MAX_TOTAL_TRIAL_WORKSPACES` set to
      real, intended pilot values.
- [ ] Platform Mail configured for real delivery (`PLATFORM_RESEND_API_KEY` +
      `PLATFORM_MAIL_FROM`) — **never** `PLATFORM_MAIL_TRANSPORT=capture` in this environment.

## First Signup

- [ ] A real account can sign up publicly (or via invitation, per the chosen policy).
- [ ] The verification email actually arrives (real transport, not `capture`).
- [ ] Verifying the link works and the account becomes workspace-eligible.

## First Workspace

- [ ] `POST /api/workspaces` creates a real, atomic tenant + owner membership + 12 agent
      configs + trial timestamps.
- [ ] The new workspace is immediately active and lands in Guided Onboarding.

## First AI Connection

- [ ] A real Anthropic or OpenAI key can be added and tested through Control Center /
      Onboarding, and at least one agent becomes `READY`.

## First Salla Connection

- [ ] The real OAuth flow (`GET /api/integrations/oauth/salla/start`) completes end-to-end
      for a real store.

## First Agent Run

- [ ] `POST /api/agents/:id/run` (or a real triggered scenario) produces a real, recorded run
      — visible in Agent history.

## First Webhook

- [ ] A real inbound webhook (Salla order, WhatsApp message, or whichever the pilot company
      actually uses) is received, routed to the correct tenant, and recorded idempotently.

## First Scheduled Job

- [ ] The scheduler's next tick runs for the new tenant without error (daily brief /
      follow-up sweep / schedule prepare, depending on time of day).

## First Invitation

- [ ] The tenant's owner invites a real teammate; the teammate receives a real email and can
      accept it, landing in the shared workspace (never redirected toward creating their own
      company).

## Trial Expiry Simulation

- [ ] On a throwaway test tenant (never the real pilot company): set `trial_expires_at` into
      the past, confirm `getTrialStatus` reports `EXPIRED` immediately, confirm the next
      scheduler tick flips it to `SUSPENDED`, confirm its members see the real "Trial Ended"
      state (never a generic dead end), and confirm `#platform` → Extend Trial restores it.

## Backup

- [ ] `npm run backup` runs successfully against the real, now-populated pilot database.

## Restore

- [ ] The restore procedure has been rehearsed (see `docs/PILOT_RUNBOOK.md`) — not necessarily
      against the live pilot data, but the operator running the pilot has done it at least once.

## Sign-off

Once every box above is checked for the specific pilot company being onboarded, the workspace
is ready for real use.
