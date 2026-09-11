// Multi-Tenant Phase 4C-4 — Guided Workspace Onboarding wizard. Configures an EXISTING
// workspace only (never creates one). Reuses the same design system, the same
// `GET /api/control-center/summary` aggregation Phase 4C-2 already built (for real connection/
// agent/workspace data), and the same real Add-Connection flows already wired in
// pages/control-center.js (Salla OAuth start, Anthropic/OpenAI credential save) rather than
// duplicating them — this page adds no new business logic, only a guided real-status view over
// what already exists. No step here is ever a client-asserted checkbox: every state shown is
// read verbatim from `GET /api/onboarding`, which derives it live server-side.
import {escape,button,badge,empty,skeleton,tabs,promptDrawer,toast as showToast} from '../components/ui/index.js';
import {t,getLocale} from '../i18n.js';

const $=s=>document.querySelector('#onboarding '+s);
let apiClient,currentAuth,state=null,summary=null,tabControl=null,renderGeneration=0;

const STEP_IDS=['company','ai','commerce','messaging','productivity','agents','safety','systemCheck'];

function api(path,body,method){return apiClient(path,body,method);}
function toast(text){showToast(text,'success');}
function toastError(text){showToast(text,'error');}
function stepBadge(step){return badge(t('onboarding.state.'+step.state),step.state==='READY'?'CONNECTED':step.state==='SKIPPED'?'DISCONNECTED':'PENDING');}
function staleGuard(generation){return generation!==renderGeneration;}

export function installOnboardingPage(){
 const root=document.querySelector('[data-page="onboarding"] #onboarding');
 root.innerHTML=`<div id="ob-banner"></div><div id="ob-tabs"></div>`;
}

export async function renderOnboardingPage({api:client,auth}){
 apiClient=client;currentAuth=auth;
 const navLink=document.querySelector('#nav-onboarding');
 const visible=auth.user && ['owner','operator'].includes(auth.user.role);
 navLink.hidden=!visible;
 if(!visible)return;
 const generation=++renderGeneration;
 $('#ob-tabs').innerHTML=skeleton(t('common.loading'));
 let onboardingState,summaryData;
 try{[onboardingState,summaryData]=await Promise.all([api('/api/onboarding'),api('/api/control-center/summary')]);}
 catch(error){
  if(staleGuard(generation))return;
  $('#ob-tabs').innerHTML=empty(t('onboarding.loadFailed'),error.message);
  return;
 }
 if(staleGuard(generation))return;
 state=onboardingState;summary=summaryData;
 renderBanner();
 renderSteps();
}

function renderBanner(){
 const banner=$('#ob-banner');
 if(state.status!=='COMPLETED'){banner.innerHTML='';return;}
 banner.innerHTML=`<div class="card"><div class="row-between"><div><h3>${escape(t('onboarding.completedTitle'))}</h3><p>${escape(t('onboarding.completedHint'))}</p></div></div></div>`;
 const actions=document.createElement('div');actions.className='report-actions';
 const reopen=button(t('onboarding.reopenButton'),{variant:'secondary'});
 reopen.onclick=async()=>{try{await api('/api/onboarding',{reopen:true},'PATCH');toast(t('common.savedSuccessfully'));renderOnboardingPage({api:apiClient,auth:currentAuth});}catch(error){toastError(error.message);}};
 const goCc=button(t('onboarding.goToControlCenter'),{variant:'ghost'});
 goCc.onclick=()=>{location.hash='#control-center';};
 actions.append(reopen,goCc);
 banner.querySelector('.card').append(actions);
}

function renderSteps(){
 const host=$('#ob-tabs');host.innerHTML='';
 const panels=STEP_IDS.map(id=>{const el=document.createElement('div');el.id='ob-panel-'+id;return el;});
 host.append(...panels);
 const entries=STEP_IDS.map((id,i)=>{
  const step=state.steps.find(s=>s.id===id);
  const requiredMark=step.required?' *':'';
  const label=`${i+1}. ${t('onboarding.step.'+id)}${requiredMark} — ${t('onboarding.state.'+step.state)}`;
  return [label,panels[i]];
 });
 tabControl=tabs(host,entries);
 const startIndex=Math.max(0,STEP_IDS.indexOf(state.currentStep));
 tabControl.select(startIndex);
 // Persist the owner's chosen step server-side (Part 46) — a view-only operator can still
 // browse tabs locally without ever calling the owner-only PATCH route.
 if(currentAuth.user.role==='owner'){
  host.querySelectorAll('.ui-tabs [role=tab]').forEach((tabButton,index)=>{
   tabButton.addEventListener('click',()=>{
    const id=STEP_IDS[index];
    if(id!==state.currentStep)api('/api/onboarding',{currentStep:id},'PATCH').then(next=>{state=next;}).catch(()=>{});
   });
  });
 }
 STEP_IDS.forEach((id,i)=>paintStep(id,panels[i],i));
}

