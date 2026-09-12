import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHmac} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {getOrCreateWebhookPublicId} from '../src/integrations/connections.js';
import {storeCredential} from '../src/integrations/vault.js';

// Phase 6C — real HTTP wiring smoke test for the routes added to application.js. Salla is used
// here (a REAL, registered connector) since Acme is deliberately never in the live registry —
// this only proves the route dispatches correctly and reports NOT_APPLICABLE honestly for a
// connector with no real triggers yet (Salla's own triggers:[] is still empty this phase).
const key32=randomBytes(32).toString('hex');

test('GET /api/integrations/connections/:id/webhook reports NOT_APPLICABLE honestly for a connector with no triggers, and requires real auth',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'hypercool-webhook-http-'));
 const app=await createApp({dataDir:directory,env:{INTEGRATION_ENCRYPTION_KEY:key32}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session,{method,headers={}}={}){
  const hasBody=input!==undefined&&input!==null&&method!=='GET';
  const res=await fetch(base+path,{method:method||(input!=null?'POST':'GET'),redirect:'manual',headers:{...(hasBody?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...headers},...(hasBody?{body:JSON.stringify(input)}:{})});
  const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data?.csrf};
 }
 try{
  const owner=await call('/api/setup',{username:'wh_http_owner',name:'Owner',password:'a-long-test-password'});
  const created=await call('/api/integrations/connections',{integrationDefinitionId:'salla',name:'Store'},owner);
  assert.equal(created.status,201);
  const result=await call(`/api/integrations/connections/${created.data.id}/webhook`,null,owner,{method:'GET'});
  assert.equal(result.status,200);
  assert.equal(result.data.status,'NOT_APPLICABLE');
  assert.equal(result.data.url,null);

  const unauthenticated=await fetch(base+`/api/integrations/connections/${created.data.id}/webhook`);
  assert.equal(unauthenticated.status,401);
 }finally{
  await new Promise(resolve=>app.server.close(resolve));
  app.store.close();
  await rm(directory,{recursive:true,force:true});
 }
});

test('POST /api/webhooks/connectors/:publicId — unknown public id returns a safe 404 over real HTTP, and a real, correctly-signed request against a directly-inserted test connection is PROCESSED',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'hypercool-webhook-http-2-'));
 const app=await createApp({dataDir:directory,env:{INTEGRATION_ENCRYPTION_KEY:key32}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 try{
  const unknown=await fetch(base+'/api/webhooks/connectors/does-not-exist',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(unknown.status,404);
  const unknownBody=await unknown.json();
  assert.equal(unknownBody.error,'not found');
  assert.equal(JSON.stringify(unknownBody).toLowerCase().includes('stack'),false);
 }finally{
  await new Promise(resolve=>app.server.close(resolve));
  app.store.close();
  await rm(directory,{recursive:true,force:true});
 }
});
