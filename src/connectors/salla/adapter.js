// Universal Integration Platform (Phase 6A, Part 18) — SallaConnectorAdapter. A thin wrapper
// around the EXISTING, already-tested Salla code (src/connectors.js's testSallaConnection/
// importSalla) — it reimplements nothing. Behavior is byte-for-byte preserved; only the
// calling shape changes to match the generic Connector Adapter contract (src/connectors/core/adapter.js).
import {testSallaConnection,importSalla,ConnectorError} from '../../connectors.js';
import {CONNECTOR_ERROR_CODE} from '../core/enums.js';
import {listWebhookEvents} from '../../runtime/webhook-events.js';

const ORDER_EVENT_TYPES=new Set(['order.created','order.status.updated','order.completed']);
// Real data straight from the already-working, verified webhook ledger (src/runtime/salla-webhooks.js)
// — see the manifest's own comment on this action for why this reads stored deliveries rather than
// polling an unconfirmed REST endpoint.
function recentOrdersFromWebhookLedger(db,tenantId,limit) {
 const events=listWebhookEvents(db,{source:'salla',limit:Math.max(limit*4,100)},tenantId)
  .filter(row=>ORDER_EVENT_TYPES.has(row.type))
  .slice(0,limit);
 return events.map(row=>{
  const payload=JSON.parse(row.payload);
  return {
   webhookEventId:row.id,sallaEvent:row.type,receivedAt:row.received_at,
   orderId:payload?.data?.id??null,status:payload?.data?.status?.name??payload?.data?.status??null,
   total:payload?.data?.amounts?.total?.amount??payload?.data?.total?.amount??null,
   currency:payload?.data?.amounts?.total?.currency??payload?.data?.currency??null,
   customer:payload?.data?.customer?.first_name?[payload.data.customer.first_name,payload.data.customer.last_name].filter(Boolean).join(' '):null
  };
 });
}

function mapError(code) {
 return {
  CREDENTIALS_REJECTED:CONNECTOR_ERROR_CODE.AUTH_FAILED,
  RATE_LIMITED:CONNECTOR_ERROR_CODE.RATE_LIMITED,
  NETWORK_OR_TIMEOUT:CONNECTOR_ERROR_CODE.NETWORK_ERROR,
  INVALID_SALLA_RESPONSE:CONNECTOR_ERROR_CODE.REMOTE_VALIDATION_ERROR,
  SALLA_NOT_CONFIGURED:CONNECTOR_ERROR_CODE.CAPABILITY_MISSING
 }[code]||CONNECTOR_ERROR_CODE.REMOTE_SERVER_ERROR;
}

// A connection is tested/used with ITS OWN credential only: the server's static SALLA_ACCESS_TOKEN belongs to the operator's
// workspace and must never stand in for another tenant's missing or revoked credential.
const ownCredentialOnly=env=>({...env,SALLA_ACCESS_TOKEN:undefined});
export const sallaAdapter={
 async healthCheck({env,fetcher,credential}) {
  const accessToken=credential?.payload?.accessToken||null;
  const result=await testSallaConnection({env:ownCredentialOnly(env),fetcher,accessToken});
  if(result.result==='OK')return {status:'OK'};
  return {status:result.result,errorCode:mapError(result.code)};
 },
 async executeAction({action,input,env,fetcher,credential,db,connection}) {
  const accessToken=credential?.payload?.accessToken||null;
  if(action.slug==='list_recent_orders') {
   const orders=recentOrdersFromWebhookLedger(db,connection.tenantId,Math.min(Math.max(input?.limit||25,1),100));
   return {status:'OK',output:{count:orders.length,orders,source:'webhook_ledger'}};
  }
  if(action.slug!=='sync_products')return {status:'ERROR',errorCode:CONNECTOR_ERROR_CODE.CAPABILITY_MISSING};
  try {
   const products=await importSalla({env:ownCredentialOnly(env),fetcher,accessToken});
   return {status:'OK',output:{count:products.length,products}};
  } catch(error) {
   const code=error instanceof ConnectorError?error.code:'NETWORK_OR_TIMEOUT';
   return {status:'ERROR',errorCode:mapError(code)};
  }
 }
};
