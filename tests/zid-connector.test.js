import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createAuth} from '../src/auth.js';
import {createTenant} from '../src/tenancy.js';
import {createConnection,updateConnection,getConnection} from '../src/integrations/connections.js';
import {storeCredential,getCredentialForRuntime} from '../src/integrations/vault.js';
import {executeConnectorAction,checkConnectorHealth} from '../src/connectors/core/runtime.js';
import {resolveToolConnection,upsertAssignment} from '../src/runtime/tool-assignments.js';
import {createZidAuthorizeUrl,exchangeZidCodeForTokens,refreshZidTokens,zidOAuthConfigured} from '../src/runtime/zid-oauth.js';
import {getConnectorManifest} from '../src/connectors/registry.js';

// Phase 6E — real Zid Connector proof, built entirely on the Universal Integration Platform
// (Phase 6A-6D). Every fixture shape below (orders/customers/profile response fields, error
// envelope, OAuth token response fields) is taken directly from the OFFICIAL Zid Developers
// documentation (docs.zid.sa, reviewed 2026-09-12 — see docs/ZID_CONNECTOR.md for sources and
// dates). No real Zid credentials exist in this environment, so every test here is
// MOCK/OFFICIAL-CONTRACT VERIFIED, never LIVE VERIFIED — see docs/ZID_CONNECTOR.md section AN/AO
// for the explicit distinction.
const key32=randomBytes(32).toString('hex');
const ZID_ENV={INTEGRATION_ENCRYPTION_KEY:key32,ZID_CLIENT_ID:'test-zid-client',ZID_CLIENT_SECRET:'test-zid-secret',ZID_REDIRECT_URI:'https://app.example.com/callback/zid'};

async function harness() {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-zid-'));
 const app=await createApp({dataDir:directory,env:ZID_ENV});
 const auth=createAuth(app.store.db);
 const owner=auth.createUser({username:'zid_owner_'+Math.random().toString(36).slice(2),name:'Owner',password:'a-long-test-password'},'owner');
 const tenantId=createTenant(app.store.db,{name:'Zid Co',slug:'zid-'+Math.random().toString(36).slice(2)},owner.id);
 return {app,db:app.store.db,env:ZID_ENV,owner,tenantId,cleanup:async()=>{app.store.close();await rm(directory,{recursive:true,force:true});}};
}
async function connectZid(db,tenantId,{accessToken='real-zid-access',refreshToken='real-zid-refresh',expiresInSeconds=31536000}={}) {
 const connection=createConnection(db,{integrationDefinitionId:'zid',name:'My Zid Store'},tenantId);
 storeCredential(db,ZID_ENV,{connectionId:connection.id,credentialType:'oauth_tokens',payload:{accessToken,refreshToken,expiresAt:new Date(Date.now()+expiresInSeconds*1000).toISOString()}},tenantId);
 return updateConnection(db,connection.id,{status:'CONNECTED'},tenantId);
}
// A resolver/transport pair simulating the real, documented api.zid.sa Merchant API surface.
function mockZidTransport({accessToken='real-zid-access',ordersFixture,customersFixture,profileFixture,onCall}={}) {
 const calls=[];
 const transport=async({path,method,headers})=>{
  calls.push({path,method,headers});
  onCall?.({path,method,headers});
  const authOk=headers.authorization===`Bearer ${accessToken}` && headers['x-manager-token']===accessToken;
  if(!authOk)return {statusCode:401,headers:{},stream:Buffer.from(JSON.stringify({status:401,success:false,error:{code:'unauthenticated',message:'Invalid token'}}))};
  if(path.startsWith('/v1/managers/account/profile'))return {statusCode:200,headers:{},stream:Buffer.from(JSON.stringify(profileFixture||OFFICIAL_PROFILE_FIXTURE))};
  if(path.startsWith('/v1/managers/store/orders'))return {statusCode:200,headers:{},stream:Buffer.from(JSON.stringify(ordersFixture||OFFICIAL_ORDERS_FIXTURE))};
  if(path.startsWith('/v1/managers/store/customers'))return {statusCode:200,headers:{},stream:Buffer.from(JSON.stringify(customersFixture||OFFICIAL_CUSTOMERS_FIXTURE))};
  return {statusCode:404,headers:{},stream:Buffer.from(JSON.stringify({status:404,success:false,error:{code:'not_found',message:'not found'}}))};
 };
 return {transport,calls,resolver:async()=>['203.0.113.50']};
}
// Official-contract fixtures — field names taken verbatim from docs.zid.sa (get-manager-profile,
// list-of-orders, list-of-customers), reviewed 2026-09-12.
const OFFICIAL_PROFILE_FIXTURE={status:'success',user:{id:1,uuid:'u-1',name:'Test Manager',email:'m@example.com',username:'manager1'},store:{id:987654,uuid:'s-1',title:'Test Zid Store',username:'teststore'}};
const OFFICIAL_ORDERS_FIXTURE={status:'success',orders:[{id:1,status:'new'},{id:2,status:'delivered'}],grand_total:2,total_order_count:2,total_order_count_per_status:{new:1,delivered:1}};
const OFFICIAL_CUSTOMERS_FIXTURE={status:'success',customers:[{id:11,name:'Ahmad',email:'a@example.com'}],grand_total:1,total_customers_count:1,active_customers_count:1,inactive_customers_count:0,next_cursor:null};

