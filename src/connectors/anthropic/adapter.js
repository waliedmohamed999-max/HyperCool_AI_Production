// Universal Integration Platform (Phase 6A, Part 18) — AnthropicConnectorAdapter. Wraps the
// EXISTING testAnthropicConnection() (src/connectors.js) — the same fixed-this-phase real
// GET /v1/models key check, never a second implementation.
import {testAnthropicConnection} from '../../connectors.js';
import {CONNECTOR_ERROR_CODE} from '../core/enums.js';

function mapError(code) {
 return {
  CREDENTIALS_REJECTED:CONNECTOR_ERROR_CODE.AUTH_FAILED,
  RATE_LIMITED:CONNECTOR_ERROR_CODE.RATE_LIMITED,
  NETWORK_OR_TIMEOUT:CONNECTOR_ERROR_CODE.NETWORK_ERROR,
  ANTHROPIC_NOT_CONFIGURED:CONNECTOR_ERROR_CODE.CAPABILITY_MISSING
 }[code]||CONNECTOR_ERROR_CODE.REMOTE_SERVER_ERROR;
}

export const anthropicAdapter={
 async healthCheck({env,fetcher,credential}) {
  const testEnv=credential?.payload?.apiKey?{...env,ANTHROPIC_API_KEY:credential.payload.apiKey}:env;
  const result=await testAnthropicConnection({env:testEnv,fetcher});
  if(result.result==='OK')return {status:'OK'};
  return {status:result.result,errorCode:mapError(result.code)};
 },
 async executeAction({action,env,fetcher,credential}) {
  if(action.slug!=='test_key')return {status:'ERROR',errorCode:CONNECTOR_ERROR_CODE.CAPABILITY_MISSING};
  const testEnv=credential?.payload?.apiKey?{...env,ANTHROPIC_API_KEY:credential.payload.apiKey}:env;
  const result=await testAnthropicConnection({env:testEnv,fetcher});
  if(result.result==='OK')return {status:'OK',output:{ok:true}};
  return {status:'ERROR',errorCode:mapError(result.code)};
 }
};
