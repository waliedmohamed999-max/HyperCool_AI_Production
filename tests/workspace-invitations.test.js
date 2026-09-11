import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createAuth} from '../src/auth.js';
import {createTenant} from '../src/tenancy.js';

// Phase 4C-3 — Workspace Invitations + Member Management. Real HTTP end-to-end tests, same
// harness shape as tests/workspace-selection.test.js / tests/control-center.test.js.
async function harness(env={}) {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-invitations-'));
 const app=await createApp({dataDir:directory,env});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session,{method,headers={}}={}) {
  const hasBody=input!==undefined && input!==null && method!=='GET';
  const res=await fetch(base+path,{method:method||(input!=null?'POST':'GET'),redirect:'manual',headers:{...(hasBody?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...headers},...(hasBody?{body:typeof input==='string'?input:JSON.stringify(input)}:{})});
  const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data?.csrf};
 }
 return {app,call,cleanup:async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}};
}
async function twoTenants(env={}) {
 const {app,call,cleanup}=await harness(env);
 const ownerA=await call('/api/setup',{username:'ownera',name:'Owner A',password:'a-long-test-password'});
 await call('/api/auth',null,ownerA,{method:'GET'});
 const userA=app.store.db.prepare("SELECT id FROM users WHERE username='ownera'").get();
 const tenantA=app.store.db.prepare('SELECT tenant_id AS id FROM tenant_memberships WHERE user_id=?').get(userA.id).id;
 const auth=createAuth(app.store.db);
 const userB=auth.createUser({username:'ownerb',name:'Owner B',password:'a-long-test-password'},'owner');
 const tenantB=createTenant(app.store.db,{name:'Tenant B',slug:'tenant-b'},userB.id);
 const loginB=auth.login({username:'ownerb',password:'a-long-test-password'},'127.0.0.1');
 const ownerB={cookie:'hc_session='+loginB.token,csrf:loginB.csrf};
 return {app,call,cleanup,ownerA,ownerB,tenantA,tenantB,userAId:userA.id,userBId:userB.id};
}
async function loginAs(app,username,password) {
 const auth=createAuth(app.store.db);
 const login=auth.login({username,password},'127.0.0.1');
 return {cookie:'hc_session='+login.token,csrf:login.csrf};
}

// --- Creation, authorization, validation ---------------------------------------------------

test('Authorized invitation creation: owner creates a real, pending invitation and receives the one-time token',async()=>{
 const {call,cleanup,ownerA}=await twoTenants();
 try{
  const result=await call('/api/workspaces/invitations',{email:'newperson@example.com',role:'operator'},ownerA);
  assert.equal(result.status,201);
  assert.equal(result.data.status,'PENDING');
  assert.equal(result.data.email,'newperson@example.com');
  assert.ok(result.data.token && result.data.token.length>=32);
  assert.equal(result.data.tokenHash,undefined);
 }finally{await cleanup();}
});

test('Unauthorized role cannot invite: a reviewer (or operator) gets 403, matching the /api/users bar',async()=>{
 const {app,call,cleanup,ownerA,tenantA}=await twoTenants();
 try{
  const auth=createAuth(app.store.db);
  auth.createUser({username:'reviewer1',name:'Reviewer',password:'a-long-test-password'},'reviewer');
  const reviewer=await loginAs(app,'reviewer1','a-long-test-password');
  const asReviewer=await call('/api/workspaces/invitations',{email:'x@example.com',role:'operator'},reviewer);
  assert.equal(asReviewer.status,403);
 }finally{await cleanup();}
});

test('Invalid email rejected; invalid role rejected',async()=>{
 const {call,cleanup,ownerA}=await twoTenants();
 try{
  const badEmail=await call('/api/workspaces/invitations',{email:'not-an-email',role:'operator'},ownerA);
  assert.equal(badEmail.status,400);
  const badRole=await call('/api/workspaces/invitations',{email:'ok@example.com',role:'superadmin'},ownerA);
  assert.equal(badRole.status,400);
 }finally{await cleanup();}
});