// --- OAuth flow (documentation-contract) ---------------------------------------------------

test('Zid OAuth: authorize URL matches the official authorize endpoint, correct params, no invented PKCE fields',()=>{
 assert.equal(zidOAuthConfigured(ZID_ENV),true);
 const url=new URL(createZidAuthorizeUrl(ZID_ENV,'ignored-user-id','real-state-token'));
 assert.equal(url.origin+url.pathname,'https://oauth.zid.sa/oauth/authorize');
 assert.equal(url.searchParams.get('client_id'),'test-zid-client');
 assert.equal(url.searchParams.get('response_type'),'code');
 assert.equal(url.searchParams.get('redirect_uri'),ZID_ENV.ZID_REDIRECT_URI);
 assert.equal(url.searchParams.get('state'),'real-state-token');
 assert.equal(url.searchParams.has('code_challenge'),false);
 assert.equal(url.searchParams.has('code_challenge_method'),false);
});
test('Zid OAuth: token exchange posts the exact documented grant_type/params to the official token endpoint and normalizes the response',async()=>{
 let captured=null;
 const fetcher=async(url,options)=>{
  captured={url,body:options.body};
  return new Response(JSON.stringify({access_token:'new-access',refresh_token:'new-refresh',expires_in:31536000,scope:'orders.read customers.read'}),{status:200,headers:{'content-type':'application/json'}});
 };
 const tokens=await exchangeZidCodeForTokens({env:ZID_ENV,fetcher,code:'real-auth-code'});
 assert.equal(captured.url,'https://oauth.zid.sa/oauth/token');
 const sentParams=new URLSearchParams(captured.body);
 assert.equal(sentParams.get('grant_type'),'authorization_code');
 assert.equal(sentParams.get('client_id'),'test-zid-client');
 assert.equal(sentParams.get('client_secret'),'test-zid-secret');
 assert.equal(sentParams.get('redirect_uri'),ZID_ENV.ZID_REDIRECT_URI);
 assert.equal(sentParams.get('code'),'real-auth-code');
 assert.equal(tokens.accessToken,'new-access');
 assert.equal(tokens.refreshToken,'new-refresh');
 assert.deepEqual(tokens.scopes,['orders.read','customers.read']);
 assert.ok(tokens.expiresAt);
});
test('Zid OAuth: refresh posts grant_type=refresh_token with the real stored refresh token',async()=>{
 let captured=null;
 const fetcher=async(url,options)=>{captured=options.body;return new Response(JSON.stringify({access_token:'refreshed-access',refresh_token:'refreshed-refresh',expires_in:31536000}),{status:200,headers:{'content-type':'application/json'}});};
 const tokens=await refreshZidTokens({env:ZID_ENV,fetcher,refreshToken:'old-refresh'});
 const sentParams=new URLSearchParams(captured);
 assert.equal(sentParams.get('grant_type'),'refresh_token');
 assert.equal(sentParams.get('refresh_token'),'old-refresh');
 assert.equal(tokens.accessToken,'refreshed-access');
});
test('Zid OAuth: a real 401 from the token endpoint classifies as CREDENTIALS_REJECTED, never a silent success',async()=>{
 const fetcher=async()=>new Response(JSON.stringify({status:401,success:false,error:{code:'invalid_grant',message:'bad code'}}),{status:401,headers:{'content-type':'application/json'}});
 await assert.rejects(()=>exchangeZidCodeForTokens({env:ZID_ENV,fetcher,code:'bad-code'}),error=>error.code==='CREDENTIALS_REJECTED');
});

