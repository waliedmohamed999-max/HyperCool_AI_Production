import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createTenant} from '../src/tenancy.js';
import {createAuth} from '../src/auth.js';
import {
 tenantCustomConnectorsEnabled,createTenantConnectorDraft,updateTenantConnectorDraft,
 upsertTenantConnectorAction,submitTenantConnectorForReview,listOwnTenantConnectors,
 listPendingTenantConnectors,reviewTenantConnector,effectiveCustomConnectorLimit
} from '../src/connectors/dynamic/tenant-custom.js';
import {getTenantCatalog,getConnectorForBuilder,listConnectorsForBuilder} from '../src/connectors/dynamic/builder.js';
import {setCustomConnectorLimitByPlatform,getTenantDetail} from '../src/platform-admin.js';

// Phase 6G, Part 28-38 — Tenant Custom Connector Governance: the flag now gates real code
// paths (Phase 6F left it gating nothing — docs/TENANT_CUSTOM_CONNECTORS.md's own admission).
const key32=randomBytes(32).toString('hex');
const PLATFORM_ADMIN_USERNAMES='platform_admin';

async function harness({enabled=true,maxPerTenant}={}) {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-tenantcustom-'));
 const env={INTEGRATION_ENCRYPTION_KEY:key32,PLATFORM_ADMIN_USERNAMES,ENABLE_TENANT_CUSTOM_CONNECTORS:enabled?'true':'false'};
 if(maxPerTenant)env.MAX_CUSTOM_CONNECTORS_PER_TENANT=String(maxPerTenant);
 const app=await createApp({dataDir:directory,env});
 const auth=createAuth(app.store.db);
 const admin=auth.createUser({username:'platform_admin',name:'Platform Admin',password:'a-long-test-password'},'owner');
 const owner=auth.createUser({username:'owner_'+Math.random().toString(36).slice(2),name:'Owner',password:'a-long-test-password'},'owner');
 const tenantId=createTenant(app.store.db,{name:'Co '+Math.random().toString(36).slice(2),slug:'co-'+Math.random().toString(36).slice(2)},owner.id);
 return {app,db:app.store.db,env,admin,owner,tenantId,cleanup:async()=>{app.store.close();await rm(directory,{recursive:true,force:true});}};
}
function throwsWithCode(fn,expectedCode) {
 let thrown=null;
 try{fn();}catch(error){thrown=error;}
 assert.ok(thrown,`expected a throw with code ${expectedCode}`);
 assert.equal(thrown.code,expectedCode);
}
function draftInput(slug='tc_shop') {
 return {
  slug,nameAr:'متجري',nameEn:'My Shop',category:'commerce',descriptionAr:'x',descriptionEn:'x',
  connectionMode:'SINGLE',auth:{type:'API_KEY',headerName:'X-Key'},
  capabilities:['commerce.orders.read'],rest:{baseUrl:'https://tc-shop.test'}
 };
}

test('Flag off: every tenant-custom function refuses, and the flag genuinely gates something now',async()=>{
 const {db,env,owner,tenantId,cleanup}=await harness({enabled:false});
 try{
  assert.equal(tenantCustomConnectorsEnabled(env),false);
  throwsWithCode(()=>createTenantConnectorDraft(db,env,owner,tenantId,draftInput()),'TENANT_CUSTOM_CONNECTORS_DISABLED');
 } finally { await cleanup(); }
});

