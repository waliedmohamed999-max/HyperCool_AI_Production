# LinkedIn Integration Setup

LinkedIn is a real B2B publishing channel for the Content Calendar — an approved, scheduled
`platform: 'LinkedIn'` content item flows automatically through the internal scheduler
(`src/runtime/scheduler.js` → `prepareDue`) to the Publishing & Scheduling agent, which
calls the real `linkedin_publish` tool (`src/runtime/tools.js`) once that agent's autonomy
allows it (L2+ — see "Autonomy" in [X_INTEGRATION_SETUP.md](X_INTEGRATION_SETUP.md), which
applies identically here). This app **only ever publishes to a Company Page/Organization**,
never a personal profile — that restriction is enforced in code, not just documented.

## In the LinkedIn Developer Portal

1. Create an app at [www.linkedin.com/developers/apps](https://www.linkedin.com/developers/apps)
   (a real URL you navigate to yourself — confirm current portal structure there, as
   LinkedIn's developer portal and product-approval process change independently of this
   codebase).
2. Under **Auth**, note the **Client ID** and **Client Secret**, and add an **Authorized
   redirect URL** set to exactly `https://<your-domain>/api/integrations/linkedin/oauth/callback`
   (must match byte-for-byte what you put in `LINKEDIN_REDIRECT_URI` below).
3. Under **Products**, request:
   - **Sign In with LinkedIn using OpenID Connect** — grants `openid`/`profile`/`email`
     (identity only; usually auto-approved).
   - **Community Management API** — grants `w_organization_social` (publish to a Page),
     `r_organization_social` (read the Page's own posts/metrics), and
     `rw_organization_admin` (list the Pages this account administers). **This product
     requires LinkedIn's review/approval and is not automatic** — do not assume it is
     granted the moment you request it (spec Part V). A connection made before approval
     still succeeds as identity-only; publishing stays `INTEGRATION_REQUIRED` until it is.
4. You (or whoever connects the app) must be an **Administrator** of the target Company
   Page in LinkedIn itself — `rw_organization_admin` only ever returns pages you actually
   administer, there is no way around this from the API side.

## In `.env`

```dotenv
LINKEDIN_CLIENT_ID=...
LINKEDIN_CLIENT_SECRET=...
LINKEDIN_REDIRECT_URI=https://<your-domain>/api/integrations/linkedin/oauth/callback
INTEGRATION_ENCRYPTION_KEY=<32-byte key, hex or base64 — shared with other integrations if already set>
```

## Connect

1. Owner logs in → `GET /api/integrations/linkedin/oauth/start` (a button on the
   Integrations page links here) → redirects to LinkedIn's consent screen.
2. Approve → LinkedIn redirects back to your callback URL with `code`/`state`.
3. The callback exchanges the code for an access token, resolves the connected person's
   identity (`GET /v2/userinfo`), and **attempts** to resolve an administered Company Page
   (`GET /v2/organizationAcls`) — this can legitimately fail if the Community Management
   API product isn't approved yet, in which case the connection still succeeds as
   identity-only (`publishingCapable: false` in the status response) rather than failing
   the whole connect.
4. `GET /api/integrations/linkedin/oauth/status` shows `connected`, `profile`,
   `organization` (`null` until resolved), and `publishingCapable`.
5. `POST /api/integrations/linkedin/disconnect` (owner) to revoke locally at any time.

### If your app is approved for multiple Company Pages

This app resolves and stores the **first** administered organization it finds — the same
"pick one, document the limitation" approach used for Meta's Page selection. If the
connected account administers more than one Page and you need a different one, set it
explicitly after connecting: `LINKEDIN_ORGANIZATION_ID` in `.env` overrides the stored
resolution for the static-token path, or reconnect with an account that only administers
the intended Page. A dedicated multi-Page picker UI is not built (see "not yet built"
below).

### Token expiry — there is no silent refresh

LinkedIn's default OAuth app receives **no refresh token** — the access token is valid for
~60 days and then a human must reconnect. (A `refresh_token` is only issued to apps
LinkedIn has separately enrolled in "Programmatic Refresh Tokens"; if yours has one, it is
stored and used automatically.) `GET .../oauth/status`'s `reauthorizeRequired` flag turns
`true` once the stored token is actually expired — surface this in the Integrations UI
rather than letting `linkedin_publish` fail silently.

## Legacy static token (no OAuth)

```dotenv
LINKEDIN_ACCESS_TOKEN=...
LINKEDIN_ORGANIZATION_ID=...
```
Both are required together — unlike Meta, LinkedIn has no "list my Pages" call usable
without the OAuth-obtained organization scopes, so a static setup must supply the
organization id directly (find it in the Page's own admin URL,
`linkedin.com/company/<numeric-id>/admin/`).

## Publishing behavior

- Only `platform: 'LinkedIn'` content can be published by `linkedin_publish`; anything
  else returns `BLOCKED: UNSUPPORTED_PLATFORM`.
- LinkedIn content requires the item's `englishCopy` (this app's existing content model
  already requires an English copy for LinkedIn at schedule time — see `planning.js`
  `scheduleContent`); `linkedin_publish` publishes that field, never the Arabic `body`.
- Posts go to `POST /v2/ugcPosts` as the resolved Company Page (`urn:li:organization:...`)
  — never a personal profile URN — with `shareMediaCategory: 'ARTICLE'` when the content
  item has a `url`, so the link unfurls as a real LinkedIn link card.
- Already-published content short-circuits to `{status:'OK', reason:'ALREADY_PUBLISHED'}`
  — never a second post (spec Part P: idempotency).
- A genuine network failure/timeout returns `STATUS_UNKNOWN` (never blindly retried) and
  opens a real P2 escalation, exactly like the X integration.
- A real API error classifies into `AUTH_FAILED`, `PERMISSION_MISSING`, `RATE_LIMIT`,
  `INVALID_CONTENT`, or `API_UNAVAILABLE`.
- On success, the created post's id is read from LinkedIn's real `x-restli-id` response
  header (LinkedIn's `ugcPosts` endpoint returns an empty body on success) — this is the
  correct, documented way to get it, not a workaround.

## Test Mode

Set `SOCIAL_PUBLISHING_TEST_MODE=true` (shared with the X integration — see
[X_INTEGRATION_SETUP.md](X_INTEGRATION_SETUP.md)) to rehearse the full pipeline without
ever calling the real LinkedIn API or marking anything published.

## Metrics — expect this to be unavailable for most apps

Real organization post analytics require LinkedIn's Community Management API's
**analytics** endpoint (`organizationalEntityShareStatistics`), which is a separate
approval from basic organization posting. `getLinkedInPostMetrics` calls the real endpoint
and returns real numbers when your app has that access — otherwise it honestly reports
`{status:'NOT_AVAILABLE'}`, never a simulated number.

## Test the connection

`POST /api/integrations/linkedin/test` (owner only) — `OK` once both identity and a
resolved organization are confirmed, `CONFIGURED_NO_ORGANIZATION` for an identity-only
connection (waiting on Community Management API approval or a Page administrator role),
`AUTH_FAILED`/`RATE_LIMITED`/`NETWORK_ERROR`, or `NOT_CONFIGURED`.

## What is NOT built yet

- **Multi-Page picker UI** — see "If your app is approved for multiple Company Pages"
  above; the first administered organization is used automatically.
- **Image/document posts.** Only text + optional link-card is implemented; LinkedIn's image
  upload (`registerUpload` + binary PUT) is a real, buildable next step but was not rushed
  into this pass alongside the OAuth/publishing/scheduling wiring.
- **A recurring metrics-sync job** — same position as X and Salla above.