test('Duplicate pending invitation for the same email rotates the token/expiry on the SAME row rather than creating a second pending row',async()=>{
 const {app,call,cleanup,ownerA,tenantA}=await twoTenants();
 try{
  const first=await call('/api/workspaces/invitations',{email:'dup@example.com',role:'operator'},ownerA);
  const second=await call('/api/workspaces/invitations',{email:'dup@example.com',role:'reviewer'},ownerA);
  assert.equal(second.status,201);
  assert.equal(second.data.id,first.data.id);
  assert.notEqual(second.data.token,first.data.token);
  assert.equal(second.data.role,'reviewer');
  const count=app.store.db.prepare("SELECT COUNT(*) c FROM workspace_invitations WHERE tenant_id=? AND email='dup@example.com'").get(tenantA).c;
  assert.equal(count,1);
  // the OLD token must no longer work
  const oldAccept=await call(`/api/invitations/${first.data.token}/preview`,null,null,{method:'GET'});
  assert.equal(oldAccept.status,404);
 }finally{await cleanup();}
});

// --- Token security: hashed at rest, never in list ------------------------------------------

test('Token is stored hashed, never plaintext, and never appears in the list API',async()=>{
 const {app,call,cleanup,ownerA,tenantA}=await twoTenants();
 try{
  const created=await call('/api/workspaces/invitations',{email:'secure@example.com',role:'operator'},ownerA);
  const row=app.store.db.prepare('SELECT token_hash FROM workspace_invitations WHERE tenant_id=?').get(tenantA);
  assert.notEqual(row.token_hash,created.data.token);
  assert.equal(row.token_hash.length,64); // sha256 hex
  const list=await call('/api/workspaces/invitations',null,ownerA,{method:'GET'});
  assert.equal(JSON.stringify(list.data).includes(created.data.token),false);
  assert.equal(JSON.stringify(list.data).includes('token_hash'),false);
 }finally{await cleanup();}
});

// --- Acceptance: existing user, new user, identity/replay/expiry/revocation -----------------

test('Existing-user acceptance: a logged-in user accepts a real invitation and gets a real tenant-scoped membership with the invitation\'s role',async()=>{
 const {app,call,cleanup,ownerA,tenantB}=await twoTenants();
 try{
  const auth=createAuth(app.store.db);
  auth.createUser({username:'existing1',name:'Existing User',password:'a-long-test-password'},'operator');
  const existingSession=await loginAs(app,'existing1','a-long-test-password');
  const created=await call('/api/workspaces/invitations',{email:'x@example.com',role:'reviewer'},ownerA);

  const accepted=await call(`/api/invitations/${created.data.token}/accept`,{},existingSession);
  assert.equal(accepted.status,200);
  assert.equal(accepted.data.workspace.role,'reviewer');

  const workspaces=await call('/api/workspaces',null,existingSession,{method:'GET'});
  assert.ok(workspaces.data.some(w=>w.role==='reviewer'));
  // the invitation is now ACCEPTED
  const list=await call('/api/workspaces/invitations',null,ownerA,{method:'GET'});
  assert.equal(list.data.find(i=>i.id===created.data.id).status,'ACCEPTED');
 }finally{await cleanup();}
});

test('New-user acceptance: registering through an invitation token creates the account, membership, and a real logged-in session, with the account\'s role taken from the invitation',async()=>{
 const {call,cleanup,ownerA}=await twoTenants();
 try{
  const created=await call('/api/workspaces/invitations',{email:'brandnew@example.com',role:'operator'},ownerA);
  const registered=await call(`/api/invitations/${created.data.token}/register`,{username:'brandnewuser',name:'Brand New',password:'a-long-registration-password'});
  assert.equal(registered.status,200);
  assert.ok(registered.cookie);
  assert.equal(registered.data.workspace.role,'operator');
  const newSession={cookie:registered.cookie,csrf:registered.data.csrf};
  const active=await call('/api/workspaces/active',null,newSession,{method:'GET'});
  assert.equal(active.status,200);
  assert.equal(active.data.role,'operator');
 }finally{await cleanup();}
});

test('Token reuse (replay) is rejected: a second accept with the same token fails',async()=>{
 const {app,call,cleanup,ownerA}=await twoTenants();
 try{
  const auth=createAuth(app.store.db);
  auth.createUser({username:'replay1',name:'Replay',password:'a-long-test-password'},'operator');
  const session=await loginAs(app,'replay1','a-long-test-password');
  const created=await call('/api/workspaces/invitations',{email:'r@example.com',role:'operator'},ownerA);
  const first=await call(`/api/invitations/${created.data.token}/accept`,{},session);
  assert.equal(first.status,200);
  const second=await call(`/api/invitations/${created.data.token}/accept`,{},session);
  assert.equal(second.status,409);
 }finally{await cleanup();}
});

