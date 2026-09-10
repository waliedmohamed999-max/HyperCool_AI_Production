import {escape,drawer,badge,empty} from './components/ui/index.js';
import {t,getLocale} from './i18n.js';
const $=selector=>document.querySelector(selector);
const stageNames=new Proxy({},{get:(_,code)=>{const key='content.stage'+code.charAt(0)+code.slice(1).toLowerCase();const value=t(key);return value===key?undefined:value;}});
const severityLabel=new Proxy({},{get:(_,code)=>{const key='content.severity'+code.charAt(0)+code.slice(1).toLowerCase();const value=t(key);return value===key?undefined:value;}});
const actionNames=new Proxy({},{get:(_,code)=>{const key='operationsLog.actions.'+code;const value=t(key);return value===key?undefined:value;}});
let dashboard=null;

function kpiCard(id,label,value,hint,clickable){
 return `<article class="kpi-card${clickable?' clickable':''}"${clickable?` data-content-kpi="${id}"`:''}><div class="row-between"><span class="kpi-label">${escape(label)}</span></div><strong class="kpi-value">${escape(value)}</strong><span class="kpi-context">${escape(hint)}</span></article>`;
}
function renderKPIs(kpis){
 $('#stats').className='kpi-grid';
 $('#stats').innerHTML=[
  kpiCard('drafts',t('content.kpiDrafts'),kpis.drafts.value,kpis.drafts.hint,true),
  kpiCard('complianceFlagged',t('content.kpiComplianceFlagged'),kpis.complianceFlagged.value,kpis.complianceFlagged.hint,true),
  kpiCard('awaitingApproval',t('content.kpiAwaitingApproval'),kpis.awaitingApproval.value,kpis.awaitingApproval.hint,true),
  kpiCard('approved',t('content.kpiApproved'),kpis.approved.value,kpis.approved.hint,true),
  kpiCard('scheduled',t('content.kpiScheduled'),kpis.scheduled.value,kpis.scheduled.hint,true),
  kpiCard('published',t('content.kpiPublished'),kpis.published.value,kpis.published.hint,false),
  kpiCard('blocked',t('content.kpiBlocked'),kpis.blocked.value,kpis.blocked.hint,true)
 ].join('');
}
function renderPipeline(pipeline){
 $('#content-pipeline').innerHTML=`<div class="kanban">${pipeline.map(column=>`<div class="kanban-column"><h4><span>${escape(column.label)}</span><span>${column.cards.length}</span></h4>${column.cards.map(card=>`<div class="kanban-card" data-content-open="${escape(card.id)}"><b>${escape(card.title)}</b><span>${escape(card.platform)} · ${escape(card.date)}</span><div class="badges">${card.owner?`<span class="pill" data-status="COMPLETED">${escape(card.owner)}</span>`:''}${card.risk?`<span class="pill" data-status="${card.risk==='HIGH'?'BLOCKED':card.risk==='MEDIUM'?'PENDING':'APPROVED'}">${escape(severityLabel[card.risk]||card.risk)}</span>`:''}${card.assetMissing?`<span class="pill" data-status="PENDING">${escape(t('content.assetMissing'))}</span>`:''}</div></div>`).join('')||`<p><small>${escape(t('content.emptyColumn'))}</small></p>`}</div>`).join('')}</div>`;
}
function renderFrostInsights(insights){
 if(!insights.hasData){$('#content-frost-insights').innerHTML=empty(t('content.frostNoDataTitle'),t('content.frostNoDataHint'));return;}
 if(!insights.bullets.length){$('#content-frost-insights').innerHTML=empty(t('content.frostNoNotesTitle'),t('content.frostNoNotesHint'));return;}
 $('#content-frost-insights').innerHTML=`<div class="risk-list">${insights.bullets.map(b=>`<div class="risk-item"><div class="risk-body"><span class="risk-title">${escape(b.text)}</span></div>${badge(severityLabel[b.severity]||b.severity,b.severity==='HIGH'?'BLOCKED':b.severity==='MEDIUM'?'PENDING':'APPROVED')}</div>`).join('')}</div>`;
}
function renderLibrary(library){
 if(!library.length){$('#content-library').innerHTML=empty(t('content.libraryEmptyTitle'),t('content.libraryEmptyHint'));return;}
 const locale=getLocale()==='en'?'en-US':'ar-SA';
 $('#content-library').innerHTML=`<table><thead><tr><th>${escape(t('content.contentTitle'))}</th><th>${escape(t('content.platform'))}</th><th>${escape(t('content.product'))}</th><th>${escape(t('content.tableStatus'))}</th><th>${escape(t('content.date'))}</th><th>${escape(t('content.tableBy'))}</th><th>${escape(t('content.tableApproval'))}</th><th>${escape(t('content.tablePublish'))}</th><th></th></tr></thead><tbody>${library.map(item=>`<tr><td>${escape(item.title)}</td><td>${escape(item.platform)}</td><td>${escape(item.product||'—')}</td><td>${badge(stageNames[item.status]||item.status,item.status)}</td><td dir="ltr">${escape(item.date)}</td><td>${escape(item.createdBy||'—')}</td><td>${escape(item.approvedBy||'—')}</td><td>${item.scheduledAt?new Date(item.scheduledAt).toLocaleDateString(locale,{timeZone:'Asia/Riyadh'}):(item.publishedAt||t('content.notPublishedYet'))}</td><td><button type="button" class="ghost" data-content-open="${escape(item.id)}">${escape(t('content.openButton'))}</button></td></tr>`).join('')}</tbody></table>`;
}
export async function renderContent({api}){
 try{dashboard=await api('/api/content/dashboard');}catch(error){dashboard=null;console.error('content dashboard failed to load:',error);}
 if(!dashboard){$('#content-pipeline').innerHTML=empty(t('content.dashboardLoadFailed'));return;}
 renderKPIs(dashboard.kpis);
 renderPipeline(dashboard.pipeline);
 renderFrostInsights(dashboard.frostInsights);
 renderLibrary(dashboard.library);
}
// Appends real AI-authored fields (hook/CTA/hashtags/factual dependencies) and a per-item
// history trail onto the existing content card — the same extensible <details> pattern
// already used for the English-copy block, instead of a second competing editor UI.
export function enrichContentCards(state,esc){
 const locale=getLocale()==='en'?'en-US':'ar-SA';
 const listSep=getLocale()==='en'?', ':'، ';
 $('#items').querySelectorAll(':scope>article').forEach((card,index)=>{
  const item=state.content[index];if(!item)return;
  if(item.aiDecision?.payload){
   const p=item.aiDecision.payload;
   const brief=document.createElement('details');brief.className='content-brief';
   const summary=document.createElement('summary');summary.textContent=t('content.creativeBriefSummary');
   const body=document.createElement('div');
   body.innerHTML=`<p><b>${esc(t('content.hookLabel'))}</b> ${esc(p.hook)}</p><p><b>${esc(t('content.ctaFieldLabel'))}</b> ${esc(p.CTA)}</p><p><b>${esc(t('content.hashtagsLabel'))}</b> ${(p.hashtags||[]).map(h=>esc(h)).join(' ')||'—'}</p>${p.factual_dependencies?.length?`<p><b>${esc(t('content.factualDependenciesLabel'))}</b> ${p.factual_dependencies.map(f=>esc(typeof f==='string'?f:JSON.stringify(f))).join(listSep)}</p>`:''}${p.tone_notes?.length?`<p><b>${esc(t('content.toneNotesLabel'))}</b> ${p.tone_notes.map(esc).join(listSep)}</p>`:''}${p.compliance_notes?.length?`<p><b>${esc(t('content.complianceNotesFromWriterLabel'))}</b> ${p.compliance_notes.map(esc).join(listSep)}</p>`:''}`;
   brief.append(summary,body);card.append(brief);
  }
  const history=[...state.audit.filter(a=>a.itemId===item.id),...(item.parentId?state.audit.filter(a=>a.itemId===item.parentId):[])].sort((a,b)=>b.at.localeCompare(a.at));
  if(history.length){
   const details=document.createElement('details');details.className='content-history';
   const summary=document.createElement('summary');summary.textContent=t('content.historyLabel');
   const body=document.createElement('div');
   body.innerHTML=history.map(a=>`<p><small>${esc(actionNames[a.action]||a.action)} · ${esc(a.actorName||'—')} · ${new Date(a.at).toLocaleString(locale,{timeZone:'Asia/Riyadh'})}</small></p>`).join('');
   details.append(summary,body);card.append(details);
  }
 });
}
export function installContentInteractions(){
 document.addEventListener('click',e=>{
  const kpi=e.target.closest('[data-content-kpi]');
  if(kpi){
   const key=kpi.dataset.contentKpi;
   const statusMap={drafts:'DRAFT',awaitingApproval:'REVIEWED',approved:'APPROVED',blocked:'REJECTED'};
   if(statusMap[key]){const select=$('#content-status');if(select){select.value=statusMap[key];select.dispatchEvent(new Event('input',{bubbles:true}));}$('#items')?.scrollIntoView({behavior:'smooth',block:'start'});}
   else if(key==='complianceFlagged'){document.querySelectorAll('.ui-tabs .tab')[1]?.click();}
   else if(key==='scheduled'){$('#content-pipeline')?.scrollIntoView({behavior:'smooth',block:'start'});}
  }
 });
}
let progressDialog=null,progressTimer=null;
export function beginGeneration(){
 const steps=[t('content.genStep1'),t('content.genStep2'),t('content.genStep3'),t('content.genStep4')];
 const node=document.createElement('div');
 node.innerHTML=`<ol class="gen-progress">${steps.map((s,i)=>`<li data-step="${i}">${escape(s)}</li>`).join('')}</ol><p><small>${escape(t('content.genProgressNote'))}</small></p>`;
 progressDialog=drawer(t('content.generatingDraftTitle'),node,{restore:false});
 let step=0;
 const advance=()=>{const items=node.querySelectorAll('li');items.forEach((el,i)=>el.classList.toggle('active',i<=step));if(step<steps.length-1){step++;progressTimer=setTimeout(advance,700);}};
 advance();
}
export function endGeneration(){
 clearTimeout(progressTimer);
 const dialog=progressDialog;progressDialog=null;
 if(!dialog)return;
 dialog.querySelectorAll('li').forEach(el=>el.classList.add('active'));
 setTimeout(()=>{try{dialog.close();}finally{dialog.remove();}},500);
}
