import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {openaiAdapter} from '../src/connectors/openai/adapter.js';
import {openaiManifest} from '../src/connectors/openai/manifest.js';

const key32=randomBytes(32).toString('hex');
const FAKE_PNG_B64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('openaiManifest declares design.generate and the generate_image action, requiring it',()=>{
 assert.ok(openaiManifest.capabilities.includes('design.generate'));
 const action=openaiManifest.actions.find(a=>a.slug==='generate_image');
 assert.ok(action);
 assert.equal(action.requiredCapability,'design.generate');
 assert.equal(action.actionType,'EXTERNAL_SEND');
 assert.notEqual(action.riskLevel,'LOW'); // a write-shaped action can never silently default to LOW risk
});

test('openaiAdapter generate_image: OK with a real b64_json response, sends the prompt and Bearer auth to the documented endpoint',async()=>{
 let seen=null;
 const fetcher=async(url,options)=>{
  seen={url,body:JSON.parse(options.body),authorization:options.headers.authorization};
  return new Response(JSON.stringify({data:[{b64_json:FAKE_PNG_B64}]}),{status:200,headers:{'content-type':'application/json'}});
 };
 const result=await openaiAdapter.executeAction({action:{slug:'generate_image'},input:{prompt:'a red teapot'},env:{},fetcher,credential:{payload:{apiKey:'sk-test-key'}}});
 assert.equal(result.status,'OK');
 assert.equal(result.output.imageDataUri,`data:image/png;base64,${FAKE_PNG_B64}`);
 assert.equal(seen.url,'https://api.openai.com/v1/images/generations');
 assert.equal(seen.authorization,'Bearer sk-test-key');
 assert.equal(seen.body.prompt,'a red teapot');
 assert.equal(seen.body.model,'gpt-image-1');
});

test('openaiAdapter generate_image: honors OPENAI_IMAGE_MODEL override, and a url-only response also works',async()=>{
 let seenModel=null;
 const fetcher=async(url,options)=>{
  seenModel=JSON.parse(options.body).model;
  return new Response(JSON.stringify({data:[{url:'https://files.openai.example/generated.png'}]}),{status:200,headers:{'content-type':'application/json'}});
 };
 const result=await openaiAdapter.executeAction({action:{slug:'generate_image'},input:{prompt:'x'},env:{OPENAI_IMAGE_MODEL:'dall-e-3'},fetcher,credential:{payload:{apiKey:'sk-test-key'}}});
 assert.equal(seenModel,'dall-e-3');
 assert.equal(result.output.imageDataUri,'https://files.openai.example/generated.png');
});

test('openaiAdapter generate_image: a real 401 maps to AUTH_FAILED, never a silent success',async()=>{
 const fetcher=async()=>new Response(JSON.stringify({error:'invalid api key'}),{status:401,headers:{'content-type':'application/json'}});
 const result=await openaiAdapter.executeAction({action:{slug:'generate_image'},input:{prompt:'x'},env:{},fetcher,credential:{payload:{apiKey:'sk-bad'}}});
 assert.equal(result.status,'ERROR');
 assert.equal(result.errorCode,'AUTH_FAILED');
});

test('openaiAdapter generate_image: no API key at all -> CAPABILITY_MISSING, never calls the network',async()=>{
 const result=await openaiAdapter.executeAction({action:{slug:'generate_image'},input:{prompt:'x'},env:{},fetcher:async()=>{throw new Error('must not be called');},credential:null});
 assert.equal(result.status,'ERROR');
 assert.equal(result.errorCode,'CAPABILITY_MISSING');
});

// --- Full stack: the existing generic action-runner route, never a new one ------------------

async function harness(env,fetcher){
 const directory=await mkdtemp(join(tmpdir(),'hypercool-openai-image-'));
 const app=await createApp({dataDir:directory,env,...(fetcher?{fetcher}:{})});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session,{method,headers={}}={}){
  const res=await fetch(base+path,{method:method||(input?'POST':'GET'),redirect:'manual',headers:{...(input!==undefined?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...headers},...(input!==undefined?{body:typeof input==='string'?input:JSON.stringify(input)}:{})});
  const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data?.csrf};
 }
 return {app,call,cleanup:async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}};
}

test('Full stack: generate_image is a write-shaped action — the Control Center action runner requires approval by default, never runs it silently',async()=>{
 const fetcher=async(url)=>{
  if(url==='https://api.openai.com/v1/images/generations')
   return new Response(JSON.stringify({data:[{b64_json:FAKE_PNG_B64}]}),{status:200,headers:{'content-type':'application/json'}});
  if(url==='https://api.openai.com/v1/models') // the PUT .../credential route tests the key first, via testOpenAIConnection
   return new Response(JSON.stringify({data:[]}),{status:200,headers:{'content-type':'application/json'}});
  throw new Error('unexpected network call to '+url);
 };
 const {call,cleanup}=await harness({INTEGRATION_ENCRYPTION_KEY:key32},fetcher);
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'a-long-test-password'});
  const connection=await call('/api/integrations/connections',{integrationDefinitionId:'openai',name:'My OpenAI'},owner);
  assert.equal(connection.status,201);
  const credentialed=await call(`/api/integrations/connections/${connection.data.id}/credential`,{apiKey:'sk-real-test-key'},owner,{method:'PUT'});
  assert.equal(credentialed.status,200);
  const run=await call(`/api/integrations/connections/${connection.data.id}/actions/generate_image`,{input:{prompt:'a friendly robot mascot'}},owner);
  assert.equal(run.status,200);
  assert.equal(run.data.status,'WAITING_APPROVAL');
  assert.ok(run.data.approvalId);
 }finally{await cleanup();}
});
