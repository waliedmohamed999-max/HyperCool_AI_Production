#!/usr/bin/env node
// Investor Demo Data Pack — seeds two realistic, clearly-labeled DEMO tenants (Nova Store /
// Vertex Solutions) into the REAL local database using the app's own real create/write
// functions (never a parallel fake data path). See docs/INVESTOR_DEMO.md for the full design,
// the honest mapping of every requested item to what actually exists in this codebase, and the
// exact list of requested concepts that have NO backing entity in this app and were
// deliberately NOT fabricated.
//
// SAFETY:
//  - Zero outbound network calls (no LLM call, no OAuth exchange, no webhook, no publish).
//  - No real credential is ever stored (connections are seeded via updateConnection's status
//    fields only — never storeCredential — so there is no "fake encrypted secret" at all).
//  - Every write is scoped to the two fixed demo tenants (by slug) or the investor_demo user.
//
// Usage: npm run demo:seed   (or: node scripts/demo-seed.mjs)
import { createApp } from '../src/application.js';
import { createTenant, getTenant } from '../src/tenancy.js';
import { createAuth } from '../src/auth.js';
import { createConnection, updateConnection } from '../src/integrations/connections.js';
import { replaceProducts } from '../src/knowledge.js';
import { createLead, updateLead, stages as LEAD_STAGES } from '../src/crm.js';
import { createContent, reviewContent, approveContent } from '../src/domain.js';
import { insertContent, writeContent } from '../src/content.js';
import { createApproval, decideApproval } from '../src/runtime/approvals.js';
import { createEscalation } from '../src/runtime/escalations.js';
import { updateTenantAgentConfig } from '../src/runtime/agent-config.js';
import { setAutonomy } from '../src/autonomy.js';
import { recordAudit } from '../src/audit.js';
import { saveDailyBrief } from '../src/planning.js';
import { saveWeeklyReport } from '../src/reporting.js';
import { listApprovals } from '../src/runtime/approvals.js';
import { listEscalations } from '../src/runtime/escalations.js';
import { listAgents as listRegistryAgents } from '../src/runtime/registry.js';
import { listRuns } from '../src/runtime/runtime.js';
import { randomUUID } from 'node:crypto';
import {
 DEMO_SLUGS, DEMO_USERNAME, DEMO_MARKER, makeRng, pick, pickWeighted, randInt, randFloat, shuffle,
 daysAgoIso, daysAgoDate, dateOnly, mostRecentSunday, patchJsonRow, designAssetDataUri, DESIGN_THEMES, DESIGN_TEMPLATE_COUNT,
 NOVA_TEAM, VERTEX_TEAM, NOVA_CUSTOMER_FIRST, NOVA_CUSTOMER_LAST, NOVA_PRODUCTS,
 VERTEX_CLIENT_NAMES, VERTEX_PROJECT_THEMES, NOVA_ACTIVITY_NARRATIVES, VERTEX_ACTIVITY_NARRATIVES
} from './demo/shared.mjs';

// --- Part 35 — env guard: refuse in production unless explicitly overridden ------------------
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
 console.error('[demo:seed] Refusing to run: NODE_ENV=production and ALLOW_DEMO_SEED is not "true".');
 console.error('[demo:seed] Set ALLOW_DEMO_SEED=true explicitly if you really intend to seed demo data in production.');
 process.exit(1);
}
// --- Part 33 — demo user password must come from the environment, never hardcoded -----------
const DEMO_PASSWORD = process.env.DEMO_USER_PASSWORD;
if (!DEMO_PASSWORD || DEMO_PASSWORD.length < 12) {
 console.error('[demo:seed] DEMO_USER_PASSWORD env var is required (>=12 chars) to create the investor_demo account.');
 console.error('[demo:seed] Example: DEMO_USER_PASSWORD="a-strong-passphrase-here" npm run demo:seed');
 process.exit(1);
}

const app = await createApp({ env: process.env });
const db = app.store.db;
const store = app.store;
const auth = createAuth(db);
const rng = makeRng('hypercool-investor-demo-v1'); // Part 45 — fixed seed, reproducible every run

function log(msg) { console.log(`[demo:seed] ${msg}`); }

