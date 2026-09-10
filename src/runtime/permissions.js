import {currentAutonomy,listAutonomyLog,levels} from '../autonomy.js';

// AgentPermissionService. The level itself stays owned by src/autonomy.js (the real,
// audited, human-only L0-L3 ledger already built) — this module only adds what was
// still missing: turning the level into an actual gate on tool use, and computing
// promotion eligibility from real run history instead of a fixed badge.
export function levelOf(db,agentId) {
 return currentAutonomy(db)[agentId]?.level||'L0';
}
// Launch-safety cap: SYSTEM_MODE=PRODUCTION_SAFE (see DEPLOYMENT.md) forces every agent
// down to L1 regardless of what's stored in the audited autonomy ledger, without touching
// the ledger itself — an owner can still see/set L2/L3 in the UI, it just won't take
// effect until SYSTEM_MODE is raised. Any other/unset SYSTEM_MODE leaves the real stored
// level untouched (unchanged, backward-compatible default behavior).
const SYSTEM_MODE_CAPS={PRODUCTION_SAFE:'L1'};
export function effectiveLevel(dbLevel,env={}) {
 const cap=SYSTEM_MODE_CAPS[env.SYSTEM_MODE];
 if(!cap)return dbLevel;
 return levels.indexOf(dbLevel)<=levels.indexOf(cap)?dbLevel:cap;
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
export function computeHealth(db,agentId,sinceDays=14) {
 const since=new Date(Date.now()-sinceDays*DAY_MS).toISOString();
 const runs=db.prepare('SELECT status,output FROM agent_runs WHERE agent_id=? AND started_at>=?').all(agentId,since);
 const successful_runs=runs.filter(r=>r.status==='COMPLETED').length;
 const failed_runs=runs.filter(r=>r.status==='FAILED').length;
 const compliance_blocks=runs.filter(r=>{try{return JSON.parse(r.output||'null')?.status==='BLOCKED';}catch{return false;}}).length;
 const approvals=db.prepare('SELECT status FROM agent_approvals WHERE agent_id=? AND created_at>=?').all(agentId,since);
 const decided=approvals.filter(a=>a.status!=='PENDING');
 const human_overrides=approvals.filter(a=>['REJECTED','EDITED'].includes(a.status)).length;
 const approval_acceptance_rate=decided.length?approvals.filter(a=>a.status==='APPROVED').length/decided.length:null;
 const tool_failures=db.prepare("SELECT COUNT(*) AS n FROM agent_tool_calls WHERE status='ERROR' AND run_id IN (SELECT id FROM agent_runs WHERE agent_id=? AND started_at>=?)").get(agentId,since).n;
 const critical_incidents=db.prepare("SELECT COUNT(*) AS n FROM agent_escalations WHERE agent_id=? AND priority='P0' AND created_at>=?").get(agentId,since).n;
 return {sinceDays,successful_runs,failed_runs,compliance_blocks,human_overrides,approval_acceptance_rate,tool_failures,critical_incidents};
}
// Never promotes anything — only reports whether the 14-day clean-run bar (scope
// doc section 8) is met. The owner still has to act on it via POST /api/agents/:id/autonomy.
export function promotionEligibility(db,agentId) {
 const health=computeHealth(db,agentId,14);
 const log=listAutonomyLog(db,agentId);
 const lastChange=log[0]?.at||null;
 const earliestRun=db.prepare('SELECT MIN(started_at) AS at FROM agent_runs WHERE agent_id=?').get(agentId).at;
 // Clean-since anchor is the last human level change, or (if the level has never
 // changed) this agent's very first run — never just "some runs exist somewhere".
 const referencePoint=lastChange||earliestRun;
 const cleanSince=referencePoint?Date.now()-Date.parse(referencePoint)>=14*DAY_MS:false;
 const clean=health.failed_runs===0 && health.compliance_blocks===0 && health.critical_incidents===0 && health.successful_runs>0;
 const eligible=clean && cleanSince;
 return {eligible,status:eligible?'ELIGIBLE_FOR_PROMOTION':'NOT_ELIGIBLE',health,lastLevelChangeAt:lastChange,referencePoint};
}