// --- Manifest / registry -------------------------------------------------------------------

test('Zid is registered as a real, validated BUILT_IN connector — COMMERCE category, MULTI mode, only the two implemented capabilities',()=>{
 const manifest=getConnectorManifest('zid');
 assert.ok(manifest);
 assert.equal(manifest.category,'COMMERCE');
 assert.equal(manifest.connectionMode,'MULTI');
 assert.deepEqual(manifest.capabilities.sort(),['commerce.customers.read','commerce.orders.read']);
 assert.equal(manifest.actions.length,2);
 assert.equal(manifest.triggers.length,0);
 assert.equal(manifest.webhooks,null); // V1 deliberately ships no webhook — see docs/ZID_CONNECTOR.md
});

// --- Health check ----------------------------------------------------------------------------

test('Zid health check: a real valid token resolves store identity through the official read-only profile endpoint',async()=>{
 const {db,env,tenantId,cleanup}=await harness();
 try{
  const connection=await connectZid(db,tenantId);
  const {transport,resolver}=mockZidTransport();
  const result=await checkConnectorHealth({db,env,tenantId,connectorSlug:'zid',connectionId:connection.id,resolver,transport});
  assert.equal(result.status,'OK');
  assert.equal(result.externalAccountId,'987654');
  assert.equal(result.externalAccountName,'Test Zid Store');
 }finally{await cleanup();}
});
test('Zid health check: an invalid/expired token with no refresh token reports TOKEN_EXPIRED, never a fake OK',async()=>{
 const {db,env,tenantId,cleanup}=await harness();
 try{
  const connection=createConnection(db,{integrationDefinitionId:'zid',name:'x'},tenantId);
  storeCredential(db,env,{connectionId:connection.id,credentialType:'oauth_tokens',payload:{accessToken:'expired-token',refreshToken:null,expiresAt:new Date(Date.now()-1000).toISOString()}},tenantId);
  updateConnection(db,connection.id,{status:'CONNECTED'},tenantId);
  const {transport,resolver}=mockZidTransport();
  const result=await checkConnectorHealth({db,env,tenantId,connectorSlug:'zid',connectionId:connection.id,resolver,transport});
  assert.equal(result.status,'TOKEN_EXPIRED');
 }finally{await cleanup();}
});
test('Zid health check: an expiring token WITH a refresh token refreshes automatically, persists the new token to the Vault, and health still succeeds',async()=>{
 const {db,env,tenantId,cleanup}=await harness();
 try{
  const connection=createConnection(db,{integrationDefinitionId:'zid',name:'x'},tenantId);
  storeCredential(db,env,{connectionId:connection.id,credentialType:'oauth_tokens',payload:{accessToken:'stale-access',refreshToken:'real-refresh',expiresAt:new Date(Date.now()+60000).toISOString()}},tenantId);
  updateConnection(db,connection.id,{status:'CONNECTED'},tenantId);
  let refreshCalled=false;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
   if(url==='https://oauth.zid.sa/oauth/token'){refreshCalled=true;return new Response(JSON.stringify({access_token:'refreshed-access',refresh_token:'refreshed-refresh',expires_in:31536000}),{status:200,headers:{'content-type':'application/json'}});}
   return originalFetch(url,options);
  };
  try{
   const {transport,resolver}=mockZidTransport({accessToken:'refreshed-access'});
   const result=await checkConnectorHealth({db,env,tenantId,connectorSlug:'zid',connectionId:connection.id,resolver,transport});
   assert.equal(result.status,'OK');
   assert.equal(refreshCalled,true);
   const stored=getCredentialForRuntime(db,env,connection.id,tenantId);
   assert.equal(stored.payload.accessToken,'refreshed-access');
   assert.equal(stored.payload.refreshToken,'refreshed-refresh');
  }finally{globalThis.fetch=originalFetch;}
 }finally{await cleanup();}
});
test('Zid health check: a real 401 from the remote API (not just an expired-locally token) reports ERROR/AUTH_FAILED, never OK',async()=>{
 const {db,env,tenantId,cleanup}=await harness();
 try{
  const connection=await connectZid(db,tenantId,{accessToken:'revoked-token'});
  const {transport,resolver}=mockZidTransport({accessToken:'the-real-expected-token'});
  const result=await checkConnectorHealth({db,env,tenantId,connectorSlug:'zid',connectionId:connection.id,resolver,transport});
  assert.equal(result.status,'ERROR');
  assert.equal(result.errorCode,'AUTH_FAILED');
 }finally{await cleanup();}
});

