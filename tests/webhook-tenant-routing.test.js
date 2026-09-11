import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHmac} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createAuth} from '../src/auth.js';
import {createTenant,resolveTenantForUser} from '../src/tenancy.js';
import {saveCredentials} from '../src/runtime/credentials.js';

// Multi-Tenant Phase 3.5 (Part B14/B15) — the cross-tenant webhook security matrix: real
// provider identity routes correctly, an unknown identity resolves to nobody (never a
// default tenant), and a payload that CLAIMS to belong to a different tenant is ignored
// entirely, because no code path here ever reads such a claim in the first place.
const key32=randomBytes(32).toString('hex');

async function harness(env={}) {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-webhook-tenancy-'));
 const app=await createApp({dataDir:directory,env});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session,{method,headers={}}={}){
  const hasBody=input!==undefined && input!==null && method!=='GET';
  const res=await fetch(base+path,{method:method||(input!=null?'POST':'GET'),redirect:'manual',headers:{...(hasBody?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...headers},...(hasBody?{body:typeof input==='string'?input:JSON.stringify(input)}:{})});
  const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data?.csrf,location:res.headers.get('location')};
 }
 return {app,call,cleanup:async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}};
}
async function twoTenants(env={}) {
 const {app,call,cleanup}=await harness(env);
 const ownerA=await call('/api/setup',{username:'ownera',name:'Owner A',password:'a-long-test-password'});
 // Phase 4C-1: resolve Owner A's own membership while still the sole tenant — see the same
 // note in tests/tenancy-phase2.test.js.
 await call('/api/auth',null,ownerA,{method:'GET'});
 const auth=createAuth(app.store.db);
 const userB=auth.createUser({username:'ownerb',name:'Owner B',password:'a-long-test-password'},'owner');
 const tenantB=createTenant(app.store.db,{name:'Second Co',slug:'second-co'},userB.id);
 app.store.db.prepare('DELETE FROM tenant_memberships WHERE user_id=? AND tenant_id!=?').run(userB.id,tenantB);
 const loginB=auth.login({username:'ownerb',password:'a-long-test-password'},'127.0.0.1');
 const ownerB={cookie:'hc_session='+loginB.token,csrf:loginB.csrf};
 const userA=app.store.db.prepare("SELECT id FROM users WHERE username='ownera'").get();
 const tenantA=resolveTenantForUser(app.store.db,userA.id);
 return {app,call,cleanup,ownerA,ownerB,tenantA,tenantB};
}
function sign(secret,body){return 'sha256='+createHmac('sha256',secret).update(body).digest('hex');}
function connectWhatsApp(app,env,tenantId,phoneNumberId){
 saveCredentials(app.store.db,env,'meta',{accessToken:'user-token',expiresAt:new Date(Date.now()+3600000).toISOString(),extra:{pageAccessToken:'page-token'},metadata:{whatsapp:{phoneNumberId,businessAccountId:'waba-'+phoneNumberId,displayPhoneNumber:'+9665'+phoneNumberId}}},null,tenantId);
}

test('B14/T — a WhatsApp webhook for Tenant A\'s real phone_number_id only ever creates data in Tenant A, never Tenant B',async()=>{
 const env={META_WEBHOOK_SECRET:'wh-secret',INTEGRATION_ENCRYPTION_KEY:key32};
 const {app,call,cleanup,ownerA,ownerB,tenantA,tenantB}=await twoTenants(env);
 try{
  connectWhatsApp(app,env,tenantA,'phone-a');
  connectWhatsApp(app,env,tenantB,'phone-b');
  const rawA=JSON.stringify({entry:[{changes:[{value:{metadata:{phone_number_id:'phone-a'},contacts:[{profile:{name:'Customer A'}}],messages:[{id:'wamid.a.1',from:'966500000001',type:'text',text:{body:'hi from A side'}}]}}]}]});
  const res=await call('/api/webhooks/meta/whatsapp',rawA,null,{headers:{'x-hub-signature-256':sign('wh-secret',rawA)}});
  assert.equal(res.status,200);assert.equal(res.data.received,1);
  const leadsA=(await call('/api/crm',null,ownerA,{method:'GET'})).data.leads;
  const leadsB=(await call('/api/crm',null,ownerB,{method:'GET'})).data.leads;
  assert.equal(leadsA.length,1);
  assert.equal(leadsA[0].phone,'+966500000001');
  assert.equal(leadsB.length,0); // Tenant B never sees Tenant A's WhatsApp customer
 }finally{await cleanup();}
});

