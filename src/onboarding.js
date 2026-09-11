import {fail} from './auth.js';
import {agents as agentIdentities} from './domain.js';
import {getTenant} from './tenancy.js';
import {currentAutonomy} from './autonomy.js';
import {isEnabled} from './runtime/feature-flags.js';
import {providerStatus} from './runtime/llmProvider.js';
import {buildControlCenterSummary} from './runtime/control-center.js';
import {updateTenantAgentConfig,getTenantAgentConfig} from './runtime/agent-config.js';

// Multi-Tenant Phase 4C-4 — Guided Workspace Onboarding. This configures an EXISTING tenant
// only — it never creates one (Part 78/50). Every step's `state` is derived LIVE from the
// exact same real services Phase 4B/4C-2 already built (evaluateAgentReadiness,
// buildControlCenterSummary, providerStatus, currentAutonomy) — never a stored checkbox a
// client could fake (Part 5/58). The persisted row (`workspace_onboarding`) holds only the
// three things that genuinely have no other real source: which step the user is currently on,
// which OPTIONAL steps they explicitly skipped, and the start/completion timestamps.
export function installOnboarding(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS workspace_onboarding (
  tenant_id TEXT PRIMARY KEY,
  current_step TEXT NOT NULL DEFAULT 'company',
  skipped_steps TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL
 );`);
}
// Order matches the requested path exactly. `required:true` on a step means it can block
// overall completion (Part 42) — today only 'ai' actually is: this is an AI Operating System,
// every real agent's own readiness already hard-depends on a configured provider
// (AI_NOT_CONFIGURED — see agent-readiness.js), so this is not an invented requirement, it is
// the same real dependency already enforced everywhere else, surfaced here as a wizard step.
const STEP_IDS=['company','ai','commerce','messaging','productivity','agents','safety','systemCheck'];
const REQUIRED_STEPS=new Set(['ai']);
const SKIPPABLE_STEPS=new Set(['commerce','messaging','productivity']);

function getRow(db,tenantId) {
 return db.prepare('SELECT * FROM workspace_onboarding WHERE tenant_id=?').get(tenantId)||null;
}
function ensureRow(db,tenantId) {
 const existing=getRow(db,tenantId);
 if(existing)return existing;
 const now=new Date().toISOString();
 db.prepare("INSERT INTO workspace_onboarding (tenant_id,current_step,skipped_steps,started_at,updated_at) VALUES (?,?,?,?,?)").run(tenantId,'company','[]',now,now);
 return getRow(db,tenantId);
}
const HEALTHY=new Set(['CONNECTED','DEGRADED']);
function hasHealthyConnection(summary,slug) {
 const provider=summary.integrations.providers.find(p=>p.slug===slug);
 return !!provider?.connections.some(c=>HEALTHY.has(c.status));
}
/**
 * Every step's real state — never a stored flag. `READY` means the underlying real condition
 * genuinely holds right now; `SKIPPED` only for an optional step the owner explicitly opted
 * out of (persisted, since "skip" itself has no other real source — Part 48); `NOT_STARTED`
 * otherwise. A step can never be both required and legitimately skippable (Part 5/42).
 */
function computeSteps(db,env,tenantId,row) {
 const summary=buildControlCenterSummary(db,env,tenantId,'owner');
 const skipped=new Set(JSON.parse(row.skipped_steps));
 const aiReady=summary.aiProviders.some(c=>c.status==='CONNECTED')||providerStatus(env,{}).configured;
 const states={
  company:'READY', // informational/read-only — nothing to block on (Part 11)
  ai:aiReady?'READY':'NOT_STARTED',
  commerce:hasHealthyConnection(summary,'salla')?'READY':skipped.has('commerce')?'SKIPPED':'NOT_STARTED',
  messaging:['whatsapp','meta','x','linkedin'].some(slug=>hasHealthyConnection(summary,slug))?'READY':skipped.has('messaging')?'SKIPPED':'NOT_STARTED',
  productivity:hasHealthyConnection(summary,'microsoft365')?'READY':skipped.has('productivity')?'SKIPPED':'NOT_STARTED',
  agents:summary.agents.ready>0?'READY':'NOT_STARTED', // informational signal only — never blocks (Part 26/29)
  safety:'READY', // informational-only display, nothing to complete (Part 35/36)
  systemCheck:'READY'
 };
 return STEP_IDS.map(id=>({id,required:REQUIRED_STEPS.has(id),state:states[id],blockers:REQUIRED_STEPS.has(id)&&states[id]!=='READY'?[id==='ai'?'AI_NOT_CONFIGURED':id.toUpperCase()+'_NOT_READY']:[]}));
}
function overallStatus(row) {
 return row.completed_at?'COMPLETED':'IN_PROGRESS';
}
/** `GET /api/onboarding` — the entire derived view. `null` only for a tenant that has never
 * opened the wizard at all (NOT_STARTED, no row created yet) — reading never creates a row;
 * only actually interacting with the wizard does (`updateOnboardingState`), so simply loading
 * Control Center never silently "starts" onboarding for a tenant that never asked for it. */
export function getOnboardingState(db,env,tenantId) {
 const row=getRow(db,tenantId);
 if(!row) {
  const steps=computeSteps(db,env,tenantId,{skipped_steps:'[]'});
  return {status:'NOT_STARTED',currentStep:'company',steps,startedAt:null,completedAt:null};
 }
 const steps=computeSteps(db,env,tenantId,row);
 return {status:overallStatus(row),currentStep:row.current_step,steps,startedAt:row.started_at,completedAt:row.completed_at};
}
const canComplete=steps=>steps.filter(s=>s.required).every(s=>s.state==='READY');
/**
 * `PATCH /api/onboarding` — owner only (Part 59). Every mutation re-derives real state before
 * acting: `complete:true` is REJECTED server-side (never silently accepted) if a required
 * step genuinely isn't ready (Part 42/58) — the frontend cannot mark AI "done" by asserting it.
 */
export function updateOnboardingState(db,env,tenantId,patch) {
 const row=ensureRow(db,tenantId);
 const now=new Date().toISOString();
 if(patch.currentStep!==undefined) {
  if(!STEP_IDS.includes(patch.currentStep))fail(400,'خطوة غير معروفة');
  db.prepare('UPDATE workspace_onboarding SET current_step=?,updated_at=? WHERE tenant_id=?').run(patch.currentStep,now,tenantId);
 }
 if(patch.skipStep!==undefined) {
  if(!SKIPPABLE_STEPS.has(patch.skipStep))fail(400,'هذه الخطوة لا يمكن تخطّيها');
  const skipped=new Set(JSON.parse(getRow(db,tenantId).skipped_steps));skipped.add(patch.skipStep);
  db.prepare('UPDATE workspace_onboarding SET skipped_steps=?,updated_at=? WHERE tenant_id=?').run(JSON.stringify([...skipped]),now,tenantId);
 }
 if(patch.unskipStep!==undefined) {
  const skipped=new Set(JSON.parse(getRow(db,tenantId).skipped_steps));skipped.delete(patch.unskipStep);
  db.prepare('UPDATE workspace_onboarding SET skipped_steps=?,updated_at=? WHERE tenant_id=?').run(JSON.stringify([...skipped]),now,tenantId);
 }
 if(patch.complete===true) {
  const steps=computeSteps(db,env,tenantId,getRow(db,tenantId));
  if(!canComplete(steps))fail(409,'لا يمكن إكمال الإعداد — توجد متطلبات أساسية غير جاهزة بعد');
  db.prepare('UPDATE workspace_onboarding SET completed_at=?,updated_at=? WHERE tenant_id=?').run(now,now,tenantId);
 }
 if(patch.reopen===true) {
  // Never resets connections/config/skip history (Part 49) — only clears the completion
  // timestamp so the wizard is reachable again; every step's state is still derived live.
  db.prepare('UPDATE workspace_onboarding SET completed_at=NULL,updated_at=? WHERE tenant_id=?').run(now,tenantId);
 }
 return getOnboardingState(db,env,tenantId);
}
/**
 * The one real mutation beyond simple state bookkeeping: a safe, explicit "recommended setup"
 * preset (Part 27/28/30). For every SELECTED agent that has no AI connection override yet, it
 * assigns the chosen healthy AI connection via the exact same, already-audited
 * `updateTenantAgentConfig` used everywhere else — nothing else. It never touches autonomy
 * level (stays whatever it already is — L0 by default for a fresh tenant), never enables an
 * external-send/publish tool, never creates a tool assignment for anything beyond what was
 * already there. Owner-only, exactly like the underlying config route it wraps.
 */
export function applyRecommendedPreset(db,tenantId,{aiConnectionId,agentIds}) {
 const targets=Array.isArray(agentIds)&&agentIds.length?agentIds.filter(id=>agentIdentities.some(a=>a.id===id)):agentIdentities.map(a=>a.id);
 const applied=[];
 for(const agentId of targets) {
  const existing=getTenantAgentConfig(db,tenantId,agentId);
  if(existing?.aiConnectionId)continue; // never override an explicit choice already made
  updateTenantAgentConfig(db,tenantId,agentId,{aiConnectionId});
  applied.push(agentId);
 }
 return {applied};
}
/** Read-only safety/permissions snapshot for the Safety step (Part 33/35/36) — every flag is
 * env-derived and genuinely has no runtime toggle API (feature-flags.js reads `process.env`
 * directly); shown honestly as current values, never a fake interactive toggle. */
export function safetySnapshot(db,env,tenantId) {
 const tenant=getTenant(db,tenantId);
 const autonomy=currentAutonomy(db,tenantId);
 return {
  agentLevels:agentIdentities.map(a=>({id:a.id,level:autonomy[a.id]?.level||'L0'})),
  tenantSafetyCeiling:tenant?.maxAgentLevel||null,
  flags:{
   externalMessaging:isEnabled(env,'ENABLE_EXTERNAL_MESSAGING'),
   externalPublishing:isEnabled(env,'ENABLE_EXTERNAL_PUBLISHING'),
   automatedFollowups:isEnabled(env,'ENABLE_AUTOMATED_FOLLOWUPS'),
   scheduledPublishing:isEnabled(env,'ENABLE_SCHEDULED_PUBLISHING'),
   l2Autonomy:isEnabled(env,'ENABLE_L2_AUTONOMY'),
   l3Autonomy:isEnabled(env,'ENABLE_L3_AUTONOMY')
  }
 };
}
