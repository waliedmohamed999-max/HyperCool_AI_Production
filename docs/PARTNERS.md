# Frost Partners (partnership program)

A self-contained partner/affiliate program: public landing, application flow, partner portal, referral
tracking, a commission ledger, payouts, marketing assets and a dashboard admin page. Everything is
real data in SQLite; nothing is mocked or seeded except the three editable starter plans.

## Where things live

| Area | Files |
|---|---|
| Backend domain | `src/partners/{core,schema,plans,access,referrals,partners,applications,commissions,payouts,assets,analytics,mail,index}.js` |
| HTTP surface | `src/partners/routes.js` (mounted in `src/application.js` before the workspace pipeline) |
| Partner portal (SPA) | `public/partners.html`, `public/partner-portal/*` (own i18n in `i18n/{ar,en}.json`) |
| Admin (dashboard) | `public/pages/partnerships.js`, hash route `#partnerships`, locale domain `partnerships` |
| Tests | `tests/partners-core.test.js` (domain), `tests/partners-program.test.js` (HTTP), `tests/e2e/partners-journey.e2e.mjs` (browser) |

## Routes

Public pages (all serve `partners.html`): `/partners`, `/partners/login`, `/partners/register`.
Signed-in pages: `/partners/onboarding|dashboard|referrals|customers|commissions|payouts|marketing|settings`.
Referral links: `GET /r/:code` (sets the `frost_ref` cookie, 302 to the link's landing path).
API: `/api/partners/*` (partner + admin), `POST /api/webhooks/partner-billing` (HMAC).
Admin UI: `/app#partnerships` (tabs: overview, applications, partners, plans, commissions, payouts, marketing assets, settings).

## Roles and authorization

`user` (any account) → `partner` (has a `partner_profiles` row) → `partner_manager` (row in `partner_staff`,
per-permission: `applications, partners, commissions, payouts, plans, assets`) → `admin`/`owner`
(platform admins from `PLATFORM_ADMIN_USERNAMES`, all permissions plus `settings` and `staff`).
A workspace owner is **not** a program admin. The partner id always comes from the session; no route
accepts a partner id from a partner. Ownership is re-checked on every object (payouts, links, receipts).
Writes need the session CSRF header. The portal's UI gating is cosmetic; the server enforces everything.

## Plans → features (single source of truth)

Partner plans live in `partner_plans` (price, billing period, default commission in basis points, hold
days, commission window, min payout, limits, `entitlements_json`). Feature keys:
`partner.dashboard, referrals, customers, commissions, payouts, marketing_assets, analytics, export_data,
custom_branding, team_members`. `entitlementsFor(db, profile)` is the only resolver; routes call
`requireEntitlement(...)` and answer `403 ENTITLEMENT_REQUIRED | PLAN_EXPIRED | PARTNER_SUSPENDED`.
When a subscription period ends the partner becomes **limited** (keeps dashboard, customers, commissions,
payouts; loses the rest) — data is never deleted. Renewing restores everything. `sweepSubscriptions`
marks lapsed periods `expired` and notifies 7 days ahead. Three starter plans (Starter 20%, Professional
25%, Elite 30%; price 0, assigned by staff) are created only when the table is empty and are fully editable.

> Frost has no partner checkout/payment gateway yet, so plan periods are set by staff (or trial days),
> not bought by the partner.

## Referral lifecycle

1. Partner approval creates: profile, unique 8-char referral code, default link, plan subscription.
2. `GET /r/CODE` → `trackClick`: dedupes refreshes (30 min), rate-limits per IP hash (flagged visits are
   not counted), sets `frost_ref` (HttpOnly, SameSite=Lax, window = `attribution_window_days`).
3. Signup (`/api/signup` or `/api/partners/register`) → `attributeRegistration` decides **on the server**
   from the cookie (a made-up cookie value matches no visit). Rejections stored as `rejected` referrals:
   `self_referral`, `suspicious_volume`, `plan_limit_reached`. Statuses: clicked/registered/qualified
   (email verified)/converted (first commission)/rejected/cancelled.
4. Admin can `cancel` a referral (reason required) — open commissions are reversed, paid ones clawed back.

## Commission ledger

Money is integer minor units, rates are basis points, half-up integer math (`computeCommission`).
`commission_ledger` is append-only (DB triggers reject UPDATE/DELETE); balances are always
`SUM(amount) GROUP BY bucket`; there is no balance column. Buckets: `pending → available → reserved → paid`.

* Accrual: a `payment_succeeded` billing event for a referred customer creates a `commissions` row
  (rate snapshot) and a `pending` ledger entry. Rate = partner custom rate ?? plan rate.
  Skipped with a recorded `result` when: customer unknown, not referred, partner suspended/closed,
  currency ≠ program currency, outside the commission window, zero amount.
* Review: `commission_review = manual` (default) → `pending` until staff approve; `auto` → `approved`.
  Approved commissions move to `available` when `hold_until` passes (`releaseDueCommissions`, run lazily).
  Staff can hold / release / reject (reason). Statuses: pending, on_hold, approved, available, rejected, cancelled, paid.
* Refunds / failed payments: proportional reversal (`reversal` from pending, or `clawback` from available
  when already released/paid, so future earnings absorb it). Fully reversed → `cancelled`.
* Idempotency: `billing_events` is unique on `(source, external_id)`; replays return the stored result.

### Feeding payments in

* Webhook: `POST /api/webhooks/partner-billing`, header `x-frost-signature: sha256=<hex HMAC-SHA256 of raw body>`
  with `PARTNER_BILLING_WEBHOOK_SECRET`. Body: `{id, type: payment_succeeded|payment_failed|refund, customer:{email|userId}, planRef, amountMinor, currency, occurredAt, refersTo}`.
* Manual: dashboard → Partnerships → Commissions → Billing events (amount typed as `120.50`, converted on the server).

## Payouts

Methods (bank transfer / PayPal / other, configurable in settings) are encrypted with AES-256-GCM
(`INTEGRATION_ENCRYPTION_KEY`, via `src/runtime/crypto.js`); the API returns only a masked value.
A request needs: verified email, `partner.payouts`, an active method, balance ≥ minimum, no other open
request. It picks whole commissions oldest-first up to the requested/withdrawable amount and moves the
amount `available → reserved`. States: requested → under_review → approved → processing → paid, or
rejected / cancelled (funds return). Marking paid needs a payment reference and moves
`reserved → paid`; staff can upload a receipt (PDF/PNG/JPEG ≤ 2 MB, magic bytes verified). Staff viewing
the decrypted destination is audited (`PAYOUT_DETAILS_VIEWED`).

## Settings (dashboard → Partnerships → Settings)

Attribution window, commission window, hold days, minimum payout, currency, open vs invite-only
registration, manual vs auto application approval (auto = verified applicant + free plan only),
commission review mode, enabled payout methods, anti-fraud limits, email notifications, terms text/version
(stored with each application). **No legal text is shipped**: paste your own terms in the settings.

## Database (additive, `installPartners`)

`partner_settings, partner_plans, partner_staff, partner_invites, partner_applications, partner_profiles,
partner_subscriptions, partner_campaigns, referral_links, referral_visits, referrals, billing_events,
commissions, commission_ledger, payout_methods, payout_requests, payout_commissions, payout_receipts,
partner_marketing_assets, partner_admin_notes, partner_audit_logs, partner_notifications`.
No existing table is altered except an idempotent rebuild of `platform_mail_outbox` to allow the
`PARTNER_NOTICE` kind (existing rows preserved). Down-migration: `uninstallPartners(db)` (drops only these tables).

## Environment

| Variable | Purpose |
|---|---|
| `PARTNER_BILLING_WEBHOOK_SECRET` | HMAC secret for the billing webhook (unset → 503; manual recording still works) |
| `INTEGRATION_ENCRYPTION_KEY` | already used by the vault; partners cannot save payout methods without it |
| `PLATFORM_ADMIN_USERNAMES` | comma list of program admins |
| `PLATFORM_MAIL_*` / `PLATFORM_RESEND_API_KEY` | optional; partner e-mails are best-effort, in-app notifications are the durable channel |

## Security notes

Server-side money math only (browser sends `"120.50"` / `"25"`), CSRF on all writes, session-derived ids,
per-object ownership checks, masked customer PII for partners, XSS-safe DOM building in the portal and
`escape()` in the dashboard, CSV export neutralises formula injection, uploads validated by type, size and
magic bytes and served with `Content-Security-Policy: sandbox`, append-only audit log for staff actions.