test('Tenant Draft -> Submit -> Platform Review -> Approve -> visible ONLY to the submitting tenant',async()=>{
 const {db,env,admin,owner,tenantId,cleanup}=await harness();
 try{
  const draft=createTenantConnectorDraft(db,env,owner,tenantId,draftInput());
  assert.equal(draft.status,'DRAFT');
  assert.equal(draft.ownerTenantId,tenantId);
  upsertTenantConnectorAction(db,env,tenantId,draft.id,{slug:'get_orders',nameAr:'ط',nameEn:'Orders',httpMethod:'GET',pathTemplate:'/orders',requiredCapability:'commerce.orders.read',actionType:'READ',riskLevel:'LOW'});

  assert.equal(getTenantCatalog(db,tenantId).some(c=>c.slug==='tc_shop'),false,'a draft is never catalog-visible, even to its own tenant');

  const submitted=submitTenantConnectorForReview(db,env,tenantId,draft.id);
  assert.equal(submitted.reviewStatus,'PENDING');

  const pending=listPendingTenantConnectors(db,env,admin);
  assert.ok(pending.some(p=>p.id===draft.id));

  const approved=reviewTenantConnector(db,env,admin,draft.id,{decision:'APPROVE'});
  assert.equal(approved.status,'PUBLISHED');
  assert.equal(approved.reviewStatus,'APPROVED');

  // Part 30 — published for THIS tenant only.
  assert.equal(getTenantCatalog(db,tenantId).some(c=>c.slug==='tc_shop'),true);
  const auth=createAuth(db);
  const ownerB=auth.createUser({username:'ownerb_'+Math.random().toString(36).slice(2),name:'B',password:'a-long-test-password'},'owner');
  const tenantB=createTenant(db,{name:'B Co',slug:'b-co-'+Math.random().toString(36).slice(2)},ownerB.id);
  assert.equal(getTenantCatalog(db,tenantB).some(c=>c.slug==='tc_shop'),false,'never visible to any other tenant — Part 30');
 } finally { await cleanup(); }
});

test('Reject / Request Changes: never published, tenant can revise and resubmit',async()=>{
 const {db,env,admin,owner,tenantId,cleanup}=await harness();
 try{
  const draft=createTenantConnectorDraft(db,env,owner,tenantId,draftInput());
  submitTenantConnectorForReview(db,env,tenantId,draft.id);
  const rejected=reviewTenantConnector(db,env,admin,draft.id,{decision:'REJECT',notes:'not safe enough'});
  assert.equal(rejected.status,'DRAFT');
  assert.equal(rejected.reviewStatus,'REJECTED');
  assert.equal(getTenantCatalog(db,tenantId).some(c=>c.slug==='tc_shop'),false);

  // Part 37 — tenant can edit and resubmit after rejection/changes-requested.
  const revised=updateTenantConnectorDraft(db,env,tenantId,draft.id,{descriptionAr:'محدّث'});
  assert.equal(revised.reviewStatus,null,'editing resets review status back to an un-submitted draft');
  const resubmitted=submitTenantConnectorForReview(db,env,tenantId,draft.id);
  assert.equal(resubmitted.reviewStatus,'PENDING');
 } finally { await cleanup(); }
});

test('Per-tenant limit (MAX_CUSTOM_CONNECTORS_PER_TENANT) is enforced',async()=>{
 const {db,env,owner,tenantId,cleanup}=await harness({maxPerTenant:1});
 try{
  createTenantConnectorDraft(db,env,owner,tenantId,draftInput('tc_a'));
  throwsWithCode(()=>createTenantConnectorDraft(db,env,owner,tenantId,draftInput('tc_b')),'CUSTOM_CONNECTOR_LIMIT_REACHED');
 } finally { await cleanup(); }
});

