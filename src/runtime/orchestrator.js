import {isPaused} from './gate.js';

// Frost — routes events to the agent(s) responsible, applying the priority and conflict
// rules from the scope doc (compliance > growth, human approval > automation, etc.).
// Deliberately thin: each route just says which agent runs and how to shape its input;
// the actual conflict/priority weighting happens where escalations are prioritized
// (see priorityFor in runtime.js) and where tools already fail closed (compliance BLOCK
// forces status BLOCKED — see agents.js — before Frost ever sees the result).
const ROUTES={
 CUSTOMER_MESSAGE_RECEIVED:{agentId:'sales',priority:'P1',buildInput:payload=>({channel:payload.channel,leadId:payload.leadId||null,message:payload.text,current_datetime:new Date().toISOString(),timezone:'Asia/Riyadh'})},
 LEAD_CREATED:{agentId:'sales',priority:'P2',buildInput:payload=>({leadId:payload.leadId,task:'triage_new_lead',customerType:payload.customerType,sourceType:payload.sourceType,current_datetime:new Date().toISOString(),timezone:'Asia/Riyadh'})},
 QUOTE_REQUESTED:{agentId:'sales',priority:'P2',buildInput:payload=>payload},
 FOLLOWUP_DUE:{agentId:'followup',priority:'P2',buildInput:payload=>payload},
 CONTENT_IDEA_CREATED:{agentId:'copy',priority:'P3',buildInput:payload=>payload},
 // Fired by planning.js's prepareDue once a scheduled item is due and still fully valid
 // (approved, hash-matched, connector-eligible) — the Publishing & Scheduling agent decides
 // which *_publish tool to call based on payload.platform. Its own tools independently
 // re-check approval/idempotency, so this route never bypasses those safeguards.
 CONTENT_PUBLISH_REQUESTED:{agentId:'publishing',priority:'P2',buildInput:payload=>payload},
 DAILY_BRIEF_REQUIRED:{agentId:'frost',priority:'P3',buildInput:payload=>payload},
 WEEKLY_REPORT_REQUIRED:{agentId:'frost',priority:'P3',buildInput:payload=>payload}
};
export function installOrchestrator(eventBus,runtime,db) {
 for(const [eventType,route] of Object.entries(ROUTES)) {
  eventBus.on(eventType,async payload=>{
   if(route.agentId==='frost')return; // Frost's own cycles are driven explicitly (see the scheduler), not re-entrantly by its own events.
   if(isPaused(db))return; // "pause all autonomous actions" must also stop event-triggered runs, not just the scheduler.
   // Multi-Tenant Phase 3: every stored event row already carries a real tenant_id
   // (src/runtime/events.js) — this is what actually threads it into the run it triggers,
   // closing the gap where a correctly tenant-tagged event used to silently fall back to
   // AgentRuntime.run()'s own default resolution instead of the event's real tenant.
   await runtime.run(route.agentId,{triggerType:'EVENT',triggerId:payload.__eventId,input:route.buildInput(payload),tenantId:payload.tenantId});
  });
 }
 return {routes:Object.keys(ROUTES)};
}
/**
 * The daily cycle Frost is supposed to run each morning. Reads only what already
 * exists (weekly report internals, escalations, autonomy) — it fabricates nothing
 * it cannot compute from real rows.
 */
export function buildDailyBrief({store,db,listEscalations,listRuns,buildBriefFn,tenantId=null}) {
 const openEscalations=listEscalations(db,{status:'OPEN'},tenantId);
 const failedRuns=listRuns(db,{limit:50},tenantId).filter(run=>run.status==='FAILED');
 const contentBrief=buildBriefFn(store,undefined,tenantId);
 return {
  generatedAt:new Date().toISOString(),
  hotEscalations:openEscalations.filter(e=>['P0','P1'].includes(e.priority)),
  openEscalations:openEscalations.length,
  failedRunsLast50:failedRuns.length,
  contentDueToday:contentBrief.decisionsNeeded,
  blockedSchedule:contentBrief.blockedJobs,
  waitingForConnector:contentBrief.waitingForConnector
 };
}
