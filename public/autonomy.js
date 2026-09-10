import {t,getLocale} from './i18n.js';
const levels=['L0','L1','L2','L3'];
const levelNames=new Proxy({},{get:(_,code)=>t('agents.level'+code)});
const runStatusNames=new Proxy({},{get:(_,code)=>{const key='agents.run'+code.split('_').map(p=>p.charAt(0)+p.slice(1).toLowerCase()).join('');const value=t(key);return value===key?undefined:value;}});
const actionTypeNames=new Proxy({},{get:(_,code)=>{const key='weeklyReport.actionType'+code.split('_').map(p=>p.charAt(0).toUpperCase()+p.slice(1).toLowerCase()).join('');const value=t(key);return value===key?undefined:value;}});
let agents=[];
const testResults=new Map();
function dateLocale(){return getLocale()==='en'?'en-US':'ar-SA';}
export async function renderAgents({api,auth,escape}) {
 agents=await api('/api/agents');
 const locale=dateLocale();
 document.querySelector('#agent-list').innerHTML=agents.map(agent=>{
  const index=levels.indexOf(agent.level);
  const options=[...(index<levels.length-1?[levels[index+1]]:[]),...levels.slice(0,index)];
  const history=agent.autonomyUpdatedAt?`<small>${t('agents.autonomyLastChangedLine',{by:escape(agent.autonomyUpdatedBy||''),reason:escape(agent.autonomyReason||''),date:escape(new Date(agent.autonomyUpdatedAt).toLocaleDateString(locale))})}</small>`:`<small>${t('agents.autonomyNeverChangedNote')}</small>`;
  const control=auth.user.role==='owner'&&options.length?`<details><summary>${t('agents.changeAutonomyLevelSummary')}</summary><form data-autonomy="${agent.id}"><label>${t('agents.newLevelFieldLabel')}<select name="level">${options.map(level=>`<option value="${level}">${levelNames[level]}</option>`).join('')}</select></label><label>${t('agents.changeReasonFieldLabel')}<input name="reason" required maxlength="1000"></label><button>${t('agents.saveLevelButton')}</button></form></details>`:'';
  const runLine=agent.lastRunAt?`<small>${t('agents.lastRunLine',{status:escape(runStatusNames[agent.lastRunStatus]||agent.lastRunStatus),date:escape(new Date(agent.lastRunAt).toLocaleString(locale,{timeZone:'Asia/Riyadh'})),count:agent.runsTotal})}</small>`:`<small>${t('agents.noRunsYet')}</small>`;
  const test=testResults.get(agent.id);
  const testBody=!test?'':test.status==='RUNNING'?`<p>${t('agents.testRunningNote')}</p>`:`<p><b>${escape(test.status)}</b>${test.output?.action?' · '+escape(test.output.action):''}</p>${test.output?.rationale?`<p>${escape(test.output.rationale)}</p>`:''}${test.error?`<p>${escape(test.error)}</p>`:''}${test.output?.payload?`<pre>${escape(JSON.stringify(test.output.payload,null,2))}</pre>`:''}${test.toolCalls?.length?`<p>${t('agents.toolCallsLabel')} ${test.toolCalls.map(tc=>escape(tc.tool)+' ('+escape(tc.status)+')').join(getLocale()==='en'?', ':'، ')}</p>`:''}<p><small>${test.output?.escalation_required?t('agents.escalationRequiredNote'):t('agents.noEscalationNote')} · ${test.output?.risk_level?t('agents.riskLevelLabel')+' '+escape(test.output.risk_level):''} · ${t('agents.noExternalSendNote')}</small></p>`;
  return `<article class="card"><div class="meta"><span class="pill" data-status="${escape(agent.level)}">${escape(agent.level)}</span><span class="pill" data-status="${agent.runtimeStatus==='ONLINE'?'COMPLETED':agent.runtimeStatus==='WAITING_INTEGRATION'?'HOLD':agent.runtimeStatus==='DISABLED'?'CANCELLED':'NEEDS_DATA'}">${escape(agent.runtimeLabel)}</span></div><h3>${escape(agent.name)}</h3><p>${escape(agent.purpose)}</p>${runLine}${history}${control}<details><summary>${t('agents.testAgentSummary')}</summary><form data-agent-test="${agent.id}"><label>${t('agents.scenarioFieldLabel')}<textarea name="scenario" required maxlength="4000" placeholder="${escape(t('agents.scenarioPlaceholder'))}"></textarea></label><button>${t('agents.runTestButton')}</button></form>${testBody}</details></article>`;
 }).join('');
 if(auth.user.role==='reviewer')document.querySelectorAll('#agent-list [data-agent-test]').forEach(form=>form.closest('details').remove());
}
export async function submitAutonomy(form,input,api) {
 if(!form.dataset.autonomy)return null;
 const id=form.dataset.autonomy;
 input.expectedVersion=agents.find(agent=>agent.id===id)?.autonomyVersion||0;
 await api(`/api/agents/${id}/autonomy`,input);
 return t('agents.toastAutonomyUpdated');
}
export async function renderFrostControl({api,auth,escape}) {
 const status=await api('/api/frost/status');
 const gate=status.gate;
 document.querySelector('#frost-status').innerHTML=`<div class="row-between"><h2>${t('agents.frostControlCenter')}</h2><span class="pill" data-status="${gate.paused||!status.schedulerRunning?'HOLD':'ONLINE'}">${gate.paused?t('statuses.HOLD'):status.schedulerRunning?t('agents.schedulerActiveLabel'):t('agents.schedulerInactiveLabel')}</span></div><p>${t('agents.frostDailyCheckNote')}</p>${gate.paused&&gate.pausedBy?'<p>'+t('agents.pausedByPrefix')+' '+escape(gate.pausedBy)+(gate.reason?' · '+escape(gate.reason):'')+'</p>':''}<details><summary>${t('agents.runtimeDetailsSummary')}</summary><p>${status.schedulerRunning?t('agents.schedulerRunningNote'):t('agents.schedulerNotRunningNote')}</p><p dir="ltr">${status.routes.map(escape).join(' · ')}</p></details>`;
 document.querySelector('#frost-pause').hidden=gate.paused||auth.user.role!=='owner';
 document.querySelector('#frost-resume').hidden=!gate.paused||auth.user.role!=='owner';
 document.querySelector('#frost-run-now').hidden=auth.user.role!=='owner';
}
export async function clickFrost(button,api) {
 if(button.id==='frost-pause'){await api('/api/frost/pause',{reason:t('agents.manualPauseReason')});return t('agents.toastPausedAll');}
 if(button.id==='frost-resume'){await api('/api/frost/resume',{});return t('agents.toastResumedAll');}
 if(button.id==='frost-run-now'){const result=await api('/api/frost/run-now',{});return result.skipped?t('agents.toastCycleStoppedNote'):t('agents.toastCycleRanNow');}
 return null;
}
export async function renderApprovalCenter({api,auth,escape}) {
 const [approvals,escalations]=await Promise.all([api('/api/approvals?status=PENDING'),api('/api/escalations?status=OPEN')]);
 const canDecide=auth.user.role==='owner';
 const rows=[
  ...approvals.map(a=>`<div class="risk-item"><div class="risk-body"><span class="risk-title">${escape(actionTypeNames[a.action_type]||a.action_type)}</span><span class="risk-meta">${escape(t('weeklyReport.agentPrefix',{id:a.agent_id}))} · ${escape(a.reason)}</span></div>${canDecide?`<div class="row"><button type="button" data-approval-decide="${a.id}" data-decision="APPROVED">${t('agents.approveDecisionButton')}</button><button type="button" class="secondary" data-approval-decide="${a.id}" data-decision="REJECTED">${t('agents.rejectDecisionButton')}</button></div>`:`<span class="pill" data-status="${escape(a.risk_level)}">${escape(a.risk_level)}</span>`}</div>`),
  ...escalations.map(e=>`<div class="risk-item"><div class="risk-body"><span class="risk-title">${escape(e.reason)}</span><span class="risk-meta">${escape(t('agents.escalationAgentLine',{id:e.agent_id}))}</span></div>${canDecide?`<div class="row"><button type="button" data-escalation-resolve="${e.id}">${t('agents.markResolvedButton')}</button><span class="pill" data-status="${escape(e.priority)}">${escape(e.priority)}</span></div>`:`<span class="pill" data-status="${escape(e.priority)}">${escape(e.priority)}</span>`}</div>`)
 ];
 document.querySelector('#approval-center-list').innerHTML=rows.length?`<div class="risk-list">${rows.join('')}</div>`:`<div class="empty">${t('weeklyReport.noPendingDecisions')}</div>`;
}
export async function clickApprovalCenter(button,api) {
 if(button.dataset.approvalDecide){await api(`/api/approvals/${button.dataset.approvalDecide}/decide`,{decision:button.dataset.decision});return button.dataset.decision==='APPROVED'?t('agents.toastApprovalApproved'):t('agents.toastApprovalRejected');}
 if(button.dataset.escalationResolve){await api(`/api/escalations/${button.dataset.escalationResolve}/resolve`,{});return t('agents.toastEscalationResolved');}
 return null;
}
export async function submitAgentTest(form,input,api) {
 if(!form.dataset.agentTest)return null;
 const id=form.dataset.agentTest;
 testResults.set(id,{status:'RUNNING'});
 try {
  const run=await api(`/api/agents/${id}/run`,{scenario:input.scenario});
  testResults.set(id,{status:run.status,output:run.output,error:run.error,toolCalls:run.toolCalls});
  return t('agents.testCompletedToast');
 } catch(error) {
  testResults.set(id,{status:'FAILED',error:error.message});
  throw error;
 }
}
