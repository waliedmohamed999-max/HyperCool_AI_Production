// Phase 5 (Part 20) — periodic, SAFE, READ-ONLY data isolation watch. Opens the real DB
// read-only (never writes, never deletes) and reports, in plain text, any row that would
// indicate a real multi-tenant boundary problem: an unresolved tenant_id where one is
// expected, a membership pointing at a tenant/user that no longer exists, or a tool
// assignment/credential/run whose own connection_id belongs to a DIFFERENT tenant than the
// row itself (the exact shape a real cross-tenant leak would take). This is diagnostic only —
// it fixes nothing and deletes nothing; a real finding must be investigated by hand.
// Usage: node scripts/data-isolation-check.mjs [dataDir]
import { DatabaseSync } from 'node:sqlite';
import { resolve, join } from 'node:path';

const dataDir = resolve(process.argv[2] || process.env.DATA_DIR || './data');
const dbPath = join(dataDir, 'hypercool.sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });

let findings = 0;
function report(line) { console.log(line); findings++; }
function info(line) { console.log(line); }

console.log(`=== HyperCool Data Isolation Check — ${dbPath} ===\n`);

// --- 1. tenant_id NULL in tables that should always have one resolved by boot time ---------
const tenantOwnedTables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
).all().map(r => r.name).filter(name => {
  const cols = db.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name);
  return cols.includes('tenant_id');
});

for (const table of tenantOwnedTables) {
  const nullCount = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE tenant_id IS NULL`).get().c;
  if (nullCount === 0) continue;
  if (table === 'webhook_events') {
    // The one legitimate NULL tenant_id case in the whole schema (Part B7): a delivery the
    // system genuinely could not map to any tenant. Reported as INFO, not a finding.
    const unresolved = db.prepare("SELECT COUNT(*) c FROM webhook_events WHERE tenant_id IS NULL AND status='TENANT_UNRESOLVED'").get().c;
    const unexplained = nullCount - unresolved;
    info(`ℹ webhook_events: ${unresolved} legitimate TENANT_UNRESOLVED row(s) with NULL tenant_id`);
    if (unexplained > 0) report(`✖ webhook_events: ${unexplained} row(s) with NULL tenant_id NOT marked TENANT_UNRESOLVED — unexpected`);
    continue;
  }
  report(`✖ ${table}: ${nullCount} row(s) with NULL tenant_id (expected to always be resolved by boot)`);
}

// --- 2. Orphan tenant_memberships ------------------------------------------------------------
const orphanMembershipTenant = db.prepare(
  'SELECT COUNT(*) c FROM tenant_memberships tm WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id=tm.tenant_id)'
).get().c;
if (orphanMembershipTenant > 0) report(`✖ tenant_memberships: ${orphanMembershipTenant} row(s) referencing a tenant that no longer exists`);
const orphanMembershipUser = db.prepare(
  'SELECT COUNT(*) c FROM tenant_memberships tm WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id=tm.user_id)'
).get().c;
if (orphanMembershipUser > 0) report(`✖ tenant_memberships: ${orphanMembershipUser} row(s) referencing a user that no longer exists`);

// --- 3. Cross-tenant connection references (the exact shape a real leak would take) ---------
// A row's own tenant_id must match the tenant_id of the connection_id it points to — anything
// else means one tenant's agent/tool/credential is wired to ANOTHER tenant's integration.
function crossTenantConnectionCheck(table, connectionColumn = 'connection_id') {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(connectionColumn)) return;
  const rows = db.prepare(
    `SELECT COUNT(*) c FROM ${table} r JOIN integration_connections ic ON ic.id=r.${connectionColumn} WHERE r.tenant_id IS NOT NULL AND r.tenant_id!=ic.tenant_id`
  ).get().c;
  if (rows > 0) report(`✖ ${table}: ${rows} row(s) whose ${connectionColumn} points to ANOTHER tenant's integration connection — real cross-tenant wiring`);
  const orphanConn = db.prepare(
    `SELECT COUNT(*) c FROM ${table} r WHERE r.${connectionColumn} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM integration_connections ic WHERE ic.id=r.${connectionColumn})`
  ).get().c;
  if (orphanConn > 0) report(`✖ ${table}: ${orphanConn} row(s) whose ${connectionColumn} references a connection that no longer exists`);
}
for (const table of ['agent_tool_assignments', 'agent_runs', 'agent_tool_calls', 'integration_credentials_vault', 'agent_approvals']) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (exists) crossTenantConnectionCheck(table);
}

// --- 4. Invalid agent tool assignments (tenant_id present but agent/tool combination orphaned)
const assignmentsExist = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_tool_assignments'").get();
if (assignmentsExist) {
  const orphanTenant = db.prepare(
    'SELECT COUNT(*) c FROM agent_tool_assignments a WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id=a.tenant_id)'
  ).get().c;
  if (orphanTenant > 0) report(`✖ agent_tool_assignments: ${orphanTenant} row(s) referencing a tenant that no longer exists`);
}

// --- 5. tenants.slug uniqueness sanity (should be impossible given the schema's UNIQUE index,
//        but a real report should never assume a constraint was never bypassed by an old migration)
const duplicateSlugs = db.prepare('SELECT slug, COUNT(*) c FROM tenants GROUP BY slug HAVING c>1').all();
if (duplicateSlugs.length) report(`✖ tenants: duplicate slug(s) found: ${duplicateSlugs.map(r => r.slug).join(', ')}`);

console.log(`\n=== ${findings === 0 ? 'No isolation issues found.' : findings + ' finding(s) — investigate by hand, do not auto-delete.'} ===`);
db.close();
process.exitCode = findings > 0 ? 1 : 0;
