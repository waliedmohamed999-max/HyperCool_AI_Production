import {randomUUID} from 'node:crypto';
import {getLead, updateLead, stages} from '../crm.js';
import {createApproval} from './approvals.js';
import {recordAudit} from '../audit.js';

// Phase MKT-2, Part E — a strict, allowlisted, auditable layer for applying a real sales-agent
// decision's proposed CRM changes. The agent's own `crm_updates` payload field has NO schema
// beyond "is an object" (payload-schemas.js: `crm_updates:{type:'object'}`) — the model can put
// anything in it. This file is the ONE place that ever reads it, and it never trusts it beyond
// this fixed allowlist. Everything else in the decision is ignored, not erred on (a model may
// legitimately propose a field this system doesn't support yet).
const SAFE_FIELDS=['city','productNeed','productUrl','quantity','valueSAR','timeline','budgetBand','temperature','nextCheckAt'];

// Reads the REAL, already-structured `qualification` sub-object the sales agent's own payload
// schema already defines (city/product_need/quantity/timeline/budget_band) plus
// `lead_temperature`, then layers an explicit `crm_updates` value on top (if the model also set
// one) — never the reverse, so a stray/malformed crm_updates entry can't silently shadow the
// properly-typed qualification fields. `stage` is deliberately NEVER auto-applied here — it is
// the one sensitive field this system routes through the existing Approval Engine instead (see
// proposeStageChangeApproval), regardless of what crm_updates.stage says.
export function extractSafeCrmUpdates(decisionPayload) {
 if(!decisionPayload||typeof decisionPayload!=='object')return {safe:{},stageProposal:null};
 const q=decisionPayload.qualification&&typeof decisionPayload.qualification==='object'?decisionPayload.qualification:{};
 const rawUpdates=decisionPayload.crm_updates&&typeof decisionPayload.crm_updates==='object'?decisionPayload.crm_updates:{};
 const candidate={
  city:q.city,productNeed:q.product_need,quantity:q.quantity,timeline:q.timeline,budgetBand:q.budget_band,
  temperature:decisionPayload.lead_temperature,
  ...rawUpdates
 };
 const safe={};
 for(const field of SAFE_FIELDS) {
  const value=candidate[field];
  if(value!==undefined && value!==null && value!=='')safe[field]=value;
 }
 if(safe.temperature && !['COLD','WARM','HOT'].includes(safe.temperature))delete safe.temperature;
 if(safe.quantity!==undefined && !Number.isFinite(Number(safe.quantity)))delete safe.quantity;
 if(safe.valueSAR!==undefined && !Number.isFinite(Number(safe.valueSAR)))delete safe.valueSAR;
 const stageProposal=typeof rawUpdates.stage==='string' && stages.includes(rawUpdates.stage)?rawUpdates.stage:null;
 return {safe,stageProposal};
}

// Applies only the SAFE (non-stage) fields — none of these affect pipeline stage or WON/LOST
// revenue accounting, so they auto-apply without a human approval step. Goes through the
// EXISTING updateLead function (never a second write path): the lead's CURRENT stage/version/
// assignedTo are read fresh and passed back unchanged, exactly like a human editing only a few
// fields on the same form would. Tenant-scoped throughout; every application is audited with
// the real agent run id it came from.
export function applySafeCrmUpdates(store,leadId,safeFields,{runId,agentId},tenantId=null) {
 if(!safeFields||!Object.keys(safeFields).length)return null;
 const lead=getLead(store.db,leadId,tenantId);
 const actor={id:'agent:'+agentId,name:'وكيل '+agentId,role:'automation'};
 const input={
  stage:lead.stage,temperature:safeFields.temperature||lead.temperature,expectedVersion:lead.version,
  reason:`تحديث تلقائي من تشغيلة وكيل ${agentId} (${runId})`,
  city:safeFields.city??lead.city,productNeed:safeFields.productNeed??lead.productNeed,
  productUrl:safeFields.productUrl??lead.productUrl,quantity:safeFields.quantity??lead.quantity,
  valueSAR:safeFields.valueSAR??lead.valueSAR,timeline:safeFields.timeline??lead.timeline,
  budgetBand:safeFields.budgetBand??lead.budgetBand,nextCheckAt:safeFields.nextCheckAt??lead.nextCheckAt,
  assignedTo:lead.assignedTo
 };
 const updated=updateLead(store,leadId,input,actor,tenantId);
 recordAudit(store.db,{id:randomUUID(),action:'AGENT_CRM_UPDATE_APPLIED',itemId:leadId,detail:{runId,agentId,fields:Object.keys(safeFields)},actorId:actor.id,actorName:actor.name,at:new Date().toISOString()},tenantId);
 return updated;
}

// Sensitive changes (pipeline stage) never auto-apply — routed through the exact same Approval
// Engine every other sensitive agent action already uses (agent_tool_send, workflow_step_approval).
// Applying it on approval is wired in application.js's existing /api/approvals/:id/decide
// dispatch, matching the established one-branch-per-action_type pattern there.
export function proposeStageChangeApproval(db,{leadId,fromStage,toStage,runId,agentId},tenantId=null) {
 return createApproval(db,{runId,agentId,actionType:'marketing_crm_stage_update',
  proposedOutput:{leadId,fromStage,toStage},riskLevel:'MEDIUM',
  reason:`الوكيل ${agentId} يقترح تغيير مرحلة العميل من ${fromStage} إلى ${toStage} بناءً على محادثة حقيقية`,tenantId});
}
