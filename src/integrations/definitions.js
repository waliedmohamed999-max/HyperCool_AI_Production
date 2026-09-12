// IntegrationDefinition — Multi-Tenant Phase 4A, Part 2/3. GLOBAL (not per-tenant): these
// describe WHAT an integration is and how it authenticates, never a tenant's own connection
// to it (that is `integration_connections`, see connections.js). auth_type is extracted from
// each provider's REAL, already-implemented flow (src/runtime/*-oauth.js, whatsapp.js,
// llmProvider.js) — never assumed. Only providers with a real, working implementation
// somewhere in this codebase are listed; nothing here is a placeholder for a feature that
// doesn't exist (Canva has no real implementation anywhere — see its own row below).
export function installIntegrationDefinitions(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS integration_definitions (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  category TEXT NOT NULL,
  description_ar TEXT NOT NULL,
  description_en TEXT NOT NULL,
  auth_type TEXT NOT NULL CHECK(auth_type IN ('OAUTH2','API_KEY','ACCESS_TOKEN','CUSTOM','NONE')),
  icon_key TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  is_available INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
 );`);
 // Universal Integration Platform (Phase 6D, Part 2/3) — this table remains the ONE canonical
 // definition model (no parallel `connector_definitions` table): every additive column below
 // makes an existing built-in row (Salla, Anthropic, ...) and a Platform-Admin-authored dynamic
 // definition (via the Builder) structurally identical. `auth_type`'s CHECK constraint is
 // NOT widened (a live SQLite table rebuild is real, avoidable risk) — BEARER_TOKEN/BASIC
 // connectors instead store their real type in the new `auth_config` JSON column, with
 // `auth_type='CUSTOM'` here only for legacy display/filtering compatibility.
 const columns=db.prepare('PRAGMA table_info(integration_definitions)').all().map(c=>c.name);
 const additions=[
  ['status',"TEXT NOT NULL DEFAULT 'PUBLISHED'"],  // DRAFT | PUBLISHED | DISABLED (Part 4)
  ['version',"INTEGER NOT NULL DEFAULT 1"],
  ['adapter_type',"TEXT NOT NULL DEFAULT 'BUILT_IN'"], // BUILT_IN | GENERIC_REST | AI_PROVIDER (Part 5)
  ['adapter_key',"TEXT"], // whitelist key for BUILT_IN resolution (Part 6/112) — never a module path
  ['connection_mode_override',"TEXT"], // persisted MULTI/SINGLE for a dynamic definition; NULL -> legacy CONNECTION_MODE map for built-ins
  ['is_system',"INTEGER NOT NULL DEFAULT 0"], // Part 47 — never hard-deletable
  ['created_by_user_id',"TEXT"],
  ['published_at',"TEXT"],
  ['rest_config',"TEXT"], // JSON: {baseUrl, allowHttp, allowedHosts, tenantConfigurableHost, health}
  ['auth_config',"TEXT"] // JSON: real auth type + non-secret config (headerName, credentialSchema, ...) — Part 12/13
 ];
 for(const [name,def] of additions)
  if(!columns.includes(name))db.exec(`ALTER TABLE integration_definitions ADD COLUMN ${name} ${def}`);
 seedIntegrationDefinitions(db);
}
// Real, verified per this codebase's own implementation as of Phase 4A:
// - Anthropic/OpenAI (src/runtime/llmProvider.js): env-var API keys, resolved fresh per call
//   — no OAuth, no persisted "connection" object today. auth_type: API_KEY.
// - Salla (src/runtime/salla-oauth.js): real OAuth2 authorization-code flow. No PKCE.
// - Microsoft 365 (src/runtime/microsoft-oauth.js): real OAuth2 authorization-code flow.
// - X (src/runtime/x-oauth.js): real OAuth2 — PKCE is MANDATORY (X rejects a code exchange
//   without a code_verifier), unlike every other OAuth2 provider here.
// - LinkedIn (src/runtime/linkedin-oauth.js): real OAuth2 authorization-code flow.
// - Meta/WhatsApp (src/runtime/meta-oauth.js): real OAuth2 (Facebook Login for Business) —
//   ONE connection resolves Page + Instagram + WhatsApp assets together (Meta's own asset
//   model), which is why Meta and WhatsApp share one definition+flow rather than two.
// - Canva: grepped the entire codebase — no real API call, OAuth flow, or connector exists
//   anywhere for Canva; only an env var name (CANVA_API_KEY) is referenced as a placeholder
//   in integration status displays. Listed as is_available=0 (NOT_IMPLEMENTED) rather than
//   faking a connect flow for it, per this phase's explicit "no fake connected states" rule.
const DEFINITIONS=[
 {slug:'anthropic',nameAr:'Anthropic (Claude)',nameEn:'Anthropic (Claude)',category:'ai',descAr:'مزوّد الذكاء الاصطناعي الأساسي للوكلاء (Claude).',descEn:'Primary AI provider for agents (Claude).',authType:'API_KEY',iconKey:'anthropic',capabilities:['llm.generate','llm.tools','llm.structured'],isAvailable:1,adapterType:'AI_PROVIDER'},
 {slug:'openai',nameAr:'OpenAI',nameEn:'OpenAI',category:'ai',descAr:'مزوّد ذكاء اصطناعي احتياطي أو بديل للوكلاء.',descEn:'Backup or alternate AI provider for agents.',authType:'API_KEY',iconKey:'openai',capabilities:['llm.generate','llm.tools','llm.structured'],isAvailable:1,adapterType:'AI_PROVIDER'},
 {slug:'salla',nameAr:'سلة',nameEn:'Salla',category:'ecommerce',descAr:'منصة المتجر الإلكتروني — كتالوج المنتجات والطلبات.',descEn:'E-commerce storefront platform — product catalog and orders.',authType:'OAUTH2',iconKey:'salla',capabilities:['products.read','stock.read','orders.read'],isAvailable:1,adapterType:'BUILT_IN'},
 {slug:'whatsapp',nameAr:'واتساب للأعمال',nameEn:'WhatsApp Business',category:'messaging',descAr:'إرسال واستقبال رسائل واتساب مع العملاء.',descEn:'Send and receive WhatsApp messages with customers.',authType:'OAUTH2',iconKey:'whatsapp',capabilities:['messages.receive','messages.send','templates.read'],isAvailable:1,adapterType:'BUILT_IN'},
 {slug:'meta',nameAr:'ميتا (فيسبوك/إنستغرام)',nameEn:'Meta (Facebook/Instagram)',category:'social',descAr:'نشر ومتابعة صفحات فيسبوك وإنستغرام.',descEn:'Publish to and manage Facebook Pages and Instagram.',authType:'OAUTH2',iconKey:'meta',capabilities:['publishing','messaging','analytics'],isAvailable:1,adapterType:'BUILT_IN'},
 {slug:'microsoft365',nameAr:'مايكروسوفت 365',nameEn:'Microsoft 365',category:'productivity',descAr:'البريد الإلكتروني والتقويم عبر Microsoft Graph.',descEn:'Email and calendar via Microsoft Graph.',authType:'OAUTH2',iconKey:'microsoft365',capabilities:['mail.read','mail.send','calendar.read','calendar.write'],isAvailable:1,adapterType:'BUILT_IN'},
 {slug:'x',nameAr:'إكس (تويتر)',nameEn:'X (Twitter)',category:'social',descAr:'نشر ومتابعة أداء المنشورات على إكس.',descEn:'Publish to and track post performance on X.',authType:'OAUTH2',iconKey:'x',capabilities:['publish','analytics'],isAvailable:1,adapterType:'BUILT_IN'},
 {slug:'linkedin',nameAr:'لينكدإن',nameEn:'LinkedIn',category:'social',descAr:'نشر على صفحة الشركة في لينكدإن.',descEn:'Publish to a LinkedIn Company Page.',authType:'OAUTH2',iconKey:'linkedin',capabilities:['organization.publish','analytics'],isAvailable:1,adapterType:'BUILT_IN'},
 {slug:'canva',nameAr:'كانفا',nameEn:'Canva',category:'design',descAr:'تصميم الأصول البصرية — غير مُفعّل تقنيًا بعد.',descEn:'Visual asset design — not technically implemented yet.',authType:'NONE',iconKey:'canva',capabilities:[],isAvailable:0,adapterType:'BUILT_IN'}
];
// Multi-Tenant Phase 4B (Part 13/14/96) — connection_mode is a HONEST, code-derived fact
// about the OAuth flow that actually exists today, never a promise. `integration_connections`
// structurally allows many rows per (tenant, provider) for every provider — but the credential
// layer underneath (`integration_credentials`, PRIMARY KEY(tenant_id, provider) — see
// credentials.js) can only ever hold ONE row per tenant for whatsapp/meta/microsoft365/x/
// linkedin, and every one of those providers' "Connect" flows (saveCredentials' upsert)
// OVERWRITES that single row rather than adding a second. Salla is the one non-AI provider
// proven end-to-end with real multiple simultaneous connections (see
// docs/AGENT_TOOL_MAPPING.md's Salla multi-store test); Anthropic/OpenAI likewise (AI
// multi-connection test, same doc). Canva has no real implementation at all (see above).
const CONNECTION_MODE={anthropic:'MULTI',openai:'MULTI',salla:'MULTI',whatsapp:'SINGLE',meta:'SINGLE',microsoft365:'SINGLE',x:'SINGLE',linkedin:'SINGLE',canva:'UNAVAILABLE'};
export function connectionModeFor(slug) { return CONNECTION_MODE[slug]||'SINGLE'; }
function seedIntegrationDefinitions(db) {
 const now=new Date().toISOString();
 // Every built-in row is re-asserted as is_system=1/PUBLISHED/version=1 on every boot — a
 // Platform-Admin-authored dynamic definition (a different slug entirely) is never touched by
 // this INSERT/ON CONFLICT, since ON CONFLICT(slug) only ever fires for these 9 known slugs.
 const insert=db.prepare(`INSERT INTO integration_definitions (id,slug,name_ar,name_en,category,description_ar,description_en,auth_type,icon_key,capabilities,is_available,status,version,adapter_type,adapter_key,is_system,created_at,updated_at)
  VALUES (@slug,@slug,@nameAr,@nameEn,@category,@descAr,@descEn,@authType,@iconKey,@capabilities,@isAvailable,'PUBLISHED',1,@adapterType,@slug,1,@now,@now)
  ON CONFLICT(slug) DO UPDATE SET name_ar=excluded.name_ar,name_en=excluded.name_en,category=excluded.category,description_ar=excluded.description_ar,description_en=excluded.description_en,auth_type=excluded.auth_type,icon_key=excluded.icon_key,capabilities=excluded.capabilities,is_available=excluded.is_available,adapter_type=excluded.adapter_type,adapter_key=excluded.adapter_key,is_system=1,updated_at=excluded.updated_at`);
 for(const def of DEFINITIONS)insert.run({...def,capabilities:JSON.stringify(def.capabilities),now});
}
function hydrate(row) {
 return {id:row.id,slug:row.slug,nameAr:row.name_ar,nameEn:row.name_en,category:row.category,descriptionAr:row.description_ar,descriptionEn:row.description_en,authType:row.auth_type,iconKey:row.icon_key,capabilities:JSON.parse(row.capabilities),isAvailable:!!row.is_available,connectionMode:row.connection_mode_override||connectionModeFor(row.slug),createdAt:row.created_at,updatedAt:row.updated_at,
  status:row.status||'PUBLISHED',version:row.version||1,adapterType:row.adapter_type||'BUILT_IN',adapterKey:row.adapter_key||row.slug,
  isSystem:!!row.is_system,createdByUserId:row.created_by_user_id||null,publishedAt:row.published_at||null,
  restConfig:row.rest_config?JSON.parse(row.rest_config):null,authConfig:row.auth_config?JSON.parse(row.auth_config):null};
}
export function listIntegrationDefinitions(db) {
 return db.prepare('SELECT * FROM integration_definitions ORDER BY category,slug').all().map(hydrate);
}
export function getIntegrationDefinition(db,slug) {
 const row=db.prepare('SELECT * FROM integration_definitions WHERE slug=?').get(slug);
 return row?hydrate(row):null;
}