// Phase 6H, Part 37-42 — Per-tenant Custom Connector Limit Override.
test('Per-tenant PLATFORM override raises (or lowers) the effective limit for exactly one tenant, never touching the global default for anyone else',async()=>{
 const {db,env,admin,owner,tenantId,cleanup}=await harness({maxPerTenant:1});
 try{
  const auth=createAuth(db);
  const ownerB=auth.createUser({username:'ownerb_'+Math.random().toString(36).slice(2),name:'B',password:'a-long-test-password'},'owner');
  const tenantB=createTenant(db,{name:'B',slug:'b-'+Math.random().toString(36).slice(2)},ownerB.id);

  assert.equal(effectiveCustomConnectorLimit(db,env,tenantId),1);
  const result=setCustomConnectorLimitByPlatform(db,env,tenantId,{limit:3},admin);
  assert.equal(result.customConnectorLimit,3);
  assert.equal(result.effectiveLimit,3);
  assert.equal(effectiveCustomConnectorLimit(db,env,tenantId),3);
  // Tenant B never sees this tenant's override — the global default (1) still applies to it.
  assert.equal(effectiveCustomConnectorLimit(db,env,tenantB),1);

  createTenantConnectorDraft(db,env,owner,tenantId,draftInput('tc_over_a'));
  createTenantConnectorDraft(db,env,owner,tenantId,draftInput('tc_over_b'));
  createTenantConnectorDraft(db,env,owner,tenantId,draftInput('tc_over_c'));
  throwsWithCode(()=>createTenantConnectorDraft(db,env,owner,tenantId,draftInput('tc_over_d')),'CUSTOM_CONNECTOR_LIMIT_REACHED');

  const detail=getTenantDetail(db,env,tenantId);
  assert.equal(detail.customConnectors.limitOverride,3);
  assert.equal(detail.customConnectors.effectiveLimit,3);
  assert.equal(detail.customConnectors.count,3);

  // Reverting to null restores the global default.
  const reverted=setCustomConnectorLimitByPlatform(db,env,tenantId,{limit:null},admin);
  assert.equal(reverted.customConnectorLimit,null);
  assert.equal(reverted.effectiveLimit,1);
 } finally { await cleanup(); }
});

test('Per-tenant limit override: input validation refuses a negative/non-integer limit',async()=>{
 const {db,env,admin,tenantId,cleanup}=await harness();
 try{
  let thrown=null;
  try{setCustomConnectorLimitByPlatform(db,env,tenantId,{limit:-1},admin);}catch(error){thrown=error;}
  assert.ok(thrown);
  thrown=null;
  try{setCustomConnectorLimitByPlatform(db,env,tenantId,{limit:1.5},admin);}catch(error){thrown=error;}
  assert.ok(thrown);
 } finally { await cleanup(); }
});

test('Forbidden capability prefixes (platform./security./admin./permissions.*) are rejected even if hypothetically registered',async()=>{
 const {db,env,owner,tenantId,cleanup}=await harness();
 try{
  throwsWithCode(()=>createTenantConnectorDraft(db,env,owner,tenantId,{...draftInput(),capabilities:['platform.admin.write']}),'FORBIDDEN_CAPABILITY');
  throwsWithCode(()=>createTenantConnectorDraft(db,env,owner,tenantId,{...draftInput(),capabilities:['security.override']}),'FORBIDDEN_CAPABILITY');
 } finally { await cleanup(); }
});

test('A genuinely unknown (never-registered) capability is rejected — a tenant can never invent a capability string outside the canonical registry',async()=>{
 const {db,env,owner,tenantId,cleanup}=await harness();
 try{
  throwsWithCode(()=>createTenantConnectorDraft(db,env,owner,tenantId,{...draftInput(),capabilities:['made_up.not_real_capability']}),'UNKNOWN_CAPABILITY');
  const draft=createTenantConnectorDraft(db,env,owner,tenantId,draftInput());
  throwsWithCode(()=>upsertTenantConnectorAction(db,env,tenantId,draft.id,{slug:'x',nameAr:'x',nameEn:'x',httpMethod:'GET',pathTemplate:'/x',requiredCapability:'made_up.not_real_capability',actionType:'READ',riskLevel:'LOW'}),'UNKNOWN_CAPABILITY');
 } finally { await cleanup(); }
});

