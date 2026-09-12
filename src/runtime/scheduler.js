import {randomUUID} from 'node:crypto';
import {isPaused} from './gate.js';
import {saveDailyBrief,riyadhDate,prepareDue} from '../planning.js';
import {saveWeeklyReport,currentWeekStart} from '../reporting.js';
import {listLeads} from '../crm.js';
import {getCredentialsMeta,updateCredentialsMetadata,isExpiringSoon} from './credentials.js';
import {renewMailSubscription} from './microsoft-graph.js';
import {isEnabled} from './feature-flags.js';
import {listTenants,expireTrials} from '../tenancy.js';
import {recordAudit} from '../audit.js';

export const SCHEDULER_ACTOR={id:'scheduler',name:'الجدولة الآلية',role:'automation'};
const FOLLOWUP_ELIGIBLE_STAGES=['QUOTE_SENT','DEMO','POST_PURCHASE'];

function riyadhParts(now) {
 const d=new Date(now+10800000);
 return {hour:d.getUTCHours(),weekday:d.getUTCDay()};
}

/**
 * Finds leads that reached a stage where a follow-up is expected but have no active
 * sequence — the gap a human would otherwise have to notice by scrolling the CRM list —
 * and lets the real followup agent (same runtime, same tools, same permission gate as
 * every manual run) decide what to do. This never sends anything itself; it only
 * triggers the agent, whose own tools stay human-approval-gated exactly as before.
 */
export async function sweepFollowupGaps({store,agentRuntime,env={},tenantId=null}) {
 if(!isEnabled(env,'ENABLE_AUTOMATED_FOLLOWUPS'))return {checked:0,triggered:0,errors:0,skipped:'FEATURE_DISABLED'};
 const db=store.db;
 const leads=listLeads(db,tenantId).filter(lead=>FOLLOWUP_ELIGIBLE_STAGES.includes(lead.stage) && !lead.optOut && !lead.humanHold && !lead.replyHold);
 let triggered=0,checked=0,errors=0;
 for(const lead of leads) {
  checked++;
  const active=db.prepare("SELECT id FROM crm_followups WHERE lead_id=? AND status IN ('DRAFT','APPROVED','READY_FOR_CHANNEL') LIMIT 1").get(lead.id);
  if(active)continue;
  const run=await agentRuntime.run('followup',{triggerType:'SCHEDULE',triggerId:lead.id,input:{leadId:lead.id,stage:lead.stage,city:lead.city||null,productNeed:lead.productNeed||null,current_datetime:new Date().toISOString(),timezone:'Asia/Riyadh'},user:SCHEDULER_ACTOR,tenantId});
  triggered++;
  if(run.status==='FAILED')errors++;
 }
 return {checked,triggered,errors};
}

/**
 * Microsoft Graph mail subscriptions expire after a maximum of ~70.5 hours (Graph's own
 * limit — see microsoft-graph.js createMailSubscription) — this is why renewal must be a
 * recurring scheduled job (spec Part AU), not a one-time setup step. Renews once the
 * stored subscription is within 6 hours of expiry; does nothing if no subscription is on
 * record (nothing to renew — see /api/integrations/microsoft/subscribe for creating one).
 */
export async function renewMicrosoftSubscriptionIfNeeded({store,env,fetcher=fetch,tenantId=null}) {
 const meta=getCredentialsMeta(store.db,'microsoft365',tenantId);
 const subscription=meta?.metadata?.mailSubscription;
 if(!subscription?.id)return {skipped:'NO_SUBSCRIPTION'};
 if(!isExpiringSoon(subscription.expiresAt,6*3600000))return {skipped:'NOT_DUE'};
 try {
  const renewed=await renewMailSubscription({store,env,fetcher},subscription.id,tenantId);
  updateCredentialsMetadata(store.db,'microsoft365',{mailSubscription:{...subscription,expiresAt:renewed.expiresAt,lastRenewedAt:new Date().toISOString()}},tenantId,env);
  return {renewed:true,expiresAt:renewed.expiresAt};
 } catch(error) {
  updateCredentialsMetadata(store.db,'microsoft365',{mailSubscription:{...subscription,lastRenewalError:error.message,lastRenewalAttemptAt:new Date().toISOString()}},tenantId,env);
  throw error;
 }
}
/**
 * CONNECTION_JOB (Part A section, spec Phase 3.5; cut over to `integration_connections` in
 * Phase 4A Part 45): a Microsoft mail subscription is a per-tenant connection, not a
 * platform-wide one. This enumerates every tenant that actually has a non-disconnected
 * microsoft365 connection on record (never assumes "the" tenant) and renews each
 * independently; one tenant's renewal failure is caught and reported per-tenant, never
 * allowed to stop the loop for the others (Part A14 — failure isolation). The actual renewal
 * still reads/writes the legacy `integration_credentials` metadata via getCredentialsMeta/
 * updateCredentialsMetadata below — those calls' own compatibility-bridge side effect (see
 * credentials.js) is what keeps `integration_connections` in sync going forward.
 */
