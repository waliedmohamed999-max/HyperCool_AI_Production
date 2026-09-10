import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { initialState } from './domain.js';

export function openStore(path, legacyPath) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','reviewer','operator')), password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL);
  `);
  // Additive-only migration for Team Management: existing rows get status='active' (they
  // could already log in, so this reflects real current capability) and NULL timestamps
  // (honestly "unknown" for accounts created before this column existed, never backfilled).
  const userColumns=db.prepare("SELECT name FROM pragma_table_info('users')").all().map(r=>r.name);
  if(!userColumns.includes('status'))db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended'))");
  if(!userColumns.includes('created_at'))db.exec('ALTER TABLE users ADD COLUMN created_at TEXT');
  if(!userColumns.includes('last_login_at'))db.exec('ALTER TABLE users ADD COLUMN last_login_at TEXT');
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
