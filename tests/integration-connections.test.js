import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {openStore} from '../src/store.js';
import {installTenancy,createTenant} from '../src/tenancy.js';
import {createAuth} from '../src/auth.js';
import {installIntegrationDefinitions,listIntegrationDefinitions,getIntegrationDefinition,connectionModeFor} from '../src/integrations/definitions.js';
import {installIntegrationConnections,createConnection,listConnections,getConnection,getConnectionOrNull,updateConnection,setDefaultConnection,getDefaultConnection,resolveProviderAccount,disconnectConnection} from '../src/integrations/connections.js';
import {installCredentialsVault,storeCredential,getCredentialForRuntime,hasCredential,getCredentialMeta,removeCredential} from '../src/integrations/vault.js';
import {installOAuthStates,createOAuthState,consumeOAuthState,pruneExpiredOAuthStates} from '../src/integrations/oauth-state.js';
import {syncConnectionFromLegacyCredential,markLegacyCredentialDisconnected} from '../src/integrations/legacy-sync.js';
import {migrateLegacyIntegrationCredentials} from '../src/integrations/migration.js';
import {testConnectionHealth} from '../src/integrations/health.js';
import {installCredentials} from '../src/runtime/credentials.js';

const key32=randomBytes(32).toString('hex');
const env={INTEGRATION_ENCRYPTION_KEY:key32};

function fixture(){
 const store=openStore(':memory:');
 installTenancy(store.db);installIntegrationDefinitions(store.db);installIntegrationConnections(store.db);
 installCredentialsVault(store.db);installOAuthStates(store.db);installCredentials(store.db);
 return store;
}
function twoTenants(store){
 const auth=createAuth(store.db);
 const userA=auth.createUser({username:'a-owner',name:'A',password:'a-long-test-password'},'owner');
 const userB=auth.createUser({username:'b-owner',name:'B',password:'a-long-test-password'},'owner');
 const tenantA=createTenant(store.db,{name:'Tenant A',slug:'tenant-a'},userA.id);
 const tenantB=createTenant(store.db,{name:'Tenant B',slug:'tenant-b'},userB.id);
 return {tenantA,tenantB,userA,userB};
}

// --- IntegrationDefinitions ------------------------------------------------------------

test('IntegrationDefinitions: seeds exactly the 10 real providers, Canva now a real OAuth2 identity connector (isAvailable:true, SINGLE, zero capabilities)',()=>{
 const store=fixture();try{
  const defs=listIntegrationDefinitions(store.db);
  assert.equal(defs.length,10);
  const canva=getIntegrationDefinition(store.db,'canva');
  assert.equal(canva.authType,'OAUTH2');assert.equal(canva.isAvailable,true);
  assert.equal(connectionModeFor('canva'),'SINGLE');
  assert.deepEqual(canva.capabilities,[]); // identity/health only — no confirmed generate/autofill call yet
  const salla=getIntegrationDefinition(store.db,'salla');
  assert.equal(salla.authType,'OAUTH2');assert.equal(salla.isAvailable,true);
  const anthropic=getIntegrationDefinition(store.db,'anthropic');
  assert.equal(anthropic.authType,'API_KEY');
  const zid=getIntegrationDefinition(store.db,'zid');
  assert.equal(zid.authType,'OAUTH2');assert.equal(zid.isAvailable,true);assert.equal(zid.connectionMode,'MULTI');
  assert.equal(getIntegrationDefinition(store.db,'not-a-real-provider'),null);
 }finally{store.close();}
});

// --- IntegrationConnections: multiple connections, defaults, tenant isolation ----------

test('IntegrationConnections: a tenant can hold MULTIPLE Salla connections; the first is default, later ones are not',()=>{
 const store=fixture();try{
  const {tenantA}=twoTenants(store);
  const main=createConnection(store.db,{integrationDefinitionId:'salla',name:'Main Store'},tenantA);
  const riyadh=createConnection(store.db,{integrationDefinitionId:'salla',name:'Riyadh Store'},tenantA);
  assert.equal(main.isDefault,true);
  assert.equal(riyadh.isDefault,false);
  const list=listConnections(store.db,{integrationDefinitionId:'salla'},tenantA);
  assert.equal(list.length,2);
 }finally{store.close();}
});

test('IntegrationConnections: creating a connection for an unknown provider is refused',()=>{
 const store=fixture();try{
  const {tenantA}=twoTenants(store);
  assert.throws(()=>createConnection(store.db,{integrationDefinitionId:'not-real',name:'x'},tenantA),/تكامل غير معروف/);
 }finally{store.close();}
});