test('B14/U — the same webhook route correctly attributes Tenant B\'s own delivery to Tenant B, not Tenant A',async()=>{
 const env={META_WEBHOOK_SECRET:'wh-secret',INTEGRATION_ENCRYPTION_KEY:key32};
 const {app,call,cleanup,ownerA,ownerB,tenantA,tenantB}=await twoTenants(env);
 try{
  connectWhatsApp(app,env,tenantA,'phone-a');
  connectWhatsApp(app,env,tenantB,'phone-b');
  const rawB=JSON.stringify({entry:[{changes:[{value:{metadata:{phone_number_id:'phone-b'},contacts:[{profile:{name:'Customer B'}}],messages:[{id:'wamid.b.1',from:'966500000002',type:'text',text:{body:'hi from B side'}}]}}]}]});
  await call('/api/webhooks/meta/whatsapp',rawB,null,{headers:{'x-hub-signature-256':sign('wh-secret',rawB)}});
  const leadsA=(await call('/api/crm',null,ownerA,{method:'GET'})).data.leads;
  const leadsB=(await call('/api/crm',null,ownerB,{method:'GET'})).data.leads;
  assert.equal(leadsB.length,1);
  assert.equal(leadsB[0].phone,'+966500000002');
  assert.equal(leadsA.length,0);
 }finally{await cleanup();}
});

test('B6/Q — a WhatsApp webhook for a phone_number_id no tenant ever connected creates no lead for anyone and never guesses',async()=>{
 const env={META_WEBHOOK_SECRET:'wh-secret',INTEGRATION_ENCRYPTION_KEY:key32};
 const {app,call,cleanup,ownerA,ownerB,tenantA}=await twoTenants(env);
 try{
  connectWhatsApp(app,env,tenantA,'phone-a'); // only Tenant A ever connected anything
  const rawUnknown=JSON.stringify({entry:[{changes:[{value:{metadata:{phone_number_id:'phone-nobody-owns'},messages:[{id:'wamid.x.1',from:'966500000003',type:'text',text:{body:'hi'}}]}}]}]});
  const res=await call('/api/webhooks/meta/whatsapp',rawUnknown,null,{headers:{'x-hub-signature-256':sign('wh-secret',rawUnknown)}});
  assert.equal(res.status,200); // the delivery itself is still acknowledged (never lose real provider data)
  assert.equal((await call('/api/crm',null,ownerA,{method:'GET'})).data.leads.length,0);
  assert.equal((await call('/api/crm',null,ownerB,{method:'GET'})).data.leads.length,0);
  const stored=app.store.db.prepare("SELECT tenant_id AS tenantId, status FROM webhook_events WHERE source='meta'").get();
  assert.equal(stored.tenantId,null); // never a guessed tenant
  assert.equal(stored.status,'TENANT_UNRESOLVED');
 }finally{await cleanup();}
});

test('B15 — a WhatsApp webhook payload that CLAIMS to belong to Tenant B is routed by its real phone_number_id to Tenant A instead, proving the claim is never read',async()=>{
 const env={META_WEBHOOK_SECRET:'wh-secret',INTEGRATION_ENCRYPTION_KEY:key32};
 const {app,call,cleanup,ownerA,ownerB,tenantA,tenantB}=await twoTenants(env);
 try{
  connectWhatsApp(app,env,tenantA,'phone-a');
  connectWhatsApp(app,env,tenantB,'phone-b');
  // The payload uses Tenant A's real, verified phone_number_id but ALSO carries a spoofed
  // top-level tenant_id claiming Tenant B — no code path in normalizeWhatsAppWebhook,
  // resolveTenantForWhatsAppPhoneNumberId, or the webhook route ever reads this field.
  const spoofed=JSON.stringify({tenant_id:tenantB,entry:[{changes:[{value:{metadata:{phone_number_id:'phone-a'},messages:[{id:'wamid.spoof.1',from:'966500000009',type:'text',text:{body:'spoof attempt'}}]}}]}]});
  await call('/api/webhooks/meta/whatsapp',spoofed,null,{headers:{'x-hub-signature-256':sign('wh-secret',spoofed)}});
  const leadsA=(await call('/api/crm',null,ownerA,{method:'GET'})).data.leads;
  const leadsB=(await call('/api/crm',null,ownerB,{method:'GET'})).data.leads;
  assert.equal(leadsA.length,1); // routed by the REAL phone_number_id (Tenant A's), not the spoofed claim
  assert.equal(leadsA[0].phone,'+966500000009');
  assert.equal(leadsB.length,0); // the spoofed tenant_id:tenantB claim had zero effect
 }finally{await cleanup();}
});

