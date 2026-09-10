# X (Twitter) Integration Setup

X is a real publishing channel for approved Content Calendar items — an approved, scheduled
`platform: 'X'` content item flows automatically through the internal scheduler
(`src/runtime/scheduler.js` → `prepareDue`) to the Publishing & Scheduling agent
(`agents/publishing.md`), which calls the real `x_publish` tool
(`src/runtime/tools.js`) once the agent's own autonomy level allows it (L2+ — see
"Autonomy" below). Nothing here is a separate content or scheduling system: it reuses the
exact same Content Calendar, Approval Center, and Agent Runtime as every other channel.

## Why OAuth is not optional here

Unlike Salla/Meta/Microsoft 365, X has no usable "static token" shortcut for publishing.
X's API v2 issues two very different kinds of Bearer token:

- **App-only Bearer token** (`X_BEARER_TOKEN`) — read-only. It can look up tweets/metrics
  but `POST /2/tweets` rejects it outright. This app still accepts it (for
  `search`/metrics-style reads and a connectivity test), but it is honestly reported as
  `CONFIGURED_READ_ONLY`, never `OK`, and `x_publish` never uses it.
- **OAuth 2.0 user-context token** (via "Connect X") — the only token that can actually
  post. X's OAuth 2.0 additionally **mandates PKCE** for every client, confidential or
  public — this app generates and verifies the `code_verifier`/`code_challenge` pair
  internally (`src/runtime/x-oauth.js`); there is nothing extra to configure for that part.

## In the X Developer Portal

1. Create a Project and an App at [developer.x.com](https://developer.x.com) (a real URL
   you navigate to yourself — confirm current portal structure there, as X's developer
   portal layout changes independently of this codebase).
2. Under the App's **User authentication settings**, enable **OAuth 2.0**, set the app type
   to **Confidential client** (since this is a server-side app that can hold a client
   secret), and request **Read and write** permissions.
3. Set the **Callback URI / Redirect URL** to exactly
   `https://<your-domain>/api/integrations/x/oauth/callback` (must match byte-for-byte
   what you put in `X_REDIRECT_URI` below).
4. Note the **Client ID** and **Client Secret** from the app's "Keys and tokens" tab.
5. (Optional, for read-only metrics/testing without connecting) generate an **App-only
   Bearer Token** from the same tab.

## In `.env`

```dotenv
X_CLIENT_ID=...
X_CLIENT_SECRET=...
X_REDIRECT_URI=https://<your-domain>/api/integrations/x/oauth/callback
X_BEARER_TOKEN=...                      # optional — read-only only, see above
INTEGRATION_ENCRYPTION_KEY=<32-byte key, hex or base64 — shared with Salla/Meta/Microsoft if already set>
```

Generate the encryption key once (skip if already set for another integration — it's one
shared key across all of them):
```
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## Connect

1. Owner logs in → `GET /api/integrations/x/oauth/start` (a button on the Integrations
   page links here) → redirects to X's consent screen.
2. Approve → X redirects back to your callback URL with `code`/`state`.
3. The callback exchanges the code (with the matching PKCE `code_verifier`) for tokens,
   resolves the connected account (`GET /2/users/me`), encrypts and stores them, and
   redirects to `/#integrations`. The connection is now `connected: true` with the
   account's `username`.
4. Tokens refresh automatically near expiry using the `offline_access` scope's refresh
   token. If a refresh fails (revoked), `x_publish` reports `INTEGRATION_REQUIRED` again —
   reconnect via the Integrations page.
5. `POST /api/integrations/x/disconnect` (owner) to revoke locally at any time.

## Autonomy — why a connected X still might not publish anything

The Publishing & Scheduling agent (`publishing`) starts, like every agent, at **L0**. The
`x_publish`/`meta_publish`/`linkedin_publish` tools all require **L2** and are restricted
(`allowedAgents`) to the `publishing` agent specifically — no other agent can call them even
at a higher level. Raise it one step at a time from the Team/Agents page (or
`POST /api/agents/publishing/autonomy`): L0 → L1 → L2. This is intentional (spec Part M):
L0 never publishes, L1 would require approval on the tool call itself (not used by this
tool — approval already happened at content-approval time), L2 executes pre-approved,
already-scheduled content automatically.

## Publishing behavior

- Only `platform: 'X'` content can be published by `x_publish`; anything else returns
  `BLOCKED: UNSUPPORTED_PLATFORM`.
- Copy length is validated against the real 280-character limit, with any URL counted as a
  flat 23 characters (X's own t.co shortening rule) rather than its literal length —
  `src/runtime/x-publishing.js` `validateTweetText`.
- Already-published content (`externalPostId` already set) short-circuits to
  `{status:'OK', reason:'ALREADY_PUBLISHED'}` — never a second post, even if the tool is
  called again (spec Part P: idempotency).
- A genuine network failure/timeout returns `STATUS_UNKNOWN` (never blindly retried) and
  opens a real P2 escalation for human review — it does **not** mark the job `FAILED`
  (which would imply a confirmed rejection) nor `PUBLISHED`.
- A real API error (401/403/429/etc.) is classified into `AUTH_FAILED`,
  `PERMISSION_MISSING`, `RATE_LIMIT` (with X's own `Retry-After` header when present),
  `DUPLICATE_REQUEST`, `INVALID_CONTENT`, or `API_UNAVAILABLE`.
- On success, the content item becomes `PUBLISHED` with a real `externalPostId` and
  `liveUrl`, the matching Content Calendar `schedule_jobs` row is marked `PUBLISHED`, and a
  `CONTENT_PUBLISHED` event fires.

## Test Mode (rehearse without posting)

```dotenv
SOCIAL_PUBLISHING_TEST_MODE=true
```
With this set, `x_publish` (and `linkedin_publish`) never call the real API and never mark
anything published — they return `{status:'OK', testMode:true, would_publish:true,
platform, payload}` after the same approval/schedule/permission checks. Useful for
rehearsing the full pipeline (calendar → approval → scheduler → agent) before a real X
connection exists. Meta publishing is unaffected by this flag.

## Metrics

`getXPostMetrics` (best-effort, `tweet.fields=public_metrics`) returns
`impressions`/`likes`/`comments`/`shares` when the connected account's access tier actually
returns them — a field X does not return stays `null`, never a fabricated `0`. `reach` and
`clicks` are not exposed by the public metrics endpoint and always report `null`.

## Test the connection

`POST /api/integrations/x/test` (owner only) — `OK` for a working OAuth connection,
`CONFIGURED_READ_ONLY` for a bearer-only setup (verified against a real, permanently public
tweet — never a fabricated check), `AUTH_FAILED`/`RATE_LIMITED`/`NETWORK_ERROR`, or
`NOT_CONFIGURED`.

## What is NOT built yet

- **Media/image tweets.** X's media upload for API v2 still goes through the legacy v1.1
  `media/upload` endpoint, which requires OAuth 1.0a user-context signing — a genuinely
  different auth scheme from the OAuth 2.0 flow this integration uses. `x_publish` is
  text-only for this reason, not as an oversight; adding OAuth 1.0a signing is a real,
  separate next-phase item.
- **Reply/thread support, deletion.** Only a single top-level post is implemented.
- **A recurring metrics-sync job.** `getXPostMetrics` exists and is real, but nothing calls
  it on a schedule yet — same "not rushed this pass" position as Salla's order sync.