function goToStep(index){
 tabControl.select(index);
 document.querySelectorAll('#ob-tabs .ui-tabs [role=tab]')[index]?.focus();
 if(currentAuth.user.role==='owner' && STEP_IDS[index]!==state.currentStep){
  api('/api/onboarding',{currentStep:STEP_IDS[index]},'PATCH').then(next=>{state=next;}).catch(()=>{});
 }
}
function stepNav(panel,index,{skippable=false}={}){
 const nav=document.createElement('div');nav.className='report-actions';
 if(index>0){const back=button(t('onboarding.backButton'),{variant:'ghost'});back.onclick=()=>goToStep(index-1);nav.append(back);}
 const step=state.steps.find(s=>s.id===STEP_IDS[index]);
 const isOwner=currentAuth.user.role==='owner';
 if(skippable && isOwner){
  const skipBtn=button(step.state==='SKIPPED'?t('onboarding.unskipButton'):t('onboarding.skipButton'),{variant:'ghost'});
  skipBtn.onclick=async()=>{
   try{
    state=await api('/api/onboarding',step.state==='SKIPPED'?{unskipStep:STEP_IDS[index]}:{skipStep:STEP_IDS[index]},'PATCH');
    renderSteps();goToStep(index);
   }catch(error){toastError(error.message);}
  };
  nav.append(skipBtn);
 }
 if(index<STEP_IDS.length-1){const next=button(t('onboarding.nextButton'),{variant:'primary',iconName:'arrow'});next.onclick=()=>goToStep(index+1);nav.append(next);}
 panel.append(nav);
}

function paintStep(id,panel,index){
 panel.innerHTML='';
 const step=state.steps.find(s=>s.id===id);
 const head=document.createElement('div');head.className='row-between';
 head.innerHTML=`<h3>${escape(t('onboarding.step.'+id))} ${step.required?badge(t('onboarding.requiredBadge'),'PENDING'):badge(t('onboarding.optionalBadge'),'DISCONNECTED')}</h3>${stepBadge(step)}`;
 panel.append(head);
 const body=document.createElement('div');panel.append(body);
 ({company:paintCompany,ai:paintAi,commerce:paintCommerce,messaging:paintMessaging,productivity:paintProductivity,agents:paintAgents,safety:paintSafety,systemCheck:paintSystemCheck}[id])(body,step,index);
 stepNav(panel,index,{skippable:['commerce','messaging','productivity'].includes(id)});
}

// --- Company (Part 12-14: read-only, informational, always READY) ------------------------

function paintCompany(body){
 const w=summary.workspace;
 body.innerHTML=`<p>${escape(t('onboarding.companyStep.note'))}</p>
  <p><strong>${escape(t('onboarding.companyStep.name'))}:</strong> ${escape(w.name)}</p>
  <p><strong>${escape(t('onboarding.companyStep.slug'))}:</strong> <span dir="ltr">${escape(w.slug)}</span></p>
  <p><strong>${escape(t('onboarding.companyStep.locale'))}:</strong> ${escape(w.locale)}</p>
  <p><strong>${escape(t('onboarding.companyStep.timezone'))}:</strong> ${escape(w.timezone)}</p>
  <p><strong>${escape(t('onboarding.companyStep.role'))}:</strong> ${escape(t('workspace.role'+w.role.charAt(0).toUpperCase()+w.role.slice(1)))}</p>`;
}

// --- AI provider (Part 15-18: the only REQUIRED step) -------------------------------------

