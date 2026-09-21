import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {CLIENT_TABLES, RETAINED_ON_UNINSTALL, uninstallClient} from '../src/client/schema.js';
import {installClientPortal} from '../src/client/index.js';
import {retireUnbackedKeys} from '../src/client/plans.js';

// Migration safety of the merchant layer, on real databases: fresh install, install twice, an existing database that already holds
// core, partner and merchant data, removal (which must not touch anything else and keeps the audit trail), reinstall, and the
// one-off cleanup of retired plan keys.
const ENV = {PLATFORM_MAIL_TRANSPORT: 'capture', INTEGRATION_ENCRYPTION_KEY: 'ab'.repeat(32), PLATFORM_ADMIN_USERNAMES: 'mg_admin'};
const PASSWORD = 'migration-long-password-1';
const REG = {name: 'Owner', phone: '+966500000100', country: 'SA', businessType: 'retail', businessSize: 'small', ecommercePlatform: 'salla', teamSize: 3, goals: ['content'], planSlug: 'growth', acceptTerms: true, locale: 'en'};

async function open(dir) {
 const app = await createApp({dataDir: dir, env: ENV});
 await new Promise(r => app.server.listen(0, '127.0.0.1', r));
 const base = `http://127.0.0.1:${app.server.address().port}`;
 const call = async (path, {body, s, method} = {}) => {
  const res = await fetch(base + path, {method: method || (body ? 'POST' : 'GET'), headers: {...(body ? {'Content-Type': 'application/json'} : {}), ...(s ? {cookie: s.cookie, 'x-csrf-token': s.csrf} : {})}, ...(body ? {body: JSON.stringify(body)} : {})});
  const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch { /* */ }
  return {status: res.status, data, text, cookie: res.headers.get('set-cookie')?.split(';')[0], csrf: data?.csrf};
 };
 const close = async () => { await new Promise(r => app.server.close(r)); app.store.close(); };
 return {app, call, close, db: app.store.db};
}
const tableNames = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
const triggerNames = db => db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map(r => r.name);
const counts = (db, names) => Object.fromEntries(names.map(n => [n, db.prepare(`SELECT COUNT(*) n FROM ${n}`).get().n]));
const nonClient = db => tableNames(db).filter(n => !n.startsWith('client_'));

test('fresh database: the client schema installs, installs again without changes, and seeds the plans once', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'frost-mig-fresh-'));
 const a = await open(dir);
 try {
  for (const t of CLIENT_TABLES) assert.ok(tableNames(a.db).includes(t), t);
  const before = counts(a.db, CLIENT_TABLES);
  installClientPortal(a.db); installClientPortal(a.db);
  assert.deepEqual(counts(a.db, CLIENT_TABLES), before, 'a repeated install changes nothing');
  assert.equal(a.db.prepare('SELECT COUNT(*) n FROM client_plans').get().n, 3);
  assert.deepEqual(a.db.prepare('PRAGMA foreign_key_check').all(), []);
  // no plan carries the retired entitlement / limits
  for (const p of a.db.prepare('SELECT entitlements_json, limits_json FROM client_plans').all()) {
   assert.ok(!p.entitlements_json.includes('api_access'));
   assert.ok(!/storage_mb|retention_days/.test(p.limits_json));
  }
 } finally { await a.close(); await rm(dir, {recursive: true, force: true}); }
});