async function renewMicrosoftSubscriptionsForAllTenants({store,env,fetcher}) {
 let tenantIds=[];
 try{tenantIds=store.db.prepare("SELECT DISTINCT tenant_id AS tenantId FROM integration_connections WHERE integration_definition_id='microsoft365' AND status!='DISCONNECTED'").all().map(row=>row.tenantId);}
 catch{tenantIds=[];} // a fixture that never called installIntegrationConnections() has no such table — same "not connected" default as getCredentialsMeta's own try/catch
 const results={};
 for(const tenantId of tenantIds) {
  try{results[tenantId]=await renewMicrosoftSubscriptionIfNeeded({store,env,fetcher,tenantId});}
  catch(error){results[tenantId]={error:error.message};}
 }
 return results;
}
/**
 * Runs one TENANT_JOB for one tenant, isolated from every other tenant's jobs (Part A14 —
 * a single tenant's failure must never stop the cycle for anyone else) and recorded to the
 * shared Operations Log on failure only — a routine no-op tick (nothing due, nothing to
 * sweep) is not itself a business event worth a permanent audit row, matching how every
 * other audit entry in this codebase represents something a human would actually want to
 * see, not a heartbeat. `correlationId` ties one job attempt's failure record to itself;
 * it does not (yet) thread further into agent_runs/agent_events, which have no such column —
 * see docs/TENANT_SCHEDULER.md for the honest scope note on this.
 */
async function runTenantJob(store,jobName,tenantId,fn) {
 const correlationId=randomUUID();
 try {
  return {status:'OK',result:await fn()};
 } catch(error) {
  recordAudit(store.db,{id:randomUUID(),action:'SCHEDULER_JOB_FAILED',itemId:jobName,errorCode:error.message,correlationId,at:new Date().toISOString()},tenantId);
  return {status:'ERROR',error:error.message,correlationId};
 }
}
/**
 * AgentScheduler. One in-process interval loop (this is a single always-on local
 * server — no external cron exists yet, see docs/agent-runtime.md). `tick()` is the
 * whole unit of work and is exported standalone so tests call it directly on a fake
 * clock instead of waiting on real timers; `start()` is only ever called from the
 * server's main-execution block, never from createApp() itself, so importing/testing
 * this module never spins up a background timer by accident.
 *
 * Multi-Tenant Phase 3.5 (Part A) — tenant-aware execution model. Every TENANT_JOB
 * (daily brief, weekly report, follow-up sweep, scheduled publishing) now runs once PER
 * ELIGIBLE TENANT (`listTenants` — ACTIVE/TRIAL only, never SUSPENDED/ARCHIVED) instead of
 * once globally against whatever `resolveActiveTenantId` would have guessed. Sequential,
 * not parallel — bounded, predictable load on a single-instance app, and it keeps failure
 * isolation trivial (one tenant at a time, one try/catch per job). The Microsoft
 * subscription renewal is a CONNECTION_JOB (Part A11): it loops over whichever tenants
 * actually hold a microsoft365 connection, not every eligible tenant.
 */
