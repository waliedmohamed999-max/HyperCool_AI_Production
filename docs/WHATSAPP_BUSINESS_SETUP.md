# WhatsApp Business Setup

WhatsApp rides on the same Meta OAuth connection as Instagram/Facebook — see
`docs/META_INTEGRATION_SETUP.md` first for the App/OAuth/webhook basics. This doc covers
what's specific to WhatsApp.

## 1. WhatsApp Business Platform

1. In your Meta App, add the **WhatsApp** product.
2. Meta gives you a test phone number automatically for development; for production, add
   your own number under WhatsApp → API Setup → Phone Numbers.
3. Note the **Phone Number ID** and **WhatsApp Business Account ID** — the OAuth connect
   flow resolves these automatically (`exchangeCodeAndResolveAssets` in
   `src/runtime/meta-oauth.js`) if your connected Page owns the WABA; if not, set them
   manually:
   ```dotenv
   WHATSAPP_PHONE_NUMBER_ID=...
   WHATSAPP_BUSINESS_ACCOUNT_ID=...
   ```

## 2. Two ways to authenticate (same as Salla's pattern)

- **OAuth** (recommended): connect Meta via `docs/META_INTEGRATION_SETUP.md` — the Page
  access token doubles as the WhatsApp bearer token in this app's connection model.
- **Static token**: `WHATSAPP_ACCESS_TOKEN` (a System User token from Meta Business
  Settings, or a temporary token during development). OAuth takes priority whenever both
  are configured (`resolveMetaAccessToken(..., 'whatsapp')`).

## 3. Webhook

Same endpoint as Meta's messaging webhook: `POST /api/webhooks/meta/whatsapp` (see the Meta
doc for verify-token/signature setup). Subscribe to the `messages` field on your WhatsApp
Business Account. Inbound flow, exactly:

```
Meta webhook → verify signature → normalize (src/runtime/meta-webhooks.js)
 → find-or-create CRM lead by phone (src/crm.js findOrCreateLeadFromChannel)
 → record the message (recordChannelMessage) — deduped by WhatsApp's own message id
 → CUSTOMER_MESSAGE_RECEIVED event → Frost → Sales Agent (existing orchestrator route,
   unchanged) → real Salla price/stock tools → structured reply
```

Delivery-status updates (`sent`/`delivered`/`read`/`failed`) update the **same** message
row in place (`updateMessageStatus`) — never a new row per status.

## 4. The 24-hour customer service window

WhatsApp's own rule (not a HyperCool invention): free-form replies are only allowed within
24 hours of the customer's last message. Outside that window, only a pre-approved template
may be sent. This is enforced in the backend, both for the `whatsapp_send` agent tool and
the manual "reply by hand" route (`POST /api/crm/leads/:id/whatsapp-send`) — sending free
text outside the window is rejected with `TEMPLATE_REQUIRED_OUTSIDE_WINDOW`, not silently
attempted.

## 5. Templates

```
POST /api/integrations/... (owner)  →  POST /api/whatsapp/templates/sync
GET  /api/whatsapp/templates
```

Pulls your real templates and their **real** approval status from Meta
(`syncWhatsAppTemplates`) into a local table — statuses are Meta's own
(`APPROVED`/`PENDING`/`REJECTED`/`PAUSED`/...), never invented locally. Use an approved
template's exact name when sending outside the service window (`templateName`,
`templateLanguage` on the send tool/route).

## 6. Opt-out

A message matching a stop/unsubscribe pattern (Arabic or English — the same detection
`src/crm.js` already used for manually-recorded messages) immediately sets `optOut=true` on
the lead, stops any active follow-up sequence, and emits `CUSTOMER_OPTED_OUT`. Every
outbound path (agent tool and manual route) checks `optOut` first and refuses to send.

## 7. Hot leads / human handoff

Independent of WhatsApp specifically: whenever a lead's temperature is set to `HOT` (by a
human via the UI, or by an agent calling its own `update_lead` tool), `src/crm.js`'s
`maybeEscalateHotLead` creates a real P1 escalation (visible in the Approval &
Escalation Center / Operations Log) exactly once per COLD/WARM→HOT transition — never a
second one for an already-hot lead.

## 8. Test the connection

`POST /api/integrations/whatsapp/test` (owner) — confirms the resolved token can read the
phone number's own profile (`display_phone_number`, `verified_name`). Returns
`NOT_CONFIGURED`, `OK`, `AUTH_FAILED`, `RATE_LIMITED`, or `NETWORK_ERROR`.

## What is NOT built yet

- **Media download/storage** — an inbound image/document/audio/video is recorded as
  `MEDIA_RECEIVED` with provider metadata only (the Meta media id, mime type, caption); the
  actual file is never downloaded or analyzed. Add a media-fetch step if you need the
  content itself, not just the fact that it arrived.
- **Instagram/Facebook DM ingestion** — the webhook route and CRM plumbing are shared and
  ready, but only WhatsApp payloads are normalized today.
- **Multi-Page/multi-WABA picker** — one Meta connection resolves to the first Page's
  assets; see the Meta doc.
- **A background queue** — inbound processing (find-or-create lead, record message, run
  the agent) happens synchronously within the webhook request today. There is no
  Redis/worker-queue layer in this codebase; see the AI Provider setup doc's own note on
  this same gap.

## Common errors (send classification, `src/runtime/whatsapp.js`)

| Class | Meaning |
|---|---|
| `AUTH` | Token invalid/expired (Meta error code 190 or HTTP 401) |
| `RATE_LIMIT` | Meta rate limit hit |
| `INVALID_RECIPIENT` | Phone number not on WhatsApp / invalid |
| `TEMPLATE_REQUIRED` | Outside the 24h window, no template given |
| `TEMPLATE_REJECTED` | Meta rejected the named template |
| `API_UNAVAILABLE` | Meta returned a 5xx |
| `OTHER` | Anything else — check `errorDetail` |

No automatic retry on any of these — a human (or a future scheduled reconciliation) decides
whether to try again, per the integration spec's "no random retries" rule.
