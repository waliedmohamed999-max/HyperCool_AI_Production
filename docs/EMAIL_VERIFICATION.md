# Email Verification (Multi-Tenant Phase 4C-5)

## Model

`email_verification_tokens` (`src/platform-identity.js`, additive-only):

```sql
CREATE TABLE email_verification_tokens (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id),
 email_normalized TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE,
 expires_at TEXT NOT NULL,
 used_at TEXT,
 created_at TEXT NOT NULL,
 attempt_count INTEGER NOT NULL DEFAULT 0
);
```

The raw token is **never stored** — only `sha256(token)`. `attempt_count` is incremented when a
verify attempt targets an already-expired row (a lightweight anomaly signal); it is not itself
a brute-force defense, since the token's 256 bits of entropy already make guessing infeasible
regardless of any counter.

## Lifecycle

1. **Request** (`POST /api/account/email`, body `{email}`) — `requestEmailChange()`:
   normalizes, rejects if another account already holds it as a **verified** `email` (409;
   Part 5), deletes any prior *unused* token for this user (Part 55/56 — rotation), inserts a
   fresh one (45-minute expiry — Part 8's suggested 30–60 minute range), and sets
   `users.pending_email`.
2. **Send** — the route builds `${baseUrl}/#verify-email/${token}` (`baseUrl` is the same
   already-validated `PUBLIC_ORIGIN`/host application.js uses for its own Host/Origin checks —
   never inferred from an arbitrary client header, Part 45) and calls
   `sendVerificationEmail()` (`docs/PLATFORM_EMAIL.md`). The response reports
   `{pendingEmail, delivered, errorCode}` honestly — `delivered:false` if the platform mail
   transport is unconfigured or the send failed; the frontend must never claim "sent" when this
   is false (Part 15).
3. **Verify** (`POST /api/account/email/verify`, public, body `{token}`) —
   `verifyEmailToken()`: 404 for an unknown token, 410 for already-used or expired (Part 8/9),
   otherwise promotes atomically — `users.email = email_normalized`, `email_verified_at = now`,
   `pending_email = NULL`, and marks the token used. The final `UNIQUE(email)` check happens
   here, for real, against the live table: if the address was claimed by someone else in the
   rare window between two concurrent verifications, this fails with 409 rather than silently
   overwriting.
4. **Resend** (`POST /api/account/email/resend-verification`) — requires an existing
   `pending_email` (409 otherwise), rotates the token exactly like step 1.

## Changing an already-verified email

The **old** verified email stays fully active (including as a login identity) until the
**new** one is actually verified (Part 10) — `pending_email` never overwrites `email`. Tested
directly: `tests/platform-identity.test.js`'s "Changing an already-verified email keeps the OLD
one active until the NEW one is verified".

## Security

- Token: `randomBytes(32)` (256 bits), `sha256` hashed at rest, single-use (`used_at`),
  45-minute expiry.
- Rate-limited (`checkEmailVerificationRateLimit`, 40/15min per IP — sized to never interfere
  with a real multi-step account flow while still throttling scripted abuse).
- No user enumeration on the **authenticated** add/change route is a different bar than a
  public route: telling the account holder "this email is already used by another account" is
  ordinary, necessary UX (every real product with unique emails does this) — the anonymity
  guarantee that matters is on the **public**, unauthenticated surface, covered by
  `docs/PASSWORD_RECOVERY.md`'s forgot-password endpoint.
- Verified by test that the raw token never appears in any DB row (`tests/platform-identity.test.js`,
  "No raw token ever appears anywhere in the plain DB rows").

## Login with a verified email

Once verified, the address becomes a second valid login identity alongside `username` — see
`docs/PLATFORM_IDENTITY.md`'s "Login accepts username OR verified email" section. An unverified
`pending_email` is never usable for login.
