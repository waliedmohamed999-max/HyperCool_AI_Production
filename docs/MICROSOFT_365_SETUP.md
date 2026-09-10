# Microsoft 365 (Email + Calendar) Integration Setup

Microsoft 365 is the real email channel for HyperCool: inbound customer emails become CRM
messages on the existing `crm_leads`/`crm_messages` tables (the same model WhatsApp uses —
see [WHATSAPP_BUSINESS_SETUP.md](WHATSAPP_BUSINESS_SETUP.md)), outbound quote/discount/
B2B/legal emails go through the existing L0-L3 approval engine before a real send, and
optional calendar tools (`create_calendar_event`, `get_calendar_availability`) are
restricted to the `frost`/`sales`/`followup` agents only.

Two independent authentication methods exist, exactly like Salla and Meta. **OAuth takes
priority whenever both are configured** (`src/runtime/microsoft-oauth.js`
`resolveMicrosoftAccessToken`).

## Method 1 — Static access token (simplest, manual rotation)

1. Acquire an access token with `Mail.Read`/`Mail.Send` scope by any means (e.g. the
   Microsoft Graph Explorer, or a client-credentials flow if your tenant allows app-only
   mail access for a shared mailbox).
2. `.env`: `MICROSOFT_ACCESS_TOKEN=...`
3. No expiry handling, no refresh, no webhook subscription possible with a static token
   alone — this method is for quick testing of `microsoft_sendEmail`/`sendMail`, not
   production inbound mail.

## Method 2 — OAuth app (auto-refreshing, required for inbound mail + calendar)

### In the Azure Portal (Entra ID app registration)

1. Go to **Azure Portal → Microsoft Entra ID → App registrations → New registration**.
2. Name it (e.g. "HyperCool AI OS"). Under **Supported account types**, choose based on
   which mailboxes should be connectable — "Accounts in this organizational directory
   only" for a single-tenant setup (the common case), matching `MICROSOFT_TENANT_ID` below.
3. Under **Redirect URI**, add a **Web** platform redirect URI set to exactly
   `https://<your-domain>/api/integrations/microsoft/oauth/callback` (must match
   byte-for-byte what you put in `MICROSOFT_REDIRECT_URI` below).
4. Note the **Application (client) ID** and **Directory (tenant) ID** from the Overview
   page.
5. Go to **Certificates & secrets → New client secret**. Copy the secret **value**
   immediately (it is shown once).
6. Go to **API permissions → Add a permission → Microsoft Graph → Delegated permissions**
   and add: `offline_access`, `User.Read`, `Mail.Read`, `Mail.Send`, and — only if you plan
   to enable calendar tools — `Calendars.Read`, `Calendars.ReadWrite`.
7. Click **Grant admin consent** for your organization (required for `Mail.Read`/
   `Mail.Send` in most tenants; a non-admin user will otherwise see a consent failure at
   step "Connect" below).

### In `.env`

```dotenv
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
MICROSOFT_TENANT_ID=...                 # tenant GUID, or 'organizations'/'common'
MICROSOFT_REDIRECT_URI=https://<your-domain>/api/integrations/microsoft/oauth/callback
INTEGRATION_ENCRYPTION_KEY=<32-byte key, hex or base64 — shared with Salla/Meta if already set>
MICROSOFT_ENABLE_CALENDAR=false         # set 'true' only if you granted Calendars.* above
```

Generate the encryption key once (skip if already set for Salla/Meta — it's one shared
key across every integration):
```
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```
This key encrypts the stored OAuth access/refresh tokens at rest (AES-256-GCM) — it never
leaves your host environment, is never in the database or the repo, and is never returned
by any API response (only connection *metadata* — email, display name, scopes, whether
calendar is enabled — is exposed via `GET /api/integrations/microsoft/oauth/status`).

### Connect

1. Owner logs in → `GET /api/integrations/microsoft/oauth/start` (a button on the
   Integrations page links here) → redirects to the Microsoft login/consent screen for the
   mailbox you want connected (this becomes the sending/receiving mailbox for every
   `microsoft_sendEmail` call and every inbound-mail webhook).