function markTenantAsDemo(tenantId) {
 db.prepare('UPDATE tenants SET status=?,branding_settings=?,updated_at=? WHERE id=?')
  .run('ACTIVE', JSON.stringify({ demo: true, marker: DEMO_MARKER, seededAt: new Date().toISOString() }), new Date().toISOString(), tenantId);
}
function addMembership(tenantId, userId, role, isOwner) {
 db.prepare('INSERT OR IGNORE INTO tenant_memberships (id,tenant_id,user_id,role,status,is_owner,created_at) VALUES (?,?,?,?,?,?,?)')
  .run(randomUUID(), tenantId, userId, role, 'active', isOwner ? 1 : 0, new Date().toISOString());
}
function ensureUser(spec) {
 const existing = db.prepare('SELECT id,username,name,role FROM users WHERE username=?').get(spec.username);
 if (existing) return existing;
 return auth.createUser({ username: spec.username, name: spec.name, password: 'demo-team-' + spec.username.slice(0, 6) + '-2024x' }, spec.role);
}

// --- Reusable seeding building blocks --------------------------------------------------------

// `createTenant` itself already inserts the OWNER's own membership row — this helper is only
// ever called with the REMAINING team specs (never the owner), and adds an explicit membership
// for each one (no "add member to an already-created tenant" function exists in this codebase
// — see docs/INVESTOR_DEMO.md's honest note on this).
function seedTeamMembers(tenantId, teamSpecs) {
 return teamSpecs.map(spec => {
  const u = ensureUser(spec);
  addMembership(tenantId, u.id, spec.role, false);
  return u;
 });
}

function seedConnections(tenantId, specs) {
 const created = [];
 for (const spec of specs) {
  const conn = createConnection(db, { integrationDefinitionId: spec.slug, name: spec.name }, tenantId);
  const connectedDaysAgo = randInt(rng, 20, 85);
  const patch = { status: spec.status, name: spec.name };
  if (spec.status === 'CONNECTED' || spec.status === 'DEGRADED' || spec.status === 'TOKEN_EXPIRED') {
   patch.externalAccountName = spec.externalAccountName || null;
   patch.connectedAt = daysAgoIso(connectedDaysAgo);
   patch.lastHealthCheck = daysAgoIso(randInt(rng, 0, 3));
   patch.lastSuccessAt = spec.status === 'CONNECTED' ? daysAgoIso(randInt(rng, 0, 2)) : daysAgoIso(randInt(rng, 5, 15));
  }
  if (spec.status === 'DEGRADED') { patch.lastErrorAt = daysAgoIso(randInt(rng, 0, 2)); patch.lastErrorCode = 'RATE_LIMITED'; patch.lastErrorMessageSafe = 'تجاوز الحد المسموح من الطلبات مؤقتًا (بيانات تجريبية)'; }
  if (spec.status === 'TOKEN_EXPIRED') { patch.lastErrorAt = daysAgoIso(randInt(rng, 3, 10)); patch.lastErrorCode = 'TOKEN_EXPIRED'; patch.lastErrorMessageSafe = 'انتهت صلاحية رمز الوصول — يلزم إعادة الربط (بيانات تجريبية)'; }
  updateConnection(db, conn.id, patch, tenantId);
  created.push(conn);
 }
 return created;
}

function seedProducts(tenantId, pool, count) {
 const chosen = shuffle(rng, pool).slice(0, count);
 const now = new Date().toISOString();
 const products = chosen.map((p, i) => {
  const price = randFloat(rng, p.priceRange[0], p.priceRange[1], 0);
  const stock = pickWeighted(rng, [[randInt(rng, 40, 300), 6], [randInt(rng, 1, 8), 2], [0, 1]]); // mostly healthy, some low/out
  const id = 'demo-' + String(i + 1).padStart(3, '0');
  const field = value => ({ value, source: 'DEMO_SEED', verifiedAt: now });
  return {
   id, name: field(`${p.nameAr} (Demo)`), url: field(`https://hyper-cool.com/demo/${id}`),
   price: field({ amount: price, currency: 'SAR' }), stock: field(stock), available: field(stock > 0),
   status: 'active', source: 'DEMO', syncedAt: now, category: p.category, nameEn: p.nameEn
  };
 });
 replaceProducts(db, products, true, tenantId);
 return products;
}

function ensureAssignableUser(tenantMembers, roleFilter) {
 const candidates = tenantMembers.filter(u => roleFilter.includes(u.role));
 return candidates.length ? pick(rng, candidates) : null;
}

// --- Nova Store (E-commerce) -----------------------------------------------------------------

