import {randomUUID} from 'node:crypto';

// Multi-Tenant Control Center — Phase 1 foundation only (deliberately scoped; see
// docs/MULTI_TENANT_ARCHITECTURE.md for what is and is not built yet). This app was, until
// this module existed, genuinely single-tenant: one SQLite file, no company/organization
// concept anywhere, `integration_credentials` keyed by `provider` alone system-wide. This
// module adds the real Tenant + TenantMembership tables and a lossless backfill of the
// current single real company's data into exactly one Tenant row — it does not yet let a
// second tenant be created from the UI (no Control Center exists), but every function here
// is written so that a future one can be added without another data migration.
export function installTenancy(db) {
 db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
   id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
   status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SUSPENDED','TRIAL','ARCHIVED')),
   plan TEXT, default_locale TEXT NOT NULL DEFAULT 'ar', timezone TEXT NOT NULL DEFAULT 'Asia/Riyadh',
   branding_settings TEXT, system_mode TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tenant_memberships (
   id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id),
   role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', is_owner INTEGER NOT NULL DEFAULT 0,
   created_at TEXT NOT NULL, UNIQUE(tenant_id,user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_tenant_memberships_user ON tenant_memberships(user_id);
  CREATE INDEX IF NOT EXISTS idx_tenant_memberships_tenant ON tenant_memberships(tenant_id);
 `);
}
/**
 * Idempotent, lossless backfill (spec Part 99-101). The very first call on a real database
 * creates exactly one Tenant ("HyperCool") and attaches every EXISTING user to it as a
 * member with their current global role carried over verbatim — no data invented, nothing
 * dropped. Every later call is a cheap indexed lookup that returns the same id. Safe to call
 * from any module that needs "the tenant" and doesn't want to force every caller to thread
 * one through explicitly yet (see credentials.js/crm.js's optional `tenantId` parameters).
 */
export function ensureDefaultTenant(db) {
 installTenancy(db);
 const existing=db.prepare('SELECT id FROM tenants ORDER BY created_at LIMIT 1').get();
 if(existing)return existing.id;
 const id=randomUUID(),now=new Date().toISOString();
 db.prepare('INSERT INTO tenants (id,name,slug,status,default_locale,timezone,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(id,'HyperCool','hypercool','ACTIVE','ar','Asia/Riyadh',now,now);
 let users=[];
 try{users=db.prepare('SELECT id,role FROM users').all();}catch{users=[];} // users table may not exist yet in a bare fixture
 const insertMembership=db.prepare('INSERT OR IGNORE INTO tenant_memberships (id,tenant_id,user_id,role,status,is_owner,created_at) VALUES (?,?,?,?,?,?,?)');
 for(const user of users)insertMembership.run(randomUUID(),id,user.id,user.role,'active',user.role==='owner'?1:0,now);
 return id;
}
// The single real entry point every tenant-scoped module resolves "which tenant" through
// when no explicit tenant context was threaded in from a request — see the module docstring
// above for why this is a correct value today, not a placeholder.
export function resolveActiveTenantId(db) {
 return ensureDefaultTenant(db);
}
/**
 * Resolves the tenant a specific logged-in user belongs to — this is what a real
 * TenantContext.resolveTenant() will call once a session is available (spec Part 4). A user
 * with no membership row yet (created before this module existed, or any edge case) is
 * attached to the default tenant on first resolution rather than left tenant-less.
 */
export function resolveTenantForUser(db,userId) {
 const tenantId=ensureDefaultTenant(db);
 const membership=db.prepare('SELECT tenant_id AS tenantId FROM tenant_memberships WHERE user_id=? LIMIT 1').get(userId);
 if(membership)return membership.tenantId;
 const user=db.prepare('SELECT role FROM users WHERE id=?').get(userId);
 if(user)db.prepare('INSERT OR IGNORE INTO tenant_memberships (id,tenant_id,user_id,role,status,is_owner,created_at) VALUES (?,?,?,?,?,?,?)')
  .run(randomUUID(),tenantId,userId,user.role,'active',user.role==='owner'?1:0,new Date().toISOString());
 return tenantId;
}
export function getTenant(db,tenantId) {
 const row=db.prepare('SELECT * FROM tenants WHERE id=?').get(tenantId);
 if(!row)return null;
 return {id:row.id,name:row.name,slug:row.slug,status:row.status,plan:row.plan,defaultLocale:row.default_locale,timezone:row.timezone,brandingSettings:row.branding_settings?JSON.parse(row.branding_settings):null,systemMode:row.system_mode,createdAt:row.created_at,updatedAt:row.updated_at};
}
export function listTenantMembers(db,tenantId) {
 return db.prepare('SELECT tm.id,tm.user_id AS userId,u.name,u.username,tm.role,tm.status,tm.is_owner AS isOwner,tm.created_at AS createdAt FROM tenant_memberships tm JOIN users u ON u.id=tm.user_id WHERE tm.tenant_id=? ORDER BY tm.created_at').all(tenantId);
}
/**
 * Creates a brand-new, empty tenant — no credentials, no CRM data, no memory, no logs (spec
 * Part 53: "cloning" a customer must never copy another tenant's data). Not yet reachable
 * from any UI (no Control Center exists in this pass) — exposed here so the next phase's
 * onboarding route has a real, tested function to call rather than inventing one blind.
 */
export function createTenant(db,{name,slug},ownerUserId) {
 const id=randomUUID(),now=new Date().toISOString();
 db.prepare('INSERT INTO tenants (id,name,slug,status,default_locale,timezone,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(id,name,slug,'TRIAL','ar','Asia/Riyadh',now,now);
 if(ownerUserId)db.prepare('INSERT INTO tenant_memberships (id,tenant_id,user_id,role,status,is_owner,created_at) VALUES (?,?,?,?,?,?,?)')
  .run(randomUUID(),id,ownerUserId,'owner','active',1,now);
 return id;
}