// --- Actions: get_orders / get_customers (official-contract fixtures) ----------------------

test('Zid get_orders executes through ConnectorRuntime and returns the real, documented order fields',async()=>{
 const {db,env,owner,tenantId,cleanup}=await harness();
 try{
  const connection=await connectZid(db,tenantId);
  const {transport,resolver}=mockZidTransport();
  const result=await executeConnectorAction({db,env,tenantId,connectorSlug:'zid',connectionId:connection.id,actionId:'get_orders',actor:owner,resolver,transport});
  assert.equal(result.status,'OK');
  assert.equal(result.output.orders.length,2);
  assert.equal(result.output.totalOrderCount,2);
 }finally{await cleanup();}
});
test('Zid get_customers executes through ConnectorRuntime and returns the real, documented customer fields',async()=>{
 const {db,env,owner,tenantId,cleanup}=await harness();
 try{
  const connection=await connectZid(db,tenantId);
  const {transport,resolver}=mockZidTransport();
  const result=await executeConnectorAction({db,env,tenantId,connectorSlug:'zid',connectionId:connection.id,actionId:'get_customers',actor:owner,resolver,transport});
  assert.equal(result.status,'OK');
  assert.equal(result.output.customers.length,1);
  assert.equal(result.output.totalCustomersCount,1);
 }finally{await cleanup();}
});
test('Zid actions pass the real page/per_page query params through to the official endpoint',async()=>{
 const {db,env,owner,tenantId,cleanup}=await harness();
 try{
  const connection=await connectZid(db,tenantId);
  let capturedPath=null;
  const {transport,resolver}=mockZidTransport({onCall:({path})=>{if(path.startsWith('/v1/managers/store/orders'))capturedPath=path;}});
  await executeConnectorAction({db,env,tenantId,connectorSlug:'zid',connectionId:connection.id,actionId:'get_orders',input:{page:2,perPage:50},actor:owner,resolver,transport});
  const parsed=new URL('https://api.zid.sa/v1'+capturedPath);
  assert.equal(parsed.searchParams.get('page'),'2');
  assert.equal(parsed.searchParams.get('per_page'),'50');
 }finally{await cleanup();}
});
test('Zid actions normalize a real 429 rate-limit response through the standard connector error codes',async()=>{
 const {db,env,owner,tenantId,cleanup}=await harness();
 try{
  const connection=await connectZid(db,tenantId);
  const transport=async()=>({statusCode:429,headers:{},stream:Buffer.from(JSON.stringify({status:429,success:false,error:{code:'too_many_requests',message:'slow down'}}))});
  const result=await executeConnectorAction({db,env,tenantId,connectorSlug:'zid',connectionId:connection.id,actionId:'get_orders',actor:owner,resolver:async()=>['203.0.113.50'],transport});
  assert.equal(result.status,'ERROR');
  assert.equal(result.errorCode,'RATE_LIMITED');
 }finally{await cleanup();}
});
test('Zid actions never leak the raw remote error body (which could carry customer data) into the connector result',async()=>{
 const {db,env,owner,tenantId,cleanup}=await harness();
 try{
  const connection=await connectZid(db,tenantId);
  const transport=async()=>({statusCode:422,headers:{},stream:Buffer.from(JSON.stringify({status:422,success:false,error:{code:'validation_error',message:'secret-customer-detail@example.com is invalid',fields:{email:['secret-customer-detail@example.com bad']}}}))});
  const result=await executeConnectorAction({db,env,tenantId,connectorSlug:'zid',connectionId:connection.id,actionId:'get_orders',actor:owner,resolver:async()=>['203.0.113.50'],transport});
  assert.equal(result.status,'ERROR');
  assert.equal(JSON.stringify(result).includes('secret-customer-detail'),false);
 }finally{await cleanup();}
});