2. Approve → Microsoft redirects back to your callback URL with `code`/`state`.
3. The callback exchanges the code for tokens, resolves the connected profile
   (`GET /me`), encrypts and stores the tokens, and redirects to `/#integrations`. The
   connection is now `connected: true` with the mailbox's `email`/`displayName`.
4. Tokens refresh automatically on the next Graph API call once near expiry. If a refresh
   fails (revoked refresh token, revoked admin consent), the integration falls back to
   `MICROSOFT_ACCESS_TOKEN` if one is set, otherwise surfaces as needing reconnection.
5. `POST /api/integrations/microsoft/disconnect` (owner) to revoke locally at any time —
   this also deletes the active mail subscription (see below) so Microsoft stops sending
   notifications to a disconnected app.

## Inbound mail — subscription + webhook

Microsoft Graph has no permanent webhook; it uses a **subscription** that must be
periodically renewed, and verifies deliveries completely differently from Salla (token/
signature) or Meta (HMAC).

```dotenv
MICROSOFT_WEBHOOK_SECRET=<a random secret you choose, at least 32 characters>
```

1. Set the webhook URL to `https://<your-domain>/api/webhooks/microsoft/mail` — this is a
   single endpoint that handles both the validation handshake and real notifications.
2. Once connected via OAuth, call `POST /api/integrations/microsoft/subscribe` (owner
   only) to create the actual Graph subscription on `me/mailFolders('inbox')/messages`,
   using `MICROSOFT_WEBHOOK_SECRET` as the subscription's `clientState`. Graph immediately
   sends a validation request to your webhook URL with a `?validationToken=` query
   parameter, which the app answers by echoing the token back as plain text (this must
   succeed within a few seconds, so the endpoint must already be publicly reachable before
   you call `/subscribe`).
3. **Verification is per-notification, not a body signature**: every notification item
   Graph sends afterward carries back the same `clientState` value, which the webhook
   handler compares against `MICROSOFT_WEBHOOK_SECRET` before touching anything — an item
   with a missing/wrong `clientState` is rejected and never processed.
4. Every notification is deduped against the shared `webhook_events` table (same ledger
   Salla/Meta use) keyed by `subscriptionId:messageId:changeType` — a redelivery is a no-op.
