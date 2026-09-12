# Bot Protection (Multi-Tenant Phase 4C-7)

`src/runtime/bot-protection.js`. `DISABLED` unless `CAPTCHA_PROVIDER` is set — zero behavior
change for a deployment that never asked for this.

## Provider

One real, production-friendly provider today: **Cloudflare Turnstile** — a plain HTTPS
`siteverify` API call (same idiom as every other external call in this codebase:
`connectors.js`'s Anthropic/OpenAI test calls), no SDK dependency. `CAPTCHA_PROVIDER=turnstile`
+ `TURNSTILE_SECRET_KEY`. Naming a provider without its secret is a real, honest
misconfiguration (`status:'ERROR'`) — never silently treated as disabled.

## Scope — configurable per surface, never on every authenticated action (Part 7)

- **Signup** (`POST /api/signup`) — defaults to **required** the moment a provider is
  configured (`CAPTCHA_REQUIRE_SIGNUP`, default `true` once configured) — the primary bot
  target.
- **Forgot password** (`POST /api/auth/forgot-password`) — optional, `CAPTCHA_REQUIRE_
  FORGOT_PASSWORD`, default `false`.
- **Workspace creation** (`POST /api/workspaces`) — optional, `CAPTCHA_REQUIRE_
  WORKSPACE_CREATION`, default `false`.

Never required from an already-authenticated user browsing the rest of the app.

## Verification (Part 8)

`verifyBotProtection({env,fetcher},token,remoteIp)` — the one real entry point every gated
route calls, **before** any user/workspace mutation. Never throws (callers decide their own
status code); never exposes provider internals beyond a small set of safe generic codes
(`CAPTCHA_REQUIRED`, `CAPTCHA_MISCONFIGURED`, `CAPTCHA_PROVIDER_ERROR`,
`CAPTCHA_VERIFICATION_FAILED`, or the provider's own safe `error-codes` value).

## Development/test bypass (Part 9)

Only reachable when `NODE_ENV !== 'production'` **and** the literal token `'DEV_BYPASS'` is
sent — no bypass secret exists anywhere, not in the frontend, not in a config file. A real
deployment simply sets `NODE_ENV=production` (checked by `npm run production:check`), which
closes this path completely — there is no separate flag to accidentally leave on. Verified by
test: the identical bypass attempt is rejected outright once `NODE_ENV=production`.

## Failure handling

A CAPTCHA rejection on `forgot-password` is orthogonal to that route's own no-enumeration rule
(`docs/PASSWORD_RECOVERY.md`) — it never reveals whether the target email exists, only whether
a challenge was solved.