test('existing database with core, partner and merchant data: reopening, removal, reinstall and full removal lose nothing else', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'frost-mig-data-'));
 let a = await open(dir);
 try {
  // real data across the platform: a merchant workspace (with an audit trail), a partner application, a legacy signup
  const reg = await a.call('/api/client/register', {body: {...REG, username: 'mg_merchant', email: 'mg_merchant@mg.example', password: PASSWORD, businessName: 'Migration Store'}});
  assert.equal(reg.status, 201, reg.text);
  const s = {cookie: reg.cookie, csrf: reg.csrf};
  assert.equal((await a.call('/api/client/onboarding/1', {method: 'PUT', body: {businessName: 'Store', country: 'SA', offering: 'Shoes and bags', audience: 'Shoppers'}, s})).status, 200);
  const partner = await a.call('/api/partners/register', {body: {name: 'Partner P', username: 'mg_partner', email: 'mg_partner@mg.example', password: PASSWORD, fullName: 'Partner P', phone: '+966500000009', country: 'SA', partnerType: 'agency', marketingMethod: 'Newsletters about e-commerce for small shops.', expectedCustomers: 10, acceptTerms: true}});
  assert.equal(partner.status, 201, partner.text);
  assert.equal((await a.call('/api/signup', {body: {name: 'Plain', username: 'mg_plain', email: 'mg_plain@mg.example', password: PASSWORD}})).status, 201);
  const auditBefore = a.db.prepare('SELECT * FROM client_audit_logs ORDER BY rowid').all();
  assert.ok(auditBefore.length >= 2);

  // 1. reopening the same database (a normal restart) changes no data
  const snapshotOpen = {all: counts(a.db, tableNames(a.db))};
  await a.close();
  a = await open(dir);
  assert.deepEqual(counts(a.db, tableNames(a.db)), snapshotOpen.all, 'reopen leaves every table as it was');
  assert.equal((await a.call('/api/login', {body: {username: 'mg_merchant', password: PASSWORD}})).status, 200);
  assert.equal(a.db.prepare('SELECT COUNT(*) n FROM client_plans').get().n, 3, 'plans are not seeded twice');

  // 2. removal: only the client tables go (audit + support evidence stay); nothing else changes
  const coreBefore = counts(a.db, nonClient(a.db));
  assert.ok(nonClient(a.db).some(n => n.startsWith('partner_')), 'partner tables exist');
  const partnerRows = Object.entries(coreBefore).filter(([n]) => n.startsWith('partner_')).reduce((sum, [, n]) => sum + n, 0);
  assert.ok(partnerRows >= 1 && coreBefore.users >= 3 && coreBefore.tenants >= 2, JSON.stringify({partnerRows, users: coreBefore.users, tenants: coreBefore.tenants}));
  uninstallClient(a.db);
  assert.deepEqual(counts(a.db, nonClient(a.db)), coreBefore, 'core, partner and integration data are untouched');
  const left = tableNames(a.db).filter(n => n.startsWith('client_')).sort();
  assert.deepEqual(left, [...RETAINED_ON_UNINSTALL].sort(), 'only the retained evidence tables remain (no orphan client tables)');
  assert.deepEqual(a.db.prepare('SELECT * FROM client_audit_logs ORDER BY rowid').all(), auditBefore, 'the audit trail is preserved exactly');
  assert.deepEqual(triggerNames(a.db).filter(n => n.startsWith('client_')).sort(), ['client_audit_no_delete', 'client_audit_no_update', 'client_support_events_no_delete', 'client_support_events_no_update']);
  assert.deepEqual(a.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.throws(() => a.db.prepare("UPDATE client_audit_logs SET action='x'").run(), /append-only/);

  // 3. reinstall on top of the retained evidence
  installClientPortal(a.db);
  for (const t of CLIENT_TABLES) assert.ok(tableNames(a.db).includes(t), t);
  assert.equal(a.db.prepare('SELECT COUNT(*) n FROM client_plans').get().n, 3);
  assert.deepEqual(a.db.prepare('SELECT * FROM client_audit_logs ORDER BY rowid').all().slice(0, auditBefore.length), auditBefore, 'the retained rows are exactly the same (re-seeding the plans only appends)');
  assert.deepEqual(counts(a.db, nonClient(a.db)), coreBefore);

  // 4. explicit full removal (evidence too) still leaves everything else alone
  uninstallClient(a.db, {dropAudit: true});
  assert.deepEqual(tableNames(a.db).filter(n => n.startsWith('client_')), []);
  assert.deepEqual(triggerNames(a.db).filter(n => n.startsWith('client_')), []);
  assert.deepEqual(counts(a.db, nonClient(a.db)), coreBefore);
  assert.deepEqual(a.db.prepare('PRAGMA foreign_key_check').all(), []);
  installClientPortal(a.db); // and the schema can be put back after a full removal
  for (const t of CLIENT_TABLES) assert.ok(tableNames(a.db).includes(t), t);
 } finally { await a.close(); await rm(dir, {recursive: true, force: true}); }
});

test('retired plan keys are removed from existing plans and overrides, once', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'frost-mig-retire-'));
 const a = await open(dir);
 try {
  const plan = a.db.prepare("SELECT id, entitlements_json, limits_json FROM client_plans WHERE slug='scale'").get();
  const ents = JSON.parse(plan.entitlements_json), lims = JSON.parse(plan.limits_json);
  a.db.prepare('UPDATE client_plans SET entitlements_json=?, limits_json=? WHERE id=?').run(JSON.stringify([...ents, 'client.api_access']), JSON.stringify({...lims, storage_mb: 5000, retention_days: 730}), plan.id);
  const tenant = a.db.prepare('SELECT id FROM tenants LIMIT 1').get().id;
  const t = new Date().toISOString();
  a.db.prepare('INSERT INTO client_tenant_overrides (tenant_id,kind,key,value,updated_by,updated_at) VALUES (?,?,?,?,?,?)').run(tenant, 'entitlement', 'client.api_access', 'allow', 'x', t);
  a.db.prepare('INSERT INTO client_tenant_overrides (tenant_id,kind,key,value,updated_by,updated_at) VALUES (?,?,?,?,?,?)').run(tenant, 'limit', 'storage_mb', '10', 'x', t);
  a.db.prepare('INSERT INTO client_tenant_overrides (tenant_id,kind,key,value,updated_by,updated_at) VALUES (?,?,?,?,?,?)').run(tenant, 'limit', 'users', '7', 'x', t);
  assert.ok(retireUnbackedKeys(a.db) >= 3);
  const after = a.db.prepare('SELECT entitlements_json, limits_json FROM client_plans WHERE id=?').get(plan.id);
  assert.ok(!after.entitlements_json.includes('api_access') && !/storage_mb|retention_days/.test(after.limits_json));
  assert.deepEqual(JSON.parse(after.entitlements_json), ents, 'every other entitlement is kept');
  assert.equal(JSON.parse(after.limits_json).users, lims.users, 'every other limit is kept');
  assert.deepEqual(a.db.prepare('SELECT key FROM client_tenant_overrides ORDER BY key').all().map(r => r.key), ['users']);
  assert.equal(retireUnbackedKeys(a.db), 0, 'idempotent');
 } finally { await a.close(); await rm(dir, {recursive: true, force: true}); }
});
