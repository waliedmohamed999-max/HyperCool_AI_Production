# Platform Mail Service (Multi-Tenant Phase 4C-5)

`src/runtime/platform-mail.js`. Sends **on behalf of HyperCool itself** (account verification,
password recovery, workspace invitations) — completely separate from any tenant's own
Microsoft 365 connection (`runtime/microsoft-graph.js`'s `sendMail`, used only for a tenant's
own outbound customer email). Using a tenant's mailbox for platform mail would be both a
category error (whose address would it send from?) and a real security problem (one tenant's
OAuth token now sending mail to every other tenant's users). Platform mail configuration lives
in deployment env vars, never inside any tenant's Control Center (Part 68).

## Transports

Same idiom as every other external call in this codebase (`connectors.js`'s Anthropic/OpenAI
test calls): a raw `fetch` to a real REST API, no SDK dependency.

- **`resend`** (real) — [Resend](https://resend.com)'s plain HTTPS JSON API. Configured via
  `PLATFORM_RESEND_API_KEY` + `PLATFORM_MAIL_FROM` (see `.env.example`). One `POST
  https://api.resend.com/emails` call per message.
- **`capture`** (development/test only) — set `PLATFORM_MAIL_TRANSPORT=capture`. Never touches
  the network; records the **full rendered message**, including the verification/reset/invite
  link, into `platform_mail_outbox.captured_body`. This is the one place a token's resulting
  link is ever allowed to be persisted, and it is only ever selected by an explicit
  development/test opt-in — never in a real deployment (`platformMailStatus()` reports
  `capture` as a real, intentional `CONFIGURED` state, not a fallback).

`platformMailStatus(env)` → `{status: 'CONFIGURED'|'UNCONFIGURED', transport}` — a real,
honest capability check with no secret ever included in the response (Part 51). Surfaced to
the client only as the bare `status` string, on `GET /api/account`.

## `platform_mail_outbox` (Part 54)

```sql
CREATE TABLE platform_mail_outbox (
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('VERIFY_EMAIL','PASSWORD_RESET','INVITATION','SECURITY_NOTICE')),
 to_email TEXT NOT NULL,
 subject TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('SENT','FAILED')),
 sent_at TEXT,
 last_send_error_code TEXT,
 captured_body TEXT,
 created_at TEXT NOT NULL
);
```

`captured_body` is populated **only** under the `capture` transport. A real `resend` send never
stores the message body or any provider response — only the safe metadata (`sent_at`,
`last_send_error_code`), matching Part 54's "no provider response containing secrets."

## Failure handling (Part 15)

`sendPlatformMail()` never claims `delivered:true` unless the chosen transport genuinely
accepted the message. Every caller (`POST /api/account/email`, `.../resend-verification`,
`POST /api/workspaces/invitations`, `.../resend`, `POST /api/auth/forgot-password`) reports the
real outcome back — the frontend must show "email could not be sent" rather than "sent"
whenever `delivered` is `false`. A password reset's confirmation notice
(`sendSecurityNotice`) is the one exception allowed to fail silently, since by that point the
password change itself has already succeeded server-side.

## Templates (Part 44)

Four minimal, transactional-only templates (no marketing copy), each bilingual by the caller's
locale: verify-your-email, reset-your-password, workspace-invitation, and a generic
security-notice. Every link is built from `baseUrl` — the same already-validated
`PUBLIC_ORIGIN`/host `application.js` uses for its own Host/Origin checks (Part 45) — never
inferred from an arbitrary request header.

## Never sends real mail in the automated test suite (Part 74)

Every test in `tests/platform-identity.test.js` runs with `PLATFORM_MAIL_TRANSPORT=capture`
and reads the real link back from `platform_mail_outbox` — no network call, no real recipient,
ever, in CI or local `npm test`.