5. **Subscriptions expire after ~70.5 hours (Graph's own hard maximum)** — the internal
   scheduler (`src/runtime/scheduler.js` `renewMicrosoftSubscriptionIfNeeded`, wired into
   the existing `tick()` loop that already runs the daily brief/weekly report/follow-up
   sweep) checks every tick and renews automatically once within 6 hours of expiry. No
   external cron is required as long as the Node process stays running; if it renews with
   an error, that's recorded in the connection's stored metadata for the Integrations page
   to surface, and the subscription is left as-is (not deleted) so a later successful
   renewal can still recover it before it actually expires.
6. On a genuine new-mail notification, the app fetches the real message via Graph
   (`GET /me/messages/{id}`), **skips it silently if `isDraft` is true** (never treats your
   own draft as a customer message), otherwise matches/creates a CRM lead by the sender's
   email (`findOrCreateLeadFromChannel`), records the message (subject, body preview,
   `internetMessageId`, Graph `conversationId` as the thread id), detects opt-out phrases
   the same way every other channel does, and — unless the system is paused — emits
   `CUSTOMER_MESSAGE_RECEIVED` to route it to the Sales/Conversation agent exactly like an
   inbound WhatsApp message.

## Outbound mail — `microsoft_sendEmail` tool + manual send route

- The agent tool `microsoft_sendEmail` (L1+) sends through the connected mailbox via
  `POST /me/sendMail`. Categories `quote`, `discount`, `large_b2b`, and `legal` **always**
  create a real `agent_approvals` row (`action_type: send_marketing_message`, the same
  approval type WhatsApp marketing messages already use) and return
  `WAITING_APPROVAL` — the email is never sent until an owner decides
  `POST /api/approvals/:id/decide`. On `APPROVED`, that same route performs the real send
  synchronously and returns `emailSendResult` in its response; on `REJECTED`, nothing is
  ever sent.
- `category: 'general'` sends immediately (still subject to the lead's `optOut`/
  `humanHold`/missing-email blocks).
- `POST /api/crm/leads/:id/email-send` is the manual, human-initiated equivalent — same
  category/approval rules — for owners composing an email directly from the CRM lead page
  rather than through an agent run.
- A successful send is recorded as an OUTBOUND `crm_messages` row the same way an inbound
  one is, so the full thread (in both directions) is visible on the lead's detail page.
- Read-only tools `search_email_conversation`, `get_email_thread`, `get_recent_replies`
  (L0) let agents check prior context before drafting a reply, all reading from the
  existing CRM message history — no separate email store.

## Calendar (optional, off by default)

Only meaningful with `MICROSOFT_ENABLE_CALENDAR=true` **and** the `Calendars.Read`/
`Calendars.ReadWrite` scopes granted above — otherwise these tools return
`INTEGRATION_REQUIRED`.

- `create_calendar_event` / `get_calendar_availability` — restricted via `allowedAgents`
  to `frost`, `sales`, and `followup` only (enforced both in what the model is shown and
  again, unbypassably, when the tool actually executes). Times are Asia/Riyadh by default.

## Test the connection

`POST /api/integrations/microsoft/test` (owner only) — resolves whichever access method
is active (OAuth or static) and makes one light Graph read call (`GET /me`). Returns
`NOT_CONFIGURED`, `OK`, `AUTH_FAILED`, `RATE_LIMITED`, or `NETWORK_ERROR` — never claims
`OK` without a real successful Graph response.

## Environment variables (reference)

| Variable | Required for | Notes |
|---|---|---|
| `MICROSOFT_CLIENT_ID` | OAuth | Azure app registration |
| `MICROSOFT_CLIENT_SECRET` | OAuth | Azure app registration secret value |
| `MICROSOFT_TENANT_ID` | OAuth | GUID, or `organizations`/`common`; defaults to `organizations` |
| `MICROSOFT_REDIRECT_URI` | OAuth | Must match the Azure app's registered redirect URI exactly |
| `MICROSOFT_ENABLE_CALENDAR` | Calendar tools | `'true'` to request Calendars.* scopes at connect time |
| `MICROSOFT_WEBHOOK_SECRET` | Inbound mail | Your own random secret, used as Graph's `clientState` |
| `MICROSOFT_GRAPH_BASE_URL` | Sovereign clouds only | Defaults to `https://graph.microsoft.com/v1.0` |
| `MICROSOFT_ACCESS_TOKEN` | Static-token fallback | Only for quick testing or as a refresh-failure fallback |
| `INTEGRATION_ENCRYPTION_KEY` | OAuth | Shared with Salla/Meta — one key for all stored OAuth tokens |

## Common errors

- **Consent screen fails / "need admin approval"** — an admin has not granted consent for
  `Mail.Read`/`Mail.Send` yet. Grant admin consent in Azure Portal → API permissions, or
  have a tenant admin complete the OAuth connect flow once.
- **Validation handshake times out at `/subscribe`** — the webhook URL must already be
  publicly reachable over HTTPS before calling `/subscribe`; Graph does not retry the
  handshake.
- **Subscription silently stops delivering after ~3 days** — check
  `GET /api/integrations/microsoft/oauth/status` for a `lastRenewalError` in the stored
  metadata; the scheduler renews automatically but a renewal can fail if the OAuth
  connection itself expired first (reconnect, then re-subscribe).
- **`AUTH_FAILED` on test** — refresh token was revoked (password reset, admin token
  revocation, or the app registration's secret expired) — reconnect via
  `/api/integrations/microsoft/oauth/start`.

## What is NOT built yet (deliberately not rushed this pass)

- **Multi-mailbox / shared-mailbox picker** — one Microsoft 365 connection per HyperCool
  instance (the connected mailbox from step "Connect" above), matching this app's existing
  single-tenant design everywhere else (same as the single-Salla-store, single-Meta-Page
  patterns).
- **A real Queue/Redis layer for webhook processing** — notifications are processed inline
  on receipt, same as Salla/Meta; still no queue anywhere in this codebase.
- **Attachment upload/download for outbound/inbound mail** — the schema has room
  (`attachments` field on the message record) but no code reads/writes real file content
  yet; only metadata plumbing exists.