function paintAi(body,step){
 const connected=summary.aiProviders.filter(c=>c.status==='CONNECTED');
 body.innerHTML=`<p>${escape(t('onboarding.aiStep.hint'))}</p>`;
 if(connected.length){
  const note=document.createElement('p');note.textContent=t('onboarding.aiStep.connectedHint');body.append(note);
  const presetCard=document.createElement('div');presetCard.className='card';
  presetCard.innerHTML=`<h4>${escape(t('onboarding.aiStep.presetTitle'))}</h4><p>${escape(t('onboarding.aiStep.presetHint'))}</p>`;
  const select=document.createElement('select');
  for(const c of connected)select.innerHTML+=`<option value="${c.id}">${escape(c.name)} (${escape(c.provider)})</option>`;
  const apply=button(t('onboarding.aiStep.applyPreset'),{variant:'primary'});
  apply.onclick=async()=>{
   try{const result=await api('/api/onboarding/preset',{aiConnectionId:select.value});toast(t('common.savedSuccessfully'));if(result.applied.length===0)toast(t('common.noResults'));}
   catch(error){toastError(error.message);}
  };
  presetCard.append(select,apply);body.append(presetCard);
 }
 const addButton=button(t('onboarding.aiStep.addConnection'),{variant:connected.length?'secondary':'primary',iconName:'plus'});
 addButton.onclick=()=>openAddAiConnection();
 body.append(addButton);
}
function openAddAiConnection(){
 promptDrawer(t('onboarding.aiStep.addConnection'),node=>{
  const providerSelect=document.createElement('select');providerSelect.innerHTML=`<option value="anthropic">Anthropic</option><option value="openai">OpenAI</option>`;
  const providerLabel=document.createElement('label');providerLabel.textContent=t('controlCenter.connectionNameLabel');providerLabel.append(providerSelect);
  const nameInput=document.createElement('input');nameInput.name='name';nameInput.required=true;nameInput.maxLength=100;
  const nameLabel=document.createElement('label');nameLabel.textContent=t('onboarding.aiStep.connectionNameLabel');nameLabel.append(nameInput);
  const keyInput=document.createElement('input');keyInput.name='apiKey';keyInput.type='password';keyInput.required=true;keyInput.autocomplete='off';
  const keyLabel=document.createElement('label');keyLabel.textContent=t('onboarding.aiStep.apiKeyLabel');keyLabel.append(keyInput);
  node.append(providerLabel,nameLabel,keyLabel);
  return {value:()=>({integrationDefinitionId:providerSelect.value,name:nameInput.value.trim(),apiKey:keyInput.value}),focus:()=>nameInput.focus()};
 },{confirmLabel:t('onboarding.aiStep.save')}).then(async result=>{
  if(!result)return;
  const {integrationDefinitionId,name,apiKey}=result;
  try{
   const connection=await api('/api/integrations/connections',{integrationDefinitionId,name});
   await api(`/api/integrations/connections/${connection.id}/credential`,{apiKey},'PUT');
   toast(t('common.savedSuccessfully'));
   renderOnboardingPage({api:apiClient,auth:currentAuth});
  }catch(error){toastError(error.message);}
 });
}

// --- Commerce / Messaging / Productivity (Part 19-24: optional, skippable) ----------------

function paintCommerce(body,step){
 const salla=summary.integrations.providers.find(p=>p.slug==='salla');
 const healthy=salla?.connections.some(c=>['CONNECTED','DEGRADED'].includes(c.status));
 body.innerHTML=`<p>${escape(t('onboarding.commerceStep.hint'))}</p>`;
 if(healthy){body.append(Object.assign(document.createElement('p'),{textContent:t('onboarding.commerceStep.connectedHint')}));return;}
 const connect=button(t('onboarding.commerceStep.connectButton'),{variant:'primary',iconName:'plus'});
 connect.onclick=()=>{
  promptDrawer(t('onboarding.commerceStep.connectButton'),node=>{
   const input=document.createElement('input');input.name='name';input.required=true;input.maxLength=100;input.placeholder=t('onboarding.commerceStep.storeNamePlaceholder');
   const label=document.createElement('label');label.textContent=t('controlCenter.connectionNameLabel');label.append(input);node.append(label);
   return {value:()=>input.value.trim(),focus:()=>input.focus()};
  },{confirmLabel:t('controlCenter.startOAuth')}).then(name=>{
   if(name===null)return;
   window.location.href=`/api/integrations/oauth/salla/start?name=${encodeURIComponent(name||t('onboarding.commerceStep.storeNamePlaceholder'))}`;
  });
 };
 body.append(connect);
}
function paintMessaging(body){
 const healthy=['whatsapp','meta','x','linkedin'].some(slug=>summary.integrations.providers.find(p=>p.slug===slug)?.connections.some(c=>['CONNECTED','DEGRADED'].includes(c.status)));
 body.innerHTML=`<p>${escape(t('onboarding.messagingStep.hint'))}</p>${healthy?`<p>${escape(t('onboarding.messagingStep.connectedHint'))}</p>`:''}`;
 const goCc=button(t('onboarding.goToControlCenter'),{variant:'secondary'});goCc.onclick=()=>{location.hash='#control-center';};
 body.append(goCc);
}
function paintProductivity(body){
 const healthy=summary.integrations.providers.find(p=>p.slug==='microsoft365')?.connections.some(c=>['CONNECTED','DEGRADED'].includes(c.status));
 body.innerHTML=`<p>${escape(t('onboarding.productivityStep.hint'))}</p>${healthy?`<p>${escape(t('onboarding.productivityStep.connectedHint'))}</p>`:''}`;
 const goCc=button(t('onboarding.goToControlCenter'),{variant:'secondary'});goCc.onclick=()=>{location.hash='#control-center';};
 body.append(goCc);
}

