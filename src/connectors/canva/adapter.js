// Canva's ConnectorAdapter — wraps the real OAuth token + identity call in
// src/runtime/canva-oauth.js. No executeAction: the manifest declares zero actions (see its
// own comment on why), so this is never called for one; the adapter contract still requires
// the method to exist only when the manifest declares actions (validateAdapter), which it
// doesn't here — executeAction is intentionally omitted, not stubbed.
import {ConnectorError} from '../../connectors.js';
import {resolveConnectedProfile} from '../../runtime/canva-oauth.js';
import {CONNECTOR_ERROR_CODE} from '../core/enums.js';

function mapError(code) {
 return {
  CREDENTIALS_REJECTED:CONNECTOR_ERROR_CODE.AUTH_FAILED,
  RATE_LIMITED:CONNECTOR_ERROR_CODE.RATE_LIMITED,
  NETWORK_OR_TIMEOUT:CONNECTOR_ERROR_CODE.NETWORK_ERROR,
  INVALID_PROVIDER_RESPONSE:CONNECTOR_ERROR_CODE.REMOTE_VALIDATION_ERROR,
  CANVA_OAUTH_NOT_CONFIGURED:CONNECTOR_ERROR_CODE.CAPABILITY_MISSING
 }[code]||CONNECTOR_ERROR_CODE.REMOTE_SERVER_ERROR;
}
export const canvaAdapter={
 async healthCheck({fetcher,credential}) {
  const accessToken=credential?.payload?.accessToken||null;
  if(!accessToken)return {status:'NOT_CONFIGURED'};
  try {
   await resolveConnectedProfile({fetcher,accessToken});
   return {status:'OK'};
  } catch(error) {
   const code=error instanceof ConnectorError?error.code:'NETWORK_OR_TIMEOUT';
   return {status:error instanceof ConnectorError&&error.code==='CREDENTIALS_REJECTED'?'AUTH_FAILED':'ERROR',errorCode:mapError(code)};
  }
 }
};
