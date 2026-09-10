import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHmac} from 'node:crypto';
import {openStore} from '../src/store.js';
import {installCredentials,saveCredentials,getCredentials,getCredentialsMeta,clearCredentials,credentialsConfigured,isExpiringSoon,safeEqual} from '../src/runtime/credentials.js';
import {installWebhookEvents,verifySallaWebhook,processSallaWebhook,listWebhookEvents} from '../src/runtime/salla-webhooks.js';
import {installEvents,createEventBus} from '../src/runtime/events.js';
import {resolveSallaAccessToken,oauthConfigured} from '../src/runtime/salla-oauth.js';

const user={id:'owner-1',name:'Owner',role:'owner'};
const key32=randomBytes(32).toString('hex');

function fixture(){
 const store=openStore(':memory:');
 installCredentials(store.db);installWebhookEvents(store.db);installEvents(store.db);
 return store;
}

test('credentials round-trip through real AES-256-GCM encryption and are never stored as plaintext',()=>{
 const store=fixture();try{
 const env={INTEGRATION_ENCRYPTION_KEY:key32};
 saveCredentials(store.db,env,'salla',{accessToken:'plain-access-token',refreshToken:'plain-refresh-token',expiresAt:'2030-01-01T00:00:00.000Z',scopes:['products.read'],externalAccountId:'store-123'},user);
 const rawRow=store.db.prepare('SELECT access_token_enc,refresh_token_enc FROM integration_credentials WHERE provider=?').get('salla');
 assert.ok(!rawRow.access_token_enc.includes('plain-access-token'));
 assert.ok(!rawRow.refresh_token_enc.includes('plain-refresh-token'));
 const creds=getCredentials(store.db,env,'salla');
 assert.equal(creds.accessToken,'plain-access-token');
 assert.equal(creds.refreshToken,'plain-refresh-token');
 assert.equal(creds.externalAccountId,'store-123');
 const meta=getCredentialsMeta(store.db,'salla');
 assert.equal(JSON.stringify(meta).includes('plain-access-token'),false);
 assert.equal(meta.connectedByName,'Owner');
 }finally{store.close();}
});

test('saving a credential without a valid 32-byte encryption key fails closed, never stores plaintext',()=>{
 const store=fixture();try{
 assert.throws(()=>saveCredentials(store.db,{},'salla',{accessToken:'x'},user),/INTEGRATION_ENCRYPTION_KEY/);
 assert.throws(()=>saveCredentials(store.db,{INTEGRATION_ENCRYPTION_KEY:'too-short'},'salla',{accessToken:'x'},user),/INTEGRATION_ENCRYPTION_KEY/);
 assert.equal(store.db.prepare('SELECT COUNT(*) n FROM integration_credentials').get().n,0);
 assert.equal(credentialsConfigured({}),false);
 assert.equal(credentialsConfigured({INTEGRATION_ENCRYPTION_KEY:key32}),true);
 }finally{store.close();}
});

test('a token refresh (no user) never overwrites who originally connected the integration',()=>{
 const store=fixture();try{
 const env={INTEGRATION_ENCRYPTION_KEY:key32};
 saveCredentials(store.db,env,'salla',{accessToken:'a1',externalAccountId:'store-1'},user);
 saveCredentials(store.db,env,'salla',{accessToken:'a2'},null); // simulates a background refresh
 const meta=getCredentialsMeta(store.db,'salla');
 assert.equal(meta.connectedByName,'Owner');
 assert.equal(meta.externalAccountId,'store-1');
 assert.equal(getCredentials(store.db,env,'salla').accessToken,'a2');
 }finally{store.close();}
});

test('isExpiringSoon and safeEqual behave correctly at the boundary',()=>{
 assert.equal(isExpiringSoon(null),false);
 assert.equal(isExpiringSoon(new Date(Date.now()+10000).toISOString(),300000),true);
 assert.equal(isExpiringSoon(new Date(Date.now()+3600000).toISOString(),300000),false);
 assert.equal(safeEqual('secret','secret'),true);
 assert.equal(safeEqual('secret','wrong'),false);
 assert.equal(safeEqual('secret','secretlonger'),false);
});

test('resolveSallaAccessToken prefers a connected OAuth token over the legacy static token',async()=>{
 const store=fixture();try{
 const env={INTEGRATION_ENCRYPTION_KEY:key32,SALLA_ACCESS_TOKEN:'legacy-static-token'};
 saveCredentials(store.db,env,'salla',{accessToken:'oauth-token',expiresAt:new Date(Date.now()+3600000).toISOString()},user);
 const resolved=await resolveSallaAccessToken({store,env,fetcher:()=>{throw new Error('must not call network for a still-valid token');}});
 assert.equal(resolved.token,'oauth-token');assert.equal(resolved.source,'oauth');
 }finally{store.close();}
});

test('resolveSallaAccessToken falls back to the static token when OAuth was never connected',async()=>{
 const store=fixture();try{
 const env={SALLA_ACCESS_TOKEN:'legacy-static-token'};
 const resolved=await resolveSallaAccessToken({store,env,fetcher:()=>{throw new Error('must not call network');}});
 assert.equal(resolved.token,'legacy-static-token');assert.equal(resolved.source,'static');
 assert.equal(await resolveSallaAccessToken({store,env:{},fetcher:()=>{throw new Error('x');}}),null);
 }finally{store.close();}
});