function seedNova() {
 const existing = db.prepare('SELECT id FROM tenants WHERE slug=?').get(DEMO_SLUGS.nova);
 if (existing) { log(`Nova Store already seeded (tenant ${existing.id}) — skipping.`); return existing.id; }

 const owner = ensureUser(NOVA_TEAM[0]);
 const tenantId = createTenant(db, { name: 'متجر نوفا', slug: DEMO_SLUGS.nova, createdByUserId: owner.id }, owner.id);
 db.prepare('UPDATE tenants SET default_locale=?,timezone=? WHERE id=?').run('ar', 'Asia/Riyadh', tenantId);
 markTenantAsDemo(tenantId);
 const team = [owner, ...seedTeamMembers(tenantId, NOVA_TEAM.slice(1))];
 log(`Nova Store tenant created (${tenantId}), ${team.length} team members.`);

 seedConnections(tenantId, [
  { slug: 'salla', name: 'Salla Demo Store', status: 'CONNECTED', externalAccountName: 'متجر نوفا التجريبي (Salla Demo)' },
  { slug: 'zid', name: 'Zid Demo Store', status: 'CONNECTED', externalAccountName: 'متجر نوفا التجريبي (Zid Demo)' },
  { slug: 'openai', name: 'OpenAI Demo', status: 'CONNECTED' },
  { slug: 'whatsapp', name: 'WhatsApp Demo', status: 'TOKEN_EXPIRED' },
  { slug: 'meta', name: 'Meta Demo', status: 'DEGRADED' }
 ]);
 log('Nova Store: 5 demo connections (CONNECTED x3, TOKEN_EXPIRED x1, DEGRADED x1).');

 seedProducts(tenantId, NOVA_PRODUCTS, 18);
 log('Nova Store: 18 demo products.');

 // --- CRM leads / customers (Part 6/7 — merged: no separate "customers" entity exists) -----
 const channels = ['إنستقرام', 'تيك توك', 'قوقل', 'واتساب', 'إحالة عميل'];
 const leadDistribution = [
  ['NEW', 15], ['QUALIFIED', 15], ['QUOTE_SENT', 10], ['DEMO', 8], ['PARKED', 7], ['LOST', 10], ['WON', 35]
 ];
 let leadCount = 0;
 const nowSeq = [];
 for (const [stage, count] of leadDistribution) {
  for (let i = 0; i < count; i++) {
   const first = pick(rng, NOVA_CUSTOMER_FIRST), last = pick(rng, NOVA_CUSTOMER_LAST);
   const channel = pick(rng, channels);
   const product = pick(rng, NOVA_PRODUCTS);
   const daysBack = randInt(rng, 1, 89);
   const lead = createLead(store, {
    name: `${first} ${last}`, customerType: 'B2C', sourceType: 'INBOUND',
    email: `demo.customer${leadCount + 1}@example.com`, phone: `+9665${randInt(rng, 10000000, 99999999)}`,
    productNeed: `استفسار عبر ${channel} عن: ${product.nameAr}`,
    quantity: randInt(rng, 1, 3), valueSAR: stage === 'WON' ? randFloat(rng, 150, 480, 0) : randFloat(rng, 80, 500, 0),
    timeline: pick(rng, ['خلال أسبوع', 'خلال شهر', 'غير محدد']), budgetBand: pick(rng, ['أقل من 300', '300-800', 'أكثر من 800'])
   }, owner, tenantId);
   patchJsonRow(db, 'crm_leads', 'id', lead.id, obj => { obj.createdAt = daysAgoIso(daysBack); });
   if (stage !== 'NEW') {
    const reason = stage === 'WON' ? 'تم إتمام عملية الشراء' : stage === 'LOST' ? 'لم يستجب العميل بعد عدة محاولات تواصل' : 'تحديث حالة الفرصة ضمن المتابعة الاعتيادية';
    const nextCheckAt = stage === 'PARKED' ? daysAgoDate(-randInt(rng, 5, 20)).toISOString() : undefined;
    updateLead(store, lead.id, {
     expectedVersion: 1, stage, reason, temperature: pick(rng, ['COLD', 'WARM', 'HOT']),
     city: pick(rng, ['الرياض', 'جدة', 'الدمام', 'مكة', 'المدينة']), productNeed: `استفسار عبر ${channel} عن: ${product.nameAr}`,
     quantity: randInt(rng, 1, 3), valueSAR: stage === 'WON' ? randFloat(rng, 150, 480, 0) : randFloat(rng, 80, 500, 0),
     timeline: 'خلال أسبوع', budgetBand: '300-800', nextCheckAt
    }, owner, tenantId);
    patchJsonRow(db, 'crm_leads', 'id', lead.id, obj => { obj.updatedAt = daysAgoIso(Math.max(0, daysBack - randInt(rng, 1, Math.min(daysBack, 10)))); });
   }
   leadCount++;
  }
 }
 log(`Nova Store: ${leadCount} CRM leads/customers across ${LEAD_STAGES.length} pipeline stages.`);

 // --- Content calendar (Part 10/11 — real channels only: Instagram/Facebook/X/LinkedIn) ----
 const platforms = ['Instagram', 'Facebook', 'X', 'LinkedIn'];
 const contentThemes = [
  'إطلاق تشكيلة اليوم الوطني', 'عرض نهاية الأسبوع', 'حملة الاستهداف الإعادي', 'تعريف بمنتج جديد',
  'قصة عميل سعيد', 'نصائح العناية بالمنتج', 'عرض حصري لفترة محدودة', 'حملة استقطاب عملاء جدد'
 ];
 let contentCount = 0;
 for (let i = 0; i < 24; i++) {
  const daysBack = randInt(rng, 1, 89);
  const platform = pick(rng, platforms);
  const theme = pick(rng, contentThemes);
  let item = createContent({
   title: `${theme} — ${platform}`, body: `محتوى تجريبي (Demo) لحملة: ${theme}. هذا نص عرض تجريبي لأغراض العرض على المستثمر فقط.`,
   platform, date: dateOnly(daysAgoDate(daysBack)), url: 'https://hyper-cool.com/demo/campaign/' + (i + 1)
  });
  item.createdAt = daysAgoIso(daysBack);
  // `createContent`'s own validation only accepts a real https:// assetUrl (a hosted creative
  // asset) — by design, since a real user's asset is always something actually uploaded
  // somewhere. This demo pack must never reference any real external host at all, so instead of
  // loosening that production validation, a real, self-contained data: URI "design" (see
  // designAssetDataUri, scripts/demo/shared.mjs — zero network calls, a visible DEMO watermark)
  // is attached directly to the already-validated object, exactly the same "patch after the
  // real function runs" pattern already used elsewhere in this script for backdating timestamps.
  item.assetUrl = designAssetDataUri({ lines: [theme], subtitle: `متجر نوفا · ${platform}`, theme: pick(rng, DESIGN_THEMES), platform, template: randInt(rng, 0, DESIGN_TEMPLATE_COUNT - 1) });
  const finalStatus = pickWeighted(rng, [['DRAFT', 2], ['REVIEWED', 2], ['APPROVED', 2], ['PUBLISHED', 4]]);
  if (['REVIEWED', 'APPROVED', 'PUBLISHED'].includes(finalStatus)) {
   item = reviewContent(item, { reviewer: 'سارة التجريبية', evidence: 'تم التحقق من الأسعار والادعاءات (بيانات تجريبية)', facts: true, claims: true, link: true, asset: true });
   item.review.at = daysAgoIso(Math.max(0, daysBack - 1));
  }
  if (['APPROVED', 'PUBLISHED'].includes(finalStatus)) {
   item = approveContent(item, { owner: 'أحمد التجريبي' });
   item.approval.at = daysAgoIso(Math.max(0, daysBack - 2));
  }
  if (finalStatus === 'PUBLISHED') { item.status = 'PUBLISHED'; item.publishedAt = daysAgoIso(Math.max(0, daysBack - 3)); }
  insertContent(db, item, tenantId);
  contentCount++;
 }
 log(`Nova Store: ${contentCount} content calendar items (DRAFT/REVIEWED/APPROVED/PUBLISHED).`);

 // --- Approvals (Part 9) -------------------------------------------------------------------
 const approvalSpecs = [
  { actionType: 'discount', reason: 'موافقة على خصم 15% لحملة اليوم الوطني', risk: 'MEDIUM' },
  { actionType: 'publish_content', reason: 'موافقة على نشر منشور حملة تجريبي', risk: 'LOW' },
  { actionType: 'send_marketing_message', reason: 'موافقة على إرسال رسالة تسويقية جماعية تجريبية', risk: 'MEDIUM' },
  { actionType: 'large_quote', reason: 'موافقة على عرض سعر بقيمة كبيرة لعميل جملة', risk: 'HIGH' },
  { actionType: 'connector_action', reason: 'موافقة على استثناء استرجاع لطلب متأخر', risk: 'MEDIUM' }
 ];
 let approvalCount = 0;
 for (let i = 0; i < 10; i++) {
  const spec = pick(rng, approvalSpecs);
  const approval = createApproval(db, { runId: null, agentId: 'human', actionType: spec.actionType, proposedOutput: spec.reason + ' (بيانات تجريبية)', riskLevel: spec.risk, reason: spec.reason, tenantId });
  const decision = pickWeighted(rng, [['PENDING', 3], ['APPROVED', 5], ['REJECTED', 2]]);
  if (decision !== 'PENDING') decideApproval(db, approval.id, decision, owner, tenantId);
  approvalCount++;
 }
 log(`Nova Store: ${approvalCount} approval requests (mix Pending/Approved/Rejected).`);

 // --- Escalations as "Tasks" (Part 8, mapped per explicit user decision) -------------------
 const taskThemes = [
  ['P1', 'مراجعة ميزانية حملة اليوم الوطني', 'التسويق'], ['P2', 'تجهيز محتوى لعرض نهاية الأسبوع', 'المحتوى'],
  ['P0', 'مخزون منخفض على منتج نشط في حملة', 'العمليات'], ['P3', 'الرد على استفسارات عملاء متراكمة', 'الدعم'],
  ['P2', 'متابعة عملاء محتملين لم يتم التواصل معهم', 'المبيعات'], ['P4', 'تحديث أوصاف المنتجات الجديدة', 'المحتوى'],
  ['P1', 'التحقق من صحة رابط عرض ترويجي', 'التسويق'], ['P3', 'تنسيق شحنة مرتجعة', 'العمليات'],
  ['P2', 'تجهيز تقرير أداء أسبوعي للإدارة', 'المبيعات'], ['P5', 'أرشفة محتوى منشور سابق', 'المحتوى']
 ];
 let taskCount = 0;
 for (let i = 0; i < 35; i++) {
  const [priority, reasonBase, dept] = pick(rng, taskThemes);
  const daysBack = randInt(rng, 0, 89);
  const esc = createEscalation(db, { runId: null, agentId: pick(rng, ['frost', 'strategy', 'copy', 'performance']), priority, reason: `${reasonBase} (${dept}) — بيانات تجريبية`, context: { department: dept, demo: true }, tenantId });
  const createdAtIso = daysAgoIso(daysBack);
  db.prepare('UPDATE agent_escalations SET created_at=? WHERE id=?').run(createdAtIso, esc.id);
  const shouldResolve = rng() < 0.55;
  if (shouldResolve) {
   db.prepare('UPDATE agent_escalations SET status=?,resolved_at=?,resolved_by=?,resolved_by_name=? WHERE id=?')
    .run('RESOLVED', daysAgoIso(Math.max(0, daysBack - randInt(rng, 0, 3))), owner.id, owner.name, esc.id);
  }
  taskCount++;
 }
 log(`Nova Store: ${taskCount} task-equivalent escalations (P0-P5, OPEN/RESOLVED).`);

 // --- Agents (Part 12) ----------------------------------------------------------------------
 const novaAgentModels = { strategy: 'claude-sonnet-5', copy: 'claude-sonnet-5', creative: 'claude-sonnet-5', publishing: 'claude-sonnet-5', leads: 'claude-sonnet-5', sales: 'claude-sonnet-5', followup: 'claude-sonnet-5' };
 for (const agentId of ['frost', 'strategy', 'copy', 'creative', 'compliance', 'publishing', 'leads', 'sales', 'followup', 'intelligence', 'performance', 'memory']) {
  updateTenantAgentConfig(db, tenantId, agentId, { enabled: true, model: novaAgentModels[agentId] || null });
 }
 setAutonomy(store, 'sales', { level: 'L1', reason: 'تمكين مستوى استقلالية أولي لوكيل المحادثات (بيانات تجريبية)', expectedVersion: 0 }, owner, {}, tenantId);
 log('Nova Store: 12 agents configured; conversation agent promoted to L1.');

 // --- Activity feed / audit trail (Part 13/29/30) -------------------------------------------
 let activityCount = 0;
 for (let i = 0; i < 55; i++) {
  const narrative = pick(rng, NOVA_ACTIVITY_NARRATIVES);
  const daysBack = randInt(rng, 0, 89);
  recordAudit(db, { id: randomUUID(), action: narrative.action, itemId: null, actorId: 'system', actorName: 'Frost (Demo)', detail: narrative.detail + ' (بيانات تجريبية)', at: daysAgoIso(daysBack) }, tenantId);
  activityCount++;
 }
 log(`Nova Store: ${activityCount} historical activity/audit entries over the last 90 days.`);

 // --- Reports (Part 15/27/28) -----------------------------------------------------------------
 saveDailyBrief(store, dateOnly(new Date()), owner, tenantId);
 const extras = tid => ({ agents: listRegistryAgents(db), agentRuns: listRuns(db, { limit: 2000 }, tid), escalations: listEscalations(db, {}, tid), approvals: listApprovals(db, {}, tid), env: {} });
 for (let w = 0; w < 4; w++) {
  const weekStart = dateOnly(new Date(mostRecentSunday().getTime() - w * 7 * 86400000));
  saveWeeklyReport(store, weekStart, owner, extras(tenantId), tenantId);
 }
 log('Nova Store: latest daily brief + 4 weekly reports generated from real seeded data.');

 return tenantId;
}