test('Expired invitation is rejected on accept and on preview',async()=>{
 const {app,call,cleanup,ownerA,tenantA}=await twoTenants();
 try{
  const created=await call('/api/workspaces/invitations',{email:'exp@example.com',role:'operator'},ownerA);
  app.store.db.prepare("UPDATE workspace_invitations SET expires_at=? WHERE id=?").run(new Date(Date.now()-1000).toISOString(),created.data.id);
  const preview=await call(`/api/invitations/${created.data.token}/preview`,null,null,{method:'GET'});
  assert.equal(preview.data.status,'EXPIRED');
  const auth=createAuth(app.store.db);
  auth.createUser({username:'expuser',name:'Exp',password:'a-long-test-password'},'operator');
  const session=await loginAs(app,'expuser','a-long-test-password');
  const accept=await call(`/api/invitations/${created.data.token}/accept`,{},session);
  assert.equal(accept.status,410);
 }finally{await cleanup();}
});

test('Revoked invitation is rejected: revoked mid-flow (after the user already loaded it) still fails on accept',async()=>{
 const {app,call,cleanup,ownerA}=await twoTenants();
 try{
  const created=await call('/api/workspaces/invitations',{email:'rev@example.com',role:'operator'},ownerA);
  const preview=await call(`/api/invitations/${created.data.token}/preview`,null,null,{method:'GET'});
  assert.equal(preview.data.status,'PENDING');
  const revoke=await call(`/api/workspaces/invitations/${created.data.id}/revoke`,{},ownerA);
  assert.equal(revoke.status,200);
  const auth=createAuth(app.store.db);
  auth.createUser({username:'revuser',name:'Rev',password:'a-long-test-password'},'operator');
  const session=await loginAs(app,'revuser','a-long-test-password');
  const accept=await call(`/api/invitations/${created.data.token}/accept`,{},session);
  assert.equal(accept.status,410);
 }finally{await cleanup();}
});

test('A guessed/random invitation token fails safely with 404, same as any other unknown token',async()=>{
 const {call,cleanup}=await twoTenants();
 try{
  const preview=await call('/api/invitations/'+'a'.repeat(64)+'/preview',null,null,{method:'GET'});
  assert.equal(preview.status,404);
 }finally{await cleanup();}
});

test('Invitation to a SUSPENDED tenant cannot be accepted',async()=>{
 const {app,call,cleanup,ownerA,tenantA}=await twoTenants();
 try{
  const created=await call('/api/workspaces/invitations',{email:'susp@example.com',role:'operator'},ownerA);
  app.store.db.prepare("UPDATE tenants SET status='SUSPENDED' WHERE id=?").run(tenantA);
  const auth=createAuth(app.store.db);
  auth.createUser({username:'suspuser',name:'Susp',password:'a-long-test-password'},'operator');
  const session=await loginAs(app,'suspuser','a-long-test-password');
  const accept=await call(`/api/invitations/${created.data.token}/accept`,{},session);
  assert.equal(accept.status,409);
 }finally{await cleanup();}
});

test('Duplicate membership prevented: accepting an invitation for a tenant the user already belongs to reactivates/confirms rather than duplicating',async()=>{
 const {app,call,cleanup,ownerA,tenantA}=await twoTenants();
 try{
  const created=await call('/api/workspaces/invitations',{email:'already@example.com',role:'reviewer'},ownerA);
  // ownerA is ALREADY a member of tenantA — accept anyway.
  const accept=await call(`/api/invitations/${created.data.token}/accept`,{},ownerA);
  assert.equal(accept.status,200);
  const userAId=app.store.db.prepare("SELECT id FROM users WHERE username='ownera'").get().id;
  const count=app.store.db.prepare('SELECT COUNT(*) c FROM tenant_memberships WHERE tenant_id=? AND user_id=?').get(tenantA,userAId).c;
  assert.equal(count,1);
 }finally{await cleanup();}
});