// --- Secret handling / audit -----------------------------------------------------------------

test('Zid: the OAuth access/refresh token never appears in the action result or the audit log',async()=>{
 const {db,env,owner,tenantId,cleanup}=await harness();
 try{
  const connection=await connectZid(db,tenantId,{accessToken:'super-secret-zid-token',refreshToken:'super-secret-zid-refresh'});
  const {transport,resolver}=mockZidTransport({accessToken:'super-secret-zid-token'});
  const result=await executeConnectorAction({db,env,tenantId,connectorSlug:'zid',connectionId:connection.id,actionId:'get_orders',actor:owner,resolver,transport});
  assert.equal(JSON.stringify(result).includes('super-secret-zid-token'),false);
  const auditRows=db.prepare('SELECT json FROM audit_logs').all().map(r=>r.json).join('\n');
  assert.equal(auditRows.includes('super-secret-zid-token'),false);
  assert.equal(auditRows.includes('super-secret-zid-refresh'),false);
 }finally{await cleanup();}
});

// --- Cross-tenant isolation --------------------------------------------------------------------

test('Cross-tenant: Tenant A cannot execute or health-check Tenant B\'s Zid connection',async()=>{
 const {db,env,owner,tenantId:tenantA,cleanup}=await harness();
 try{
  const auth=createAuth(db);
  const ownerB=auth.createUser({username:'zid_owner_b_'+Math.random().toString(36).slice(2),name:'Owner B',password:'a-long-test-password'},'owner');
  const tenantB=createTenant(db,{name:'Zid Co B',slug:'zid-b-'+Math.random().toString(36).slice(2)},ownerB.id);
  const connB=await connectZid(db,tenantB,{accessToken:'tenant-b-zid-token'});
  const {transport,resolver,calls}=mockZidTransport({accessToken:'tenant-b-zid-token'});
  const result=await executeConnectorAction({db,env,tenantId:tenantA,connectorSlug:'zid',connectionId:connB.id,actionId:'get_orders',actor:owner,resolver,transport});
  assert.equal(result.status,'ERROR');
  assert.equal(result.errorCode,'CONNECTION_NOT_FOUND');
  assert.equal(calls.length,0);
 }finally{await cleanup();}
});