test('resolveSallaAccessToken refreshes an expiring OAuth token and persists the new one',async()=>{
 const store=fixture();try{
 const env={INTEGRATION_ENCRYPTION_KEY:key32,SALLA_CLIENT_ID:'c',SALLA_CLIENT_SECRET:'s',SALLA_REDIRECT_URI:'https://hyper-cool.com/cb'};
 saveCredentials(store.db,env,'salla',{accessToken:'old-token',refreshToken:'refresh-1',expiresAt:new Date(Date.now()+1000).toISOString()},user);
 const fetcher=async()=>new Response(JSON.stringify({access_token:'new-token',refresh_token:'refresh-2',expires_in:3600}),{status:200,headers:{'content-type':'application/json'}});
 const resolved=await resolveSallaAccessToken({store,env,fetcher});
 assert.equal(resolved.token,'new-token');assert.equal(resolved.source,'oauth');
 assert.equal(getCredentials(store.db,env,'salla').refreshToken,'refresh-2');
 }finally{store.close();}
});

test('resolveSallaAccessToken falls back to the static token when the refresh call itself fails',async()=>{
 const store=fixture();try{
 const env={INTEGRATION_ENCRYPTION_KEY:key32,SALLA_CLIENT_ID:'c',SALLA_CLIENT_SECRET:'s',SALLA_REDIRECT_URI:'https://hyper-cool.com/cb',SALLA_ACCESS_TOKEN:'legacy-static-token'};
 saveCredentials(store.db,env,'salla',{accessToken:'old-token',refreshToken:'refresh-1',expiresAt:new Date(Date.now()+1000).toISOString()},user);
 const resolved=await resolveSallaAccessToken({store,env,fetcher:async()=>new Response('',{status:401})});
 assert.equal(resolved.token,'legacy-static-token');assert.equal(resolved.source,'static');
 }finally{store.close();}
});

test('webhook token-strategy verification accepts the exact secret and rejects anything else',()=>{
 const env={SALLA_WEBHOOK_SECRET:'wh-secret-32-characters-minimum'};
 assert.doesNotThrow(()=>verifySallaWebhook({headers:{authorization:'Bearer wh-secret-32-characters-minimum'}},'{}',env));
 assert.throws(()=>verifySallaWebhook({headers:{authorization:'Bearer wrong'}},'{}',env),/رمز الويبهوك/);
 assert.throws(()=>verifySallaWebhook({headers:{}},'{}',env),/رمز الويبهوك/);
 assert.throws(()=>verifySallaWebhook({headers:{}},'{}',{}),/SALLA_WEBHOOK_SECRET/);
});

test('webhook signature-strategy verification is a real HMAC-SHA256 over the exact raw body, not the parsed object',()=>{
 const env={SALLA_WEBHOOK_SECRET:'wh-secret',SALLA_WEBHOOK_STRATEGY:'signature'};
 const raw='{"event":"order.created","data":{"id":1}}';
 const validSig=createHmac('sha256','wh-secret').update(raw).digest('hex');
 assert.doesNotThrow(()=>verifySallaWebhook({headers:{'x-salla-signature':validSig}},raw,env));
 assert.throws(()=>verifySallaWebhook({headers:{'x-salla-signature':validSig}},raw+' ',env),/توقيع/); // body tampered after signing
 assert.throws(()=>verifySallaWebhook({headers:{'x-salla-signature':'deadbeef'}},raw,env),/توقيع/);
});

test('webhook processing is idempotent — the same delivery redelivered is never processed twice',()=>{
 const store=fixture();try{
 const eventBus=createEventBus(store.db);
 const body={event:'order.created',data:{id:'order-1'},created_at:'2030-01-01T00:00:00Z'};
 const first=processSallaWebhook({db:store.db,eventBus,body});
 assert.equal(first.replayed,false);assert.equal(first.internalType,'ORDER_CREATED');
 const second=processSallaWebhook({db:store.db,eventBus,body});
 assert.equal(second.replayed,true);
 assert.equal(store.db.prepare('SELECT COUNT(*) n FROM webhook_events').get().n,1);
 assert.equal(eventBus.list({type:'ORDER_CREATED'}).length,1);
 }finally{store.close();}
});

test('an unmapped Salla event type is stored for observability but never fabricates an internal event',()=>{
 const store=fixture();try{
 const eventBus=createEventBus(store.db);
 const result=processSallaWebhook({db:store.db,eventBus,body:{event:'something.salla.added.later',data:{id:'x'}}});
 assert.equal(result.internalType,null);
 const stored=listWebhookEvents(store.db,{source:'salla'})[0];
 assert.equal(stored.status,'UNMAPPED');
 assert.equal(eventBus.list({limit:100}).length,0);
 }finally{store.close();}
});

test('product.updated and product.available map to the correct internal events',()=>{
 const store=fixture();try{
 const eventBus=createEventBus(store.db);
 assert.equal(processSallaWebhook({db:store.db,eventBus,body:{event:'product.updated',data:{id:'p1'}}}).internalType,'PRODUCT_UPDATED');
 assert.equal(processSallaWebhook({db:store.db,eventBus,body:{event:'product.available',data:{id:'p2'}}}).internalType,'PRODUCT_STOCK_UPDATED');
 }finally{store.close();}
});

test('oauthConfigured requires all three OAuth env vars, not just one',()=>{
 assert.equal(oauthConfigured({}),false);
 assert.equal(oauthConfigured({SALLA_CLIENT_ID:'c'}),false);
 assert.equal(oauthConfigured({SALLA_CLIENT_ID:'c',SALLA_CLIENT_SECRET:'s',SALLA_REDIRECT_URI:'r'}),true);
});
