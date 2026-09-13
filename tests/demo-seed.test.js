import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createTenant } from '../src/tenancy.js';
import { createAuth } from '../src/auth.js';
import { createApp } from '../src/application.js';
import { DEMO_SLUGS, DEMO_USERNAME } from '../scripts/demo/shared.mjs';

// Investor Demo Data Pack — end-to-end tests for scripts/demo-seed.mjs, demo-reset.mjs,
// demo-status.mjs. Each script is a real, standalone CLI (top-level await, process.exit on
// guard failures) so it is exercised here exactly as an operator would run it — as a real
// child process against a real, ephemeral, throwaway data directory — never by re-implementing
// its logic inline.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const SEED_SCRIPT = join(repoRoot, 'scripts', 'demo-seed.mjs');
const RESET_SCRIPT = join(repoRoot, 'scripts', 'demo-reset.mjs');
const DEMO_PASSWORD = 'a-strong-demo-test-password-2024';

function run(script, extraEnv = {}) {
 return execFileSync(process.execPath, [script], {
  cwd: repoRoot,
  env: { ...process.env, ...extraEnv },
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
 });
}
function runExpectFailure(script, extraEnv = {}) {
 try {
  run(script, extraEnv);
  return null;
 } catch (error) {
  return { status: error.status, output: (error.stdout || '') + (error.stderr || '') };
 }
}
function openDb(dataDir) {
 return new DatabaseSync(join(dataDir, 'hypercool.sqlite'));
}

// --- Guards (Part 35/33) — fast, fail before any real work ----------------------------------

test('demo:seed refuses to run in NODE_ENV=production without ALLOW_DEMO_SEED',async()=>{
 const directory = await mkdtemp(join(tmpdir(), 'hypercool-demoseed-guard-'));
 try {
  const failure = runExpectFailure(SEED_SCRIPT, { DATA_DIR: directory, NODE_ENV: 'production', DEMO_USER_PASSWORD: DEMO_PASSWORD, ALLOW_DEMO_SEED: '' });
  assert.ok(failure, 'expected a non-zero exit code');
  assert.notEqual(failure.status, 0);
  assert.match(failure.output, /production/i);
 } finally { await rm(directory, { recursive: true, force: true }); }
});

test('demo:seed proceeds in NODE_ENV=production when ALLOW_DEMO_SEED=true is explicitly set',async()=>{
 const directory = await mkdtemp(join(tmpdir(), 'hypercool-demoseed-guard-override-'));
 try {
  run(SEED_SCRIPT, { DATA_DIR: directory, NODE_ENV: 'production', ALLOW_DEMO_SEED: 'true', DEMO_USER_PASSWORD: DEMO_PASSWORD });
  const db = openDb(directory);
  const tenant = db.prepare('SELECT id FROM tenants WHERE slug=?').get(DEMO_SLUGS.nova);
  assert.ok(tenant, 'Nova Store must exist once the override is set');
  db.close();
 } finally { await rm(directory, { recursive: true, force: true }); }
});

test('demo:seed refuses without a real DEMO_USER_PASSWORD',async()=>{
 const directory = await mkdtemp(join(tmpdir(), 'hypercool-demoseed-pw-'));
 try {
  const failure = runExpectFailure(SEED_SCRIPT, { DATA_DIR: directory, DEMO_USER_PASSWORD: '' });
  assert.ok(failure);
  assert.notEqual(failure.status, 0);
  assert.match(failure.output, /DEMO_USER_PASSWORD/);
 } finally { await rm(directory, { recursive: true, force: true }); }
});

// --- The real, full seed — one run, many assertions against its actual output --------------

