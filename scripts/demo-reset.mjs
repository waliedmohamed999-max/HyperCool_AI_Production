#!/usr/bin/env node
// Investor Demo Data Pack — removes ONLY the demo-created records: the two fixed demo tenants
// (found by their exact slug, never by name/heuristic), everything scoped to their tenant_id,
// and the investor_demo user (only once it has no remaining membership anywhere else — a
// genuine safety check, not a formality). Never touches any other tenant or user.
// Usage: npm run demo:reset   (or: node scripts/demo-reset.mjs)
import { createApp } from '../src/application.js';
import { DEMO_SLUGS, DEMO_USERNAME, DEMO_MARKER } from './demo/shared.mjs';

const app = await createApp({ env: process.env });
const db = app.store.db;
function log(msg) { console.log(`[demo:reset] ${msg}`); }

function deleteTenantData(tenantId) {
 // crm_messages/crm_followups carry no tenant_id column of their own (isolated transitively
 // via lead_id — see src/crm.js's own doc comment) so they're deleted by joining crm_leads.
 db.prepare('DELETE FROM crm_messages WHERE lead_id IN (SELECT id FROM crm_leads WHERE tenant_id=?)').run(tenantId);
 db.prepare('DELETE FROM crm_followups WHERE lead_id IN (SELECT id FROM crm_leads WHERE tenant_id=?)').run(tenantId);
 const tables = [
  'crm_leads', 'content_items', 'agent_escalations', 'agent_approvals', 'agent_autonomy',
  'tenant_agent_configs', 'integration_connections', 'integration_credentials_vault',
  'products', 'daily_briefs', 'weekly_reports', 'audit_logs', 'agent_runs', 'agent_tool_calls',
  'agent_tool_assignments', 'tenant_memberships'
 ];
 for (const table of tables) {
  try { db.prepare(`DELETE FROM ${table} WHERE tenant_id=?`).run(tenantId); }
  catch (error) { if (!/no such table/i.test(error.message)) throw error; }
 }
 db.prepare('DELETE FROM tenants WHERE id=?').run(tenantId);
}

function resetTenant(label, slug) {
 const tenant = db.prepare('SELECT id,branding_settings FROM tenants WHERE slug=?').get(slug);
 if (!tenant) { log(`${label} (${slug}) — not seeded, nothing to remove.`); return; }
 // Defense-in-depth (Part 37 — "never delete real tenant data"): refuse to touch a tenant at
 // this slug unless it is genuinely marked as this demo pack's own data. A real tenant could
 // never legitimately end up with this exact slug (both are deliberately unusual/reserved-
 // looking), but this check costs nothing and turns a hypothetical slug collision into a loud,
 // safe refusal instead of a silent deletion.
 const branding = tenant.branding_settings ? JSON.parse(tenant.branding_settings) : null;
 if (branding?.marker !== DEMO_MARKER) {
  log(`REFUSING to remove ${label} (${slug}) — tenant exists but is NOT marked as demo data (marker mismatch). Nothing was deleted.`);
  return;
 }
 deleteTenantData(tenant.id);
 log(`${label} (${slug}) — removed (tenant ${tenant.id} and everything scoped to it).`);
}

resetTenant('Nova Store', DEMO_SLUGS.nova);
resetTenant('Vertex Solutions', DEMO_SLUGS.vertex);

const investor = db.prepare('SELECT id FROM users WHERE username=?').get(DEMO_USERNAME);
if (investor) {
 const remaining = db.prepare('SELECT COUNT(*) n FROM tenant_memberships WHERE user_id=?').get(investor.id).n;
 if (remaining === 0) {
  db.prepare('DELETE FROM users WHERE id=?').run(investor.id);
  log(`Investor demo account (${DEMO_USERNAME}) removed — no remaining memberships anywhere.`);
 } else {
  log(`Investor demo account (${DEMO_USERNAME}) kept — it still has ${remaining} membership(s) outside the two demo tenants (never deleted for safety).`);
 }
} else {
 log('Investor demo account — not present, nothing to remove.');
}

log('Reset complete.');
app.store.close();
