import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createTenant} from '../src/tenancy.js';
import {createAuth} from '../src/auth.js';
import {createConnection,updateConnection} from '../src/integrations/connections.js';
import {storeCredential} from '../src/integrations/vault.js';
import {buildConnectionHealthView} from '../src/integrations/connection-health-view.js';

// Phase 6H, Part 19-21 — Token Expiry Proactive UI: dedicated coverage for the derived
// displayStatus/tokenExpiry states this UI is built on (Phase 6G shipped the module without a
// dedicated unit test of its own — closing that real gap here).
const key32=randomBytes(32).toString('hex');

async function harness() {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-healthview-'));
 const app=await createApp({dataDir:directory,env:{INTEGRATION_ENCRYPTION_KEY:key32}});
 const auth=createAuth(app.store.db);
 const owner=auth.createUser({username:'o_'+Math.random().toString(36).slice(2),name:'O',password:'a-long-test-password'},'owner');
 const tenantId=createTenant(app.store.db,{name:'Co',slug:'co-'+Math.random().toString(36).slice(2)},owner.id);
 const env={INTEGRATION_ENCRYPTION_KEY:key32};
 return {db:app.store.db,env,tenantId,cleanup:async()=>{app.store.close();await rm(directory,{recursive:true,force:true});}};
}
function fakeOAuthDefinition() { return {status:'PUBLISHED',authConfig:{type:'OAUTH2'},authType:'OAUTH2',slug:'fake_oauth'}; }

test('HEALTHY: a token expiring well in the future',async()=>{
 const {db,env,tenantId,cleanup}=await harness();
 try{
  let conn=createConnection(db,{integrationDefinitionId:'salla',name:'c'},tenantId);
  conn=updateConnection(db,conn.id,{status:'CONNECTED'},tenantId);
  storeCredential(db,env,{connectionId:conn.id,credentialType:'oauth_tokens',payload:{accessToken:'a',refreshToken:'r',expiresAt:new Date(Date.now()+30*86400000).toISOString()}},tenantId);
  const view=buildConnectionHealthView(db,env,{...conn,tenantId},fakeOAuthDefinition());
  assert.equal(view.displayStatus,'CONNECTED');
  assert.equal(view.tokenExpiry.status,'HEALTHY');
  assert.ok(view.tokenExpiry.expiresAt);
 } finally { await cleanup(); }
});

test('EXPIRING_SOON: inside the 24h heads-up window, not yet expired',async()=>{
 const {db,env,tenantId,cleanup}=await harness();
 try{
  let conn=createConnection(db,{integrationDefinitionId:'salla',name:'c'},tenantId);
  conn=updateConnection(db,conn.id,{status:'CONNECTED'},tenantId);
  storeCredential(db,env,{connectionId:conn.id,credentialType:'oauth_tokens',payload:{accessToken:'a',refreshToken:'r',expiresAt:new Date(Date.now()+3600000).toISOString()}},tenantId);
  const view=buildConnectionHealthView(db,env,{...conn,tenantId},fakeOAuthDefinition());
  assert.equal(view.tokenExpiry.status,'EXPIRING_SOON');
  assert.equal(view.displayStatus,'CONNECTED','a proactively-expiring-but-still-valid token must not be shown as already broken');
 } finally { await cleanup(); }
});

test('EXPIRED (but connection status not yet TOKEN_EXPIRED): timestamp already passed',async()=>{
 const {db,env,tenantId,cleanup}=await harness();
 try{
  let conn=createConnection(db,{integrationDefinitionId:'salla',name:'c'},tenantId);
  conn=updateConnection(db,conn.id,{status:'CONNECTED'},tenantId);
  storeCredential(db,env,{connectionId:conn.id,credentialType:'oauth_tokens',payload:{accessToken:'a',refreshToken:'r',expiresAt:new Date(Date.now()-1000).toISOString()}},tenantId);
  const view=buildConnectionHealthView(db,env,{...conn,tenantId},fakeOAuthDefinition());
  assert.equal(view.tokenExpiry.status,'EXPIRED');
 } finally { await cleanup(); }
});

test('REAUTH_REQUIRED: token expired AND the runtime already flipped the connection to TOKEN_EXPIRED',async()=>{
 const {db,env,tenantId,cleanup}=await harness();
 try{
  let conn=createConnection(db,{integrationDefinitionId:'salla',name:'c'},tenantId);
  conn=updateConnection(db,conn.id,{status:'TOKEN_EXPIRED'},tenantId);
  storeCredential(db,env,{connectionId:conn.id,credentialType:'oauth_tokens',payload:{accessToken:'a',refreshToken:null,expiresAt:new Date(Date.now()-1000).toISOString()}},tenantId);
  const view=buildConnectionHealthView(db,env,{...conn,tenantId},fakeOAuthDefinition());
  assert.equal(view.displayStatus,'REAUTH_REQUIRED');
  assert.equal(view.tokenExpiry.status,'REAUTH_REQUIRED');
  assert.equal(view.reconnectEligible,true);
 } finally { await cleanup(); }
});

test('UNKNOWN: a non-OAuth2 connection (e.g. API_KEY) has no concept of token expiry — never a fake status',async()=>{
 const {db,env,tenantId,cleanup}=await harness();
 try{
  let conn=createConnection(db,{integrationDefinitionId:'anthropic',name:'c'},tenantId);
  conn=updateConnection(db,conn.id,{status:'CONNECTED'},tenantId);
  storeCredential(db,env,{connectionId:conn.id,credentialType:'api_key',payload:{apiKey:'k'}},tenantId);
  const view=buildConnectionHealthView(db,env,{...conn,tenantId},{status:'PUBLISHED',authType:'API_KEY'});
  assert.equal(view.tokenExpiry.status,'UNKNOWN');
  assert.equal(view.tokenExpiry.expiresAt,null);
 } finally { await cleanup(); }
});

test('Never exposes the token itself, only the expiry timestamp and derived label',async()=>{
 const {db,env,tenantId,cleanup}=await harness();
 try{
  let conn=createConnection(db,{integrationDefinitionId:'salla',name:'c'},tenantId);
  conn=updateConnection(db,conn.id,{status:'CONNECTED'},tenantId);
  storeCredential(db,env,{connectionId:conn.id,credentialType:'oauth_tokens',payload:{accessToken:'super-secret-access-token-value',refreshToken:'super-secret-refresh-token-value',expiresAt:new Date(Date.now()+30*86400000).toISOString()}},tenantId);
  const view=buildConnectionHealthView(db,env,{...conn,tenantId},fakeOAuthDefinition());
  const raw=JSON.stringify(view);
  assert.equal(raw.includes('super-secret-access-token-value'),false);
  assert.equal(raw.includes('super-secret-refresh-token-value'),false);
 } finally { await cleanup(); }
});

test('DISABLED connector definition always wins over the connection\'s own status',async()=>{
 const {db,env,tenantId,cleanup}=await harness();
 try{
  let conn=createConnection(db,{integrationDefinitionId:'salla',name:'c'},tenantId);
  conn=updateConnection(db,conn.id,{status:'CONNECTED'},tenantId);
  const view=buildConnectionHealthView(db,env,{...conn,tenantId},{...fakeOAuthDefinition(),status:'DISABLED'});
  assert.equal(view.displayStatus,'DISABLED');
 } finally { await cleanup(); }
});
