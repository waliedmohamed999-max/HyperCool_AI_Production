# Credentials Vault (Multi-Tenant Phase 4A)

`src/integrations/vault.js` — one encrypted credential row per `integration_connections`
row, replacing "one encrypted row per `(tenant, provider)`" with "one encrypted row per
connection", which is what actually makes multiple connections of the same provider possible.

## Encryption: reused, not reinvented

`src/runtime/crypto.js` extracts the EXACT AES-256-GCM primitives `src/runtime/
credentials.js` already used and had already proven in production — `encryptionKey(env)`,
`encrypt(key, plaintext)`, `decrypt(key, packed)` are byte-for-byte the same logic, just
shared. There is only ever one encryption architecture in this codebase, never two.
`credentials.js` itself keeps its own original, untouched copy of this logic (deliberately —
see `docs/INTEGRATION_CONNECTION_ARCHITECTURE.md`'s compatibility-bridge rationale for why it
was left alone rather than refactored to import the shared module).

- **Master key**: `INTEGRATION_ENCRYPTION_KEY`, hex (64 chars) or base64, must decode to
  exactly 32 bytes. Read fresh from `env` on every call — **never** stored in the database,
  never logged, never returned by any route.
- **Cipher**: AES-256-GCM. A fresh random 12-byte IV per encryption; the auth tag is stored
  alongside the ciphertext (`iv.authTag.ciphertext`, each base64, dot-joined) so a tampered or
  truncated payload fails to decrypt loudly rather than silently returning garbage.
- **`encryption_version`** (currently `1`): stored on every vault row so a future key or
  algorithm rotation has a real column to branch decryption logic on, without building a full
  KMS this project has no other use for yet.

## Schema

```
integration_credentials_vault (
  id, tenant_id, connection_id UNIQUE, credential_type,
  encrypted_payload, encryption_version, created_at, updated_at, last_rotated_at
)
```

`connection_id` is `UNIQUE` — one credential per connection, matching a connection's own
one-token-set reality (an OAuth connection has one access/refresh token pair; an API-key
connection has one key). Replacing it is `storeCredential`/`replaceCredential` (an alias) —
always a full replace, never a partial merge, since a stale field silently surviving a
credential rotation is a real risk.

## Forbidden: plaintext storage, secret exposure

- **No plaintext ever touches the database.** `storeCredential` always calls `encrypt()`
  before the `INSERT`/`UPDATE` — there is no code path that writes `payload` unencrypted.
  Proven in `tests/integration-connections.test.js`: after storing a real-looking secret
  string, a raw `SELECT encrypted_payload` never contains that substring.
- **`getCredentialForRuntime` is backend-internal only.** No HTTP route in `application.js`
  ever calls it directly or returns its result — every route that needs to know "is this
  connection configured" calls `getCredentialMeta` instead, which returns only
  `{configured, credentialType, createdAt, updatedAt, lastRotatedAt}` — never the payload,
  never even its shape beyond a type tag.
- **The API-key connect route (`PUT /api/integrations/connections/:id/credential`) never
  echoes the submitted key back**, in success or failure. Proven in
  `tests/integration-connections-api.test.js`: the JSON response body, stringified, never
  contains the submitted secret.
- **A missing/invalid master key fails loudly, not silently.** `storeCredential` and
  `getCredentialForRuntime` both throw a real `500` (`INTEGRATION_ENCRYPTION_KEY غير مُعد أو
  غير صالح...`) rather than falling back to storing plaintext or returning a fabricated
  "not configured" result that would hide the real misconfiguration.

## Credential rotation and key versioning

- **Rotation** (`rotateCredential`, an alias of `storeCredential`) is just a normal replace —
  `last_rotated_at` is stamped so a future "credentials older than N days" health signal has
  real data to work from, though no such signal is built in this pass (not requested).
- **Key versioning**: `encryption_version` is populated on every write from the shared
  `ENCRYPTION_VERSION` constant. A future key rotation (e.g., moving to a new master key or a
  different cipher) would bump this constant and add a version-aware branch to `decrypt()`
  in `crypto.js` — the column already exists so that change would be additive, never a
  destructive schema migration.
- **The master key is never stored in the database**, in any table, in any form — confirmed
  by inspection of every `INSERT`/`UPDATE` in `vault.js` and `credentials.js`: the only things
  ever written are `encrypted_payload` (ciphertext) and `encryption_version` (an integer).

## Tenant isolation

Every vault function takes an optional `tenantId` (defaulting to `resolveActiveTenantId`,
matching this codebase's established pattern everywhere else) and every query is scoped by
`WHERE connection_id=? AND tenant_id=?` — a connection id that belongs to a different tenant
returns nothing, the same fail-closed shape as every other tenant-scoped table in this
codebase. Proven directly: a credential stored under Tenant A is invisible to Tenant B even
when Tenant B somehow learns the exact connection id (`hasCredential`/
`getCredentialForRuntime` both return "not found" for it).

## What this phase deliberately does not build

- A UI to "view" a stored secret — explicitly forbidden by the spec ("ممنوع: view secret");
  no route in this codebase ever exposes one, and none should ever be added.
- Automatic, scheduled credential rotation (e.g., a cron that re-issues API keys) — no
  provider here supports that programmatically today; this is a hook (`last_rotated_at`,
  `encryption_version`) for a future capability, not a built one.
- A KMS / hardware-backed key store — the master key stays a single environment variable,
  matching this codebase's existing single-instance, no-external-infrastructure deployment
  model (see `docs/agent-runtime.md`).
