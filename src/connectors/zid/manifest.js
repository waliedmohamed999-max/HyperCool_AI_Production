// Universal Integration Platform (Phase 6E) — Zid's ConnectorManifest. Every field below is
// backed by the official Zid Developers documentation (docs.zid.sa), reviewed 2026-09-12 — see
// docs/ZID_CONNECTOR.md for the full documentation audit, including sources and the
// Products/Inventory read scope this V1 deliberately does NOT implement (a genuine, unresolved
// conflict in Zid's own public docs about which headers that endpoint family requires — Part 1
// audit item K/N, Part 49/50: never guess through a security-sensitive contract conflict).
import {CONNECTOR_CATEGORY,CONNECTOR_AVAILABILITY,CONNECTION_MODE,AUTH_TYPE,ACTION_TYPE,RISK_LEVEL} from '../core/enums.js';
import {validateManifest} from '../core/manifest.js';

export const zidManifest=validateManifest({
 id:'zid',slug:'zid',
 nameAr:'زد',nameEn:'Zid',
 descriptionAr:'منصة تجارة إلكترونية سعودية — قراءة الطلبات والعملاء (V1: قراءة فقط).',
 descriptionEn:'Saudi e-commerce platform — orders and customers read (V1: read-only).',
 category:CONNECTOR_CATEGORY.COMMERCE,
 version:1,
 availability:CONNECTOR_AVAILABILITY.AVAILABLE,
 // MULTI: each OAuth authorization produces a distinct, per-store access/refresh token pair
 // (docs.zid.sa/authorization — the Manager Token is scoped to whichever store the merchant
 // authorized), the exact same real per-connection-credential model already proven safe for
 // Salla's own MULTI-store connections (Part 7).
 connectionMode:CONNECTION_MODE.MULTI,
 auth:{
  type:AUTH_TYPE.OAUTH2,
  authorizeUrl:'https://oauth.zid.sa/oauth/authorize',
  tokenUrl:'https://oauth.zid.sa/oauth/token',
  pkce:false, // not documented anywhere in the official docs — never invented (Part 5)
  scopes:[] // Zid's docs: "select the needed scopes... via your application page in the
            // Partner Dashboard" — scopes are configured platform-side per app registration,
            // never a fixed list this manifest can honestly declare (Part 57: request the
            // minimum needed for what's actually implemented below).
 },
 capabilities:['commerce.orders.read','commerce.customers.read'],
 actions:[
  {
   id:'zid.get_orders',slug:'get_orders',
   nameAr:'جلب الطلبات',nameEn:'Get Orders',
   description:'Lists orders for the connected store (GET /v1/managers/store/orders, official Zid Merchant API).',
   method:'GET',requiredCapability:'commerce.orders.read',
   riskLevel:RISK_LEVEL.LOW,actionType:ACTION_TYPE.READ,
   inputSchema:{type:'object',properties:{page:{type:'number'},perPage:{type:'number'}},additionalProperties:false},
   outputSchema:{type:'object',properties:{orders:{type:'array'},totalOrderCount:{type:'number'}}},
   timeoutMs:20000
  },
  {
   id:'zid.get_customers',slug:'get_customers',
   nameAr:'جلب العملاء',nameEn:'Get Customers',
   description:'Lists customers for the connected store (GET /v1/managers/store/customers, official Zid Merchant API).',
   method:'GET',requiredCapability:'commerce.customers.read',
   riskLevel:RISK_LEVEL.LOW,actionType:ACTION_TYPE.READ,
   inputSchema:{type:'object',properties:{page:{type:'number'},perPage:{type:'number'}},additionalProperties:false},
   outputSchema:{type:'object',properties:{customers:{type:'array'},totalCustomersCount:{type:'number'}}},
   timeoutMs:20000
  }
 ],
 triggers:[], // Phase 6E V1 deliberately ships no webhook trigger — see docs/ZID_CONNECTOR.md:
              // Zid's official "Create a Webhook" endpoint documents no signing-secret/HMAC
              // mechanism at all (only an optional HTTP Basic auth pair on the target URL
              // itself), so there is no real signature this platform could verify without
              // inventing one (explicitly forbidden, Part 28/60).
 webhooks:null,
 // Read-only, safe (GET /v1/managers/account/profile — "Retrieve Manager's Profile", the
 // documented, non-destructive identity endpoint) — proves credential validity, API
 // reachability, AND store identity in one real call (Part 20/21).
 health:{method:'GET',path:'/managers/account/profile',expectedStatus:200},
 identity:{externalAccountIdField:'store.id'}
});
