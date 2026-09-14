import {randomUUID} from 'node:crypto';
import {fail} from '../auth.js';
import {resolveActiveTenantId} from '../tenancy.js';
import {recordAudit} from '../audit.js';

// Command Center Phase 7B (spec Part 12-14) — Command Runbooks/Templates. Deliberately NOT a
// new execution engine: a runbook is just a saved natural-language command string plus a label
// — "Run" sends that exact text through the SAME sendCommandMessage() -> agentRuntime.run(
// 'frost_commander', …) pipeline a human typing it would go through (spec item 14: "Frost
// executes same underlying command pipeline"). This is also how Command Favorites (item 45)
// and the one-click Executive Review (item 38) are implemented — a favorite is just a
// personal, non-builtin runbook; Executive Review is the one BUILT_IN runbook whose command
// text triggers frost_commander's multi-agent delegation tool.
export const BUILTIN_RUNBOOKS=[
 {key:'executive_daily_review',nameAr:'المراجعة التنفيذية اليومية',nameEn:'Executive Daily Review',
  descriptionAr:'ملخص تنفيذي شامل يغطي الأداء والمخاطر والفرص والعمليات والعملاء والفريق والتكاملات، بتفويض متعدد الوكلاء.',
  commandText:'قدّم مراجعة تنفيذية شاملة الآن: حلّل الأداء عبر وكيل الأداء، وارصد اتجاهات السوق والمنافسين عبر وكيل رصد السوق، وحلّل فرص اكتساب العملاء عبر وكيل العملاء المحتملين، ثم لخّص كل ذلك في تقرير تنفيذي واحد يغطي: الملخص التنفيذي، الأداء، المخاطر، الفرص، العمليات، العملاء، التكاملات، والإجراءات الموصى بها.'},
 {key:'weekly_growth_review',nameAr:'مراجعة النمو الأسبوعية',nameEn:'Weekly Growth Review',
  descriptionAr:'مراجعة أسبوعية لمؤشرات النمو والتوصيات القابلة للتنفيذ.',
  commandText:'اعرض تقرير الأداء الأسبوعي الحالي مع أهم الفرص والمخاطر.'},
 {key:'lead_followup_review',nameAr:'مراجعة متابعة العملاء',nameEn:'Lead Follow-up Review',
  descriptionAr:'العملاء المحتاجين متابعة الآن والعملاء ذوو الأولوية العالية.',
  commandText:'اعرض العملاء المحتاجين متابعة الآن والعملاء ذوي الأولوية العالية.'},
 {key:'campaign_health_check',nameAr:'فحص صحة الحملات',nameEn:'Campaign Health Check',
  descriptionAr:'تحليل أداء المحتوى والحملات الحالية عبر وكيل الأداء.',
  commandText:'حلّل أداء المحتوى والحملات الحالية عبر وكيل الأداء ولخّص أهم النتائج والتوصيات.'},
 {key:'operations_risk_scan',nameAr:'فحص مخاطر العمليات',nameEn:'Operations Risk Scan',
  descriptionAr:'حالة الموافقات المعلقة والمهام المفتوحة والاتصالات غير السليمة.',
  commandText:'اعرض حالة التشغيل العامة: الموافقات المعلقة، المهام المفتوحة، والاتصالات غير السليمة.'},
 {key:'integration_health_review',nameAr:'مراجعة صحة التكاملات',nameEn:'Integration Health Review',
  descriptionAr:'حالة كل التكاملات المتصلة الآن.',
  commandText:'افحص التكاملات واعرض حالة كل اتصال الآن.'},
 {key:'team_workload_review',nameAr:'مراجعة عبء عمل الفريق',nameEn:'Team Workload Review',
  descriptionAr:'خريطة الوكلاء والأدوات وحالة الجاهزية.',
  commandText:'اعرض خريطة الوكلاء والأدوات وحالة كل وكيل الآن.'}
];

