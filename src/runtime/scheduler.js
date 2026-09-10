import {isPaused} from './gate.js';
import {saveDailyBrief,riyadhDate} from '../planning.js';
import {saveWeeklyReport,currentWeekStart} from '../reporting.js';
import {listLeads} from '../crm.js';

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
 * AgentScheduler. One in-process interval loop (this is a single always-on local
 * server — no external cron exists yet, see docs/agent-runtime.md). `tick()` is the
 * whole unit of work and is exported standalone so tests call it directly on a fake
 * clock instead of waiting on real timers; `start()` is only ever called from the
 * server's main-execution block, never from createApp() itself, so importing/testing
 * this module never spins up a background timer by accident.
 */
export function createScheduler({store,agentRuntime,env,getExtras}) {
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
