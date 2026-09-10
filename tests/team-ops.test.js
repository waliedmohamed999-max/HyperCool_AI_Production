import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {createAuth} from '../src/auth.js';
import {assertRoleChangeAllowed,assertDeactivationAllowed,buildTeamDashboard,ROLE_MATRIX} from '../src/team-ops.js';

function fixture(){const store=openStore(':memory:');return {store,auth:createAuth(store.db)};}

test('assertRoleChangeAllowed blocks demoting the last active owner',()=>{
 const {store,auth}=fixture();
 const owner=auth.createUser({username:'owner1',name:'Owner One',password:'x'.repeat(12)},'owner');
 assert.throws(()=>assertRoleChangeAllowed(store.db,owner.id,'operator'),/مالك/);
});
test('assertRoleChangeAllowed allows demoting an owner when another active owner remains',()=>{
 const {store,auth}=fixture();
 const owner1=auth.createUser({username:'owner1',name:'Owner One',password:'x'.repeat(12)},'owner');
 auth.createUser({username:'owner2',name:'Owner Two',password:'x'.repeat(12)},'owner');
 assert.doesNotThrow(()=>assertRoleChangeAllowed(store.db,owner1.id,'operator'));
});
test('assertRoleChangeAllowed never blocks promoting someone TO owner',()=>{
 const {store,auth}=fixture();
 const owner=auth.createUser({username:'owner1',name:'Owner One',password:'x'.repeat(12)},'owner');
 const op=auth.createUser({username:'op1',name:'Op One',password:'x'.repeat(12)},'operator');
 assert.doesNotThrow(()=>assertRoleChangeAllowed(store.db,op.id,'owner'));
 assert.doesNotThrow(()=>assertRoleChangeAllowed(store.db,owner.id,'owner'));
});
test('assertRoleChangeAllowed never blocks changing a non-owner role, regardless of owner count',()=>{
 const {store,auth}=fixture();
 auth.createUser({username:'owner1',name:'Owner One',password:'x'.repeat(12)},'owner');
 const op=auth.createUser({username:'op1',name:'Op One',password:'x'.repeat(12)},'operator');
 assert.doesNotThrow(()=>assertRoleChangeAllowed(store.db,op.id,'reviewer'));
});
test('assertRoleChangeAllowed ignores an already-suspended owner when counting active owners',()=>{
 const {store,auth}=fixture();
 const owner1=auth.createUser({username:'owner1',name:'Owner One',password:'x'.repeat(12)},'owner');
 const owner2=auth.createUser({username:'owner2',name:'Owner Two',password:'x'.repeat(12)},'owner');
 auth.setStatus(owner2.id,'suspended');
 // owner2 is suspended, so owner1 is the ONLY active owner — demoting them must be blocked.
 assert.throws(()=>assertRoleChangeAllowed(store.db,owner1.id,'operator'),/مالك/);
});

test('assertDeactivationAllowed blocks suspending/removing the last active owner',()=>{
 const {store,auth}=fixture();
 const owner=auth.createUser({username:'owner1',name:'Owner One',password:'x'.repeat(12)},'owner');
 assert.throws(()=>assertDeactivationAllowed(store.db,owner.id),/مالك/);
});
test('assertDeactivationAllowed allows suspending a non-owner freely',()=>{
 const {store,auth}=fixture();
 auth.createUser({username:'owner1',name:'Owner One',password:'x'.repeat(12)},'owner');
 const op=auth.createUser({username:'op1',name:'Op One',password:'x'.repeat(12)},'operator');
 assert.doesNotThrow(()=>assertDeactivationAllowed(store.db,op.id));
});

test('buildTeamDashboard reports real summary counts from actual user rows',()=>{
 const {store,auth}=fixture();
 auth.createUser({username:'owner1',name:'Owner One',password:'x'.repeat(12)},'owner');
 const op=auth.createUser({username:'op1',name:'Op One',password:'x'.repeat(12)},'operator');
 auth.setStatus(op.id,'suspended');
 const dash=buildTeamDashboard(store.db,{auditEntries:[]});
 assert.equal(dash.summary.total,2);
 assert.equal(dash.summary.active,1);
 assert.equal(dash.summary.owners,1);
 assert.equal(dash.summary.pendingInvitations,0); // no invite system exists — never fabricated
});
test('buildTeamDashboard marks hasActiveSession only for a user with a real, non-expired session row',()=>{
 const {store,auth}=fixture();
 const owner=auth.createUser({username:'owner1',name:'Owner One',password:'x'.repeat(12)},'owner');
 const op=auth.createUser({username:'op1',name:'Op One',password:'x'.repeat(12)},'operator');
 auth.session(owner); // creates a real, non-expired session row for owner only
 const dash=buildTeamDashboard(store.db,{auditEntries:[]});
 assert.equal(dash.members.find(m=>m.id===owner.id).hasActiveSession,true);
 assert.equal(dash.members.find(m=>m.id===op.id).hasActiveSession,false);
});
test('buildTeamDashboard activity filters strictly to user-management audit actions',()=>{
 const {store}=fixture();
 const auditEntries=[{action:'USER_CREATED',at:'2026-01-01T00:00:00.000Z'},{action:'DRAFT_CREATED',at:'2026-01-01T00:00:00.000Z'},{action:'USER_SUSPENDED',at:'2026-01-02T00:00:00.000Z'}];
 const dash=buildTeamDashboard(store.db,{auditEntries});
 assert.equal(dash.activity.length,2);
 assert.ok(dash.activity.every(a=>a.action!=='DRAFT_CREATED'));
});
test('the role matrix only ever contains the three real roles this app has',()=>{
 for(const row of ROLE_MATRIX){
  assert.ok(row.owner);assert.ok(row.operator);assert.ok(row.reviewer);
 }
});