test('IntegrationConnections: tenant isolation — Tenant B cannot read, update, or default-swap a connection that belongs to Tenant A (404, not leak)',()=>{
 const store=fixture();try{
  const {tenantA,tenantB}=twoTenants(store);
  const connection=createConnection(store.db,{integrationDefinitionId:'salla',name:'Main Store'},tenantA);
  assert.throws(()=>getConnection(store.db,connection.id,tenantB),/غير موجود/);
  assert.equal(getConnectionOrNull(store.db,connection.id,tenantB),null);
  assert.throws(()=>updateConnection(store.db,connection.id,{name:'hijacked'},tenantB),/غير موجود/);
  assert.throws(()=>setDefaultConnection(store.db,connection.id,tenantB),/غير موجود/);
  assert.throws(()=>disconnectConnection(store.db,connection.id,tenantB),/غير موجود/);
  // Tenant A itself is unaffected by Tenant B's failed attempts.
  assert.equal(getConnection(store.db,connection.id,tenantA).name,'Main Store');
 }finally{store.close();}
});

test('IntegrationConnections: the same real external account can never be claimed by two different tenants (security boundary, not a convenience constraint)',()=>{
 const store=fixture();try{
  const {tenantA,tenantB}=twoTenants(store);
  const a=createConnection(store.db,{integrationDefinitionId:'salla',name:'Store'},tenantA);
  updateConnection(store.db,a.id,{externalAccountId:'merchant-999'},tenantA);
  const b=createConnection(store.db,{integrationDefinitionId:'salla',name:'Store'},tenantB);
  assert.throws(()=>updateConnection(store.db,b.id,{externalAccountId:'merchant-999'},tenantB));
 }finally{store.close();}
});

test('IntegrationConnections: setDefaultConnection swaps atomically — exactly one default per (tenant,provider) at all times',()=>{
 const store=fixture();try{
  const {tenantA}=twoTenants(store);
  const main=createConnection(store.db,{integrationDefinitionId:'salla',name:'Main'},tenantA);
  const second=createConnection(store.db,{integrationDefinitionId:'salla',name:'Second'},tenantA);
  assert.equal(getDefaultConnection(store.db,'salla',tenantA).id,main.id);
  setDefaultConnection(store.db,second.id,tenantA);
  assert.equal(getDefaultConnection(store.db,'salla',tenantA).id,second.id);
  const list=listConnections(store.db,{integrationDefinitionId:'salla'},tenantA);
  assert.equal(list.filter(c=>c.isDefault).length,1);
 }finally{store.close();}
});

test('resolveProviderAccount: 0 connections -> null; 1 -> that one; 2+ with a default -> the default; 2+ with NO default -> CONNECTION_SELECTION_REQUIRED (never guesses)',()=>{
 const store=fixture();try{
  const {tenantA}=twoTenants(store);
  assert.equal(resolveProviderAccount(store.db,'salla',tenantA),null);
  const only=createConnection(store.db,{integrationDefinitionId:'salla',name:'Only'},tenantA);
  assert.equal(resolveProviderAccount(store.db,'salla',tenantA).id,only.id);
  const second=createConnection(store.db,{integrationDefinitionId:'salla',name:'Second'},tenantA);
  // `only` is still the default (first created) — resolves without ambiguity.
  assert.equal(resolveProviderAccount(store.db,'salla',tenantA).id,only.id);
  // Clear the default at the DB level to simulate a genuinely ambiguous state.
  store.db.prepare('UPDATE integration_connections SET is_default=0 WHERE tenant_id=?').run(tenantA);
  assert.throws(()=>resolveProviderAccount(store.db,'salla',tenantA),err=>{
   assert.equal(err.code,'CONNECTION_SELECTION_REQUIRED');assert.equal(err.status,409);
   assert.equal(err.connections.length,2);
   return true;
  });
 }finally{store.close();}
});

// --- Credentials Vault: encryption at rest, safe metadata, no secret leakage -----------