// --- Agents (Part 25-26: informational signal only, never blocks) ------------------------

function paintAgents(body){
 body.innerHTML=`<p>${escape(t('onboarding.agentsStep.hint'))}</p><p>${escape(t('onboarding.agentsStep.readyCount',{ready:summary.agents.ready,total:summary.agents.total}))}</p>`;
 const goCc=button(t('onboarding.goToControlCenter'),{variant:'secondary'});goCc.onclick=()=>{location.hash='#control-center';};
 body.append(goCc);
}

// --- Safety (Part 33-36: real, read-only snapshot) ----------------------------------------

async function paintSafety(body){
 body.innerHTML=skeleton(t('common.loading'));
 let snapshot;
 try{snapshot=await api('/api/onboarding/safety');}
 catch(error){body.innerHTML=empty(t('onboarding.loadFailed'),error.message);return;}
 body.innerHTML=`<p>${escape(t('onboarding.safetyStep.hint'))}</p>
  <p><strong>${escape(t('onboarding.safetyStep.safetyCeiling'))}:</strong> ${escape(snapshot.tenantSafetyCeiling||t('onboarding.safetyStep.noCeiling'))}</p>
  <div class="grid">${snapshot.agentLevels.map(a=>`<div class="card"><strong>${escape(t('agents.roles.'+a.id))}</strong> ${badge(a.level,'PENDING')}</div>`).join('')}</div>
  <h4>${escape(t('onboarding.safetyStep.flags'))}</h4>
  <div class="grid">${Object.entries(snapshot.flags).map(([key,on])=>`<div class="audit-row row-between"><span>${escape(t('onboarding.safetyStep.flag.'+key))}</span>${badge(on?t('onboarding.safetyStep.flagOn'):t('onboarding.safetyStep.flagOff'),on?'CONNECTED':'DISCONNECTED')}</div>`).join('')}</div>`;
}

// --- System check & finish (Part 37-42: real derived completion, server-validated) --------

function paintSystemCheck(body,step,index){
 const canComplete=state.steps.filter(s=>s.required).every(s=>s.state==='READY');
 const healthy=summary.integrations.healthyConnections;
 body.innerHTML=`<p>${escape(t('onboarding.systemCheckStep.hint'))}</p>
  <p>${escape(t('onboarding.systemCheckStep.summary',{ready:summary.agents.ready,total:summary.agents.total,healthy}))}</p>
  <p>${canComplete?badge(t('onboarding.systemCheckStep.requiredReady'),'CONNECTED'):badge(t('onboarding.systemCheckStep.requiredNotReady'),'ERROR')}</p>`;
 const finish=button(t('onboarding.finishButton'),{variant:'primary',iconName:'check'});
 finish.disabled=!canComplete||currentAuth.user.role!=='owner';
 if(!canComplete){const hint=document.createElement('p');hint.className='kpi-context';hint.textContent=t('onboarding.finishBlockedHint');body.append(hint);}
 finish.onclick=async()=>{
  try{state=await api('/api/onboarding',{complete:true},'PATCH');toast(t('common.savedSuccessfully'));renderBanner();renderSteps();goToStep(index);}
  catch(error){toastError(error.message);}
 };
 body.append(finish);
}
