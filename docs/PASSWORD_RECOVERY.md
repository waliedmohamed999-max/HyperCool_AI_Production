# Password Recovery (Multi-Tenant Phase 4C-5)

Requires a **verified** email — this is deliberately only available once
`docs/EMAIL_VERIFICATION.md`'s flow has been completed at least once, since the reset link's
entire security model rests on "only the real mailbox owner receives it."

## Model

`password_reset_tokens` (`src/platform-identity.js`, additive-only):

```sql
CREATE TABLE password_reset_tokens (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id),
 token_hash TEXT NOT NULL UNIQUE,
 expires_at TEXT NOT NULL,
 used_at TEXT,
 created_at TEXT NOT NULL
);
```

Raw token never stored, only `sha256(token)`.

## Flow

1. **`POST /api/auth/forgot-password`** (public, body `{email}`) — `requestPasswordReset()`
   looks up a user by **verified** `email` only. Whether or not a match exists, the route
   returns the **exact same** generic message ("إن وُجد حساب مرتبط بهذا البريد…") — Part 24's
   explicit no-enumeration requirement, verified by test
   (`tests/platform-identity.test.js`, "identical generic response whether the email exists or
   not"). Only when a real match exists does anything happen behind the scenes: any prior
   unused reset token for that user is deleted (rotation, Part 56), a fresh one is created
   (30-minute expiry, Part 25), and `sendPasswordResetEmail()` is called with
   `${baseUrl}/#reset-password/${token}`.
2. **`POST /api/auth/reset-password`** (public, body `{token, password}`) —
   `consumePasswordResetToken()` validates (404 unknown, 410 used/expired), then delegates the
   actual mutation to the **existing, already-tested** `auth.resetPassword(userId, password)`
   (`src/auth.js`) — which already: validates length (12–256), hashes the new password, and
   **deletes every session** for that user (Part 27's session-invalidation requirement was
   already true of this pre-existing function; this phase adds no separate invalidation logic).
   A best-effort security-notice email is then sent to the account's verified address
   (`sendSecurityNotice`, non-fatal if it fails — the reset itself has already succeeded).

Both public routes share `checkForgotPasswordRateLimit` (40/15min per IP).

## Frontend

`#forgot-password` and `#reset-password/<token>` (`public/pages/recovery.js`) — outside the
normal auth-gated flow, reachable from the login screen's "نسيت كلمة المرور؟" link. The token
is read only from `location.hash`, never persisted to `localStorage`, and the URL is cleaned
(`history.replaceState`) immediately after a successful reset.

## Verified end-to-end (real browser, this phase's own QA)

Legacy owner → add + verify email → log out → forgot password → real reset link (captured via
the safe test-only mail transport, `docs/PLATFORM_EMAIL.md`) → set new password → **old**
password now rejected, **new** password logs in, and the pre-reset session is confirmed dead
(`GET /api/auth` returns `user:null` immediately after reset, before any new login).
