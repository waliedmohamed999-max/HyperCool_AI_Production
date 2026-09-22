// Universal Integration Platform (Phase 6A, Part 18) — OpenAIConnectorAdapter. Wraps the
// existing testOpenAIConnection() (src/connectors.js), mirroring anthropic/adapter.js exactly.
import {testOpenAIConnection} from '../../connectors.js';
import {CONNECTOR_ERROR_CODE} from '../core/enums.js';

function mapError(code) {
 return {
  CREDENTIALS_REJECTED:CONNECTOR_ERROR_CODE.AUTH_FAILED,
  RATE_LIMITED:CONNECTOR_ERROR_CODE.RATE_LIMITED,
  NETWORK_OR_TIMEOUT:CONNECTOR_ERROR_CODE.NETWORK_ERROR,
  OPENAI_NOT_CONFIGURED:CONNECTOR_ERROR_CODE.CAPABILITY_MISSING,
  INVALID_PROVIDER_RESPONSE:CONNECTOR_ERROR_CODE.REMOTE_VALIDATION_ERROR
 }[code]||CONNECTOR_ERROR_CODE.REMOTE_SERVER_ERROR;
}

// POST /v1/images/generations — OpenAI's real, published image-generation endpoint. This exact
// call has never been made from this codebase (no live account to verify against here); the
// request/response shape below is this model's best recollection of OpenAI's own docs, not a
// confirmed live test. Verify against your own account before relying on it in production —
// see docs/AI_IMAGE_GENERATION.md.
async function generateImage({env,fetcher,apiKey,prompt,size}) {
 const model=env.OPENAI_IMAGE_MODEL||'gpt-image-1';
 let response;
 try {
  response=await fetcher('https://api.openai.com/v1/images/generations',{
   method:'POST',
   headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json'},
   body:JSON.stringify({model,prompt,size:size||'1024x1024',n:1}),
   signal:AbortSignal.timeout(55000)
  });
 } catch { throw {code:'NETWORK_OR_TIMEOUT'}; }
 if(!response.ok) {
  throw {code:response.status===401||response.status===403?'CREDENTIALS_REJECTED':response.status===429?'RATE_LIMITED':'PROVIDER_ERROR'};
 }
 let data;
 try {
  // Images are large; the shared requestJson() helper's 2MB default (src/connectors.js) is too
  // tight for a base64-encoded image response, so this reads the body directly with a higher cap.
  const chunks=[];let size2=0;
  for await(const chunk of response.body){size2+=chunk.length;if(size2>15000000)throw new Error('too large');chunks.push(Buffer.from(chunk));}
  data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 } catch { throw {code:'INVALID_PROVIDER_RESPONSE'}; }
 const first=data?.data?.[0];
 const b64=first?.b64_json;
 const url=first?.url;
 if(!b64 && !url)throw {code:'INVALID_PROVIDER_RESPONSE'};
 return {imageDataUri:b64?`data:image/png;base64,${b64}`:url,model};
}

export const openaiAdapter={
 async healthCheck({env,fetcher,credential}) {
  const testEnv=credential?.payload?.apiKey?{...env,OPENAI_API_KEY:credential.payload.apiKey}:env;
  const result=await testOpenAIConnection({env:testEnv,fetcher});
  if(result.result==='OK')return {status:'OK'};
  return {status:result.result,errorCode:mapError(result.code)};
 },
 async executeAction({action,input,env,fetcher,credential}) {
  const apiKey=credential?.payload?.apiKey||env.OPENAI_API_KEY;
  if(action.slug==='generate_image') {
   if(!apiKey)return {status:'ERROR',errorCode:CONNECTOR_ERROR_CODE.CAPABILITY_MISSING};
   try {
    const output=await generateImage({env,fetcher,apiKey,prompt:input?.prompt,size:input?.size});
    return {status:'OK',output};
   } catch(error) { return {status:'ERROR',errorCode:mapError(error.code)}; }
  }
  if(action.slug!=='test_key')return {status:'ERROR',errorCode:CONNECTOR_ERROR_CODE.CAPABILITY_MISSING};
  const testEnv=credential?.payload?.apiKey?{...env,OPENAI_API_KEY:credential.payload.apiKey}:env;
  const result=await testOpenAIConnection({env:testEnv,fetcher});
  if(result.result==='OK')return {status:'OK',output:{ok:true}};
  return {status:'ERROR',errorCode:mapError(result.code)};
 }
};