test('SSRF/HTTPS-only base URL policy applies to tenant custom connectors with NO relaxation (no allowHttp escape hatch)',async()=>{
 const {db,env,owner,tenantId,cleanup}=await harness();
 try{
  throwsWithCode(()=>createTenantConnectorDraft(db,env,owner,tenantId,{...draftInput(),rest:{baseUrl:'http://169.254.169.254/'}}),'UNSAFE_BASE_URL');
  throwsWithCode(()=>createTenantConnectorDraft(db,env,owner,tenantId,{...draftInput(),rest:{baseUrl:'http://tc-shop.test',allowHttp:true}}),'UNSAFE_BASE_URL');
  throwsWithCode(()=>createTenantConnectorDraft(db,env,owner,tenantId,{...draftInput(),rest:{baseUrl:'https://tc-shop2.test',tenantConfigurableHost:true}}),'INVALID_BASE_URL');
 } finally { await cleanup(); }
});

test('OAuth2 is excluded from tenant self-service auth types',async()=>{
 const {db,env,owner,tenantId,cleanup}=await harness();
 try{
  throwsWithCode(()=>createTenantConnectorDraft(db,env,owner,tenantId,{...draftInput(),auth:{type:'OAUTH2',authorizeUrl:'https://x.test/auth',tokenUrl:'https://x.test/token',clientIdEnvKey:'X_ID',clientSecretEnvKey:'X_SECRET'}}),'INVALID_AUTH_TYPE');
 } finally { await cleanup(); }
});

test('Write action policy: a POST/PUT/PATCH/DELETE action on a tenant custom connector always requires approval, even if the tenant tries to opt out',async()=>{
 const {db,env,owner,tenantId,cleanup}=await harness();
 try{
  const draft=createTenantConnectorDraft(db,env,owner,tenantId,draftInput());
  const action=upsertTenantConnectorAction(db,env,tenantId,draft.id,{slug:'create_order',nameAr:'إنشاء',nameEn:'Create',httpMethod:'POST',pathTemplate:'/orders',requiredCapability:'commerce.orders.read',actionType:'EXTERNAL_WRITE',riskLevel:'MEDIUM',requiresApprovalDefault:false});
  assert.equal(action.requiresApprovalDefault,true,'a tenant can never loosen write-action approval, even by explicitly requesting false');
 } finally { await cleanup(); }
});

test('Cross-tenant isolation: Tenant B cannot view, edit, or submit Tenant A\'s draft',async()=>{
 const {db,env,owner,tenantId:tenantA,cleanup}=await harness();
 try{
  const draft=createTenantConnectorDraft(db,env,owner,tenantA,draftInput());
  const auth=createAuth(db);
  const ownerB=auth.createUser({username:'ownerb_'+Math.random().toString(36).slice(2),name:'B',password:'a-long-test-password'},'owner');
  const tenantB=createTenant(db,{name:'B Co',slug:'b-co-'+Math.random().toString(36).slice(2)},ownerB.id);
  throwsWithCode(()=>updateTenantConnectorDraft(db,env,tenantB,draft.id,{descriptionAr:'hack'}),'CONNECTOR_NOT_FOUND');
  throwsWithCode(()=>submitTenantConnectorForReview(db,env,tenantB,draft.id),'CONNECTOR_NOT_FOUND');
  assert.equal(listOwnTenantConnectors(db,tenantB).length,0);
  assert.equal(listOwnTenantConnectors(db,tenantA).length,1);
 } finally { await cleanup(); }
});

test('Platform Admin can still disable a tenant custom connector via the existing disableConnector path (Part 38)',async()=>{
 const {db,env,admin,owner,tenantId,cleanup}=await harness();
 try{
  const draft=createTenantConnectorDraft(db,env,owner,tenantId,draftInput());
  submitTenantConnectorForReview(db,env,tenantId,draft.id);
  const approved=reviewTenantConnector(db,env,admin,draft.id,{decision:'APPROVE'});
  const {disableConnector}=await import('../src/connectors/dynamic/builder.js');
  const disabled=disableConnector(db,env,admin,approved.id);
  assert.equal(disabled.status,'DISABLED');
  assert.equal(getTenantCatalog(db,tenantId).some(c=>c.slug==='tc_shop'),false,'disabled connectors never appear in any catalog');
 } finally { await cleanup(); }
});
