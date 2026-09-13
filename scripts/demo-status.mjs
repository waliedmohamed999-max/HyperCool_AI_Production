#!/usr/bin/env node
// Investor Demo Data Pack — reports record counts for the two demo tenants (or "NOT SEEDED"
// if a tenant doesn't exist yet). Read-only; never writes anything.
// Usage: npm run demo:status   (or: node scripts/demo-status.mjs)
import { createApp } from '../src/application.js';
import { DEMO_SLUGS, DEMO_USERNAME } from './demo/shared.mjs';

const app = await createApp({ env: process.env });
const db = app.store.db;

function countFor(tenantId) {
 const c = (sql, ...params) => db.prepare(sql).get(...params).n;
 return {
  members: c('SELECT COUNT(*) n FROM tenant_memberships WHERE tenant_id=?', tenantId),
  crmLeads: c('SELECT COUNT(*) n FROM crm_leads WHERE tenant_id=?', tenantId),
  content: c('SELECT COUNT(*) n FROM content_items WHERE tenant_id=?', tenantId),
  connections: c('SELECT COUNT(*) n FROM integration_connections WHERE tenant_id=?', tenantId),
  products: c('SELECT COUNT(*) n FROM products WHERE tenant_id=?', tenantId),
  approvals: c('SELECT COUNT(*) n FROM agent_approvals WHERE tenant_id=?', tenantId),
  escalationsTasks: c('SELECT COUNT(*) n FROM agent_escalations WHERE tenant_id=?', tenantId),
  agentConfigs: c('SELECT COUNT(*) n FROM tenant_agent_configs WHERE tenant_id=?', tenantId),
  audits: c('SELECT COUNT(*) n FROM audit_logs WHERE tenant_id=?', tenantId),
  dailyBriefs: c('SELECT COUNT(*) n FROM daily_briefs WHERE tenant_id=?', tenantId),
  weeklyReports: c('SELECT COUNT(*) n FROM weekly_reports WHERE tenant_id=?', tenantId)
 };
}

function printTenant(label, slug) {
 const tenant = db.prepare('SELECT id,name,status,branding_settings FROM tenants WHERE slug=?').get(slug);
 console.log(`\n=== ${label} (${slug}) ===`);
 if (!tenant) { console.log('NOT SEEDED — run `npm run demo:seed`'); return; }
 const branding = tenant.branding_settings ? JSON.parse(tenant.branding_settings) : null;
 console.log(`tenantId: ${tenant.id}`);
 console.log(`status: ${tenant.status} | demo marker: ${branding?.demo === true ? 'yes' : 'NO (unexpected)'}`);
 const counts = countFor(tenant.id);
 for (const [key, value] of Object.entries(counts)) console.log(`  ${key.padEnd(16)}: ${value}`);
}

console.log('HyperCool Investor Demo — Status');
printTenant('Nova Store', DEMO_SLUGS.nova);
printTenant('Vertex Solutions', DEMO_SLUGS.vertex);

const investor = db.prepare('SELECT id,username FROM users WHERE username=?').get(DEMO_USERNAME);
console.log(`\n=== Investor demo account ===`);
console.log(investor ? `exists: ${investor.username} (${investor.id})` : 'NOT CREATED — run `npm run demo:seed`');

app.store.close();