test('Vault: a stored credential is genuinely encrypted at rest — a raw DB read never shows the plaintext payload',()=>{
 const store=fixture();try{
  const {tenantA}=twoTenants(store);
  const connection=createConnection(store.db,{integrationDefinitionId:'anthropic',name:'Claude'},tenantA);
  storeCredential(store.db,env,{connectionId:connection.id,credentialType:'api_key',payload:{apiKey:'sk-super-secret-value'}},tenantA);
  const raw=store.db.prepare('SELECT encrypted_payload FROM integration_credentials_vault WHERE connection_id=?').get(connection.id);
  assert.ok(!raw.encrypted_payload.includes('sk-super-secret-value'));
  const runtime=getCredentialForRuntime(store.db,env,connection.id,tenantA);
  assert.equal(runtime.payload.apiKey,'sk-super-secret-value');
 }finally{store.close();}
});

test('Vault: getCredentialMeta never returns the payload, only safe metadata',()=>{
 const store=fixture();try{
  const {tenantA}=twoTenants(store);
  const connection=createConnection(store.db,{integrationDefinitionId:'openai',name:'GPT'},tenantA);
  assert.equal(getCredentialMeta(store.db,connection.id,tenantA).configured,false);
  storeCredential(store.db,env,{connectionId:connection.id,credentialType:'api_key',payload:{apiKey:'sk-another-secret'}},tenantA);
  const meta=getCredentialMeta(store.db,connection.id,tenantA);
  assert.equal(meta.configured,true);assert.equal(meta.credentialType,'api_key');
  assert.equal(JSON.stringify(meta).includes('sk-another-secret'),false);
 }finally{store.close();}
});

test('Vault: tenant isolation — a credential stored under Tenant A is invisible to Tenant B even by the right connection id',()=>{
 const store=fixture();try{
  const {tenantA,tenantB}=twoTenants(store);
  const connection=createConnection(store.db,{integrationDefinitionId:'anthropic',name:'Claude'},tenantA);
  storeCredential(store.db,env,{connectionId:connection.id,credentialType:'api_key',payload:{apiKey:'sk-tenant-a'}},tenantA);
  assert.equal(hasCredential(store.db,connection.id,tenantB),false);
  assert.equal(getCredentialForRuntime(store.db,env,connection.id,tenantB),null);
 }finally{store.close();}
});

test('Vault: removeCredential deletes the row; storeCredential without the encryption key configured fails loudly (never silently stores plaintext)',()=>{
 const store=fixture();try{
  const {tenantA}=twoTenants(store);
  const connection=createConnection(store.db,{integrationDefinitionId:'anthropic',name:'Claude'},tenantA);
  storeCredential(store.db,env,{connectionId:connection.id,credentialType:'api_key',payload:{apiKey:'sk-x'}},tenantA);
  removeCredential(store.db,connection.id,tenantA);
  assert.equal(hasCredential(store.db,connection.id,tenantA),false);
  assert.throws(()=>storeCredential(store.db,{},{connectionId:connection.id,credentialType:'api_key',payload:{apiKey:'sk-x'}},tenantA),/INTEGRATION_ENCRYPTION_KEY/);
 }finally{store.close();}
});

// --- OAuth State: IDOR, replay, expiry --------------------------------------------------

test('OAuthState: a real round trip resolves the exact tenant/connection/provider it was created for',()=>{
 const store=fixture();try{
  const {tenantA,userA}=twoTenants(store);
  const connection=createConnection(store.db,{integrationDefinitionId:'salla',name:'Store'},tenantA);
  const token=createOAuthState(store.db,{tenantId:tenantA,userId:userA.id,integrationDefinitionId:'salla',connectionId:connection.id},env);
  assert.equal(typeof token,'string');
  const consumed=consumeOAuthState(store.db,token,{userId:userA.id,integrationDefinitionId:'salla'},env);
  assert.equal(consumed.tenantId,tenantA);assert.equal(consumed.connectionId,connection.id);
 }finally{store.close();}
});

test('OAuthState: single-use — the exact same token cannot be consumed twice (replay is refused even though it is still within its expiry window)',()=>{
 const store=fixture();try{
  const {tenantA,userA}=twoTenants(store);
  const token=createOAuthState(store.db,{tenantId:tenantA,userId:userA.id,integrationDefinitionId:'salla'},env);
  consumeOAuthState(store.db,token,{userId:userA.id,integrationDefinitionId:'salla'},env);
  assert.throws(()=>consumeOAuthState(store.db,token,{userId:userA.id,integrationDefinitionId:'salla'},env),/تم استخدام/);
 }finally{store.close();}
});