test('B3/bootstrap safety — Salla merchant self-registration only fires with exactly one unregistered candidate; two candidates stay unresolved rather than guessing',async()=>{
 const env={SALLA_WEBHOOK_SECRET:'salla-secret'};
 const {app,call,cleanup,tenantA,tenantB}=await twoTenants(env);
 try{
  const now=new Date().toISOString();
  // Both tenants have a real Salla connection, neither has a merchant id recorded yet —
  // exactly the ambiguous case where guessing would be a real cross-tenant risk. Multi-Tenant
  // Phase 4A: routing reads `integration_connections` (see resolveTenantForSallaMerchant),
  // so both candidates must exist there, not just in the legacy table.
  app.store.db.prepare('INSERT INTO integration_credentials (tenant_id,provider,access_token_enc,connected_at,updated_at) VALUES (?,?,?,?,?)').run(tenantA,'salla','placeholder-a',now,now);
  app.store.db.prepare('INSERT INTO integration_credentials (tenant_id,provider,access_token_enc,connected_at,updated_at) VALUES (?,?,?,?,?)').run(tenantB,'salla','placeholder-b',now,now);
  app.store.db.prepare("INSERT INTO integration_connections (id,tenant_id,integration_definition_id,name,status,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(crypto.randomUUID(),tenantA,'salla','الاتصال الرئيسي','CONNECTED',1,now,now);
  app.store.db.prepare("INSERT INTO integration_connections (id,tenant_id,integration_definition_id,name,status,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(crypto.randomUUID(),tenantB,'salla','الاتصال الرئيسي','CONNECTED',1,now,now);
  const raw='{"event":"order.created","data":{"id":"o1"},"merchant":99999}';
  const res=await call('/api/webhooks/salla',raw,null,{headers:{authorization:'Bearer salla-secret'}});
  assert.equal(res.status,200);
  assert.equal(res.data.status,'WEBHOOK_TENANT_UNRESOLVED'); // two candidates — correctly refuses to guess
  const stillUnregistered=app.store.db.prepare("SELECT COUNT(*) n FROM integration_connections WHERE integration_definition_id='salla' AND external_account_id IS NULL").get().n;
  assert.equal(stillUnregistered,2); // neither row was mutated
 }finally{await cleanup();}
});

test('Part C — a webhook-triggered agent run carries the SAME tenantId end to end: webhook -> event -> agent run',async()=>{
 const env={META_WEBHOOK_SECRET:'wh-secret',INTEGRATION_ENCRYPTION_KEY:key32,ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model'};
 const decision={status:'OK',action:'REPLY',rationale:'ok',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],
  payload:{intent:'general',customer_type:'B2C',qualification:{city:null,product_need:null,quantity:null,timeline:null,budget_band:null},recommended_product_id:null,reply_ar:'ok',reply_en:'ok',next_best_action:'send_link',lead_temperature:'COLD',crm_updates:{},missing_fields:[],handoff_reason:null}};
 const anthropicResponse=value=>new Response(JSON.stringify({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(value)}],usage:{input_tokens:3,output_tokens:3}}),{status:200,headers:{'content-type':'application/json'}});
 const directory=await mkdtemp(join(tmpdir(),'hypercool-webhook-propagation-'));
 const app=await createApp({dataDir:directory,env,fetcher:async()=>anthropicResponse(decision)});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session,{method,headers={}}={}){
  const hasBody=input!==undefined && input!==null && method!=='GET';
  const res=await fetch(base+path,{method:method||(input!=null?'POST':'GET'),redirect:'manual',headers:{...(hasBody?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...headers},...(hasBody?{body:typeof input==='string'?input:JSON.stringify(input)}:{})});
  const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data?.csrf};
 }
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'a-long-test-password'});
  // Phase 4C-1: resolve Owner's own membership while still the sole tenant — see the same
  // note in tests/tenancy-phase2.test.js.
  await call('/api/auth',null,owner,{method:'GET'});
  const auth=createAuth(app.store.db);
  const userB=auth.createUser({username:'ownerb',name:'Owner B',password:'a-long-test-password'},'owner');
  const tenantB=createTenant(app.store.db,{name:'Second Co',slug:'second-co'},userB.id);
  app.store.db.prepare('DELETE FROM tenant_memberships WHERE user_id=? AND tenant_id!=?').run(userB.id,tenantB);
  const userA=app.store.db.prepare("SELECT id FROM users WHERE username='owner'").get();
  const tenantA=resolveTenantForUser(app.store.db,userA.id);
  connectWhatsApp(app,env,tenantA,'phone-a');
  const raw=JSON.stringify({entry:[{changes:[{value:{metadata:{phone_number_id:'phone-a'},contacts:[{profile:{name:'Propagation Test'}}],messages:[{id:'wamid.prop.1',from:'966500000099',type:'text',text:{body:'hello'}}]}}]}]});
  await call('/api/webhooks/meta/whatsapp',raw,null,{headers:{'x-hub-signature-256':sign('wh-secret',raw)}});
  await new Promise(resolve=>setTimeout(resolve,150));
  const loginB=auth.login({username:'ownerb',password:'a-long-test-password'},'127.0.0.1');
  const ownerB={cookie:'hc_session='+loginB.token,csrf:loginB.csrf};
  const runsA=(await call('/api/agents/sales/runs',null,owner,{method:'GET'})).data;
  const runsB=(await call('/api/agents/sales/runs',null,ownerB,{method:'GET'})).data;
  assert.equal(runsA.length,1); // the agent run the webhook's event triggered stayed in the webhook's real tenant
  assert.equal(runsB.length,0); // never leaked into the other tenant's agent run list
 }finally{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}
});