// --- Vertex Solutions (B2B Services) ---------------------------------------------------------

function seedVertex() {
 const existing = db.prepare('SELECT id FROM tenants WHERE slug=?').get(DEMO_SLUGS.vertex);
 if (existing) { log(`Vertex Solutions already seeded (tenant ${existing.id}) — skipping.`); return existing.id; }

 const owner = ensureUser(VERTEX_TEAM[0]);
 const tenantId = createTenant(db, { name: 'فيرتكس للحلول', slug: DEMO_SLUGS.vertex, createdByUserId: owner.id }, owner.id);
 db.prepare('UPDATE tenants SET default_locale=?,timezone=? WHERE id=?').run('ar', 'Asia/Riyadh', tenantId);
 markTenantAsDemo(tenantId);
 const team = [owner, ...seedTeamMembers(tenantId, VERTEX_TEAM.slice(1))];
 log(`Vertex Solutions tenant created (${tenantId}), ${team.length} team members.`);

 seedConnections(tenantId, [
  { slug: 'microsoft365', name: 'Microsoft 365 Demo', status: 'CONNECTED' },
  { slug: 'linkedin', name: 'LinkedIn Demo', status: 'DEGRADED' },
  { slug: 'openai', name: 'OpenAI Demo', status: 'CONNECTED' },
  { slug: 'whatsapp', name: 'WhatsApp Demo', status: 'TOKEN_EXPIRED' }
 ]);
 log('Vertex Solutions: 4 demo connections (CONNECTED x2, DEGRADED x1, TOKEN_EXPIRED x1). "Email" was requested but has no backing integration definition in this system — Microsoft 365 (real mail+calendar) is the closest real substitute and was used instead.');

 // --- B2B CRM / pipeline + "Clients" (Part 17/18 — merged, no separate clients entity) ------
 const routeIns = ['LinkedIn', 'الموقع الإلكتروني', 'إحالة عميل', 'فعالية', 'تواصل مباشر'];
 const leadDistribution = [
  ['NEW', 8], ['QUALIFIED', 10], ['QUOTE_SENT', 8], ['DEMO', 6], ['PARKED', 5], ['LOST', 6], ['WON', 12]
 ];
 let leadCount = 0, pipelineTotal = 0, wonTotal = 0;
 for (const [stage, count] of leadDistribution) {
  for (let i = 0; i < count; i++) {
   const company = pick(rng, VERTEX_CLIENT_NAMES);
   const project = pick(rng, VERTEX_PROJECT_THEMES);
   const daysBack = randInt(rng, 1, 89);
   const value = randFloat(rng, 15000, 180000, 0);
   const useResearch = rng() < 0.4;
   const input = {
    name: `مسؤول تواصل — ${company}`, customerType: 'B2B', sourceType: useResearch ? 'RESEARCH' : 'INBOUND',
    email: `demo.contact${leadCount + 1}@example.com`, phone: `+9665${randInt(rng, 10000000, 99999999)}`,
    company, productNeed: project, quantity: 1, valueSAR: value,
    timeline: pick(rng, ['هذا الربع', 'الربع القادم', 'غير محدد']), budgetBand: 'أكثر من 50000'
   };
   if (useResearch) {
    input.triggerDate = daysAgoDate(daysBack + 1).toISOString();
    input.fitScore = randInt(rng, 3, 5);
    input.sourceChecked = true;
    input.sourceUrl = 'https://hyper-cool.com/demo/research/' + (leadCount + 1);
    input.trigger = `محفز تجريبي: توسّع ${company} في مشروع ${project}`;
    input.routeIn = pick(rng, routeIns);
   }
   const lead = createLead(store, input, owner, tenantId);
   patchJsonRow(db, 'crm_leads', 'id', lead.id, obj => { obj.createdAt = daysAgoIso(daysBack); });
   pipelineTotal += value;
   if (stage !== 'NEW') {
    const reason = stage === 'WON' ? 'تم توقيع العقد مع العميل' : stage === 'LOST' ? 'اختار العميل مزودًا آخر' : 'تحديث حالة الفرصة ضمن دورة المبيعات';
    const nextCheckAt = stage === 'PARKED' ? daysAgoDate(-randInt(rng, 5, 20)).toISOString() : undefined;
    updateLead(store, lead.id, { expectedVersion: 1, stage, reason, temperature: pick(rng, ['COLD', 'WARM', 'HOT']), city: pick(rng, ['الرياض', 'جدة', 'الدمام']), productNeed: project, quantity: 1, valueSAR: value, timeline: 'هذا الربع', budgetBand: 'أكثر من 50000', nextCheckAt }, owner, tenantId);
    patchJsonRow(db, 'crm_leads', 'id', lead.id, obj => { obj.updatedAt = daysAgoIso(Math.max(0, daysBack - randInt(rng, 1, Math.min(daysBack, 10)))); });
    if (stage === 'WON') wonTotal += value;
   }
   leadCount++;
  }
 }
 log(`Vertex Solutions: ${leadCount} B2B leads/clients — pipeline ~${Math.round(pipelineTotal).toLocaleString('en-US')} SAR, won ~${Math.round(wonTotal).toLocaleString('en-US')} SAR.`);

 // --- Content (Part 10, much lighter than Nova per spec) ------------------------------------
 let contentCount = 0;
 for (let i = 0; i < 8; i++) {
  const daysBack = randInt(rng, 1, 89);
  let item = createContent({ title: `تحديث نجاح عميل — LinkedIn ${i + 1}`, body: 'محتوى تجريبي (Demo) لمنشور نجاح عميل. نص عرض تجريبي فقط.', platform: 'LinkedIn', date: dateOnly(daysAgoDate(daysBack)), url: 'https://hyper-cool.com/demo/vertex-post/' + (i + 1) });
  item.createdAt = daysAgoIso(daysBack);
  item.assetUrl = designAssetDataUri({ lines: ['نجاح عميل'], subtitle: 'فيرتكس للحلول · LinkedIn', theme: pick(rng, DESIGN_THEMES), platform: 'LinkedIn', template: randInt(rng, 0, DESIGN_TEMPLATE_COUNT - 1) });
  if (rng() < 0.6) {
   item = reviewContent(item, { reviewer: 'منيرة التجريبية', evidence: 'تم التحقق من البيانات (بيانات تجريبية)', facts: true, claims: true, link: true, asset: true });
   item = approveContent(item, { owner: 'عبدالله التجريبي' });
   item.status = 'PUBLISHED'; item.publishedAt = daysAgoIso(Math.max(0, daysBack - 2));
  }
  insertContent(db, item, tenantId);
  contentCount++;
 }
 log(`Vertex Solutions: ${contentCount} LinkedIn content items.`);

 // --- Approvals (Part 22) -------------------------------------------------------------------
 const approvalSpecs = [
  { actionType: 'large_quote', reason: 'موافقة على عرض سعر لمشروع كبير', risk: 'HIGH' },
  { actionType: 'discount', reason: 'موافقة على خصم تعاقدي استثنائي', risk: 'MEDIUM' },
  { actionType: 'connector_action', reason: 'موافقة على استثناء بند تعاقدي', risk: 'MEDIUM' },
  { actionType: 'publish_content', reason: 'موافقة على نشر محتوى تسويقي', risk: 'LOW' }
 ];
 let approvalCount = 0;
 for (let i = 0; i < 8; i++) {
  const spec = pick(rng, approvalSpecs);
  const approval = createApproval(db, { runId: null, agentId: 'human', actionType: spec.actionType, proposedOutput: spec.reason + ' (بيانات تجريبية)', riskLevel: spec.risk, reason: spec.reason, tenantId });
  const decision = pickWeighted(rng, [['PENDING', 3], ['APPROVED', 4], ['REJECTED', 1]]);
  if (decision !== 'PENDING') decideApproval(db, approval.id, decision, owner, tenantId);
  approvalCount++;
 }
 log(`Vertex Solutions: ${approvalCount} approval requests.`);

 // --- Escalations as "Tasks" + workload distribution (Part 20) ------------------------------
 const taskThemes = [
  ['P1', 'متابعة عرض سعر لم يُرد عليه العميل', 'المبيعات'], ['P2', 'مراجعة مسودة مقترح لعميل', 'العمليات'],
  ['P0', 'عميل مصنّف بمخاطرة مرتفعة يحتاج تدخلًا', 'نجاح العملاء'], ['P3', 'تجهيز تقرير تنفيذي أسبوعي', 'الإدارة'],
  ['P2', 'تحديث حالة مشروع نشط', 'العمليات'], ['P4', 'جدولة اجتماع متابعة مع عميل', 'المبيعات'],
  ['P1', 'مراجعة عقد قبل التوقيع', 'الإدارة'], ['P3', 'تحضير محتوى تسويقي لعميل جديد', 'التسويق']
 ];
 let taskCount = 0;
 const overloadedAssignee = team.length > 1 ? team[1] : owner;
 for (let i = 0; i < 45; i++) {
  const [priority, reasonBase, dept] = pick(rng, taskThemes);
  const daysBack = randInt(rng, 0, 89);
  const esc = createEscalation(db, { runId: null, agentId: pick(rng, ['frost', 'leads', 'followup', 'performance']), priority, reason: `${reasonBase} (${dept}) — بيانات تجريبية`, context: { department: dept, demo: true, assignedToDemo: i % 3 === 0 ? overloadedAssignee.name : null }, tenantId });
  db.prepare('UPDATE agent_escalations SET created_at=? WHERE id=?').run(daysAgoIso(daysBack), esc.id);
  if (rng() < 0.5) db.prepare('UPDATE agent_escalations SET status=?,resolved_at=?,resolved_by=?,resolved_by_name=? WHERE id=?').run('RESOLVED', daysAgoIso(Math.max(0, daysBack - randInt(rng, 0, 3))), owner.id, owner.name, esc.id);
  taskCount++;
 }
 log(`Vertex Solutions: ${taskCount} task-equivalent escalations (real workload skew toward "${overloadedAssignee.name}" via context metadata — no dedicated workload table exists, see docs/INVESTOR_DEMO.md).`);

 // --- Agents (Part 25 — leads/followup/sales/performance/frost strongest) -------------------
 for (const agentId of ['frost', 'strategy', 'copy', 'creative', 'compliance', 'publishing', 'leads', 'sales', 'followup', 'intelligence', 'performance', 'memory']) {
  updateTenantAgentConfig(db, tenantId, agentId, { enabled: true, model: 'claude-sonnet-5' });
 }
 setAutonomy(store, 'leads', { level: 'L1', reason: 'تمكين مستوى استقلالية أولي لوكيل العملاء المحتملين (بيانات تجريبية)', expectedVersion: 0 }, owner, {}, tenantId);
 setAutonomy(store, 'followup', { level: 'L1', reason: 'تمكين مستوى استقلالية أولي لوكيل المتابعة (بيانات تجريبية)', expectedVersion: 0 }, owner, {}, tenantId);
 log('Vertex Solutions: 12 agents configured; leads + followup promoted to L1.');

 // --- Activity feed / audit trail ------------------------------------------------------------
 let activityCount = 0;
 for (let i = 0; i < 40; i++) {
  const narrative = pick(rng, VERTEX_ACTIVITY_NARRATIVES);
  const daysBack = randInt(rng, 0, 89);
  recordAudit(db, { id: randomUUID(), action: narrative.action, itemId: null, actorId: 'system', actorName: 'Frost (Demo)', detail: narrative.detail + ' (بيانات تجريبية)', at: daysAgoIso(daysBack) }, tenantId);
  activityCount++;
 }
 log(`Vertex Solutions: ${activityCount} historical activity/audit entries over the last 90 days.`);

 // --- Reports ---------------------------------------------------------------------------------
 saveDailyBrief(store, dateOnly(new Date()), owner, tenantId);
 const extras = tid => ({ agents: listRegistryAgents(db), agentRuns: listRuns(db, { limit: 2000 }, tid), escalations: listEscalations(db, {}, tid), approvals: listApprovals(db, {}, tid), env: {} });
 for (let w = 0; w < 4; w++) {
  const weekStart = dateOnly(new Date(mostRecentSunday().getTime() - w * 7 * 86400000));
  saveWeeklyReport(store, weekStart, owner, extras(tenantId), tenantId);
 }
 log('Vertex Solutions: latest daily brief + 4 weekly reports generated from real seeded data.');

 return tenantId;
}

// --- Investor demo account (Part 33) — owner-level access to BOTH tenants -------------------
function seedInvestorUser(novaId, vertexId) {
 let user = db.prepare('SELECT id,username,name,role FROM users WHERE username=?').get(DEMO_USERNAME);
 if (!user) {
  user = auth.createUser({ username: DEMO_USERNAME, name: 'Investor Demo', password: DEMO_PASSWORD }, 'owner');
  log(`Investor demo account created: ${DEMO_USERNAME}`);
 } else {
  log(`Investor demo account already exists: ${DEMO_USERNAME}`);
 }
 addMembership(novaId, user.id, 'owner', false);
 addMembership(vertexId, user.id, 'owner', false);
 log('Investor demo account attached as owner to both Nova Store and Vertex Solutions.');
}

// --- Run ---------------------------------------------------------------------------------------
try {
 log('Starting investor demo seed (deterministic, no network calls, no real secrets)...');
 const novaId = seedNova();
 const vertexId = seedVertex();
 seedInvestorUser(novaId, vertexId);
 log('Done. Run `npm run demo:status` to see record counts, or log in as investor_demo to view the demo.');
} finally {
 app.store.close();
}