export function createScheduler({store,agentRuntime,env,getExtras,fetcher=fetch,eventBus=null}) {
 const db=store.db;
 let timer=null;
 // In-process reentrancy guard (Part A12): this app is a single always-on instance with one
 // setInterval loop, not a horizontally-scaled cluster, so a simple in-memory flag is the
 // right-sized lock — it stops one slow tick from overlapping the next tick of the SAME
 // process (the actual risk today), which a DB-based lock would not do any better here. If
 // this process is ever run as more than one instance, a DB-based lock (a single row in a
 // `scheduler_locks` table, claimed with a conditional UPDATE) would be the natural next
 // step — deliberately not built now since nothing in this codebase runs more than one
 // instance, and building it unused would be speculative.
 let tickRunning=false;
 async function tick(now=Date.now()) {
  if(isPaused(db))return {skipped:'PAUSED'};
  if(tickRunning)return {skipped:'ALREADY_RUNNING'};
  tickRunning=true;
  try {
   const result={at:new Date(now).toISOString(),tenants:{}};
   // Multi-Tenant Phase 4C-6 (Part 17-19) — a TRIAL tenant past its own `trial_expires_at`
   // stops being automation-eligible from this same tick onward: `expireTrials` flips it to
   // the existing `SUSPENDED` status (no data touched, no new scheduler built) BEFORE
   // `listTenants` below reads the eligible set, so an expired trial never runs even one more
   // daily brief / follow-up sweep / scheduled publish after its own expiry moment.
   const expiredTenantIds=expireTrials(db);
   for(const tenantId of expiredTenantIds)recordAudit(store.db,{id:randomUUID(),action:'WORKSPACE_TRIAL_EXPIRED',itemId:tenantId,at:new Date(now).toISOString()},tenantId);
   const {hour,weekday}=riyadhParts(now);
   const eligibleTenants=listTenants(db);
   for(const tenant of eligibleTenants) {
    const tenantId=tenant.id;
    const tenantResult={};
    if(hour===8) {
     const outcome=await runTenantJob(store,'DAILY_BRIEF',tenantId,()=>saveDailyBrief(store,riyadhDate(now),SCHEDULER_ACTOR,tenantId));
     if(outcome.status==='OK')tenantResult.dailyBrief=outcome.result;else tenantResult.dailyBriefError=outcome.error;
    }
    if(weekday===0) {
     const outcome=await runTenantJob(store,'WEEKLY_REPORT',tenantId,()=>saveWeeklyReport(store,currentWeekStart(now),SCHEDULER_ACTOR,getExtras?.(tenantId),tenantId));
     if(outcome.status==='OK')tenantResult.weeklyReport=outcome.result;else tenantResult.weeklyReportError=outcome.error;
    }
    {
     const outcome=await runTenantJob(store,'FOLLOWUP_SWEEP',tenantId,()=>sweepFollowupGaps({store,agentRuntime,env,tenantId}));
     if(outcome.status==='OK')tenantResult.followupSweep=outcome.result;else tenantResult.followupSweepError=outcome.error;
    }
    // Content Calendar → Publishing pipeline (X/LinkedIn/Meta spec Part O): the internal
    // scheduler is what makes a due, approved, scheduled post actually get published without
    // anyone opening the app — prepareDue flips due jobs to READY_FOR_CONNECTOR and, only on
    // that transition, emits CONTENT_PUBLISH_REQUESTED (carrying this same tenantId) for the
    // Publishing agent to act on. Tenant A's due jobs can never resolve/publish Tenant B's
    // content — prepareDue's own tenant-scoped queries (planning.js) already guarantee that.
    {
     const outcome=await runTenantJob(store,'SCHEDULE_PREPARE',tenantId,()=>prepareDue(store,SCHEDULER_ACTOR,now,eventBus,env,tenantId));
     if(outcome.status==='OK')tenantResult.schedulePrepare=outcome.result;else tenantResult.schedulePrepareError=outcome.error;
    }
    result.tenants[tenantId]=tenantResult;
   }
   result.microsoftSubscriptionRenewal=await renewMicrosoftSubscriptionsForAllTenants({store,env,fetcher});
   return result;
  } finally {
   tickRunning=false;
  }
 }
 function start(intervalMs=Number(env.SCHEDULER_INTERVAL_MS)||300000) {
  if(timer)return;
  timer=setInterval(()=>{tick().catch(()=>{});},intervalMs);
  timer.unref?.();
 }
 function stop() {
  if(timer){clearInterval(timer);timer=null;}
 }
 return {tick,start,stop,running:()=>!!timer};
}
