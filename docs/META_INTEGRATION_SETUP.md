# Meta Integration Setup (Instagram / Facebook / shared OAuth)

Meta (Facebook Login for Business) is the single OAuth connection behind three surfaces in
HyperCool: **Instagram/Facebook publishing** (this doc), **WhatsApp messaging**
(`docs/WHATSAPP_BUSINESS_SETUP.md` — same connection, different capability), and inbound
messaging webhooks (shared by both, one subscription).

## 1. Create the Meta App

1. [developers.facebook.com](https://developers.facebook.com) → My Apps → Create App →
   type "Business".
2. Add products: **Facebook Login for Business**, **Webhooks**, and **WhatsApp** (if you'll
   use WhatsApp — see the other doc).
3. Note the **App ID** and **App Secret** (App Settings → Basic).

## 2. OAuth redirect

1. Facebook Login for Business → Settings → Valid OAuth Redirect URIs: add
   `https://<your-domain>/api/integrations/meta/oauth/callback` exactly.
2. `.env`:
   ```dotenv
   META_APP_ID=...
   META_APP_SECRET=...
   META_REDIRECT_URI=https://<your-domain>/api/integrations/meta/oauth/callback
   INTEGRATION_ENCRYPTION_KEY=<32-byte key, same one used for Salla if you have it>
   ```

## 3. Scopes / App Review

The connect flow (`src/runtime/meta-oauth.js`) requests: `business_management`,
`pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `pages_messaging`,
`instagram_basic`, `instagram_manage_messages`, `instagram_content_publish`,
`whatsapp_business_management`, `whatsapp_business_messaging`. Meta requires **App Review**
before most of these work for anyone other than the app's own admins/testers — add your
account as an App Tester first to develop against your own Page without waiting on review.

## 4. Connect

1. Owner logs in → `GET /api/integrations/meta/oauth/start` (a "Connect Meta" button on the
   Integrations page should link here) → Facebook consent screen.
2. Approve → redirected to the callback, which resolves (in order): your long-lived user
   token → the first Page you manage → that Page's Instagram Business Account → that Page's
   WhatsApp Business Account and phone number (if any) → stores everything via
   `saveMetaConnection` (Page access token encrypted, Page/IG/WhatsApp names+ids as plain
   metadata for display).
3. `GET /api/integrations/meta/oauth/status` shows what's connected without ever exposing a
   token value.
4. **A business with more than one Page**: this pass picks the *first* Page Graph API
   returns — there is no picker UI yet. If you manage multiple Pages, either restrict the
   connecting user's Page access to just the one you want, or treat multi-Page selection as
   a follow-up (see the "not yet built" list in `WHATSAPP_BUSINESS_SETUP.md`).
5. `POST /api/integrations/meta/disconnect` (owner) to revoke locally.

## 5. Webhooks (shared with WhatsApp)

```dotenv
META_VERIFY_TOKEN=<any string you choose>
META_WEBHOOK_SECRET=<falls back to META_APP_SECRET if unset>
```

1. App → Webhooks → Callback URL: `https://<your-domain>/api/webhooks/meta/whatsapp`,
   Verify Token: the exact value of `META_VERIFY_TOKEN`. Meta calls the URL with a GET
   handshake first — the app answers it automatically (`handleVerificationChallenge`).
2. Subscribe to the fields you need (`messages` for WhatsApp; for Instagram/Facebook page
   messaging, see the "not yet built" note below — those subscriptions exist in the
   endpoint but aren't fully wired to CRM yet).
3. Every POST must carry `X-Hub-Signature-256` — verified against `META_WEBHOOK_SECRET`
   (`verifyMetaSignature`). No signature, no processing.

## 6. Publishing

`meta_publish` (an Agent Runtime tool, `src/runtime/tools.js`) and the routes it calls
(`src/runtime/meta-publishing.js`) will only publish a content item that is:
- `status === 'APPROVED'` (real approval, not a suggestion),
- not already published (`externalPostId` unset — prevents a duplicate post after a retry),
- has an `assetUrl` if the platform is Instagram (Instagram requires an image/video URL;
  Facebook does not).

Instagram uses the real two-step flow (create media container → publish it); Facebook
posts directly to the Page feed. Both require the Page access token (resolved via OAuth
above, or `META_ACCESS_TOKEN`/`META_PAGE_ID` as a legacy static fallback).

## 7. Test the connection

`POST /api/integrations/meta/test` (owner) — confirms a usable access token exists. This is
a light check, not a full publish rehearsal — use a real (or test-mode) content approval to
exercise the actual publish path.

## What is NOT built yet

- **Multi-Page picker** — see step 4.5 above.
- **Instagram/Facebook DM ingestion into CRM conversations** — the webhook endpoint and
  event bus are shared and ready, but only WhatsApp messages are normalized into
  `crm_messages` today (see `WHATSAPP_BUSINESS_SETUP.md`'s "not yet built" section for the
  same limitation from the messaging side).
- **Comments-as-leads** — not implemented.
- **Metrics sync** (reach/impressions/engagement) — not implemented; the Performance Agent
  will report `data_status: PARTIAL` for social metrics until this exists.
