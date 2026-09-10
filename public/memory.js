import {escape,badge,empty,button,drawer,tabs,enhance} from './components/ui/index.js';
import {t,getLocale} from './i18n.js';
const $=selector=>document.querySelector(selector);
function toPascal(code){return code.split('_').map(p=>p.charAt(0).toUpperCase()+p.slice(1)).join('');}
export const memoryKinds=new Proxy({},{get:(_,code)=>{const key='memory.kind'+toPascal(code);const value=t(key);return value===key?undefined:value;}});
const agentNames=new Proxy({},{get:(_,id)=>{const key='agents.roles.'+id;const value=t(key);return value===key?undefined:value;}});
let entries=[],products=[],approvals=[],dashboard=null,user=null,apiClient=null;

function kpiCard(label,value,hint){return `<article class="kpi-card"><span class="kpi-label">${escape(label)}</span><strong class="kpi-value">${escape(value)}</strong><span class="kpi-context">${escape(hint)}</span></article>`;}
function recordStatus(e){return e.status==='REVOKED'?'REVOKED':e.expiresAt&&Date.parse(e.expiresAt)<=Date.now()?'EXPIRED':'APPROVED';}
const statusLabel=new Proxy({},{get:(_,code)=>{const key='memory.recordStatus'+code.charAt(0)+code.slice(1).toLowerCase();const value=t(key);return value===key?undefined:value;}});
function groupByKey(list){const groups=new Map();for(const e of list){if(!groups.has(e.key))groups.set(e.key,[]);groups.get(e.key).push(e);}return groups;}
function dateLocale(){return getLocale()==='en'?'en-US':'ar-SA';}