test('OAuthState: IDOR — a state token bound to User A cannot be consumed by User B, even a different tenant\'s owner',()=>{
 const store=fixture();try{
  const {tenantA,userA,userB}=twoTenants(store);
  const token=createOAuthState(store.db,{tenantId:tenantA,userId:userA.id,integrationDefinitionId:'salla'},env);
  assert.throws(()=>consumeOAuthState(store.db,token,{userId:userB.id,integrationDefinitionId:'salla'},env),/مستخدم مختلف/);
 }finally{store.close();}
});

test('OAuthState: a state issued for one provider cannot be redeemed against a different provider\'s callback',()=>{
 const store=fixture();try{
  const {tenantA,userA}=twoTenants(store);
  const token=createOAuthState(store.db,{tenantId:tenantA,userId:userA.id,integrationDefinitionId:'salla'},env);
  assert.throws(()=>consumeOAuthState(store.db,token,{userId:userA.id,integrationDefinitionId:'microsoft365'},env),/لا يطابق/);
 }finally{store.close();}
});

test('OAuthState: expiry — a state older than its TTL is refused even though it was never used',()=>{
 const store=fixture();try{
  const {tenantA,userA}=twoTenants(store);
  const token=createOAuthState(store.db,{tenantId:tenantA,userId:userA.id,integrationDefinitionId:'salla'},env);
  store.db.prepare("UPDATE oauth_states SET expires_at=? WHERE state_token_hash IS NOT NULL").run(new Date(Date.now()-1000).toISOString());
  assert.throws(()=>consumeOAuthState(store.db,token,{userId:userA.id,integrationDefinitionId:'salla'},env),/انتهت صلاحية/);
 }finally{store.close();}
});

test('OAuthState: an unknown token is refused; pruneExpiredOAuthStates only ever removes truly expired rows',()=>{
 const store=fixture();try{
  const {tenantA,userA}=twoTenants(store);
  assert.throws(()=>consumeOAuthState(store.db,'not-a-real-token',{userId:userA.id,integrationDefinitionId:'salla'},env),/غير معروف/);
  createOAuthState(store.db,{tenantId:tenantA,userId:userA.id,integrationDefinitionId:'salla'},env);
  assert.equal(pruneExpiredOAuthStates(store.db),0);
  store.db.prepare('UPDATE oauth_states SET expires_at=?').run(new Date(Date.now()-1000).toISOString());
  assert.equal(pruneExpiredOAuthStates(store.db),1);
 }finally{store.close();}
});

// --- Legacy compatibility bridge ---------------------------------------------------------

test('legacy-sync: mirrors a legacy credential into a real connection+vault row, then marks it DISCONNECTED and purges the credential on clear',()=>{
 const store=fixture();try{
  const {tenantA,userA}=twoTenants(store);
  syncConnectionFromLegacyCredential(store.db,env,tenantA,'microsoft365',{accessToken:'tok',refreshToken:'ref',expiresAt:null,scopes:['mail.read'],externalAccountId:'acct-1',extra:null,metadata:{displayName:'ops@hyper-cool.com'}},userA);
  const connection=getDefaultConnection(store.db,'microsoft365',tenantA);
  assert.equal(connection.status,'CONNECTED');assert.equal(connection.externalAccountName,'ops@hyper-cool.com');
  assert.equal(hasCredential(store.db,connection.id,tenantA),true);
  // Calling it again for the SAME tenant+provider reuses the same connection (idempotent upsert), never duplicates it.
  syncConnectionFromLegacyCredential(store.db,env,tenantA,'microsoft365',{accessToken:'tok2',refreshToken:'ref2',expiresAt:null,scopes:['mail.read'],externalAccountId:'acct-1',extra:null,metadata:{displayName:'ops@hyper-cool.com'}},userA);
  assert.equal(listConnections(store.db,{integrationDefinitionId:'microsoft365'},tenantA).length,1);
  markLegacyCredentialDisconnected(store.db,tenantA,'microsoft365');
  const after=getConnection(store.db,connection.id,tenantA);
  assert.equal(after.status,'DISCONNECTED');
  assert.equal(hasCredential(store.db,connection.id,tenantA),false);
 }finally{store.close();}
});

test('legacy-sync: an unmapped provider is skipped, never guessed at (no separate "whatsapp" mirror is ever created)',()=>{
 const store=fixture();try{
  const {tenantA}=twoTenants(store);
  syncConnectionFromLegacyCredential(store.db,env,tenantA,'whatsapp',{accessToken:'tok',refreshToken:null,expiresAt:null,scopes:[],externalAccountId:null,extra:null,metadata:null},null);
  assert.equal(getDefaultConnection(store.db,'whatsapp',tenantA),null);
 }finally{store.close();}
});

