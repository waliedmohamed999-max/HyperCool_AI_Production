import {randomUUID,createHash} from 'node:crypto';
import {fail} from '../auth.js';
import {resolveActiveTenantId} from '../tenancy.js';
import {listLeads,listFollowups} from '../crm.js';
import {listEscalations} from './escalations.js';
import {listApprovals} from './approvals.js';
import {listConnections} from '../integrations/connections.js';
import {listProducts} from '../knowledge.js';
import {createEscalation} from './escalations.js';
import {recordAudit} from '../audit.js';

// Suggestions — Frost Command Center (Phase 7A). Computed FRESH from real state on every
// read (never a background job — see module doc below), then UPSERTed against a
// deterministic id so an already-Accepted/Dismissed suggestion never resurfaces just because
// the underlying condition is still true. No suggestion here is ever fabricated: every one
// carries the real record(s) behind it in `evidence`, shown verbatim by the "Why?" drawer.
export function installSuggestions(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_json TEXT,
  impact TEXT,
  recommended_action TEXT,
  priority TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','ACCEPTED','DISMISSED')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
 );
 CREATE INDEX IF NOT EXISTS idx_suggestions_tenant_status ON suggestions(tenant_id,status);`);
}
function hydrate(row) {
 if(!row)return null;
 return {id:row.id,tenantId:row.tenant_id,type:row.type,title:row.title,reason:row.reason,
  evidence:row.evidence_json?JSON.parse(row.evidence_json):null,impact:row.impact,
  recommendedAction:row.recommended_action,priority:row.priority,status:row.status,
  createdAt:row.created_at,resolvedAt:row.resolved_at};
}
function stableId(tenantId,type,entityId) {
 return createHash('sha256').update(`${tenantId}:${type}:${entityId}`).digest('hex').slice(0,32);
}
const UNHEALTHY_STATUSES=new Set(['ERROR','TOKEN_EXPIRED','PERMISSION_MISSING','DEGRADED']);
const FOLLOWUP_ELIGIBLE_STAGES=['QUOTE_SENT','DEMO','POST_PURCHASE'];
const STALE_APPROVAL_MS=48*3600000;
const HIGH_VALUE_THRESHOLD_SAR=50000;

function computeCurrent(db,tenantId) {
 const out=[];
 const now=Date.now();
 for(const f of listFollowups(db,tenantId).filter(f=>f.status==='DRAFT'&&f.dueAt&&Date.parse(f.dueAt)<now)) {
  out.push({type:'overdue_followup',entityId:f.id,title:'متابعة متأخرة عن موعدها',
   reason:`متابعة مجدولة لعميل (${f.leadId}) تجاوزت موعدها المحدد ${f.dueAt} ولم تُعتمد أو تُرسل بعد.`,
   evidence:{followupId:f.id,leadId:f.leadId,dueAt:f.dueAt,status:f.status},
   impact:'قد يفقد العميل الاهتمام أو تُفوَّت فرصة إغلاق الصفقة.',
   recommendedAction:'راجع المتابعة من صفحة العملاء واعتمدها أو أعد جدولتها.',priority:'MEDIUM'});
 }
 for(const c of listConnections(db,{},tenantId).filter(c=>UNHEALTHY_STATUSES.has(c.status))) {
  out.push({type:'unhealthy_connection',entityId:c.id,title:`اتصال "${c.name}" يحتاج انتباهًا`,
   reason:`حالة الاتصال الحالية: ${c.status}${c.lastErrorCode?` (آخر خطأ: ${c.lastErrorCode})`:''}.`,
   evidence:{connectionId:c.id,name:c.name,integration:c.integrationDefinitionId,status:c.status,lastErrorCode:c.lastErrorCode,lastErrorAt:c.lastErrorAt},
   impact:'قد تتوقف الأدوات المعتمدة على هذا الاتصال عن العمل بشكل صحيح.',
   recommendedAction:'أعد الاتصال أو جدّد الصلاحيات من صفحة التكاملات.',
   priority:c.status==='ERROR'?'HIGH':'MEDIUM'});
 }
 for(const a of listApprovals(db,{status:'PENDING'},tenantId).filter(a=>now-Date.parse(a.created_at)>STALE_APPROVAL_MS)) {
  out.push({type:'stale_approval',entityId:a.id,title:'طلب موافقة معلّق منذ أكثر من يومين',
   reason:`طلب موافقة (${a.action_type}) للوكيل ${a.agent_id} لا يزال معلّقًا منذ ${a.created_at}.`,
   evidence:{approvalId:a.id,actionType:a.action_type,agentId:a.agent_id,createdAt:a.created_at,riskLevel:a.risk_level},
   impact:'تأخير القرار قد يوقف عملًا كان يمكن إنجازه أو يُبقي عميلًا بلا رد.',
   recommendedAction:'راجع الطلب من مركز الموافقات واتخذ قرارًا.',priority:a.risk_level==='HIGH'?'HIGH':'MEDIUM'});
 }
 for(const p of listProducts(db,tenantId).filter(p=>Number.isFinite(p.stock)&&p.stock>0&&p.stock<=5)) {
  out.push({type:'low_stock',entityId:p.id,title:`مخزون منخفض: ${p.nameAr||p.nameEn||p.id}`,
   reason:`المخزون المتبقي ${p.stock} وحدة فقط حسب آخر مزامنة (${p.syncedAt||'غير معروف'}).`,
   evidence:{productId:p.id,name:p.nameAr||p.nameEn||null,stock:p.stock,syncedAt:p.syncedAt||null},
   impact:'قد يتوقف البيع أو تفوت مبيعات إذا نفد المخزون قبل إعادة التزويد.',
   recommendedAction:'راجع إعادة التزويد أو أوقف الترويج لهذا المنتج مؤقتًا.',priority:p.stock<=2?'HIGH':'MEDIUM'});
 }
 const notClosed=lead=>!['WON','LOST'].includes(lead.stage);
 for(const lead of listLeads(db,tenantId).filter(l=>l.temperature==='HOT'&&notClosed(l)&&(l.valueSAR||0)>=HIGH_VALUE_THRESHOLD_SAR)) {
  out.push({type:'high_value_lead_waiting',entityId:lead.id,title:`فرصة عالية القيمة بانتظار المتابعة: ${lead.company||lead.name}`,
   reason:`فرصة باهتمام مرتفع بقيمة تقديرية ${lead.valueSAR} ر.س في مرحلة ${lead.stage}.`,
   evidence:{leadId:lead.id,name:lead.company||lead.name,valueSAR:lead.valueSAR,stage:lead.stage,city:lead.city||null},
   impact:'تأخر التواصل مع فرصة عالية القيمة قد يعني خسارتها لمنافس.',
   recommendedAction:'تواصل مع العميل أو جهّز عرض سعر بأسرع وقت.',priority:'HIGH'});
 }
 return out;
}
/**
 * Recomputes from real state and UPSERTs by a deterministic id (hash of tenant+type+entity),
 * preserving any existing ACCEPTED/DISMISSED status so a resolved suggestion never reappears
 * just because the underlying condition is still true — no background job needed.
 */
export function syncSuggestions(db,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const now=new Date().toISOString();
 const current=computeCurrent(db,resolvedTenantId);
 const insert=db.prepare(`INSERT INTO suggestions (id,tenant_id,type,title,reason,evidence_json,impact,recommended_action,priority,status,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,'OPEN',?)
  ON CONFLICT(id) DO UPDATE SET title=excluded.title,reason=excluded.reason,evidence_json=excluded.evidence_json,impact=excluded.impact,recommended_action=excluded.recommended_action,priority=excluded.priority
  WHERE suggestions.status='OPEN'`);
 for(const s of current) {
  const id=stableId(resolvedTenantId,s.type,s.entityId);
  insert.run(id,resolvedTenantId,s.type,s.title,s.reason,JSON.stringify(s.evidence),s.impact,s.recommendedAction,s.priority,now);
 }
 return listSuggestions(db,resolvedTenantId);
}
export function listSuggestions(db,tenantId=null,{status}={}) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const rows=status
  ?db.prepare('SELECT * FROM suggestions WHERE tenant_id=? AND status=? ORDER BY CASE priority WHEN \'HIGH\' THEN 0 WHEN \'MEDIUM\' THEN 1 ELSE 2 END,created_at DESC').all(resolvedTenantId,status)
  :db.prepare('SELECT * FROM suggestions WHERE tenant_id=? ORDER BY CASE priority WHEN \'HIGH\' THEN 0 WHEN \'MEDIUM\' THEN 1 ELSE 2 END,created_at DESC').all(resolvedTenantId);
 return rows.map(hydrate);
}
function getSuggestion(db,id,tenantId) {
 const row=db.prepare('SELECT * FROM suggestions WHERE id=? AND tenant_id=?').get(id,tenantId);
 if(!row)fail(404,'الاقتراح غير موجود');
 return hydrate(row);
}
function resolveSuggestion(db,id,status,user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const existing=getSuggestion(db,id,resolvedTenantId);
 if(existing.status!==status){
  const now=new Date().toISOString();
  db.prepare('UPDATE suggestions SET status=?,resolved_at=? WHERE id=? AND tenant_id=?').run(status,now,id,resolvedTenantId);
  recordAudit(db,{id:randomUUID(),action:'SUGGESTION_'+status,itemId:id,actorId:user?.id||null,actorName:user?.name||null,actorRole:user?.role||null,at:now},resolvedTenantId);
 }
 return getSuggestion(db,id,resolvedTenantId);
}
export function acceptSuggestion(db,id,user,tenantId=null) { return resolveSuggestion(db,id,'ACCEPTED',user,tenantId); }
export function dismissSuggestion(db,id,user,tenantId=null) { return resolveSuggestion(db,id,'DISMISSED',user,tenantId); }
/** "Create Task" from a suggestion — reuses the existing escalations-as-Tasks model verbatim. */
export function createTaskFromSuggestion(db,id,user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const suggestion=getSuggestion(db,id,resolvedTenantId);
 const escalation=createEscalation(db,{runId:null,agentId:'human',priority:suggestion.priority==='HIGH'?'P1':suggestion.priority==='MEDIUM'?'P2':'P3',
  reason:`${suggestion.title} — ${suggestion.recommendedAction||''}`.trim(),context:{suggestionId:id,evidence:suggestion.evidence},tenantId:resolvedTenantId});
 acceptSuggestion(db,id,user,resolvedTenantId);
 return escalation;
}
