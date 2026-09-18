import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';

// Phase MKT-2, Part K — real marketing_assets CRUD wired to the UI, reusing the EXISTING
// command_attachments store for real uploads rather than a second file-storage system.
async function harness() {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-mkt-assets-'));
 const app=await createApp({dataDir:directory,env:{PLATFORM_MAIL_TRANSPORT:'capture'}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session,{method,headers={}}={}) {
  const hasBody=input!==undefined && input!==null && method!=='GET';
  const res=await fetch(base+path,{method:method||(input!=null?'POST':'GET'),headers:{...(hasBody?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...headers},...(hasBody?{body:typeof input==='string'?input:JSON.stringify(input)}:{})});
  const contentType=res.headers.get('content-type')||'';
  const data=contentType.includes('application/json')?await res.json().catch(()=>null):await res.text();
  return {status:res.status,data,contentType,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data?.csrf};
 }
 return {app,base,call,cleanup:async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}};
}
function latestMailTo(app,toEmail,kind) {
 const row=app.store.db.prepare('SELECT * FROM platform_mail_outbox WHERE to_email=? AND kind=? ORDER BY created_at DESC LIMIT 1').get(toEmail,kind);
 return row?JSON.parse(row.captured_body):null;
}
function extractToken(body,marker) {
 const match=(body.html+body.text).match(new RegExp(marker+'/([a-f0-9]+)'));
 return match?match[1]:null;
}
async function signupAndCreateWorkspace(call,app,{username,email,companyName}) {
 const signup=await call('/api/signup',{name:'مستخدم اختبار',username,email,password:'a-long-test-password'});
 const session={cookie:signup.cookie,csrf:signup.csrf};
 const mail=latestMailTo(app,email,'VERIFY_EMAIL');
 const token=extractToken(mail,'verify-email');
 await call('/api/account/email/verify',{token},null);
 await call('/api/workspaces',{companyName},session);
 return session;
}
const TINY_PNG_BASE64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('Part K — creates a real external_url asset, refuses http and non-https, and lists it',async()=>{
 const {call,app,cleanup}=await harness();
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'asset1',email:'asset1@example.com',companyName:'Asset Test 1'});
  const rejected=await call('/api/marketing/assets',{type:'image',source:'external_url',fileRef:'http://insecure.example.com/x.png'},owner);
  assert.equal(rejected.status,400);
  const created=await call('/api/marketing/assets',{type:'image',source:'external_url',fileRef:'https://cdn.example.com/x.png'},owner);
  assert.equal(created.status,201,JSON.stringify(created.data));
  assert.equal(created.data.approved,false);
  assert.equal(created.data.status,'ACTIVE');
  const list=await call('/api/marketing/assets',undefined,owner,{method:'GET'});
  assert.equal(list.data.length,1);
  assert.equal(list.data[0].fileRef,'https://cdn.example.com/x.png');
 } finally { await cleanup(); }
});

test('Part K — a real uploaded file becomes a marketing_asset, is served back with the real content-type, and a spoofed foreign attachment id is refused',async()=>{
 const {call,app,cleanup}=await harness();
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'asset2',email:'asset2@example.com',companyName:'Asset Test 2'});
  const upload=await call('/api/command/attachments',{filename:'logo.png',mimeType:'image/png',contentBase64:TINY_PNG_BASE64},owner);
  assert.equal(upload.status,201,JSON.stringify(upload.data));
  const asset=await call('/api/marketing/assets',{type:'image',source:'upload',fileRef:upload.data.id},owner);
  assert.equal(asset.status,201,JSON.stringify(asset.data));
  const file=await call(`/api/command/attachments/${upload.data.id}/file`,undefined,owner,{method:'GET'});
  assert.equal(file.status,200);
  assert.equal(file.contentType,'image/png');
  // A foreign/nonexistent attachment id must never be silently accepted as a real reference.
  const spoofed=await call('/api/marketing/assets',{type:'image',source:'upload',fileRef:'does-not-exist'},owner);
  assert.equal(spoofed.status,404);
 } finally { await cleanup(); }
});

