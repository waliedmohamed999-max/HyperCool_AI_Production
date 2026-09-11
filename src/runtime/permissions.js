import {currentAutonomy,listAutonomyLog,levels} from '../autonomy.js';
import {resolveActiveTenantId} from '../tenancy.js';

// AgentPermissionService. The level itself stays owned by src/autonomy.js (the real,
// audited, human-only L0-L3 ledger already built) — this module only adds what was
// still missing: turning the level into an actual gate on tool use, and computing
// promotion eligibility from real run history instead of a fixed badge.
//
// Multi-Tenant Phase 4B: every function here now takes an explicit, optional tenantId
// (same pattern as everywhere else), since `agent_autonomy` and the run/approval/escalation
// history `computeHealth` reads from are all tenant-scoped as of this phase — Company A's
// clean 14-day run history must never make Company B's same-named agent eligible for
// promotion (see docs/AGENT_READINESS.md).
export function levelOf(db,agentId,tenantId=null) {
 return currentAutonomy(db,tenantId)[agentId]?.level||'L0';
}
// Launch-safety cap: SYSTEM_MODE=PRODUCTION_SAFE (see DEPLOYMENT.md) forces every agent
// down to L1 regardless of what's stored in the audited autonomy ledger, without touching
// the ledger itself — an owner can still see/set L2/L3 in the UI, it just won't take
// effect until SYSTEM_MODE is raised. Any other/unset SYSTEM_MODE leaves the real stored
// level untouched (unchanged, backward-compatible default behavior).
const SYSTEM_MODE_CAPS={PRODUCTION_SAFE:'L1'};
// Multi-Tenant Phase 4B (Part 37) — a tenant-level safety ceiling (`tenants.max_agent_level`,
// nullable — see tenancy.js) stacks with the existing system-wide SYSTEM_MODE cap: the
// EFFECTIVE level is always min(stored agent level, tenant ceiling if set, system cap if
// set). A platform operator's SYSTEM_MODE=PRODUCTION_SAFE cap can never be raised by a
// tenant's own config, and a tenant's own ceiling can never be raised by an agent's stored
// level — both are hard ceilings, never floors.
export function effectiveLevel(dbLevel,env={},tenantMaxLevel=null) {
 let level=dbLevel;
 const systemCap=SYSTEM_MODE_CAPS[env.SYSTEM_MODE];
 if(systemCap && levels.indexOf(level)>levels.indexOf(systemCap))level=systemCap;
 if(tenantMaxLevel && levels.indexOf(level)>levels.indexOf(tenantMaxLevel))level=tenantMaxLevel;
 return level;
}
// agentId is optional so every existing call site (permission-level-only checks) keeps
// working unchanged; pass it whenever a tool might carry an `allowedAgents` restriction
// (e.g. only Frost/Sales/Follow-up may create calendar events — see runtime/tools.js).
export function canUseTool(level,tool,agentId) {
 if(tool.allowedAgents && agentId && !tool.allowedAgents.includes(agentId))return false;
 if(!tool.minLevel)return true;
 return levels.indexOf(level)>=levels.indexOf(tool.minLevel);
}
const DAY_MS=86400000;
// Multi-Tenant Phase 4B (Part 83/84): every query here is now tenant-scoped. Before this
// phase, `agent_runs`/`agent_approvals`/`agent_escalations` already carried a real
// `tenant_id` column (Phase 2), but this function never filtered by it — Tenant A's clean
// run history could silently make Tenant B's identically-named agent ("sales") look eligible
// for promotion, since both share the same GLOBAL `agent_id`. `agent_tool_calls` has no
// `tenant_id` column of its own (by design — see runtime.js's schema comment); it stays
// scoped transitively through the now-tenant-filtered `agent_runs` subquery.
export function computeHealth(db,agentId,sinceDays=14,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const since=new Date(Date.now()-sinceDays*DAY_MS).toISOString();
 const runs=db.prepare('SELECT status,output FROM agent_runs WHERE tenant_id=? AND agent_id=? AND started_at>=?').all(resolvedTenantId,agentId,since);
 const successful_runs=runs.filter(r=>r.status==='COMPLETED').length;
 const failed_runs=runs.filter(r=>r.status==='FAILED').length;
 const compliance_blocks=runs.filter(r=>{try{return JSON.parse(r.output||'null')?.status==='BLOCKED';}catch{return false;}}).length;
 const approvals=db.prepare('SELECT status FROM agent_approvals WHERE tenant_id=? AND agent_id=? AND created_at>=?').all(resolvedTenantId,agentId,since);
 const decided=approvals.filter(a=>a.status!=='PENDING');
 const human_overrides=approvals.filter(a=>['REJECTED','EDITED'].includes(a.status)).length;
 const approval_acceptance_rate=decided.length?approvals.filter(a=>a.status==='APPROVED').length/decided.length:null;
 const tool_failures=db.prepare("SELECT COUNT(*) AS n FROM agent_tool_calls WHERE status='ERROR' AND run_id IN (SELECT id FROM agent_runs WHERE tenant_id=? AND agent_id=? AND started_at>=?)").get(resolvedTenantId,agentId,since).n;
 const critical_incidents=db.prepare("SELECT COUNT(*) AS n FROM agent_escalations WHERE tenant_id=? AND agent_id=? AND priority='P0' AND created_at>=?").get(resolvedTenantId,agentId,since).n;
 return {sinceDays,successful_runs,failed_runs,compliance_blocks,human_overrides,approval_acceptance_rate,tool_failures,critical_incidents};
}
// Never promotes anything — only reports whether the 14-day clean-run bar (scope
// doc section 8) is met. The owner still has to act on it via POST /api/agents/:id/autonomy.
export function promotionEligibility(db,agentId,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const health=computeHealth(db,agentId,14,resolvedTenantId);
 const log=listAutonomyLog(db,agentId,resolvedTenantId);
 const lastChange=log[0]?.at||null;
 const earliestRun=db.prepare('SELECT MIN(started_at) AS at FROM agent_runs WHERE tenant_id=? AND agent_id=?').get(resolvedTenantId,agentId).at;
 // Clean-since anchor is the last human level change, or (if the level has never
 // changed) this agent's very first run — never just "some runs exist somewhere".
 const referencePoint=lastChange||earliestRun;
 const cleanSince=referencePoint?Date.now()-Date.parse(referencePoint)>=14*DAY_MS:false;
 const clean=health.failed_runs===0 && health.compliance_blocks===0 && health.critical_incidents===0 && health.successful_runs>0;
 const eligible=clean && cleanSince;
 return {eligible,status:eligible?'ELIGIBLE_FOR_PROMOTION':'NOT_ELIGIBLE',health,lastLevelChangeAt:lastChange,referencePoint};
}
