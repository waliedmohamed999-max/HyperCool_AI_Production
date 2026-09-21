import test from 'node:test';
import assert from 'node:assert/strict';
import {PERMISSIONS, ROLE_PERMISSIONS, WORKSPACE_ROLES, LEGACY_ROLE, SUPPORT_LEVEL_ROLE, SUPPORT_LEVELS} from '../src/client/core.js';
import {AGENT_IDS, listCatalog, describeAgent, isCatalogAgent} from '../src/client/catalog.js';
import {ALL_ENTITLEMENTS} from '../src/client/plans.js';
import {canStartSupport} from '../src/client/support.js';
import {agents as registry} from '../src/domain.js';

// Pure invariants of the merchant layer (no database): catalog vs registry, roles, entitlements, support authority.

test('the catalog is exactly the 12 delegated agents of the platform registry (the chat assistant is not sold)', () => {
 assert.equal(AGENT_IDS.length, 12);
 const registryIds = registry.map(a => a.id);
 for (const id of AGENT_IDS) assert.ok(registryIds.includes(id), `${id} exists in the registry`);
 assert.deepEqual(registryIds.filter(id => !AGENT_IDS.includes(id)), ['frost_commander']);
 assert.equal(isCatalogAgent('frost_commander'), false);
 for (const a of listCatalog()) {
  assert.ok(a.nameAr && a.nameEn && a.descriptionAr && a.descriptionEn, `${a.key} is described in both languages`);
  assert.ok(['low', 'medium', 'high'].includes(a.riskLevel));
  assert.ok(ALL_ENTITLEMENTS.includes(`agent.${a.key}`), `agent.${a.key} is a real entitlement key`);
  assert.deepEqual(a.requiredEntitlements, [`agent.${a.key}`]);
 }
 assert.equal(describeAgent('sales').riskLevel, 'high');
});

test('workspace roles: the owner holds everything, every other role is a strict subset, viewers cannot act', () => {
 assert.deepEqual(WORKSPACE_ROLES, ['workspace_owner', 'workspace_admin', 'manager', 'operator', 'analyst', 'viewer']);
 assert.deepEqual(ROLE_PERMISSIONS.workspace_owner, PERMISSIONS);
 for (const role of WORKSPACE_ROLES.slice(1)) for (const p of ROLE_PERMISSIONS[role]) assert.ok(PERMISSIONS.includes(p), `${role}: ${p}`);
 assert.ok(!ROLE_PERMISSIONS.workspace_admin.includes('billing.manage'), 'only the owner manages billing');
 assert.ok(!ROLE_PERMISSIONS.operator.includes('approvals.review') && !ROLE_PERMISSIONS.operator.includes('team.manage'));
 for (const p of ROLE_PERMISSIONS.viewer) assert.match(p, /\.view$/);
 for (const p of ['agents.run', 'tasks.create', 'tasks.cancel', 'approvals.review', 'team.manage', 'integrations.manage', 'settings.manage']) assert.ok(!ROLE_PERMISSIONS.analyst.includes(p) && !ROLE_PERMISSIONS.viewer.includes(p), p);
 // the legacy role a portal role is mapped to never exceeds what the person may do
 assert.equal(LEGACY_ROLE.workspace_owner, 'owner');
 for (const r of WORKSPACE_ROLES.slice(1)) assert.notEqual(LEGACY_ROLE[r], 'owner', `${r} never becomes a legacy owner`);
});

test('support levels map to bounded roles and never to the owner', () => {
 assert.deepEqual(SUPPORT_LEVELS, ['view_only', 'limited', 'extended']);
 assert.equal(SUPPORT_LEVEL_ROLE.view_only, 'viewer');
 for (const level of SUPPORT_LEVELS) { assert.notEqual(SUPPORT_LEVEL_ROLE[level], 'workspace_owner'); assert.ok(!ROLE_PERMISSIONS[SUPPORT_LEVEL_ROLE[level]].includes('billing.manage')); }
 assert.ok(!ROLE_PERMISSIONS[SUPPORT_LEVEL_ROLE.limited].includes('team.manage'));
});

test('who may start support sessions: platform admins, narrowed by SUPPORT_ACCESS_USERNAMES', () => {
 const env = {PLATFORM_ADMIN_USERNAMES: 'boss,ops'};
 assert.equal(canStartSupport(env, {username: 'boss'}), true);
 assert.equal(canStartSupport(env, {username: 'someone'}), false, 'not a platform admin');
 assert.equal(canStartSupport({...env, SUPPORT_ACCESS_USERNAMES: 'boss'}, {username: 'ops'}), false, 'admin outside the support allowlist');
 assert.equal(canStartSupport({...env, SUPPORT_ACCESS_USERNAMES: 'boss'}, {username: 'BOSS'}), true);
 assert.equal(canStartSupport({SUPPORT_ACCESS_USERNAMES: 'boss'}, {username: 'boss'}), false, 'the allowlist alone is not enough');
});
