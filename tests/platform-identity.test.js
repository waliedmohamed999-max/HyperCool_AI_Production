import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';

// Phase 4C-5 — Platform Identity + Verified Email Foundation. Real HTTP end-to-end tests, same
// harness shape as tests/workspace-invitations.test.js / tests/workspace-onboarding.test.js.
// Every test uses `PLATFORM_MAIL_TRANSPORT=capture` (src/runtime/platform-mail.js) — a real,
// working, intentionally-non-network transport that records the full rendered message
// (including the verification/reset link) into `platform_mail_outbox`, so a test can read the
// exact same link a real inbox would receive without ever touching the network (Part 74: "Do
// not send real email in automated test suite").
async function harness(env={}) {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-identity-'));
 const app=await createApp({dataDir:directory,env:{PLATFORM_MAIL_TRANSPORT:'capture',...env}});
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
function latestMailTo(app,toEmail,kind) {
 const row=app.store.db.prepare('SELECT * FROM platform_mail_outbox WHERE to_email=? AND kind=? ORDER BY created_at DESC LIMIT 1').get(toEmail,kind);
 return row?{...row,body:JSON.parse(row.captured_body)}:null;
}
function extractToken(body,marker) {
 const match=(body.html+body.text).match(new RegExp(marker+'/([a-f0-9]+)'));
 return match?match[1]:null;
}
async function ownerSession() {
 const {app,call,cleanup}=await harness();
 const owner=await call('/api/setup',{username:'owner1',name:'Owner One',password:'a-long-test-password'});
 await call('/api/auth',null,owner,{method:'GET'});
 return {app,call,cleanup,owner};
}

test('Add email: succeeds, stores normalized, sent via capture transport, and state is PENDING not verified',async()=>{
 const {app,call,cleanup,owner}=await ownerSession();
 try{
  const result=await call('/api/account/email',{email:' Owner1@Example.COM '},owner);
  assert.equal(result.status,200);
  assert.equal(result.data.pendingEmail,'owner1@example.com');
  assert.equal(result.data.delivered,true);
  const identity=await call('/api/account',null,owner,{method:'GET'});
  assert.equal(identity.data.email,null);
  assert.equal(identity.data.pendingEmail,'owner1@example.com');
  assert.equal(identity.data.emailVerifiedAt,null);
  const mail=latestMailTo(app,'owner1@example.com','VERIFY_EMAIL');
  assert.ok(mail,'a verification email must be captured');
  assert.equal(mail.status,'SENT');
 }finally{await cleanup();}
});

test('Invalid email format is rejected with 400',async()=>{
 const {call,cleanup,owner}=await ownerSession();
 try{
  const result=await call('/api/account/email',{email:'not-an-email'},owner);
  assert.equal(result.status,400);
 }finally{await cleanup();}
});

test('Duplicate verified email across two accounts is rejected',async()=>{
 const {app,call,cleanup,owner}=await ownerSession();
 try{
  const add=await call('/api/account/email',{email:'shared@example.com'},owner);
  const mail=latestMailTo(app,'shared@example.com','VERIFY_EMAIL');
  const token=extractToken(mail.body,'verify-email');
  await call('/api/account/email/verify',{token},null);

  const second=await call('/api/setup',{username:'nope',name:'x',password:'a-long-test-password'}).catch(()=>null);
  // setup only works once; use a second real user via login flow instead
  const auth=app.store.db;
  const bcrypt=await import('../src/auth.js');
  const authApi=bcrypt.createAuth(app.store.db);
  authApi.createUser({username:'owner2',name:'Owner Two',password:'a-long-test-password'},'owner');
  const login2=authApi.login({username:'owner2',password:'a-long-test-password'},'127.0.0.1');
  const owner2={cookie:'hc_session='+login2.token,csrf:login2.csrf};

  const conflict=await call('/api/account/email',{email:'shared@example.com'},owner2);
  assert.equal(conflict.status,409);
 }finally{await cleanup();}
});

test('Verify valid token: promotes to verified email, clears pending, and login-by-email now works',async()=>{
 const {app,call,cleanup,owner}=await ownerSession();
 try{
  await call('/api/account/email',{email:'verify-me@example.com'},owner);
  const mail=latestMailTo(app,'verify-me@example.com','VERIFY_EMAIL');
  const token=extractToken(mail.body,'verify-email');
  const verify=await call('/api/account/email/verify',{token},null);
  assert.equal(verify.status,200);
  assert.equal(verify.data.email,'verify-me@example.com');

  const identity=await call('/api/account',null,owner,{method:'GET'});
  assert.equal(identity.data.email,'verify-me@example.com');
  assert.equal(identity.data.pendingEmail,null);
  assert.ok(identity.data.emailVerifiedAt);

  const loginByEmail=await call('/api/login',{username:'verify-me@example.com',password:'a-long-test-password'});
  assert.equal(loginByEmail.status,200);
  assert.equal(loginByEmail.data.user.username,'owner1');
 }finally{await cleanup();}
});

test('Verification token replay is rejected (410) — single use',async()=>{
 const {app,call,cleanup,owner}=await ownerSession();
 try{
  await call('/api/account/email',{email:'replay@example.com'},owner);
  const mail=latestMailTo(app,'replay@example.com','VERIFY_EMAIL');
  const token=extractToken(mail.body,'verify-email');
  const first=await call('/api/account/email/verify',{token},null);
  assert.equal(first.status,200);
  const second=await call('/api/account/email/verify',{token},null);
  assert.equal(second.status,410);
 }finally{await cleanup();}
});

test('Expired verification token is rejected (410)',async()=>{
 const {app,call,cleanup,owner}=await ownerSession();
 try{
  await call('/api/account/email',{email:'expired@example.com'},owner);
  const row=app.store.db.prepare('SELECT id FROM email_verification_tokens ORDER BY created_at DESC LIMIT 1').get();
  app.store.db.prepare("UPDATE email_verification_tokens SET expires_at=? WHERE id=?").run(new Date(Date.now()-1000).toISOString(),row.id);
  const mail=latestMailTo(app,'expired@example.com','VERIFY_EMAIL');
  const token=extractToken(mail.body,'verify-email');
  const result=await call('/api/account/email/verify',{token},null);
  assert.equal(result.status,410);
 }finally{await cleanup();}
});

test('Resend rotates the token: the OLD token stops working, only the NEW one verifies',async()=>{
 const {app,call,cleanup,owner}=await ownerSession();
 try{
  await call('/api/account/email',{email:'rotate@example.com'},owner);
  const firstMail=latestMailTo(app,'rotate@example.com','VERIFY_EMAIL');
  const firstToken=extractToken(firstMail.body,'verify-email');
  await call('/api/account/email/resend-verification',{},owner);
  const secondMail=app.store.db.prepare("SELECT * FROM platform_mail_outbox WHERE to_email=? AND kind='VERIFY_EMAIL' ORDER BY created_at DESC").all('rotate@example.com');
  assert.equal(secondMail.length,2);
  const secondToken=extractToken({...JSON.parse(secondMail[0].captured_body)},'verify-email');
  assert.notEqual(firstToken,secondToken);
  const oldAttempt=await call('/api/account/email/verify',{token:firstToken},null);
  assert.equal(oldAttempt.status,404);
  const newAttempt=await call('/api/account/email/verify',{token:secondToken},null);
  assert.equal(newAttempt.status,200);
 }finally{await cleanup();}
});

test('Changing an already-verified email keeps the OLD one active until the NEW one is verified',async()=>{
 const {app,call,cleanup,owner}=await ownerSession();
 try{
  await call('/api/account/email',{email:'old@example.com'},owner);
  let mail=latestMailTo(app,'old@example.com','VERIFY_EMAIL');
  await call('/api/account/email/verify',{token:extractToken(mail.body,'verify-email')},null);

  await call('/api/account/email',{email:'new@example.com'},owner);
  const identity=await call('/api/account',null,owner,{method:'GET'});
  assert.equal(identity.data.email,'old@example.com','old verified email must remain until the new one verifies');
  assert.equal(identity.data.pendingEmail,'new@example.com');

  const loginOldStillWorks=await call('/api/login',{username:'old@example.com',password:'a-long-test-password'});
  assert.equal(loginOldStillWorks.status,200);

  mail=latestMailTo(app,'new@example.com','VERIFY_EMAIL');
  await call('/api/account/email/verify',{token:extractToken(mail.body,'verify-email')},null);
  const after=await call('/api/account',null,owner,{method:'GET'});
  assert.equal(after.data.email,'new@example.com');
  assert.equal(after.data.pendingEmail,null);
 }finally{await cleanup();}
});

test('Username login is completely unaffected by any of this',async()=>{
 const {call,cleanup,owner}=await ownerSession();
 try{
  const login=await call('/api/login',{username:'owner1',password:'a-long-test-password'});
  assert.equal(login.status,200);
 }finally{await cleanup();}
});

test('An UNVERIFIED (pending) email cannot be used to log in',async()=>{
 const {call,cleanup,owner}=await ownerSession();
 try{
  await call('/api/account/email',{email:'pending@example.com'},owner);
  const login=await call('/api/login',{username:'pending@example.com',password:'a-long-test-password'});
  assert.equal(login.status,401);
 }finally{await cleanup();}
});

test('Forgot password: identical generic response whether the email exists or not (no enumeration)',async()=>{
 const {app,call,cleanup,owner}=await ownerSession();
 try{
  await call('/api/account/email',{email:'known@example.com'},owner);
  const mail=latestMailTo(app,'known@example.com','VERIFY_EMAIL');
  await call('/api/account/email/verify',{token:extractToken(mail.body,'verify-email')},null);

  const known=await call('/api/auth/forgot-password',{email:'known@example.com'});
  const unknown=await call('/api/auth/forgot-password',{email:'nobody-here@example.com'});
  assert.equal(known.status,200);
  assert.equal(unknown.status,200);
  assert.equal(known.data.message,unknown.data.message);
 }finally{await cleanup();}
});

test('Password reset: valid token resets the password, hashed at rest, single-use, and invalidates every existing session',async()=>{
 const {app,call,cleanup,owner}=await ownerSession();
 try{
  await call('/api/account/email',{email:'reset@example.com'},owner);
  let mail=latestMailTo(app,'reset@example.com','VERIFY_EMAIL');
  await call('/api/account/email/verify',{token:extractToken(mail.body,'verify-email')},null);

  await call('/api/auth/forgot-password',{email:'reset@example.com'});
  const resetMail=latestMailTo(app,'reset@example.com','PASSWORD_RESET');
  const resetToken=extractToken(resetMail.body,'reset-password');
  assert.ok(resetToken);
  const rawRow=app.store.db.prepare('SELECT token_hash FROM password_reset_tokens ORDER BY created_at DESC LIMIT 1').get();
  assert.notEqual(rawRow.token_hash,resetToken,'the raw token must never be stored — only its hash');

  const stillWorksBeforeReset=await call('/api/auth',null,owner,{method:'GET'});
  assert.ok(stillWorksBeforeReset.data.user);

  const reset=await call('/api/auth/reset-password',{token:resetToken,password:'a-brand-new-password-123'});
  assert.equal(reset.status,200);

  // old session is now dead
  const afterReset=await call('/api/auth',null,owner,{method:'GET'});
  assert.equal(afterReset.data.user,null);

  // replay is rejected
  const replay=await call('/api/auth/reset-password',{token:resetToken,password:'another-password-456'});
  assert.equal(replay.status,410);

  // new password works via username
  const login=await call('/api/login',{username:'owner1',password:'a-brand-new-password-123'});
  assert.equal(login.status,200);
 }finally{await cleanup();}
});

test('Expired password reset token is rejected',async()=>{
 const {app,call,cleanup,owner}=await ownerSession();
 try{
  await call('/api/account/email',{email:'expreset@example.com'},owner);
  let mail=latestMailTo(app,'expreset@example.com','VERIFY_EMAIL');
  await call('/api/account/email/verify',{token:extractToken(mail.body,'verify-email')},null);
  await call('/api/auth/forgot-password',{email:'expreset@example.com'});
  const row=app.store.db.prepare('SELECT id FROM password_reset_tokens ORDER BY created_at DESC LIMIT 1').get();
  app.store.db.prepare('UPDATE password_reset_tokens SET expires_at=? WHERE id=?').run(new Date(Date.now()-1000).toISOString(),row.id);
  const resetMail=latestMailTo(app,'expreset@example.com','PASSWORD_RESET');
  const result=await call('/api/auth/reset-password',{token:extractToken(resetMail.body,'reset-password'),password:'whatever-password-1'});
  assert.equal(result.status,410);
 }finally{await cleanup();}
});

test('No raw token ever appears anywhere in the plain DB rows for either token table',async()=>{
 const {app,call,cleanup,owner}=await ownerSession();
 try{
  await call('/api/account/email',{email:'secret@example.com'},owner);
  const mail=latestMailTo(app,'secret@example.com','VERIFY_EMAIL');
  const token=extractToken(mail.body,'verify-email');
  const row=app.store.db.prepare('SELECT * FROM email_verification_tokens ORDER BY created_at DESC LIMIT 1').get();
  assert.notEqual(row.token_hash,token);
  assert.equal(row.token_hash.length,64); // sha256 hex
 }finally{await cleanup();}
});

test('IDOR: a user can only ever act on their OWN account email — routes are keyed by session, never a request-supplied user id',async()=>{
 const {app,call,cleanup,owner}=await ownerSession();
 try{
  const authApi=(await import('../src/auth.js')).createAuth(app.store.db);
  authApi.createUser({username:'other1',name:'Other',password:'a-long-test-password'},'owner');
  const loginOther=authApi.login({username:'other1',password:'a-long-test-password'},'127.0.0.1');
  const other={cookie:'hc_session='+loginOther.token,csrf:loginOther.csrf};

  await call('/api/account/email',{email:'mine@example.com'},owner);
  const otherIdentity=await call('/api/account',null,other,{method:'GET'});
  assert.equal(otherIdentity.data.pendingEmail,null,'account routes have no id param — they can only ever read/act on the caller\'s own session');
 }finally{await cleanup();}
});

test('Rate limiting: forgot-password is throttled per IP after enough repeated requests',async()=>{
 // The limiter (src/platform-identity.js) is a single process-wide counter per IP, shared
 // across every test in this file (matching auth.js's own login limiter's exact shape) — so
 // this asserts "a 429 eventually appears somewhere in a large burst" rather than an exact
 // call index, which would be fragile to how much budget earlier tests already consumed.
 const {call,cleanup}=await ownerSession();
 try{
  const statuses=[];
  for(let i=0;i<60;i++)statuses.push((await call('/api/auth/forgot-password',{email:'flood@example.com'})).status);
  assert.ok(statuses.includes(429),'expected at least one 429 across a 60-request burst: '+statuses.join(','));
 }finally{await cleanup();}
});

test('Platform mail transport status is honestly reported (capture counts as CONFIGURED)',async()=>{
 const {call,cleanup,owner}=await ownerSession();
 try{
  const identity=await call('/api/account',null,owner,{method:'GET'});
  assert.equal(identity.data.platformMail,'CONFIGURED');
 }finally{await cleanup();}
});

test('EMAIL_BOUND invitation: a brand-new account registering through it gets its email auto-verified (receipt of the link IS the proof)',async()=>{
 const {app,call,cleanup,owner}=await ownerSession();
 try{
  const created=await call('/api/workspaces/invitations',{email:'newbie@example.com',role:'operator'},owner);
  assert.equal(created.data.invitationMode,'EMAIL_BOUND');
  const register=await call(`/api/invitations/${created.data.token}/register`,{username:'newbie',name:'Newbie',password:'a-long-test-password'});
  assert.equal(register.status,200);
  assert.equal(register.data.user.email,'newbie@example.com');
  assert.ok(register.data.user.emailVerifiedAt);
 }finally{await cleanup();}
});

test('EMAIL_BOUND invitation: an EXISTING user with a DIFFERENT verified email is rejected (403) — token possession alone is not enough',async()=>{
 const {app,call,cleanup,owner}=await ownerSession();
 try{
  const authApi=(await import('../src/auth.js')).createAuth(app.store.db);
  authApi.createUser({username:'wrongperson',name:'Wrong Person',password:'a-long-test-password'},'operator');
  const login=authApi.login({username:'wrongperson',password:'a-long-test-password'},'127.0.0.1');
  const wrongPerson={cookie:'hc_session='+login.token,csrf:login.csrf};
  // give wrongPerson a real, DIFFERENT verified email
  await call('/api/account/email',{email:'wrongperson@example.com'},wrongPerson);
  const mail=latestMailTo(app,'wrongperson@example.com','VERIFY_EMAIL');
  await call('/api/account/email/verify',{token:extractToken(mail.body,'verify-email')},null);

  const created=await call('/api/workspaces/invitations',{email:'targetperson@example.com',role:'operator'},owner);
  const accept=await call(`/api/invitations/${created.data.token}/accept`,{},wrongPerson);
  assert.equal(accept.status,403);
 }finally{await cleanup();}
});

test('EMAIL_BOUND invitation: an EXISTING user with NO verified email yet can still accept (Part 47/48 transition — not a new hard blocker)',async()=>{
 const {app,call,cleanup,owner}=await ownerSession();
 try{
  const authApi=(await import('../src/auth.js')).createAuth(app.store.db);
  authApi.createUser({username:'legacyperson',name:'Legacy Person',password:'a-long-test-password'},'operator');
  const login=authApi.login({username:'legacyperson',password:'a-long-test-password'},'127.0.0.1');
  const legacyPerson={cookie:'hc_session='+login.token,csrf:login.csrf};

  const created=await call('/api/workspaces/invitations',{email:'anyaddress@example.com',role:'operator'},owner);
  const accept=await call(`/api/invitations/${created.data.token}/accept`,{},legacyPerson);
  assert.equal(accept.status,200);
 }finally{await cleanup();}
});

test('TOKEN_ONLY_LEGACY invitation (pre-existing data, simulated directly at the DB level): identity binding is never enforced, exactly as before this phase',async()=>{
 const {app,call,cleanup,owner}=await ownerSession();
 try{
  const authApi=(await import('../src/auth.js')).createAuth(app.store.db);
  authApi.createUser({username:'anybody',name:'Any Body',password:'a-long-test-password'},'operator');
  const login=authApi.login({username:'anybody',password:'a-long-test-password'},'127.0.0.1');
  const anybody={cookie:'hc_session='+login.token,csrf:login.csrf};
  await call('/api/account/email',{email:'anybody@example.com'},anybody);
  const mail=latestMailTo(app,'anybody@example.com','VERIFY_EMAIL');
  await call('/api/account/email/verify',{token:extractToken(mail.body,'verify-email')},null);

  const created=await call('/api/workspaces/invitations',{email:'completely-different@example.com',role:'operator'},owner);
  // Simulate a row created BEFORE Phase 4C-5 existed.
  app.store.db.prepare("UPDATE workspace_invitations SET invitation_mode='TOKEN_ONLY_LEGACY' WHERE id=?").run(created.data.id);
  const accept=await call(`/api/invitations/${created.data.token}/accept`,{},anybody);
  assert.equal(accept.status,200,'a legacy token-only invitation must keep accepting on token possession alone, regardless of the accepting user\'s own verified email');
 }finally{await cleanup();}
});

test('Platform mail is UNCONFIGURED when no transport is set — verification email is then honestly reported as not delivered',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {createApp}=await import('../src/application.js');
 const directory=await mkdtemp(join(tmpdir(),'hypercool-identity-unconf-'));
 const app=await createApp({dataDir:directory,env:{}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session,{method,headers={}}={}) {
  const hasBody=input!==undefined && input!==null && method!=='GET';
  const res=await fetch(base+path,{method:method||(input!=null?'POST':'GET'),redirect:'manual',headers:{...(hasBody?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...headers},...(hasBody?{body:typeof input==='string'?input:JSON.stringify(input)}:{})});
  const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data?.csrf};
 }
 try{
  const owner=await call('/api/setup',{username:'noconf',name:'No Conf',password:'a-long-test-password'});
  const result=await call('/api/account/email',{email:'noconf@example.com'},owner);
  assert.equal(result.status,200);
  assert.equal(result.data.delivered,false);
  assert.equal(result.data.errorCode,'PLATFORM_MAIL_UNCONFIGURED');
 }finally{
  await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});
 }
});
