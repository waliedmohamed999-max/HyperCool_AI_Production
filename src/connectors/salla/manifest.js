// Universal Integration Platform (Phase 6A, Part 18/83) — Salla's ConnectorManifest. This
// describes EXACTLY the real, already-live Salla integration audited in Phase 6's Part 1 audit
// (docs/CAPABILITY_REGISTRY.md) — no new endpoint, scope, or capability invented.
import {CONNECTOR_CATEGORY,CONNECTOR_AVAILABILITY,CONNECTION_MODE,AUTH_TYPE,ACTION_TYPE,RISK_LEVEL} from '../core/enums.js';
import {validateManifest} from '../core/manifest.js';

export const sallaManifest=validateManifest({
 id:'salla',slug:'salla',
 nameAr:'سلة',nameEn:'Salla',
 descriptionAr:'منصة تجارة إلكترونية سعودية — قراءة المنتجات والمزامنة.',
 descriptionEn:'Saudi e-commerce platform — product catalog read and sync.',
 category:CONNECTOR_CATEGORY.COMMERCE,
 version:1,
 availability:CONNECTOR_AVAILABILITY.AVAILABLE,
 connectionMode:CONNECTION_MODE.MULTI,
 auth:{
  type:AUTH_TYPE.OAUTH2,
  authorizeUrl:'https://accounts.salla.sa/oauth2/auth',
  tokenUrl:'https://accounts.salla.sa/oauth2/token',
  pkce:false,
  scopes:['offline_access','products.read','orders.read','customers.read']
 },
 capabilities:['commerce.products.read','commerce.orders.read'],
 actions:[{
  id:'salla.sync_products',slug:'sync_products',
  nameAr:'مزامنة المنتجات',nameEn:'Sync Products',
  description:'Fetches every product page from GET /admin/v2/products and returns the full, normalized catalog (wraps the existing, tested importSalla()).',
  method:'GET',requiredCapability:'commerce.products.read',
  riskLevel:RISK_LEVEL.LOW,actionType:ACTION_TYPE.READ,
  inputSchema:{type:'object',properties:{},additionalProperties:false},
  outputSchema:{type:'object',properties:{count:{type:'number'},products:{type:'array'}}},
  timeoutMs:45000
 },{
  id:'salla.list_recent_orders',slug:'list_recent_orders',
  nameAr:'أحدث الطلبات',nameEn:'Recent Orders',
  // Salla's REST order-list endpoint has never been called/verified from this codebase (see
  // docs/SALLA_INTEGRATION_SETUP.md), so this action deliberately does NOT guess at one. It
  // reads the real, already-working webhook ledger instead (order.created/order.status.updated/
  // order.completed deliveries this tenant's Salla app has already pushed to /api/webhooks/salla
  // — src/runtime/salla-webhooks.js) — genuinely real data, honestly scoped to "what has arrived
  // so far", never a live poll of an unconfirmed endpoint.
  description:'Lists recent order events (created/updated/completed) this store has pushed via the Salla webhook — not a live poll, since Salla\'s REST order-list endpoint has no verified implementation here yet.',
  method:'LOCAL',requiredCapability:'commerce.orders.read',
  riskLevel:RISK_LEVEL.LOW,actionType:ACTION_TYPE.READ,
  inputSchema:{type:'object',properties:{limit:{type:'number'}},additionalProperties:false},
  outputSchema:{type:'object',properties:{count:{type:'number'},orders:{type:'array'},source:{type:'string'}}},
  timeoutMs:5000
 }],
 triggers:[],
 webhooks:{path:'/api/webhooks/salla',authType:'HMAC_OR_SHARED_SECRET',externalEventIdPath:'order.id'},
 health:{method:'GET',path:'/admin/v2/products?page=1&per_page=1',expectedStatus:200},
 identity:{externalAccountIdField:'merchant'}
});
