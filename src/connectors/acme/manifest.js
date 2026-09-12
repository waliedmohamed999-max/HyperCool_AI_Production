// Universal Integration Platform (Phase 6B, Part 54) — "Acme Commerce": a TEST-ONLY connector
// definition proving the Generic REST Connector architecture, never a real production
// marketplace provider (no real company/API is impersonated — `acme.test` uses the IANA/
// RFC 2606-reserved `.test` TLD, exactly the convention meant for this). It is exercised only
// against a controlled, injected mock transport (tests/generic-rest-connector.test.js) — never
// real DNS or a real socket.
import {CONNECTOR_CATEGORY,CONNECTOR_AVAILABILITY,CONNECTION_MODE,AUTH_TYPE,ACTION_TYPE,RISK_LEVEL} from '../core/enums.js';
import {validateRestManifest} from '../generic-rest/manifest.js';

export const acmeManifest=validateRestManifest({
 id:'acme',slug:'acme',
 nameAr:'أكمي كوميرس (اختبار)',nameEn:'Acme Commerce (test)',
 descriptionAr:'موصل REST عام تجريبي بحت لإثبات بنية Phase 6B — ليس مزوّدًا حقيقيًا.',
 descriptionEn:'A purely test-only Generic REST connector proving the Phase 6B architecture — not a real provider.',
 category:CONNECTOR_CATEGORY.COMMERCE,
 version:1,
 availability:CONNECTOR_AVAILABILITY.DEFINITION_ONLY,
 connectionMode:CONNECTION_MODE.SINGLE,
 auth:{type:AUTH_TYPE.API_KEY,headerName:'X-Acme-Api-Key'},
 capabilities:['commerce.products.read','commerce.orders.read','commerce.orders.write'],
 rest:{baseUrl:'https://acme.test',health:{method:'GET',path:'/health',expectedStatus:200}},
 actions:[
  {
   id:'acme.get_products',slug:'get_products',nameAr:'المنتجات',nameEn:'Get Products',
   description:'GET /products — a real, bounded read action.',
   requiredCapability:'commerce.products.read',
   inputSchema:{type:'object',properties:{},additionalProperties:false},
   outputSchema:{type:'object'},
   rest:{httpMethod:'GET',pathTemplate:'/products',responseMapping:{array:{from:'products',item:{id:'id',name:'name',price:'price'}}}}
  },
  {
   id:'acme.get_orders',slug:'get_orders',nameAr:'الطلبات',nameEn:'Get Orders',
   description:'GET /orders — a real, bounded read action.',
   requiredCapability:'commerce.orders.read',
   inputSchema:{type:'object',properties:{},additionalProperties:false},
   outputSchema:{type:'object'},
   rest:{httpMethod:'GET',pathTemplate:'/orders',responseMapping:{array:{from:'orders',item:{id:'id',total:'total'}}}}
  },
  {
   id:'acme.create_order',slug:'create_order',nameAr:'إنشاء طلب',nameEn:'Create Order',
   description:'POST /orders — a real write action, used only to prove approval/write safety (Part 55).',
   requiredCapability:'commerce.orders.write',
   inputSchema:{type:'object',properties:{productId:{type:'string'},quantity:{type:'number'}},required:['productId','quantity']},
   outputSchema:{type:'object'},
   rest:{httpMethod:'POST',pathTemplate:'/orders',bodyMapping:{productId:'$input.productId',quantity:'$input.quantity'},responseMapping:{path:'order'}}
  }
 ]
});