test('demo:seed produces two real, isolated, clearly-marked demo tenants with rich real data; idempotent on a second run; demo:status reports it; demo:reset removes ONLY it',async()=>{
 const directory = await mkdtemp(join(tmpdir(), 'hypercool-demoseed-full-'));
 try {
  const env = { DATA_DIR: directory, DEMO_USER_PASSWORD: DEMO_PASSWORD };
  const firstRun = run(SEED_SCRIPT, env);
  assert.match(firstRun, /Nova Store tenant created/);
  assert.match(firstRun, /Vertex Solutions tenant created/);
  assert.match(firstRun, /Investor demo account created/);
  assert.doesNotMatch(firstRun, /https?:\/\//i, 'seed output must never mention a real outbound URL being called');

  const db = openDb(directory);
  const nova = db.prepare('SELECT * FROM tenants WHERE slug=?').get(DEMO_SLUGS.nova);
  const vertex = db.prepare('SELECT * FROM tenants WHERE slug=?').get(DEMO_SLUGS.vertex);
  assert.ok(nova); assert.ok(vertex);

  // Demo marker (Part 38) present on both, and both start ACTIVE (no trial nag in an investor demo).
  for (const tenant of [nova, vertex]) {
   const branding = JSON.parse(tenant.branding_settings);
   assert.equal(branding.demo, true);
   assert.equal(tenant.status, 'ACTIVE');
  }

  // Rich real data landed in the actual tables (Part I/J/K/L/M/N/O/P/Q of the final report).
  const novaLeadCount = db.prepare('SELECT COUNT(*) n FROM crm_leads WHERE tenant_id=?').get(nova.id).n;
  const vertexLeadCount = db.prepare('SELECT COUNT(*) n FROM crm_leads WHERE tenant_id=?').get(vertex.id).n;
  assert.ok(novaLeadCount >= 80 && novaLeadCount <= 150, `Nova CRM/customer count should be 80-150, got ${novaLeadCount}`);
  assert.ok(vertexLeadCount >= 40, `Vertex B2B lead count should be a real pipeline, got ${vertexLeadCount}`);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM products WHERE tenant_id=?').get(nova.id).n >= 15);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM content_items WHERE tenant_id=?').get(nova.id).n > 0);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM agent_approvals WHERE tenant_id=?').get(nova.id).n > 0);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM agent_escalations WHERE tenant_id=?').get(nova.id).n > 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tenant_agent_configs WHERE tenant_id=?').get(nova.id).n, 12);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tenant_agent_configs WHERE tenant_id=?').get(vertex.id).n, 12);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM weekly_reports WHERE tenant_id=?').get(nova.id).n >= 1);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM daily_briefs WHERE tenant_id=?').get(nova.id).n >= 1);

  // Connections show a real MIX of health states, never all "green" (Part 14 — realistic readiness).
  const novaConnStatuses = db.prepare('SELECT status FROM integration_connections WHERE tenant_id=?').all(nova.id).map(r => r.status);
  assert.ok(novaConnStatuses.includes('CONNECTED'));
  assert.ok(novaConnStatuses.includes('TOKEN_EXPIRED') || novaConnStatuses.includes('DEGRADED'));

  // No real credential was ever stored for a demo connection (Part T — no fake secret).
  const vaultRows = db.prepare('SELECT COUNT(*) n FROM integration_credentials_vault WHERE tenant_id IN (?,?)').get(nova.id, vertex.id).n;
  assert.equal(vaultRows, 0, 'demo connections must never have a stored credential/secret');

  // Reports/briefs are real, well-formed JSON derived from the seeded data (Part J).
  const brief = db.prepare('SELECT json FROM daily_briefs WHERE tenant_id=?').get(nova.id);
  assert.ok(JSON.parse(brief.json));
  const report = db.prepare('SELECT json FROM weekly_reports WHERE tenant_id=?').get(nova.id);
  const reportObj = JSON.parse(report.json);
  assert.ok(reportObj.weekStart);

  // Cross-tenant isolation (Part S) — every seeded row belongs to exactly the tenant it was
  // seeded for; a lead created under one tenant id can never resolve under the other's scope.
  const novaLeadIds = db.prepare('SELECT id FROM crm_leads WHERE tenant_id=?').all(nova.id).map(r => r.id);
  const crossLeak = db.prepare(`SELECT COUNT(*) n FROM crm_leads WHERE tenant_id=? AND id IN (${novaLeadIds.map(() => '?').join(',') || "''"})`).get(vertex.id, ...novaLeadIds).n;
  assert.equal(crossLeak, 0, 'no Nova lead id must ever appear under the Vertex tenant');

  db.close();

  // --- Idempotency (Part 36) — a second run must not duplicate anything ---------------------
  const secondRun = run(SEED_SCRIPT, env);
  assert.match(secondRun, /already seeded/);
  const db2 = openDb(directory);
  const novaLeadCountAfter = db2.prepare('SELECT COUNT(*) n FROM crm_leads WHERE tenant_id=?').get(nova.id).n;
  assert.equal(novaLeadCountAfter, novaLeadCount, 'running demo:seed twice must not create duplicate CRM leads');
  db2.close();

  // --- demo:status reflects real counts (Part D of the final report) ------------------------
  const statusOutput = run(join(repoRoot, 'scripts', 'demo-status.mjs'), env);
  assert.match(statusOutput, /Nova Store/);
  assert.match(statusOutput, /Vertex Solutions/);
  assert.match(statusOutput, new RegExp(`crmLeads\\s*: ${novaLeadCount}`));

  // --- demo:reset removes ONLY the demo tenants, never a real one (Part 37) ------------------
  // Seed a genuine, unrelated tenant directly into the SAME database first, so this test can
  // prove reset leaves it completely untouched.
  const realApp = await createApp({ dataDir: directory, env: {} });
  const realAuth = createAuth(realApp.store.db);
  const realOwner = realAuth.createUser({ username: 'real_customer_owner', name: 'Real Customer', password: 'a-real-customer-password-123' }, 'owner');
  const realTenantId = createTenant(realApp.store.db, { name: 'Real Customer Co', slug: 'real-customer-co' }, realOwner.id);
  realApp.store.close();

  run(RESET_SCRIPT, env);
  const db3 = openDb(directory);
  assert.equal(db3.prepare('SELECT COUNT(*) n FROM tenants WHERE slug=?').get(DEMO_SLUGS.nova).n, 0, 'Nova Store must be gone after reset');
  assert.equal(db3.prepare('SELECT COUNT(*) n FROM tenants WHERE slug=?').get(DEMO_SLUGS.vertex).n, 0, 'Vertex Solutions must be gone after reset');
  assert.equal(db3.prepare('SELECT COUNT(*) n FROM users WHERE username=?').get(DEMO_USERNAME).n, 0, 'investor_demo must be gone once it has no memberships left');
  // The real, unrelated tenant and its owner must be completely untouched.
  const realTenantStillThere = db3.prepare('SELECT id FROM tenants WHERE id=?').get(realTenantId);
  assert.ok(realTenantStillThere, 'reset must NEVER delete a real, non-demo tenant');
  assert.ok(db3.prepare('SELECT id FROM users WHERE username=?').get('real_customer_owner'), 'reset must NEVER delete a real user');
  db3.close();
 } finally { await rm(directory, { recursive: true, force: true }); }
});

// --- Static/structural guarantee: no real network call is even reachable from the seed path -
test('demo-seed.mjs never imports or calls anything that could make a real outbound request',async()=>{
 const source = (await readFile(SEED_SCRIPT, 'utf8'))
  .split('\n').filter(line => !line.trim().startsWith('//')).join('\n'); // strip line comments only
 for (const forbidden of ['agentRuntime', 'storeCredential', 'fetch(', 'sendTestWebhookEvent', 'processGenericWebhook', "from '../src/integrations/vault.js'"]) {
  assert.ok(!source.includes(forbidden), `demo-seed.mjs must never reference "${forbidden}" outside a comment`);
 }
});
