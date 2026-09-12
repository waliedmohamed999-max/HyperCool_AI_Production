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
 capabilities:['commerce.products.read'],
 actions:[{
  id:'salla.sync_products',slug:'sync_products',
  nameAr:'مزامنة المنتجات',nameEn:'Sync Products',
  description:'Fetches every product page from GET /admin/v2/products and returns the full, normalized catalog (wraps the existing, tested importSalla()).',
  method:'GET',requiredCapability:'commerce.products.read',
  riskLevel:RISK_LEVEL.LOW,actionType:ACTION_TYPE.READ,
  inputSchema:{type:'object',properties:{},additionalProperties:false},
  outputSchema:{type:'object',properties:{count:{type:'number'},products:{type:'array'}}},
  timeoutMs:45000
 }],
 triggers:[],
 webhooks:{path:'/api/webhooks/salla',authType:'HMAC_OR_SHARED_SECRET',externalEventIdPath:'order.id'},
 health:{method:'GET',path:'/admin/v2/products?page=1&per_page=1',expectedStatus:200},
 identity:{externalAccountIdField:'merchant'}
});