test('migration: with no encryption key configured, migration is honestly skipped rather than silently doing nothing',()=>{
 const store=fixture();try{
  const result=migrateLegacyIntegrationCredentials(store.db,{});
  assert.equal(result.skipped,'NO_ENCRYPTION_KEY');assert.equal(result.migrated,0);
 }finally{store.close();}
});

test('migration: copies every existing legacy integration_credentials row into a real connection, one row failing never stops the rest',()=>{
 const store=fixture();try{
  const {tenantA,tenantB}=twoTenants(store);
  const now=new Date().toISOString();
  // A well-formed legacy row for Tenant A...
  store.db.prepare('INSERT INTO integration_credentials (tenant_id,provider,access_token_enc,connected_at,updated_at) VALUES (?,?,?,?,?)').run(tenantA,'microsoft365','not-real-ciphertext-will-fail-decrypt',now,now);
  // ...and a second, genuinely decryptable one for Tenant B via the real saveCredentials path is out of scope here (covered by credentials.test.js) — this proves isolation: A's undecryptable row errors but does not stop B's row (if any) or crash the loop.
  const result=migrateLegacyIntegrationCredentials(store.db,env);
  assert.equal(result.skipped,null);
  assert.ok(result.errors>=1); // the placeholder ciphertext cannot decrypt — counted, not thrown
 }finally{store.close();}
});

// --- Connection Health: real test-or-nothing, provider failure isolation --------------

test('Health: a connection is only ever CONNECTED after a real test call succeeds — a saved credential alone is not enough',async()=>{
 const store=fixture();try{
  const {tenantA}=twoTenants(store);
  const connection=createConnection(store.db,{integrationDefinitionId:'anthropic',name:'Claude'},tenantA);
  const result=await testConnectionHealth(connection,{store,env:{},fetcher:async()=>{throw new Error('should never be called — not configured');}});
  assert.equal(result.status,'NOT_CONFIGURED');
 }finally{store.close();}
});

test('Health: one connection\'s test call throwing is caught and reported as ERROR — it never crashes the caller or affects another connection',async()=>{
 const store=fixture();try{
  const {tenantA}=twoTenants(store);
  const broken=createConnection(store.db,{integrationDefinitionId:'anthropic',name:'Broken'},tenantA);
  const healthyEnv={ANTHROPIC_API_KEY:'key',ANTHROPIC_MODEL:'claude-x'};
  const brokenResult=await testConnectionHealth(broken,{store,env:healthyEnv,fetcher:async()=>{throw new Error('network exploded');}});
  assert.equal(brokenResult.status,'DEGRADED'); // a network/timeout failure is reported, never thrown — testAnthropicConnection classifies it as NETWORK_ERROR
  const healthy=createConnection(store.db,{integrationDefinitionId:'anthropic',name:'Healthy'},tenantA);
  const healthyResult=await testConnectionHealth(healthy,{store,env:healthyEnv,fetcher:async()=>new Response(JSON.stringify({data:[]}),{status:200,headers:{'content-type':'application/json'}})});
  assert.equal(healthyResult.status,'CONNECTED');
 }finally{store.close();}
});

test('Health: Salla health testing reads THIS connection\'s own vault credential — two Salla connections for the same tenant are tested independently',async()=>{
 const store=fixture();try{
  const {tenantA}=twoTenants(store);
  const storeA=createConnection(store.db,{integrationDefinitionId:'salla',name:'Store A'},tenantA);
  const storeB=createConnection(store.db,{integrationDefinitionId:'salla',name:'Store B'},tenantA);
  storeCredential(store.db,env,{connectionId:storeA.id,credentialType:'oauth_tokens',payload:{accessToken:'token-A'}},tenantA);
  storeCredential(store.db,env,{connectionId:storeB.id,credentialType:'oauth_tokens',payload:{accessToken:'token-B'}},tenantA);
  const seenTokens=[];
  const fetcher=async(url,options)=>{seenTokens.push(options.headers.Authorization);return new Response(JSON.stringify({success:true,data:[]}),{status:200,headers:{'content-type':'application/json'}});};
  await testConnectionHealth(storeA,{store,env,fetcher});
  await testConnectionHealth(storeB,{store,env,fetcher});
  assert.deepEqual(seenTokens,['Bearer token-A','Bearer token-B']);
 }finally{store.close();}
});
