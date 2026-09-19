import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createAuth} from '../src/auth.js';
import {createTenant,resolveTenantForUser} from '../src/tenancy.js';
import {randomUUID} from 'node:crypto';

const key32=randomBytes(32).toString('hex');
const WHATSAPP_ENV={WHATSAPP_ACCESS_TOKEN:'wa-token',WHATSAPP_PHONE_NUMBER_ID:'12345',INTEGRATION_ENCRYPTION_KEY:key32};

async function harness(env,fetcher){
 const directory=await mkdtemp(join(tmpdir(),'hypercool-wa-campaign-'));
 const app=await createApp({dataDir:directory,env,...(fetcher?{fetcher}:{})});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session,{method,headers={}}={}){
  const hasBody=input!==undefined && input!==null && method!=='GET';
  const res=await fetch(base+path,{method:method||(input!=null?'POST':'GET'),redirect:'manual',headers:{...(hasBody?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...headers},...(hasBody?{body:typeof input==='string'?input:JSON.stringify(input)}:{})});
  const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data?.csrf,location:res.headers.get('location')};
 }
 return {app,base,call,cleanup:async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}};
}
async function twoTenants(env,fetcher){
 const {app,call,cleanup}=await harness(env,fetcher);
 const ownerA=await call('/api/setup',{username:'ownera',name:'Owner A',password:'a-long-test-password'});
 await call('/api/auth',null,ownerA,{method:'GET'});
 const auth=createAuth(app.store.db);
 const userA=app.store.db.prepare("SELECT id FROM users WHERE username='ownera'").get();
 const tenantA=resolveTenantForUser(app.store.db,userA.id);
 // A plain auth.createUser() creates the account only — it has no tenant_memberships row of
 // its own (unlike /api/setup, which bootstraps the FIRST tenant+membership together), so a
 // real team member needs one inserted explicitly, exactly like a real invite-accept would.
 const operatorUser=auth.createUser({username:'operatora',name:'Operator A',password:'a-long-test-password'},'operator');
 app.store.db.prepare('INSERT INTO tenant_memberships (id,tenant_id,user_id,role,status,is_owner,created_at) VALUES (?,?,?,?,?,?,?)')
  .run(randomUUID(),tenantA,operatorUser.id,'operator','active',0,new Date().toISOString());
 const loginOperator=auth.login({username:'operatora',password:'a-long-test-password'},'127.0.0.1');
 const operatorA={cookie:'hc_session='+loginOperator.token,csrf:loginOperator.csrf};
 const userB=auth.createUser({username:'ownerb',name:'Owner B',password:'a-long-test-password'},'owner');
 const tenantB=createTenant(app.store.db,{name:'Second Co',slug:'second-co'},userB.id);
 app.store.db.prepare('DELETE FROM tenant_memberships WHERE user_id=? AND tenant_id!=?').run(userB.id,tenantB);
 const loginB=auth.login({username:'ownerb',password:'a-long-test-password'},'127.0.0.1');
 const ownerB={cookie:'hc_session='+loginB.token,csrf:loginB.csrf};
 return {app,call,cleanup,ownerA,operatorA,ownerB,tenantA,tenantB};
}
function makeEligibleLead(app,session,call,phone){
 return call('/api/crm/leads',{name:'عميل واتساب',customerType:'B2C',sourceType:'INBOUND',phone},session)
  .then(res=>{
   app.store.db.prepare(`UPDATE crm_leads SET json=json_set(json,'$.optOut',json('false'),'$.humanHold',json('false'),'$.lastInboundAt',?) WHERE id=?`).run(new Date().toISOString(),res.data.id);
   return res.data;
  });
}

test('WhatsApp campaign blast: dry-run creates no messages, real send creates one crm_messages + one audit row per successful recipient',async()=>{
 let sent=0;
 const fetcher=async(url)=>{
  if(url.includes('graph.facebook.com')){sent++;return new Response(JSON.stringify({messages:[{id:'wamid.'+sent}]}),{status:200,headers:{'content-type':'application/json'}});}
  throw new Error('unexpected fetch '+url);
 };
 const {call,cleanup,ownerA,tenantA,app}=await twoTenants(WHATSAPP_ENV,fetcher);
 try{
  const campaign=await call('/api/marketing/campaigns',{name:'حملة واتساب',channels:['WhatsApp']},ownerA);
  assert.equal(campaign.status,201);
  const lead=await makeEligibleLead(app,ownerA,call,'+966500000001');

  const preview=await call(`/api/marketing/campaigns/${campaign.data.id}/whatsapp-blast`,{leadIds:[lead.id],text:'عرض خاص',dryRun:true},ownerA);
  assert.equal(preview.status,200);
  assert.equal(preview.data.status,'PREVIEW');
  assert.equal(preview.data.eligible.length,1);
  assert.equal(sent,0);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM crm_messages').get().n,0);

  const result=await call(`/api/marketing/campaigns/${campaign.data.id}/whatsapp-blast`,{leadIds:[lead.id],text:'عرض خاص',dryRun:false},ownerA);
  assert.equal(result.status,200);
  assert.equal(result.data.status,'OK');
  assert.equal(result.data.sent,1);
  assert.equal(sent,1);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM crm_messages').get().n,1);
  const auditRows=app.store.db.prepare("SELECT * FROM audit_logs WHERE tenant_id=? AND action='WHATSAPP_CAMPAIGN_MESSAGE_SENT'").all(tenantA);
  assert.equal(auditRows.length,1);
 }finally{await cleanup();}
});

test('WhatsApp campaign blast: an operator can send; a foreign tenant\'s campaign id is a plain 404, never a cross-tenant send',async()=>{
 const fetcher=async()=>{throw new Error('must not call network for a blocked request');};
 const {call,cleanup,ownerA,operatorA,ownerB,app}=await twoTenants(WHATSAPP_ENV,fetcher);
 try{
  const campaignA=await call('/api/marketing/campaigns',{name:'حملة أ',channels:['WhatsApp']},ownerA);
  const leadA=await makeEligibleLead(app,ownerA,call,'+966500000002');

  const operatorPreview=await call(`/api/marketing/campaigns/${campaignA.data.id}/whatsapp-blast`,{leadIds:[leadA.id],text:'hi',dryRun:true},operatorA);
  assert.equal(operatorPreview.status,200);
  assert.equal(operatorPreview.data.status,'PREVIEW');

  const crossTenant=await call(`/api/marketing/campaigns/${campaignA.data.id}/whatsapp-blast`,{leadIds:[leadA.id],text:'hi',dryRun:true},ownerB);
  assert.equal(crossTenant.status,404);

  const unauthenticated=await call(`/api/marketing/campaigns/${campaignA.data.id}/whatsapp-blast`,{leadIds:[leadA.id],text:'hi',dryRun:true},null);
  assert.equal(unauthenticated.status,401);
 }finally{await cleanup();}
});

test('Meta OAuth status: an operator can now read it (regression for the read-only role widening), still 401 unauthenticated',async()=>{
 const {call,cleanup,operatorA}=await twoTenants(WHATSAPP_ENV);
 try{
  const asOperator=await call('/api/integrations/meta/oauth/status',null,operatorA,{method:'GET'});
  assert.equal(asOperator.status,200);
  assert.equal(asOperator.data.connected,false);
  const anonymous=await call('/api/integrations/meta/oauth/status',null,null,{method:'GET'});
  assert.equal(anonymous.status,401);
 }finally{await cleanup();}
});