// --- Generic, provider-independent tooling (Part 13/67/83) ----------------------------------

test('Generic get_orders/get_customers tools auto-discover the Zid connection with ZERO Zid-specific branch in tool-assignments.js or runtime.js',async()=>{
 const {db,tenantId,cleanup}=await harness();
 try{
  const connection=await connectZid(db,tenantId);
  const beforeAssign=resolveToolConnection(db,{tenantId,agentId:'frost',toolSlug:'get_orders'});
  assert.equal(beforeAssign.connectionId,null);
  upsertAssignment(db,tenantId,'frost','get_orders',{});
  const afterAssign=resolveToolConnection(db,{tenantId,agentId:'frost',toolSlug:'get_orders'});
  assert.equal(afterAssign.connectionId,connection.id,'exactly one compatible connection -> auto-selected');
  upsertAssignment(db,tenantId,'frost','get_customers',{});
  const customersAssign=resolveToolConnection(db,{tenantId,agentId:'frost',toolSlug:'get_customers'});
  assert.equal(customersAssign.connectionId,connection.id);

  // tool-assignments.js and the Agent Runtime must contain no Zid awareness at all (not even
  // a comment) — the exact same bar Phase 6D's identical Acme ERP proof already set.
  // core/runtime.js DOES mention "Zid" once, in an explanatory comment on the additive `db`
  // parameter (Part 52 — a future OAuth-refresh adapter reads it); this is checked separately
  // below for the absence of an actual conditional BRANCH (`==='zid'`), not the word itself.
  const toolAssignmentsSource=await (await import('node:fs/promises')).readFile(new URL('../src/runtime/tool-assignments.js',import.meta.url),'utf8');
  assert.equal(/zid/i.test(toolAssignmentsSource),false,'tool-assignments.js must contain zero Zid-specific code');
  const runtimeSource=await (await import('node:fs/promises')).readFile(new URL('../src/runtime/runtime.js',import.meta.url),'utf8');
  assert.equal(/zid/i.test(runtimeSource),false,'Agent Runtime must contain zero Zid-specific code');
  const coreRuntimeSource=await (await import('node:fs/promises')).readFile(new URL('../src/connectors/core/runtime.js',import.meta.url),'utf8');
  assert.equal(/===\s*['"]zid['"]/i.test(coreRuntimeSource),false,'ConnectorRuntime core must contain zero Zid-specific conditional branch');
 }finally{await cleanup();}
});

// --- Salla + Zid coexistence (Part 42/43/96 — no regression) --------------------------------

test('A tenant with BOTH a real Salla connection and a real Zid connection: neither interferes with the other',async()=>{
 const {db,env,owner,tenantId,cleanup}=await harness();
 try{
  const salla=createConnection(db,{integrationDefinitionId:'salla',name:'Salla Store A'},tenantId);
  updateConnection(db,salla.id,{status:'CONNECTED'},tenantId);
  storeCredential(db,env,{connectionId:salla.id,credentialType:'oauth_tokens',payload:{accessToken:'salla-tok'}},tenantId);
  const zid=await connectZid(db,tenantId);

  const sallaFetcher=async()=>new Response(JSON.stringify({success:true,data:[],pagination:{totalPages:1}}),{status:200,headers:{'content-type':'application/json'}});
  const sallaResult=await executeConnectorAction({db,env,fetcher:sallaFetcher,tenantId,connectorSlug:'salla',connectionId:salla.id,actionId:'sync_products',actor:owner});
  assert.equal(sallaResult.status,'OK');

  const {transport,resolver}=mockZidTransport();
  const zidResult=await executeConnectorAction({db,env,tenantId,connectorSlug:'zid',connectionId:zid.id,actionId:'get_orders',actor:owner,resolver,transport});
  assert.equal(zidResult.status,'OK');

  // Re-run Salla again AFTER Zid to prove no shared/leaked state between the two adapters.
  const sallaResult2=await executeConnectorAction({db,env,fetcher:sallaFetcher,tenantId,connectorSlug:'salla',connectionId:salla.id,actionId:'sync_products',actor:owner});
  assert.equal(sallaResult2.status,'OK');

  const salla2=getConnection(db,salla.id,tenantId);
  const zid2=getConnection(db,zid.id,tenantId);
  assert.equal(salla2.integrationDefinitionId,'salla');
  assert.equal(zid2.integrationDefinitionId,'zid');
 }finally{await cleanup();}
});

// --- No invented webhook (Part 26/28/59/60) ---------------------------------------------------

// --- Marketplace discovery (Part 35/36/81) --------------------------------------------------

test('Zid appears automatically in the tenant catalog and Control Center summary — no hardcoded frontend entry needed',async()=>{
 const {app,owner,cleanup}=await harness();
 try{
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const login=createAuth(app.store.db).login({username:owner.username,password:'a-long-test-password'},'127.0.0.1');
  const session={cookie:'hc_session='+login.token,csrf:login.csrf};
  const catalog=await (await fetch(`${base}/api/integrations/catalog`,{headers:{cookie:session.cookie,'x-csrf-token':session.csrf}})).json();
  const zidEntry=catalog.find(c=>c.slug==='zid');
  assert.ok(zidEntry,'Zid must appear in the tenant catalog automatically');
  assert.equal(zidEntry.category,'ecommerce');
  assert.deepEqual(zidEntry.capabilities.sort(),['commerce.customers.read','commerce.orders.read']);
  assert.equal(zidEntry.connectionMode,'MULTI');

  const summary=await (await fetch(`${base}/api/control-center/summary`,{headers:{cookie:session.cookie,'x-csrf-token':session.csrf}})).json();
  const zidProvider=summary.integrations.providers.find(p=>p.slug==='zid');
  assert.ok(zidProvider,'Zid must appear in the Control Center summary alongside every other real provider');
  assert.equal(zidProvider.isSystem,true);
  await new Promise(resolve=>app.server.close(resolve));
 }finally{await cleanup();}
});
test('Zid, being OAuth2, is correctly refused by the GENERIC_REST-only generic-credential route — it keeps its own dedicated OAuth flow',async()=>{
 const {app,db,owner,tenantId,cleanup}=await harness();
 try{
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const login=createAuth(db).login({username:owner.username,password:'a-long-test-password'},'127.0.0.1');
  const session={cookie:'hc_session='+login.token,csrf:login.csrf};
  const connection=createConnection(db,{integrationDefinitionId:'zid',name:'x'},tenantId);
  const response=await fetch(`${base}/api/integrations/connections/${connection.id}/generic-credential`,{method:'PUT',headers:{cookie:session.cookie,'x-csrf-token':session.csrf,'content-type':'application/json'},body:JSON.stringify({apiKey:'irrelevant'})});
  assert.equal(response.status,400);
  await new Promise(resolve=>app.server.close(resolve));
 }finally{await cleanup();}
});

test('Zid webhook URL route honestly reports NOT_APPLICABLE — V1 ships no webhook trigger, never a fabricated one',async()=>{
 const {app,owner,tenantId,cleanup}=await harness();
 try{
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const loginToken=createAuth(app.store.db).login({username:owner.username,password:'a-long-test-password'},'127.0.0.1');
  const session={cookie:'hc_session='+loginToken.token,csrf:loginToken.csrf};
  const connection=await connectZid(app.store.db,tenantId);
  const response=await fetch(`${base}/api/integrations/connections/${connection.id}/webhook`,{headers:{cookie:session.cookie,'x-csrf-token':session.csrf}});
  const data=await response.json();
  assert.equal(data.status,'NOT_APPLICABLE');
  assert.equal(data.triggers.length,0);
  await new Promise(resolve=>app.server.close(resolve));
 }finally{await cleanup();}
});
