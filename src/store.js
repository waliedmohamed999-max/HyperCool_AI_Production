import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { initialState } from './domain.js';

export function openStore(path, legacyPath) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','reviewer','operator')), password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
  `);
  // Additive-only migration for Team Management: existing rows get status='active' (they
  // could already log in, so this reflects real current capability) and NULL timestamps
  // (honestly "unknown" for accounts created before this column existed, never backfilled).
  const userColumns=db.prepare("SELECT name FROM pragma_table_info('users')").all().map(r=>r.name);
  if(!userColumns.includes('status'))db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended'))");
  if(!userColumns.includes('created_at'))db.exec('ALTER TABLE users ADD COLUMN created_at TEXT');
  if(!userColumns.includes('last_login_at'))db.exec('ALTER TABLE users ADD COLUMN last_login_at TEXT');
  // Additive-only migration for account-level language preference (i18n). NULL means "no
  // preference recorded yet" — the client falls back to its own saved preference, then to
  // the product default (Arabic), never to the browser's Accept-Language.
  if(!userColumns.includes('preferred_locale'))db.exec("ALTER TABLE users ADD COLUMN preferred_locale TEXT CHECK(preferred_locale IN ('ar','en'))");
  // Phase 4C-1 (Workspace Selection) — the ONE place a multi-membership user's chosen
  // workspace is persisted: a column on their own SERVER-SIDE session row, never a
  // client-supplied/signed value trusted at face value. Re-validated against real current
  // memberships on every request (tenancy.js's resolveTenantForUser) — this column is only
  // ever a hint of what to re-check, never itself the authority. NULL means "no selection
  // made yet" (or the user has ≤1 membership and never needed one).
  const sessionColumns=db.prepare("SELECT name FROM pragma_table_info('sessions')").all().map(r=>r.name);
  if(!sessionColumns.includes('active_tenant_id'))db.exec('ALTER TABLE sessions ADD COLUMN active_tenant_id TEXT');
  // Multi-Tenant Phase 4C-5 (Platform Identity + Verified Email) — additive only, and
  // deliberately NEVER backfilled with an invented address for an existing user (see
  // docs/PLATFORM_IDENTITY.md): `email` is populated ONLY once real ownership of that address
  // has been proven (either through the verification-token flow below, or — for a brand-new
  // account created directly from an emailed, EMAIL_BOUND invitation link — by the invitation
  // delivery itself, which is the same "received it in your inbox" proof). Always stored
  // already-normalized (trimmed + lowercased; see `normalizeEmail` in platform-identity.js) —
  // exactly one column, matching `username`'s own existing precedent of storing only the
  // normalized form with no separate "as-typed" column. `pending_email` holds a NOT-yet-
  // verified candidate while a change is in flight (Part 10: never overwrite a verified email
  // before the new one is proven) and is cleared the moment it is either promoted to `email`
  // or superseded by a newer pending request.
  if(!userColumns.includes('email'))db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  if(!userColumns.includes('email_verified_at'))db.exec('ALTER TABLE users ADD COLUMN email_verified_at TEXT');
  if(!userColumns.includes('pending_email'))db.exec('ALTER TABLE users ADD COLUMN pending_email TEXT');
  // SQLite UNIQUE indexes treat every NULL as distinct from every other NULL (standard SQL
  // semantics), so this enforces "no two accounts share the same VERIFIED email" (Part 5)
  // without needing a partial/WHERE-guarded index — any number of NULL (no email yet) rows
  // coexist freely.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)');
  if (!db.prepare('SELECT id FROM state WHERE id=1').get()) {
    const state = legacyPath && existsSync(legacyPath) ? JSON.parse(readFileSync(legacyPath,'utf8')) : initialState();
    if (!Array.isArray(state.content) || !Array.isArray(state.audit)) throw new Error('Invalid legacy state');
    for (const item of state.content) item.legacyUnauthenticated = true;
    db.prepare('INSERT INTO state VALUES (1,?)').run(JSON.stringify(state));
  }
  return {
    db,
    read: () => JSON.parse(db.prepare('SELECT json FROM state WHERE id=1').get().json),
    mutate(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const state = this.read();
        const result = fn(state);
        db.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(state));
        db.exec('COMMIT');
        return result;
      } catch(error) { db.exec('ROLLBACK'); throw error; }
    },
    close: () => db.close()
  };
}
