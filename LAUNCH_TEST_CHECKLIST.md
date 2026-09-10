# Launch Test Checklist

Manual verification to run against a real deployment before/after each safe-launch stage
(see DEPLOYMENT.md §8 for `SYSTEM_MODE`/feature-flag context). Check items off as a real
human action against the live app — this is not a substitute for `npm test`, it verifies
things automated tests cannot (real credentials, real browser rendering, real timing).

## Admin / Auth
- [ ] First owner setup works exactly once (`POST /api/setup`); a second attempt is refused.
- [ ] Login / logout works; wrong password is rejected without leaking whether the username exists.
- [ ] Session expires and requires re-login.
- [ ] Cannot demote/suspend/remove the last active owner (try it — expect a clear error, not a crash).
- [ ] `SYSTEM_MODE=PRODUCTION_SAFE` actually caps every agent at L1 (check `GET /api/agents/:id/health` or attempt an L2 tool call).

## CRM
- [ ] Create a lead manually; edit stage; search finds it by name/phone/email.
- [ ] Opt-out phrase from a real inbound message sets `optOut=true` and stops follow-ups.
- [ ] Human-hold on a lead blocks any automated send while still allowing manual replies.

## Agents (all 12)
- [ ] Every agent shows in Team/Agents page with its real stored autonomy level (default L0).
- [ ] Promote one agent L0→L1 (should succeed); attempt L1→L2 with `ENABLE_L2_AUTONOMY` unset (should be refused with a clear error naming the flag).
- [ ] Set `ENABLE_L2_AUTONOMY=true`, restart, retry the same promotion (should now succeed).
- [ ] Disable one agent (`setEnabled`) and confirm a trigger for it is recorded as `CANCELLED`/`AGENT_DISABLED`, never silently dropped.
- [ ] Trigger a manual test run for at least one agent that has no integration configured — confirm it fails safely (`NOT_CONFIGURED`/tool `INTEGRATION_REQUIRED`), no crash.

## Salla
- [ ] `POST /api/integrations/salla/test` reports `OK` only with a real working token.
- [ ] "Sync from Salla" pulls real products with real prices/stock — no fabricated data if the account has zero products.
- [ ] Disconnect, confirm status becomes `NOT_CONFIGURED`, confirm previously-synced products are NOT deleted.

## WhatsApp
- [ ] Real inbound message creates/updates a CRM lead and appears in its message thread.
- [ ] Send is blocked outside the 24h customer-service window unless a template is used.
- [ ] Set `ENABLE_EXTERNAL_MESSAGING=false`, confirm `whatsapp_send` returns `FEATURE_DISABLED` and no message actually sends; confirm a human can still reply manually from the CRM UI.

## Meta (Instagram/Facebook)
- [ ] OAuth connect resolves a real Page (and Instagram account if linked); status page shows real names, never placeholders.
- [ ] `meta_publish` on an `APPROVED` item with `ENABLE_EXTERNAL_PUBLISHING=true` produces a real `externalPostId`/`liveUrl`; the same call again reports `ALREADY_PUBLISHED`, never a duplicate post.

## Microsoft 365
- [ ] OAuth connect resolves the real mailbox; `POST /api/integrations/microsoft/subscribe` creates a real Graph subscription (needs a public HTTPS URL — will fail on localhost, that's expected).
- [ ] A real inbound email creates/updates a CRM lead; a draft in the same mailbox is never ingested as a customer message.
- [ ] A `quote`/`discount`/`large_b2b`/`legal` email via `microsoft_sendEmail` always creates a `WAITING_APPROVAL` approval — never sends immediately regardless of flags.

## X
- [ ] OAuth (PKCE) connect resolves the real account (`username` shown, never blank).
- [ ] `POST /api/integrations/x/test` distinguishes `OK` (OAuth connected) from `CONFIGURED_READ_ONLY` (bearer-only) — confirm the read-only case truthfully cannot publish.
- [ ] A real `x_publish` on approved `platform: 'X'` content produces a real tweet id/URL you can open in a browser.

## LinkedIn
- [ ] OAuth connect resolves identity; if the Community Management API product isn't approved yet, status correctly shows `publishingCapable: false` rather than a fake success.
- [ ] Once approved and an organization resolves, `linkedin_publish` posts to the **Company Page**, never a personal profile — verify this visually on linkedin.com.
- [ ] Analytics call honestly returns `NOT_AVAILABLE` if your app lacks the separate analytics approval — never a simulated number.

## Approvals
- [ ] A pending approval is visible to the owner; approve/reject both work and are logged.
- [ ] Approving a `send_marketing_message` approval (email) actually sends and records the outbound message; rejecting never sends.
- [ ] No route lets a non-owner bypass an approval directly.

## Content & Calendar
- [ ] Full pipeline: draft → compliance review → owner approval → schedule → (scheduler tick or manual `/api/schedule/prepare`) → `READY_FOR_CONNECTOR` → real publish → `PUBLISHED` with a real external id, visible in the Content dashboard's PUBLISHED column.
- [ ] Rejecting an already-scheduled item cancels its job immediately (check `GET /api/planning`).
- [ ] With `ENABLE_SCHEDULED_PUBLISHING=false`, a due job still reaches `READY_FOR_CONNECTOR` but never triggers a real publish attempt.

## Reports & Operations Log
- [ ] Weekly report generates with real numbers (zeros are fine and expected on a fresh instance — never fabricated activity).
- [ ] Operations Log filters by actor type (agent/human/system/integration) and status (Success/Failed/Blocked/Waiting Approval/Escalated).
- [ ] Every real external action (send/publish/OAuth connect) has a matching Operations Log entry with a timestamp and actor.

## Arabic QA (default)
- [ ] Sidebar on the right, tables/forms/drawers/modals/calendar/toasts all read correctly RTL.
- [ ] No leftover English placeholder text in any Arabic screen you actually use.

## English QA
- [ ] Switch to English: sidebar moves left, no leftover Arabic strings, no broken/overflowing widths.
- [ ] Switch language, refresh the page — the choice persists.

## Mobile / Tablet
- [ ] Navigation, tables, drawers, forms, CRM inbox, agent cards, and the approval center are all usable at a real phone width (not just resized desktop Chrome — test an actual device or device emulation).

## Kill switch
- [ ] `PAUSE_ALL_AUTOMATION` (Frost Control Center "Pause") stops scheduler-driven runs, event-triggered agent runs, and automation-token routes — confirm with a real pending follow-up/publish that it does NOT fire while paused, and resumes correctly after unpausing.
