import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installTenancy, resolveActiveTenantId} from '../src/tenancy.js';
import {installContent, migrateUnifyContentItems, getContent, listContent} from '../src/content.js';
import {installPlanning} from '../src/planning.js';
import {installMarketing, getCampaignContentItem, listCampaignContentItems} from '../src/marketing.js';

// Simulates a real production upgrade: a database that already has an old-shape
// campaign_content_items table (from before this deploy) with real rows, exactly the schema
// src/marketing.js's installMarketing used to create. installContent() (called first, matching
// the real boot order in src/application.js) must find it and migrate it into the unified
// content_items table before installMarketing() ever runs again on this same database.
function seedLegacyCampaignContentItems(db, tenantId) {
 db.exec(`CREATE TABLE campaign_content_items (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, campaign_id TEXT, channel TEXT NOT NULL, format TEXT NOT NULL,
  objective TEXT, audience TEXT, hook TEXT, body TEXT NOT NULL DEFAULT '', cta TEXT, hashtags_json TEXT NOT NULL DEFAULT '[]',
  creative_brief_json TEXT, status TEXT NOT NULL DEFAULT 'DRAFT', approval_id TEXT, scheduled_at TEXT, published_at TEXT,
  created_by TEXT, created_by_name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  compliance_run_id TEXT, compliance_classification TEXT, compliance_json TEXT, compliance_checked_at TEXT,
  compliance_content_hash TEXT, creative_run_id TEXT
 );`);
 const now = new Date().toISOString();
 const future = new Date(Date.now() + 3 * 86400000).toISOString();
 const insert = db.prepare(`INSERT INTO campaign_content_items
  (id,tenant_id,campaign_id,channel,format,objective,audience,hook,body,cta,hashtags_json,creative_brief_json,status,
   approval_id,scheduled_at,published_at,created_by,created_by_name,created_at,updated_at,
   compliance_run_id,compliance_classification,compliance_json,compliance_checked_at,compliance_content_hash,creative_run_id)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
 // Row 1: a real, SCHEDULED item (with a real compliance pass) — this is the previously-broken
 // "never actually executes" case the migration must close. Status is SCHEDULED (not APPROVED)
 // because the pre-unification live updateCampaignContentItem() only ever set scheduled_at
 // together with status:'SCHEDULED' — a legacy row with a non-null scheduled_at always has this
 // exact status, matching realistic production data.
 const hashtags1 = JSON.stringify(['عرض', 'صيف']);
 const complianceHash1 = 'known-hash-1'; // stand-in; the real hash is recomputed and checked by content-unification-campaign-scheduling.test.js, not here
 insert.run('camp-item-1', tenantId, 'camp-1', 'Instagram', 'post', 'وعي بالعلامة', 'شباب', 'عرض الصيف',
  'استمتع بخصم الصيف', 'اطلب الآن', hashtags1, JSON.stringify({tone: 'حماسي'}), 'SCHEDULED',
  'appr-1', future, null, 'user-1', 'Owner', now, now, 'run-1', 'PASS', JSON.stringify({classification: 'PASS'}), now, complianceHash1, 'creative-run-1');
 // Row 2: a DRAFT item, never scheduled, no compliance yet — must survive the migration as-is.
 insert.run('camp-item-2', tenantId, null, 'X', 'post', null, null, null, 'مسودة بدون حملة', null, '[]', null, 'DRAFT',
  null, null, null, 'user-1', 'Owner', now, now, null, null, null, null, null, null);
 return {future};
}

test('Content Unification migration: legacy campaign_content_items rows survive losslessly into the unified content_items table', () => {
 const store = openStore(':memory:');
 try {
  installTenancy(store.db);
  const tenantId = resolveActiveTenantId(store.db);
  const {future} = seedLegacyCampaignContentItems(store.db, tenantId);
  const beforeCount = store.db.prepare('SELECT COUNT(*) n FROM campaign_content_items').get().n;
  assert.equal(beforeCount, 2);

  // Real boot order (src/application.js): content.js, planning.js, THEN the unification
  // migration (needs schedule_jobs, owned by planning.js), then marketing.js.
  installContent(store.db);
  installPlanning(store.db);
  migrateUnifyContentItems(store.db);
  installMarketing(store.db);

  // 1. The unified table now has both migrated rows.
  const unified = listContent(store.db, tenantId);
  assert.equal(unified.length, 2);

  const item1 = getContent(store.db, 'camp-item-1', tenantId);
  assert.equal(item1.platform, 'Instagram');
  assert.equal(item1.format, 'post');
  assert.equal(item1.campaignId, 'camp-1');
  assert.equal(item1.hook, 'عرض الصيف');
  assert.equal(item1.body, 'استمتع بخصم الصيف');
  assert.equal(item1.cta, 'اطلب الآن');
  assert.deepEqual(item1.hashtags, ['عرض', 'صيف']);
  assert.deepEqual(item1.creativeBrief, {tone: 'حماسي'});
  assert.equal(item1.complianceRunId, 'run-1');
  assert.equal(item1.complianceClassification, 'PASS');
  assert.equal(item1.complianceContentHash, 'known-hash-1');
  assert.equal(item1.creativeRunId, 'creative-run-1');
  assert.equal(item1.scheduledAt, future);
  // Status is preserved as-is (identity map): the live updateCampaignContentItem() adapter and
  // prepareDue() both treat SCHEDULED as the real, externally-visible "has an active job" status
  // for campaign-shaped content — collapsing it to APPROVED here would desync migrated rows from
  // that same live invariant and make prepareDue block them forever.
  assert.equal(item1.status, 'SCHEDULED');
  assert.equal(item1.createdBy, 'user-1');
  assert.equal(item1.createdByName, 'Owner');

  const item2 = getContent(store.db, 'camp-item-2', tenantId);
  assert.equal(item2.platform, 'X');
  assert.equal(item2.campaignId, null);
  assert.equal(item2.status, 'DRAFT');
  assert.deepEqual(item2.hashtags, []);

  // 2. External adapter shape still reads correctly (application.js/UI-facing).
  const external1 = getCampaignContentItem(store.db, 'camp-item-1', tenantId);
  assert.equal(external1.channel, 'Instagram');
  assert.equal(external1.campaignId, 'camp-1');
  const campaignItems = listCampaignContentItems(store.db, tenantId, {});
  assert.equal(campaignItems.length, 2);

  // 3. The closed execution gap: item1 had a real scheduledAt and reached APPROVED, so a real
  // schedule_jobs row must now exist for it — this is what makes it actually publishable.
  const job = store.db.prepare("SELECT * FROM schedule_jobs WHERE content_id=?").get('camp-item-1');
  assert.ok(job, 'expected a real schedule_jobs row for the previously-scheduled campaign item');
  assert.equal(job.status, 'SCHEDULED');
  assert.equal(job.tenant_id, tenantId);
  // item2 was never scheduled — no job should have been fabricated for it.
  const noJob = store.db.prepare("SELECT * FROM schedule_jobs WHERE content_id=?").get('camp-item-2');
  assert.equal(noJob, undefined);

  // 4. The old table is renamed, never dropped, and its data is untouched.
  const oldTableGone = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaign_content_items_pre_unify'").get();
  assert.ok(oldTableGone, 'expected campaign_content_items to be renamed, not dropped');
  const preservedCount = store.db.prepare('SELECT COUNT(*) n FROM campaign_content_items_pre_unify').get().n;
  assert.equal(preservedCount, 2);
  const preservedRow = store.db.prepare('SELECT * FROM campaign_content_items_pre_unify WHERE id=?').get('camp-item-1');
  assert.equal(preservedRow.hook, 'عرض الصيف');

  // 5. Idempotency: running the migration again must not duplicate anything.
  migrateUnifyContentItems(store.db);
  assert.equal(listContent(store.db, tenantId).length, 2);
 } finally {
  store.close();
 }
});

test('Content Unification migration: a fresh database with no campaign_content_items table at all boots cleanly', () => {
 const store = openStore(':memory:');
 try {
  installTenancy(store.db);
  installContent(store.db);
  installPlanning(store.db);
  migrateUnifyContentItems(store.db);
  installMarketing(store.db);
  const columns = store.db.prepare('PRAGMA table_info(content_items)').all().map(c => c.name);
  assert.ok(columns.includes('campaign_id'));
  assert.ok(columns.includes('format'));
  assert.ok(columns.includes('scheduled_at'));
  assert.ok(columns.includes('connection_id'));
  assert.equal(listContent(store.db).length, 0);
 } finally {
  store.close();
 }
});