export function installRunbooks(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS command_runbooks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  key TEXT,
  name TEXT NOT NULL,
  description TEXT,
  command_text TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_by_name TEXT,
  created_at TEXT NOT NULL,
  archived_at TEXT
 );
 CREATE INDEX IF NOT EXISTS idx_command_runbooks_tenant ON command_runbooks(tenant_id,archived_at);`);
}
function hydrate(row) {
 if(!row)return null;
 return {id:row.id,tenantId:row.tenant_id,key:row.key,name:row.name,description:row.description,
  commandText:row.command_text,isBuiltin:!!row.is_builtin,createdBy:row.created_by,createdByName:row.created_by_name,
  createdAt:row.created_at,archivedAt:row.archived_at};
}
/** Tenant-isolated (item 13): every tenant gets its OWN copy of the 7 built-in runbooks the
 * first time this is called for it, seeded once (idempotent — checked by `key`), so a tenant
 * can archive/rename its own copy without affecting any other tenant. */
function ensureBuiltinsSeeded(db,tenantId) {
 const existingKeys=new Set(db.prepare('SELECT key FROM command_runbooks WHERE tenant_id=? AND is_builtin=1').all(tenantId).map(r=>r.key));
 const now=new Date().toISOString();
 for(const rb of BUILTIN_RUNBOOKS) {
  if(existingKeys.has(rb.key))continue;
  db.prepare(`INSERT INTO command_runbooks (id,tenant_id,key,name,description,command_text,is_builtin,created_at) VALUES (?,?,?,?,?,?,1,?)`)
   .run(randomUUID(),tenantId,rb.key,rb.nameAr,rb.descriptionAr,rb.commandText,now);
 }
}
export function listRunbooks(db,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 ensureBuiltinsSeeded(db,resolvedTenantId);
 return db.prepare('SELECT * FROM command_runbooks WHERE tenant_id=? AND archived_at IS NULL ORDER BY is_builtin DESC,created_at').all(resolvedTenantId).map(hydrate);
}
export function getRunbook(db,id,tenantId=null) {
 const row=db.prepare('SELECT * FROM command_runbooks WHERE id=? AND tenant_id=?').get(id,tenantId||resolveActiveTenantId(db));
 if(!row)fail(404,'القالب غير موجود');
 return hydrate(row);
}
/** A saved "Favorite" (spec item 45) is just a personal, non-builtin runbook — same table,
 * same execution path, no second concept. */
export function createRunbook(db,{name,description,commandText},user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const cleanName=typeof name==='string'?name.trim().slice(0,200):'';
 const cleanCommand=typeof commandText==='string'?commandText.trim().slice(0,2000):'';
 if(!cleanName)fail(400,'اسم القالب مطلوب');
 if(!cleanCommand)fail(400,'نص الأمر مطلوب');
 const id=randomUUID(),now=new Date().toISOString();
 db.prepare(`INSERT INTO command_runbooks (id,tenant_id,key,name,description,command_text,is_builtin,created_by,created_by_name,created_at) VALUES (?,?,NULL,?,?,?,0,?,?,?)`)
  .run(id,resolvedTenantId,cleanName,(description||'').trim().slice(0,500)||null,cleanCommand,user?.id||null,user?.name||null,now);
 recordAudit(db,{id:randomUUID(),action:'COMMAND_RUNBOOK_CREATED',itemId:id,actorId:user?.id||null,actorName:user?.name||null,actorRole:user?.role||null,at:now},resolvedTenantId);
 return getRunbook(db,id,resolvedTenantId);
}
export function archiveRunbook(db,id,user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const runbook=getRunbook(db,id,resolvedTenantId);
 if(runbook.isBuiltin)fail(400,'لا يمكن حذف قالب أساسي — يمكن فقط إضافة قوالب مخصصة جديدة');
 db.prepare('UPDATE command_runbooks SET archived_at=? WHERE id=? AND tenant_id=?').run(new Date().toISOString(),id,resolvedTenantId);
 recordAudit(db,{id:randomUUID(),action:'COMMAND_RUNBOOK_ARCHIVED',itemId:id,actorId:user?.id||null,actorName:user?.name||null,actorRole:user?.role||null,at:new Date().toISOString()},resolvedTenantId);
 return {archived:true};
}
