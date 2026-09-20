import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installTenancy, resolveActiveTenantId} from '../src/tenancy.js';
import {installContent, migrateUnifyContentItems, getContent, listContent} from '../src/content.js';
import {installPlanning} from '../src/planning.js';
import {installMarketing} from '../src/marketing.js';

// Production-readiness gate item 7: the migration must be validated against realistic legacy
// states, not just the one clean scheduled row content-unification-migration.test.js already
// covers — every real CONTENT_STATUSES value, null dates, and malformed/partial JSON in the
// OPTIONAL fields. It must never silently discard a record; a truly unrecoverable row (an
// unknown status) must fail the ENTIRE migration atomically rather than leave a half-migrated
// database.
const LEGACY_SCHEMA = `CREATE TABLE campaign_content_items (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, campaign_id TEXT, channel TEXT NOT NULL, format TEXT NOT NULL,
 objective TEXT, audience TEXT, hook TEXT, body TEXT NOT NULL DEFAULT '', cta TEXT, hashtags_json TEXT NOT NULL DEFAULT '[]',
 creative_brief_json TEXT, status TEXT NOT NULL DEFAULT 'DRAFT', approval_id TEXT, scheduled_at TEXT, published_at TEXT,
 created_by TEXT, created_by_name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 compliance_run_id TEXT, compliance_classification TEXT, compliance_json TEXT, compliance_checked_at TEXT,
 compliance_content_hash TEXT, creative_run_id TEXT
);`;
const INSERT_SQL = `INSERT INTO campaign_content_items
 (id,tenant_id,campaign_id,channel,format,objective,audience,hook,body,cta,hashtags_json,creative_brief_json,status,
  approval_id,scheduled_at,published_at,created_by,created_by_name,created_at,updated_at,
  compliance_run_id,compliance_classification,compliance_json,compliance_checked_at,compliance_content_hash,creative_run_id)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

test('Content Unification migration: every real legacy status (DRAFT/IN_REVIEW/APPROVED/SCHEDULED/PUBLISHED/FAILED) with null dates survives losslessly', () => {
 const store = openStore(':memory:');
 try {
  installTenancy(store.db);
  const tenantId = resolveActiveTenantId(store.db);
  store.db.exec(LEGACY_SCHEMA);
  const now = new Date().toISOString();
  const insert = store.db.prepare(INSERT_SQL);
  const statuses = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'FAILED'];
  for (const status of statuses) {
   // Realistic: a DRAFT/IN_REVIEW/APPROVED/FAILED row never had scheduled_at/published_at set
   // (null dates) — only SCHEDULED/PUBLISHED rows legitimately have one of the two.
   const scheduledAt = status === 'SCHEDULED' ? new Date(Date.now() + 86400000).toISOString() : null;
   const publishedAt = status === 'PUBLISHED' ? now : null;
   insert.run(`item-${status}`, tenantId, null, 'X', 'post', null, null, null, `نص ${status}`, null, '[]', null, status,
    null, scheduledAt, publishedAt, 'user-1', 'Owner', now, now, null, null, null, null, null, null);
  }

  installContent(store.db);
  installPlanning(store.db);
  const result = migrateUnifyContentItems(store.db);
  assert.equal(result.migrated, statuses.length);
  installMarketing(store.db);

  // Every row must survive with its exact status preserved (identity map, item 11) and null
  // dates must never crash date-slicing logic or fabricate a fake date.
  for (const status of statuses) {
   const item = getContent(store.db, `item-${status}`, tenantId);
   assert.equal(item.status, status, `status must be preserved as-is for a legacy ${status} row`);
   assert.equal(item.body, `نص ${status}`);
  }
  assert.equal(listContent(store.db, tenantId).length, statuses.length, 'no row must be silently discarded');

  // Only the SCHEDULED row gets a real schedule_jobs row; PUBLISHED/FAILED/DRAFT/IN_REVIEW/
  // APPROVED rows (never actually scheduled) must not have a fabricated job.
  const jobs = store.db.prepare('SELECT content_id FROM schedule_jobs').all();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].content_id, 'item-SCHEDULED');
 } finally {
  store.close();
 }
});

test('Content Unification migration: malformed/partial JSON in optional fields degrades safely (empty/null) instead of discarding the record', () => {
 const store = openStore(':memory:');
 try {
  installTenancy(store.db);
  const tenantId = resolveActiveTenantId(store.db);
  store.db.exec(LEGACY_SCHEMA);
  const now = new Date().toISOString();
  const insert = store.db.prepare(INSERT_SQL);
  // Deliberately corrupted/partial JSON blobs — must not crash the migration or drop the row.
  insert.run('item-malformed', tenantId, null, 'Instagram', 'post', null, null, 'خطاف', 'نص حقيقي مهم', null,
   '{not valid json', '{"tone":', 'DRAFT', null, null, null, 'user-1', 'Owner', now, now,
   'run-1', 'PASS', '{"classification":"PASS"', now, 'hash-1', 'creative-1');

  installContent(store.db);
  installPlanning(store.db);
  const result = migrateUnifyContentItems(store.db);
  assert.equal(result.migrated, 1, 'the record must be preserved despite malformed optional JSON fields');
  installMarketing(store.db);

  const item = getContent(store.db, 'item-malformed', tenantId);
  // Core, non-JSON fields must be fully intact — this is the part of the record that matters
  // most and must never be lost.
  assert.equal(item.body, 'نص حقيقي مهم');
  assert.equal(item.hook, 'خطاف');
  assert.equal(item.status, 'DRAFT');
  assert.equal(item.complianceRunId, 'run-1');
  // The corrupted optional fields degrade to safe defaults rather than crashing.
  assert.deepEqual(item.hashtags, []);
  assert.equal(item.creativeBrief, null);
  assert.equal(item.compliance, null);
 } finally {
  store.close();
 }
});

test('Content Unification migration: an unrecognized/impossible legacy status fails the ENTIRE migration atomically, never a partial or silently-discarded state', () => {
 const store = openStore(':memory:');
 try {
  installTenancy(store.db);
  const tenantId = resolveActiveTenantId(store.db);
  store.db.exec(LEGACY_SCHEMA);
  const now = new Date().toISOString();
  const insert = store.db.prepare(INSERT_SQL);
  // A perfectly good row, followed by one with a genuinely impossible/unknown status.
  insert.run('item-good', tenantId, null, 'X', 'post', null, null, null, 'نص جيد', null, '[]', null, 'DRAFT',
   null, null, null, 'user-1', 'Owner', now, now, null, null, null, null, null, null);
  insert.run('item-corrupt-status', tenantId, null, 'X', 'post', null, null, null, 'نص', null, '[]', null, 'SOME_UNKNOWN_STATUS_FROM_A_BUG',
   null, null, null, 'user-1', 'Owner', now, now, null, null, null, null, null, null);

  installContent(store.db);
  installPlanning(store.db);
  assert.throws(() => migrateUnifyContentItems(store.db), /حالة محتوى حملة غير معروفة/, 'must fail loudly, never silently coerce to a default status');

  // Atomicity: NOTHING must have been migrated — not even the good row that was processed
  // before the bad one — and the original table must still exist under its original name,
  // safe to retry once the bad row is fixed or manually excluded.
  assert.equal(listContent(store.db, tenantId).length, 0, 'a failed migration must not leave a half-migrated content_items table');
  const originalTableStillThere = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaign_content_items'").get();
  assert.ok(originalTableStillThere, 'the source table must still exist under its ORIGINAL name after a failed migration — never renamed on failure');
  const renamedTable = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaign_content_items_pre_unify'").get();
  assert.equal(renamedTable, undefined, 'the backup table must NOT exist after a failed migration');
  const stillTwoRows = store.db.prepare('SELECT COUNT(*) n FROM campaign_content_items').get().n;
  assert.equal(stillTwoRows, 2, 'both original rows must still be present, untouched, in the original table');
 } finally {
  store.close();
 }
});
