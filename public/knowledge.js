import {t,getLocale} from './i18n.js';
const labels=new Proxy({},{get:(_,code)=>{const key='content.aiRunStatus'+code.split('_').map(p=>p.charAt(0)+p.slice(1).toLowerCase()).join('');const value=t(key);return value===key?undefined:value;}});
const errors=new Proxy({},{get:(_,code)=>{const key='content.error'+code.split('_').map(p=>p.charAt(0)+p.slice(1).toLowerCase()).join('');const value=t(key);return value===key?undefined:value;}});
let memory=[];
export async function renderKnowledge({api,auth,escape}) {
 // Product catalog, memory records and integrations now render on the Brand Knowledge
 // Base page itself (memory.js / workspace.js's renderIntegrations) — this only keeps the
 // AI generator's product picker and its own run history in sync.
 const [products,entries,runs]=await Promise.all([api('/api/products'),api('/api/memory'),api('/api/ai/runs')]);
 memory=entries;
 document.querySelector('#ai-form').hidden=auth.user.role==='reviewer';
 document.querySelector('#memory-form').hidden=auth.user.role==='reviewer';
 document.querySelector('#salla-sync').hidden=auth.user.role!=='owner';
 const select=document.querySelector('#ai-product'),selected=select.value;
 select.innerHTML=`<option value="">${escape(t('content.chooseImportedProductOption'))}</option>`+products.map(p=>`<option value="${escape(p.id)}">${escape(p.name.value)} (${escape(p.id)})</option>`).join('');select.value=selected;
 const listSep=getLocale()==='en'?', ':'، ';
 document.querySelector('#run-list').innerHTML=runs.length?runs.map(run=>`<div class="audit-row"><div class="row-between"><b>${escape(run.title)}</b><span class="pill" data-status="${escape(run.status)}">${labels[run.status]||escape(run.status)}</span></div>${run.errorCode?`<p>${escape(errors[run.errorCode]||run.errorCode)}</p>`:''}${run.decision?.missing_data?.length?`<p>${escape(run.decision.missing_data.join(listSep))}</p>`:''}<small>${escape(run.createdAt)}${run.usage?' · '+escape(t('content.tokensLabel'))+': '+escape(run.usage.input_tokens+run.usage.output_tokens):''}</small></div>`).join(''):escape(t('content.noRunsYetNote'));
}
export async function submitKnowledge(form,input,api) {
 if(form.id==='memory-form') {
  if(input.intent==='propose') {
   await api('/api/memory/propose',{kind:input.kind,key:input.key,value:input.value,source:input.source,changeReason:input.changeReason,productId:input.productId});
   return t('content.toastMemoryProposed');
  }
  input.expectedVersion=memory.find(entry=>entry.key===input.key.trim())?.version||0;
  if(input.expiresAt)input.expiresAt=new Date(input.expiresAt).toISOString();
  await api('/api/memory',input);return t('content.toastMemorySaved');
 }
 if(form.id==='ai-form') {
  const fingerprint=JSON.stringify(input);
  if(form.dataset.fingerprint!==fingerprint){form.dataset.fingerprint=fingerprint;form.dataset.requestKey=crypto.randomUUID();}
  const result=await api('/api/ai/draft',{...input,requestKey:form.dataset.requestKey});
  if(result.status!=='RUNNING'){delete form.dataset.requestKey;delete form.dataset.fingerprint;}
  return (labels[result.status]||result.status)+(result.errorCode?' · '+(errors[result.errorCode]||result.errorCode):'');
 }
 return null;
}