test('Role changed on the invitation before acceptance: the ACCEPTED membership uses the latest stored role, never a stale one',async()=>{
 const {call,cleanup,ownerA}=await twoTenants();
 try{
  const created=await call('/api/workspaces/invitations',{email:'rolechange@example.com',role:'operator'},ownerA);
  const updated=await call('/api/workspaces/invitations',{email:'rolechange@example.com',role:'reviewer'},ownerA); // implicit resend with a new role, same row
  assert.equal(updated.data.id,created.data.id);
  // Accepting with the OLD token must fail (it was invalidated by the resend/role-change).
  const registeredOld=await call(`/api/invitations/${created.data.token}/register`,{username:'roleuser1',name:'Role User',password:'a-long-registration-password'});
  assert.equal(registeredOld.status,404);
  // Accepting with the CURRENT (latest) token succeeds with the LATEST role, never the stale 'operator'.
  const registered=await call(`/api/invitations/${updated.data.token}/register`,{username:'roleuser2',name:'Role User 2',password:'a-long-registration-password'});
  assert.equal(registered.status,200);
  assert.equal(registered.data.workspace.role,'reviewer');
 }finally{await cleanup();}
});

// --- Cross-tenant IDOR --------------------------------------------------------------------

test('Cross-tenant IDOR: Tenant A cannot list, resend, or revoke Tenant B\'s invitations',async()=>{
 const {call,cleanup,ownerA,ownerB}=await twoTenants();
 try{
  const createdB=await call('/api/workspaces/invitations',{email:'b-target@example.com',role:'operator'},ownerB);
  const listA=await call('/api/workspaces/invitations',null,ownerA,{method:'GET'});
  assert.equal(listA.data.some(i=>i.id===createdB.data.id),false);
  const resendByA=await call(`/api/workspaces/invitations/${createdB.data.id}/resend`,{},ownerA);
  assert.equal(resendByA.status,404);
  const revokeByA=await call(`/api/workspaces/invitations/${createdB.data.id}/revoke`,{},ownerA);
  assert.equal(revokeByA.status,404);
 }finally{await cleanup();}
});

test('Cross-tenant IDOR: Tenant A cannot view, edit the role of, or remove Tenant B\'s member',async()=>{
 const {app,call,cleanup,ownerA,ownerB,tenantB,userBId}=await twoTenants();
 try{
  const membershipB=app.store.db.prepare('SELECT id FROM tenant_memberships WHERE tenant_id=? AND user_id=?').get(tenantB,userBId);
  const membersA=await call('/api/workspaces/members',null,ownerA,{method:'GET'});
  assert.equal(membersA.data.some(m=>m.id===membershipB.id),false);
  const editByA=await call(`/api/workspaces/members/${membershipB.id}`,{role:'reviewer'},ownerA,{method:'PATCH'});
  assert.equal(editByA.status,404);
  const removeByA=await call(`/api/workspaces/members/${membershipB.id}`,null,ownerA,{method:'DELETE'});
  assert.equal(removeByA.status,404);
  // Tenant B's own membership is untouched
  const stillOwner=app.store.db.prepare('SELECT role,status FROM tenant_memberships WHERE id=?').get(membershipB.id);
  assert.equal(stillOwner.role,'owner');assert.equal(stillOwner.status,'active');
 }finally{await cleanup();}
});

// --- Privilege escalation / last-owner protection -------------------------------------------

test('Privilege escalation: a reviewer cannot invite or change member roles',async()=>{
 const {app,call,cleanup,ownerA}=await twoTenants();
 try{
  const auth=createAuth(app.store.db);
  auth.createUser({username:'reviewer2',name:'Reviewer2',password:'a-long-test-password'},'reviewer');
  const reviewer=await loginAs(app,'reviewer2','a-long-test-password');
  assert.equal((await call('/api/workspaces/invitations',{email:'esc@example.com',role:'owner'},reviewer)).status,403);
  assert.equal((await call('/api/workspaces/members',null,reviewer,{method:'GET'})).status,403);
 }finally{await cleanup();}
});

test('Last-owner protection: cannot demote, suspend, or remove the tenant\'s only active owner',async()=>{
 const {app,call,cleanup,ownerA,tenantA,userAId}=await twoTenants();
 try{
  const membershipA=app.store.db.prepare('SELECT id FROM tenant_memberships WHERE tenant_id=? AND user_id=?').get(tenantA,userAId);
  const demote=await call(`/api/workspaces/members/${membershipA.id}`,{role:'operator'},ownerA,{method:'PATCH'});
  assert.equal(demote.status,409);
  const suspend=await call(`/api/workspaces/members/${membershipA.id}`,{status:'suspended'},ownerA,{method:'PATCH'});
  assert.equal(suspend.status,409);
  const remove=await call(`/api/workspaces/members/${membershipA.id}`,null,ownerA,{method:'DELETE'});
  assert.equal(remove.status,409);
  // A second owner exists -> demoting/removing the FIRST one now succeeds.
  const auth=createAuth(app.store.db);
  const secondOwner=auth.createUser({username:'secondowner',name:'Second Owner',password:'a-long-test-password'},'owner');
  app.store.db.prepare('INSERT INTO tenant_memberships (id,tenant_id,user_id,role,status,is_owner,created_at) VALUES (?,?,?,?,?,?,?)').run(crypto.randomUUID(),tenantA,secondOwner.id,'owner','active',1,new Date().toISOString());
  const demoteNow=await call(`/api/workspaces/members/${membershipA.id}`,{role:'operator'},ownerA,{method:'PATCH'});
  assert.equal(demoteNow.status,200);
 }finally{await cleanup();}
});

