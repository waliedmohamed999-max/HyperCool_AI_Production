import {isPaused} from './gate.js';
import {saveDailyBrief,riyadhDate,prepareDue} from '../planning.js';
import {saveWeeklyReport,currentWeekStart} from '../reporting.js';
import {listLeads} from '../crm.js';
import {getCredentialsMeta,updateCredentialsMetadata,isExpiringSoon} from './credentials.js';
import {renewMailSubscription} from './microsoft-graph.js';

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
export async function sweepFollowupGaps({store,agentRuntime}) {
 const db=store.db;
 const leads=listLeads(db).filter(lead=>FOLLOWUP_ELIGIBLE_STAGES.includes(lead.stage) && !lead.optOut && !lead.humanHold && !lead.replyHold);
 let triggered=0,checked=0,errors=0;
 for(const lead of leads) {
  checked++;
  const active=db.prepare("SELECT id FROM crm_followups WHERE lead_id=? AND status IN ('DRAFT','APPROVED','READY_FOR_CHANNEL') LIMIT 1").get(lead.id);
  if(active)continue;
  const run=await agentRuntime.run('followup',{triggerType:'SCHEDULE',triggerId:lead.id,input:{leadId:lead.id,stage:lead.stage,city:lead.city||null,productNeed:lead.productNeed||null,current_datetime:new Date().toISOString(),timezone:'Asia/Riyadh'},user:SCHEDULER_ACTOR});
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
export async function renewMicrosoftSubscriptionIfNeeded({store,env,fetcher=fetch}) {
 const meta=getCredentialsMeta(store.db,'microsoft365');
 const subscription=meta?.metadata?.mailSubscription;
 if(!subscription?.id)return {skipped:'NO_SUBSCRIPTION'};
 if(!isExpiringSoon(subscription.expiresAt,6*3600000))return {skipped:'NOT_DUE'};
 try {
  const renewed=await renewMailSubscription({store,env,fetcher},subscription.id);
  updateCredentialsMetadata(store.db,'microsoft365',{mailSubscription:{...subscription,expiresAt:renewed.expiresAt,lastRenewedAt:new Date().toISOString()}});
  return {renewed:true,expiresAt:renewed.expiresAt};
 } catch(error) {
  updateCredentialsMetadata(store.db,'microsoft365',{mailSubscription:{...subscription,lastRenewalError:error.message,lastRenewalAttemptAt:new Date().toISOString()}});
  throw error;
 }
}
/**
 * AgentScheduler. One in-process interval loop (this is a single always-on local
 * server — no external cron exists yet, see docs/agent-runtime.md). `tick()` is the
 * whole unit of work and is exported standalone so tests call it directly on a fake
 * clock instead of waiting on real timers; `start()` is only ever called from the
 * server's main-execution block, never from createApp() itself, so importing/testing
 * this module never spins up a background timer by accident.
 */
export function createScheduler({store,agentRuntime,env,getExtras,fetcher=fetch,eventBus=null}) {
 const db=store.db;
 let timer=null;
 async function tick(now=Date.now()) {
  if(isPaused(db))return {skipped:'PAUSED'};
  const result={at:new Date(now).toISOString()};
  const {hour,weekday}=riyadhParts(now);
  if(hour===8) {
   try{result.dailyBrief=saveDailyBrief(store,riyadhDate(now),SCHEDULER_ACTOR);}catch(error){result.dailyBriefError=error.message;}
  }
  if(weekday===0) {
   try{result.weeklyReport=saveWeeklyReport(store,currentWeekStart(now),SCHEDULER_ACTOR,getExtras?.());}catch(error){result.weeklyReportError=error.message;}
  }
  try{result.followupSweep=await sweepFollowupGaps({store,agentRuntime});}catch(error){result.followupSweepError=error.message;}
  try{result.microsoftSubscriptionRenewal=await renewMicrosoftSubscriptionIfNeeded({store,env,fetcher});}catch(error){result.microsoftSubscriptionRenewalError=error.message;}
  // Content Calendar → Publishing pipeline (X/LinkedIn/Meta spec Part O): the internal
  // scheduler is what makes a due, approved, scheduled post actually get published without
  // anyone opening the app — prepareDue flips due jobs to READY_FOR_CONNECTOR and, only on
  // that transition, emits CONTENT_PUBLISH_REQUESTED for the Publishing agent to act on.
  try{result.schedulePrepare=prepareDue(store,SCHEDULER_ACTOR,now,eventBus);}catch(error){result.schedulePrepareError=error.message;}
  return result;
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