function renderSummary(){
 if(!dashboard)return;
 const s=dashboard.summary;
 $('#memory-summary').innerHTML=[
  kpiCard(t('memory.kpiTotalRecords'),s.totalRecords.value,s.totalRecords.hint),
  kpiCard(t('memory.kpiVerified'),s.verified.value,s.verified.hint),
  kpiCard(t('memory.kpiNeedsReview'),s.needsReview.value,s.needsReview.hint),
  kpiCard(t('memory.kpiExpired'),s.expired.value,s.expired.hint),
  kpiCard(t('memory.kpiPendingApproval'),s.pendingApproval.value,s.pendingApproval.hint),
  kpiCard(t('memory.kpiProductsSynced'),s.productsSynced.value,s.productsSynced.hint)
 ].join('');
}
function renderCategoryCounts(){
 if(!dashboard)return;
 document.querySelectorAll('.memory-categories button').forEach(b=>{
  const count=b.dataset.kind?dashboard.categoryCounts[b.dataset.kind]||0:entries.length?groupByKey(entries).size:0;
  let span=b.querySelector('.count');if(!span){span=document.createElement('span');span.className='count';b.append(span);}
  span.textContent=count;
 });
}
function renderHealth(){
 if(!dashboard){$('#memory-health-list').innerHTML=empty(t('memory.healthLoading'));return;}
 const h=dashboard.health;
 const rows=[
  ...h.priceConflicts.map(c=>({severity:'HIGH',text:t('memory.healthPriceConflict',{productName:c.productName,memoryAmount:c.memoryAmount,liveAmount:c.liveAmount,liveCurrency:c.liveCurrency||'SAR'}),key:c.key})),
  ...h.expiredClaims.map(c=>({severity:'MEDIUM',text:t('memory.healthExpiredClaim',{kind:memoryKinds[c.kind]||c.kind,key:c.key}),key:c.key})),
  ...h.weakSource.map(c=>({severity:'LOW',text:t('memory.healthWeakSource',{key:c.key,source:c.source}),key:c.key})),
  ...h.needsReview.map(c=>({severity:'LOW',text:t('memory.healthNeedsReviewNote',{key:c.key}),key:c.key}))
 ];
 if(!rows.length){$('#memory-health-list').innerHTML=empty(t('memory.healthNoIssuesTitle'),t('memory.healthNoIssuesHint'));return;}
 $('#memory-health-list').innerHTML=`<div class="risk-list">${rows.map(r=>`<div class="risk-item"><div class="risk-body"><span class="risk-title">${escape(r.text)}</span></div>${badge(r.severity==='HIGH'?t('content.severityHigh'):r.severity==='MEDIUM'?t('content.severityMedium'):t('content.severityLow'),r.severity==='HIGH'?'BLOCKED':r.severity==='MEDIUM'?'PENDING':'APPROVED')}<button type="button" class="ghost" data-memory-open-key="${escape(r.key)}">${escape(t('memory.openButton'))}</button></div>`).join('')}</div>`;
}
function renderApprovals(){
 if(!approvals.length){$('#memory-approvals-list').innerHTML=empty(t('memory.approvalsEmpty'));return;}
 $('#memory-approvals-list').innerHTML=`<div class="risk-list">${approvals.map(a=>{
  const p=a.proposed_output,current=groupByKey(entries).get(p.key)?.[0];
  return `<div class="risk-item"><div class="risk-body"><span class="risk-title">${escape(t('memory.approvalProposesLine',{agent:agentNames[a.agent_id]||a.agent_id,kind:memoryKinds[p.type]||p.type,key:p.key}))}</span><span class="risk-meta">${escape(t('memory.approvalCurrentLabel'))} ${current?escape(current.value):escape(t('memory.noRecord'))} ${escape(t('memory.approvalArrowTo'))} ${escape(p.newValue)}${p.confidence!=null?escape(t('memory.approvalConfidenceSuffix',{pct:Math.round(p.confidence*100)})):''}</span><span class="risk-meta">${escape(t('memory.approvalEvidenceLine',{evidence:p.evidence||'—',reason:a.reason}))}</span></div><div class="row"><button type="button" data-memory-apply-approval="${a.id}">${escape(t('memory.convertToRecord'))}</button><button type="button" data-approval-decide="${a.id}" data-decision="APPROVED">${escape(t('memory.approveButton'))}</button><button type="button" class="secondary" data-approval-decide="${a.id}" data-decision="REJECTED">${escape(t('memory.rejectButton'))}</button></div></div>`;
 }).join('')}</div>`;
}
function renderProducts(){
 if(!products.length){$('#product-list').innerHTML=empty(t('memory.catalogEmptyTitle'),t('memory.catalogEmptyHint'));return;}
 const locale=dateLocale();
 $('#product-list').innerHTML=`<table><thead><tr><th>${escape(t('memory.productCol'))}</th><th title="${escape(t('memory.skuColTitle'))}">${escape(t('memory.skuCol'))}</th><th>${escape(t('memory.priceCol'))}</th><th>${escape(t('memory.stockCol'))}</th><th title="${escape(t('memory.categoryColTitle'))}">${escape(t('memory.categoryCol'))}</th><th>${escape(t('memory.lastSyncCol'))}</th><th>${escape(t('memory.verificationCol'))}</th><th></th></tr></thead><tbody>${products.map(p=>`<tr><td>${escape(p.name.value)}</td><td dir="ltr">${escape(p.id)}</td><td dir="ltr">${p.price.value?escape(p.price.value.amount)+' '+escape(p.price.value.currency||'SAR'):escape(t('memory.unknownValue'))} <span class="pill" data-status="COMPLETED" title="${escape(t('memory.liveLabelTitle'))}">${escape(t('memory.liveLabel'))}</span></td><td>${escape(p.stock.value??t('memory.unknownValue'))}</td><td>—</td><td dir="ltr">${new Date(p.syncedAt).toLocaleDateString(locale)}</td><td><span class="pill" data-status="${p.available.value===false?'BLOCKED':'COMPLETED'}">${p.available.value===false?escape(t('memory.unavailableLabel')):escape(t('memory.availableLabel'))}</span></td><td><button type="button" class="ghost" data-product-view="${escape(p.id)}">${escape(t('memory.viewButton'))}</button></td></tr>`).join('')}</tbody></table>`;
 enhance($('#product-list'));
 $('#product-list').querySelectorAll('[data-product-view]').forEach(b=>b.onclick=()=>{
  const p=products.find(x=>x.id===b.dataset.productView);
  const linked=groupByKey(entries.filter(e=>e.productId===p.id)).size;
  const node=document.createElement('div');
  node.innerHTML=`<p><b>${escape(p.name.value)}</b></p><p>${escape(t('memory.skuLabel'))} <span dir="ltr">${escape(p.id)}</span></p><p>${escape(t('memory.priceLabelShort'))} <span dir="ltr">${p.price.value?escape(p.price.value.amount)+' '+escape(p.price.value.currency||'SAR'):escape(t('memory.unknownValue'))}</span> · ${escape(t('memory.sourceLabelShort'))} <span dir="ltr">${escape(p.price.source||'—')}</span></p><p>${escape(t('memory.stockLabelShort'))} ${escape(p.stock.value??t('memory.unknownValue'))}</p><p>${escape(t('memory.lastSyncLabelShort'))} <span dir="ltr">${new Date(p.syncedAt).toLocaleString(locale)}</span></p><p><a href="${escape(p.url.value)}" target="_blank" rel="noopener noreferrer">${escape(t('memory.openProductPage'))}</a></p><p>${escape(t('memory.linkedRecordsCount',{count:linked}))}</p>`;
  const refresh=button(t('memory.refreshCatalogButton'),{variant:'secondary'});refresh.title=t('memory.refreshCatalogButtonTitle');refresh.onclick=()=>{node.closest('dialog').close();$('#salla-sync')?.click();};
  const notes=button(t('memory.editLocalNotesButton'));notes.disabled=true;notes.title=t('memory.editLocalNotesButtonTitle');
  node.append(refresh,notes);
  drawer(t('memory.productDetailTitle'),node,{restore:true});
 });
}
export function renderMemoryList(){
 const kind=$('#memory-list')?.dataset.kind||'',q=($('#memory-search')?.value||'').toLowerCase();
 const productName=id=>products.find(p=>p.id===id)?.name.value||'';
 const groups=groupByKey(entries);
 const visible=[...groups.entries()].filter(([,versions])=>{
  const e=versions[0];
  if(kind&&e.kind!==kind)return false;
  if(!q)return true;
  const text=`${e.key} ${e.value} ${e.source} ${e.productId||''} ${productName(e.productId)} ${memoryKinds[e.kind]||e.kind} ${e.kind}`.toLowerCase();
  return text.includes(q);
 });
 if(!$('#memory-list'))return;
 if(!visible.length){$('#memory-list').innerHTML=empty(t('memory.noMatchTitle'),t('memory.noMatchHint'));return;}
 const locale=dateLocale();
 $('#memory-list').innerHTML=`<table><thead><tr><th>${escape(t('memory.keyCol'))}</th><th>${escape(t('memory.typeCol'))}</th><th>${escape(t('memory.valueCol'))}</th><th>${escape(t('memory.statusCol'))}</th><th>${escape(t('memory.sourceCol'))}</th><th>${escape(t('memory.lastUpdateCol'))}</th><th>${escape(t('memory.versionCol'))}</th></tr></thead><tbody>${visible.map(([key,versions])=>{
  const e=versions[0],status=recordStatus(e);
  return `<tr class="clickable" data-memory-row="${escape(key)}"><td dir="auto">${escape(key)}</td><td>${escape(memoryKinds[e.kind]||e.kind)}</td><td>${escape(e.value.slice(0,80))}${e.value.length>80?'…':''}</td><td>${badge(statusLabel[status],status)}</td><td>${escape(e.source.slice(0,40))}</td><td dir="ltr">${new Date(e.verifiedAt).toLocaleDateString(locale)}</td><td dir="ltr">v${e.version}</td></tr>`;
 }).join('')}</tbody></table>`;
 enhance($('#memory-list'));
 $('#memory-list').querySelectorAll('[data-memory-row]').forEach(row=>row.onclick=()=>openMemoryDetail(row.dataset.memoryRow,groups.get(row.dataset.memoryRow)));
}
async function openMemoryDetail(key,versions){
 const e=versions[0],status=recordStatus(e);
 const productName=e.productId?products.find(p=>p.id===e.productId)?.name.value:null;
 const locale=dateLocale();
 const details=document.createElement('div');
 details.innerHTML=`<div class="row-between"><span>${escape(memoryKinds[e.kind]||e.kind)}</span>${badge(statusLabel[status],status)}</div><h3 dir="auto">${escape(e.key)}</h3><p>${escape(e.value)}</p>${e.productId?`<p>${escape(t('memory.linkedProduct',{name:productName||e.productId}))}</p>`:''}<p>${escape(t('memory.sourceEvidence',{source:e.source}))}</p><p>${escape(t('memory.confidenceNote'))}</p><p>${escape(t('memory.createdApprovedBy',{name:e.approvedByName||'—'}))}</p><p>${escape(t('memory.versionUpdateLine',{version:e.version,date:new Date(e.verifiedAt).toLocaleString(locale)}))}</p>${e.expiresAt?`<p>${escape(t('memory.expiresLine',{date:new Date(e.expiresAt).toLocaleString(locale)}))}</p>`:''}`;
 if(user.role==='owner'){
  const edit=button(t('memory.addNewVersionButton'));
  edit.onclick=()=>{node.closest('dialog').close();prefillMemoryForm(e);};
  details.append(edit);
 }
 const history=document.createElement('div');
 history.innerHTML=versions.map(v=>`<article class="panel"><div class="row-between"><h3>${escape(t('memory.versionHeading',{n:v.version}))}</h3>${badge(statusLabel[recordStatus(v)],recordStatus(v))}</div><p>${escape(v.value)}</p><p>${escape(t('memory.sourceLabelShort'))} ${escape(v.source)}</p><small>${escape(v.approvedByName)} · ${escape(v.changeReason)} · <span dir="ltr">${new Date(v.verifiedAt).toLocaleString(locale)}</span></small></article>`).join('');
 if(user.role==='owner'){
  [...history.children].forEach((card,i)=>{
   if(i===0)return; // latest version — "restore" only makes sense for an older one
   const restore=button(t('memory.restoreAsNewVersionButton'),{variant:'secondary'});
   restore.onclick=()=>{node.closest('dialog').close();prefillMemoryForm(versions[i]);};
   card.append(restore);
  });
 }
 const usage=document.createElement('div');
 usage.innerHTML=`<p role="status">${escape(t('memory.usageLoading'))}</p>`;
 apiClient('/api/memory/usage?key='+encodeURIComponent(key)).then(rows=>{
  usage.innerHTML=rows.length?rows.map(r=>`<p>${escape(t('memory.usageLine',{agent:agentNames[r.agentId]||r.agentId,date:new Date(r.lastAccessedAt).toLocaleString(locale)}))}</p>`).join(''):empty(t('memory.usageEmptyTitle'),t('memory.usageEmptyHint'));
 }).catch(()=>{usage.innerHTML=`<p>${escape(t('memory.usageLoadFailed'))}</p>`;});
 const related=document.createElement('div');
 const relatedEntries=[...groupByKey(entries.filter(x=>x.key!==key&&((e.productId&&x.productId===e.productId)||x.kind===e.kind))).values()].slice(0,10);
 related.innerHTML=relatedEntries.length?relatedEntries.map(v=>`<p><b>${escape(v[0].key)}</b> — ${escape(v[0].value.slice(0,60))}</p>`).join(''):empty(t('memory.relatedEmpty'));
 const node=document.createElement('div');
 node.append(details,history,usage,related);
 tabs(node,[[t('memory.tabDetails'),details],[t('memory.tabHistory'),history],[t('memory.tabUsage'),usage],[t('memory.tabRelated'),related]]);
 drawer(t('memory.memoryDetailTitle'),node,{restore:true});
}
function prefillMemoryForm(e){
 const form=$('#memory-form');
 for(const key of ['key','kind','productId','value','source'])form.elements[key].value=e[key]||'';
 form.elements.status.value=e.status;
 form.elements.changeReason.value='';
 form.elements.expiresAt.value=e.expiresAt?new Date(Date.parse(e.expiresAt)-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16):'';
 document.dispatchEvent(new CustomEvent('memory-form-open'));
}
export function applyApprovalToForm(approvalId){
 const approval=approvals.find(a=>a.id===approvalId);if(!approval)return;
 const p=approval.proposed_output,form=$('#memory-form');
 form.elements.key.value=p.key||'';form.elements.kind.value=p.type||'';form.elements.productId.value=p.productId||'';
 form.elements.value.value=p.newValue||'';form.elements.source.value=p.evidence||'';
 form.elements.changeReason.value=t('memory.approvalReasonPrefix',{agent:agentNames[approval.agent_id]||approval.agent_id,reason:approval.reason});
 form.elements.status.value='APPROVED';form.elements.expiresAt.value='';
 document.dispatchEvent(new CustomEvent('memory-form-open'));
}
export async function renderMemory({api,auth}){
 user=auth.user;apiClient=api;
 if(user.role==='reviewer'){entries=[];products=[];approvals=[];dashboard=null;return;}
 [entries,products]=await Promise.all([api('/api/memory'),api('/api/products')]);
 try{
  const [dash,allApprovals]=await Promise.all([api('/api/memory/dashboard'),api('/api/approvals?status=PENDING')]);
  dashboard=dash;approvals=allApprovals.filter(a=>a.action_type==='memory_policy_change');
 }catch(error){dashboard=null;approvals=[];console.error('memory dashboard failed to load:',error);}
 renderSummary();renderCategoryCounts();renderHealth();renderApprovals();renderProducts();renderMemoryList();
 $('#memory-save-owner').hidden=user.role!=='owner';
 $('#memory-status-field').hidden=user.role!=='owner';
}
export function installMemoryInteractions(){
 document.addEventListener('click',e=>{
  const openKey=e.target.closest('[data-memory-open-key]');
  if(openKey){const key=openKey.dataset.memoryOpenKey,versions=groupByKey(entries).get(key);if(versions)openMemoryDetail(key,versions);return;}
  const applyApproval=e.target.closest('[data-memory-apply-approval]');
  if(applyApproval){applyApprovalToForm(applyApproval.dataset.memoryApplyApproval);}
 });
}