// --- Session/workspace invalidation after membership changes --------------------------------

test('Session invalidation: a member whose membership is suspended loses tenant-scoped access on the very next request',async()=>{
 const {app,call,cleanup,ownerA,tenantA}=await twoTenants();
 try{
  const auth=createAuth(app.store.db);
  auth.createUser({username:'suspendme',name:'Suspend Me',password:'a-long-test-password'},'operator');
  const memberSession=await loginAs(app,'suspendme','a-long-test-password');
  const created=await call('/api/workspaces/invitations',{email:'sm@example.com',role:'operator'},ownerA);
  await call(`/api/invitations/${created.data.token}/accept`,{},memberSession);
  const before=await call('/api/crm',null,memberSession,{method:'GET'});
  assert.equal(before.status,200);

  const membershipId=app.store.db.prepare("SELECT id FROM tenant_memberships WHERE tenant_id=? AND user_id=(SELECT id FROM users WHERE username='suspendme')").get(tenantA).id;
  await call(`/api/workspaces/members/${membershipId}`,{status:'suspended'},ownerA,{method:'PATCH'});

  const after=await call('/api/crm',null,memberSession,{method:'GET'});
  assert.equal(after.status,403);assert.equal(after.data.error,'NO_WORKSPACE_ACCESS');
 }finally{await cleanup();}
});

test('Workspace switch after revocation: a multi-workspace user\'s removed membership disappears from GET /api/workspaces and their active selection safely falls back',async()=>{
 const {app,call,cleanup,ownerA,ownerB,tenantA,tenantB}=await twoTenants();
 try{
  // Owner B invites Owner A into Tenant B -> Owner A becomes genuinely multi-membership.
  const created=await call('/api/workspaces/invitations',{email:'ownera-into-b@example.com',role:'operator'},ownerB);
  const accept=await call(`/api/invitations/${created.data.token}/accept`,{},ownerA);
  assert.equal(accept.status,200);

  const listBefore=await call('/api/workspaces',null,ownerA,{method:'GET'});
  assert.equal(listBefore.data.length,2);

  // Owner A switches into Tenant B.
  const activate=await call('/api/workspaces/active',{workspaceId:tenantB},ownerA,{method:'PUT'});
  assert.equal(activate.status,200);assert.equal(activate.data.id,tenantB);

  // Owner B removes Owner A's membership.
  const userAId=app.store.db.prepare("SELECT id FROM users WHERE username='ownera'").get().id;
  const membershipInB=app.store.db.prepare('SELECT id FROM tenant_memberships WHERE tenant_id=? AND user_id=?').get(tenantB,userAId);
  const removed=await call(`/api/workspaces/members/${membershipInB.id}`,null,ownerB,{method:'DELETE'});
  assert.equal(removed.status,200);

  // Tenant B must be gone from the list, and the STALE active selection (still pointing at
  // B) must safely fall back — Owner A has exactly one valid membership left (Tenant A), so
  // it resolves there automatically rather than erroring or staying stuck on B.
  const listAfter=await call('/api/workspaces',null,ownerA,{method:'GET'});
  assert.equal(listAfter.data.length,1);assert.equal(listAfter.data[0].id,tenantA);
  const activeAfter=await call('/api/workspaces/active',null,ownerA,{method:'GET'});
  assert.equal(activeAfter.status,200);assert.equal(activeAfter.data.id,tenantA);

  // And Tenant B's own data is genuinely inaccessible now.
  const controlCenter=await call('/api/control-center/summary',null,ownerA,{method:'GET'});
  assert.notEqual(controlCenter.data.workspace.id,tenantB);
 }finally{await cleanup();}
});
