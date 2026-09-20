import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installTenancy, createTenant, resolveActiveTenantId} from '../src/tenancy.js';
import {createAuth} from '../src/auth.js';
import {installContent, insertContent, listContentFiltered, getContentOrNull} from '../src/content.js';

// listContentFiltered is the ONE query both the Global Calendar and the Marketing Social
// Calendar now call (via src/marketing.js's adapters) — a tenant leak here would leak into
// BOTH surfaces at once, so this is worth its own dedicated, low-level check beyond the
// existing HTTP-level "Tenant isolation" test in tests/marketing.test.js.
function fixture() {
 const store = openStore(':memory:');
 installTenancy(store.db);
 installContent(store.db);
 const auth = createAuth(store.db);
 const tenantA = resolveActiveTenantId(store.db);
 const ownerB = auth.createUser({username: 'tenantb_owner', name: 'Owner B', password: 'a-long-test-password'}, 'owner');
 const tenantB = createTenant(store.db, {name: 'Tenant B', slug: 'tenant-b'}, ownerB.id);
 return {store, tenantA, tenantB};
}
function campaignItem(id, tenantId, campaignId) {
 const now = new Date().toISOString();
 return {id, status: 'DRAFT', platform: 'Instagram', format: 'post', date: now.slice(0, 10),
  title: 'test', body: 'body', hook: 'hook', cta: null, hashtags: [], creativeBrief: null,
  campaignId, scheduledAt: null, connectionId: null,
  complianceRunId: null, complianceClassification: null, compliance: null, complianceCheckedAt: null, complianceContentHash: null,
  creativeRunId: null, externalPostId: null, liveUrl: null, publishedAt: null,
  createdBy: null, createdByName: null, createdAt: now};
}

test('Content Unification tenancy: listContentFiltered never returns another tenant\'s rows, with or without a campaignId filter', () => {
 const {store, tenantA, tenantB} = fixture();
 try {
  insertContent(store.db, campaignItem('item-a1', tenantA, 'camp-a'), tenantA);
  insertContent(store.db, campaignItem('item-a2', tenantA, null), tenantA);
  insertContent(store.db, campaignItem('item-b1', tenantB, 'camp-b'), tenantB);

  const allForA = listContentFiltered(store.db, tenantA, {});
  assert.equal(allForA.length, 2);
  assert.ok(allForA.every(i => ['item-a1', 'item-a2'].includes(i.id)));

  const allForB = listContentFiltered(store.db, tenantB, {});
  assert.equal(allForB.length, 1);
  assert.equal(allForB[0].id, 'item-b1');

  // Filtering tenant A by a campaign id that only exists under tenant B must return nothing —
  // never accidentally match by campaign_id alone across tenants.
  const crossTenantFilter = listContentFiltered(store.db, tenantA, {campaignId: 'camp-b'});
  assert.equal(crossTenantFilter.length, 0);

  // A direct cross-tenant get must behave exactly like every other tenant-scoped getter in
  // this codebase (getLead, getCampaign, ...): not found, never a cross-tenant leak.
  assert.equal(getContentOrNull(store.db, 'item-b1', tenantA), null);
  assert.equal(getContentOrNull(store.db, 'item-a1', tenantB), null);
 } finally {
  store.close();
 }
});