test('Part K — approve and archive (soft-delete) a real asset; archived assets no longer appear in the list',async()=>{
 const {call,app,cleanup}=await harness();
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'asset3',email:'asset3@example.com',companyName:'Asset Test 3'});
  const created=await call('/api/marketing/assets',{type:'creative_reference',source:'creative_reference',fileRef:'creative brief: hero shot, top-left logo'},owner);
  const approved=await call(`/api/marketing/assets/${created.data.id}`,{approved:true},owner,{method:'PATCH'});
  assert.equal(approved.data.approved,true);
  const deleted=await call(`/api/marketing/assets/${created.data.id}`,undefined,owner,{method:'DELETE'});
  assert.equal(deleted.status,200);
  const list=await call('/api/marketing/assets',undefined,owner,{method:'GET'});
  assert.equal(list.data.length,0);
 } finally { await cleanup(); }
});

test('Part K — tenant isolation: Tenant B cannot see, fetch, approve, or delete Tenant A\'s assets',async()=>{
 const {call,app,cleanup}=await harness();
 try {
  const ownerA=await signupAndCreateWorkspace(call,app,{username:'assetisoa',email:'assetisoa@example.com',companyName:'Asset Iso A'});
  const ownerB=await signupAndCreateWorkspace(call,app,{username:'assetisob',email:'assetisob@example.com',companyName:'Asset Iso B'});
  const created=await call('/api/marketing/assets',{type:'external_url',source:'external_url',fileRef:'https://cdn.example.com/a.png'},ownerA);
  assert.equal((await call('/api/marketing/assets',undefined,ownerB,{method:'GET'})).data.length,0);
  assert.equal((await call(`/api/marketing/assets/${created.data.id}`,undefined,ownerB,{method:'GET'})).status,404);
  assert.equal((await call(`/api/marketing/assets/${created.data.id}`,{approved:true},ownerB,{method:'PATCH'})).status,404);
  assert.equal((await call(`/api/marketing/assets/${created.data.id}`,undefined,ownerB,{method:'DELETE'})).status,404);
 } finally { await cleanup(); }
});

test('Part O — tenant isolation: Tenant B cannot download Tenant A\'s uploaded file bytes, and cannot reference it as an asset',async()=>{
 const {call,app,cleanup}=await harness();
 try {
  const ownerA=await signupAndCreateWorkspace(call,app,{username:'fileisoa',email:'fileisoa@example.com',companyName:'File Iso A'});
  const ownerB=await signupAndCreateWorkspace(call,app,{username:'fileisob',email:'fileisob@example.com',companyName:'File Iso B'});
  const upload=await call('/api/command/attachments',{filename:'secret.png',mimeType:'image/png',contentBase64:TINY_PNG_BASE64},ownerA);
  assert.equal((await call(`/api/command/attachments/${upload.data.id}/file`,undefined,ownerB,{method:'GET'})).status,404);
  assert.equal((await call('/api/marketing/assets',{type:'image',source:'upload',fileRef:upload.data.id},ownerB)).status,404);
  // Tenant A itself can still fetch it — this is a tenant check, not a broken feature.
  assert.equal((await call(`/api/command/attachments/${upload.data.id}/file`,undefined,ownerA,{method:'GET'})).status,200);
 } finally { await cleanup(); }
});

test('Part K — write actions are gated to owner/operator; a reviewer can still list assets',async()=>{
 const {call,app,cleanup}=await harness();
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'assetrole1',email:'assetrole1@example.com',companyName:'Asset Roles'});
  const invite=await call('/api/workspaces/invitations',{email:'reviewer-asset1@example.com',role:'reviewer'},owner);
  const register=await call(`/api/invitations/${invite.data.token}/register`,{username:'reviewerAsset1',name:'مراجع',password:'a-long-test-password'},null);
  const reviewer={cookie:register.cookie,csrf:register.data.csrf};
  const denied=await call('/api/marketing/assets',{type:'external_url',source:'external_url',fileRef:'https://cdn.example.com/a.png'},reviewer);
  assert.equal(denied.status,403);
  const list=await call('/api/marketing/assets',undefined,reviewer,{method:'GET'});
  assert.equal(list.status,200);
 } finally { await cleanup(); }
});
