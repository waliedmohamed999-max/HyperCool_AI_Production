import {t} from './i18n.js';
const results=new Map(),keys=new Map();
const labels=new Proxy({},{get:(_,code)=>{const key='content.classification'+code.split('_').map(p=>p.charAt(0)+p.slice(1).toLowerCase()).join('');const value=t(key);return value===key?undefined:value;}});
const severities=new Proxy({},{get:(_,code)=>{const key='content.severity'+code.charAt(0)+code.slice(1).toLowerCase();const value=t(key);return value===key?undefined:value;}});
const errors=new Proxy({},{get:(_,code)=>{const key='content.error'+code.split('_').map(p=>p.charAt(0)+p.slice(1).toLowerCase()).join('');const value=t(key);return value===key?undefined:value;}});
const fingerprint=item=>JSON.stringify({title:item.title,body:item.body,englishCopy:item.englishCopy||'',url:item.url,assetUrl:item.assetUrl||'',platform:item.platform,date:item.date});
function requestKeyFor(id,fp) {
 const cached=keys.get(id);
 if(cached && cached.fingerprint===fp) return cached.key;
 const key=crypto.randomUUID();keys.set(id,{fingerprint:fp,key});return key;
}
export function resetCompliance(){results.clear();keys.clear();}
export function renderComplianceCheck(item,escape) {
 const fp=fingerprint(item),entry=results.get(item.id),stale=!entry||entry.fingerprint!==fp;
 const key=requestKeyFor(item.id,fp);
 const body=stale?`<p>${t('content.notRunYet')}</p>`
  :entry.status==='RUNNING'?`<p>${t('content.checkRunning')}</p>`
  :entry.status!=='COMPLETED'?`<p>${escape(errors[entry.errorCode]||entry.errorCode||t('content.checkIncompleteFallback'))}</p>`
  :`<p><b>${escape(labels[entry.decision.payload?.classification]||entry.decision.status)}</b>${entry.decision.payload?.reason?' — '+escape(entry.decision.payload.reason):''}</p>${(entry.decision.payload?.issues||[]).map(issue=>`<p>${escape(severities[issue.severity]||issue.severity)} · ${escape(issue.field)}: ${escape(issue.problem)}${issue.correction?escape(t('content.correctionSuggestionPrefix'))+escape(issue.correction):''}</p>`).join('')||`<p>${t('content.noAutoCheckNotes')}</p>`}`;
 return `<details class="compliance-check"><summary>${t('content.complianceCheckSummary')}</summary>${body}<p><small>${t('content.complianceAssistiveNote')}</small></p><button type="button" data-compliance-check="${item.id}" data-fp="${escape(fp)}" data-request-key="${key}">${stale?t('content.runCheckButton'):t('content.rerunCheckButton')}</button></details>`;
}
export async function clickCompliance(button,api) {
 const id=button.dataset.complianceCheck,fp=button.dataset.fp,requestKey=button.dataset.requestKey;
 results.set(id,{fingerprint:fp,status:'RUNNING'});
 try {
  const run=await api(`/api/content/${id}/compliance`,{requestKey});
  results.set(id,{fingerprint:fp,status:run.status,decision:run.decision,errorCode:run.errorCode});
  return run.replayed?t('content.toastAlreadyChecked'):run.status==='COMPLETED'?t('content.toastCheckCompleted'):(errors[run.errorCode]||t('content.checkIncompleteFallback'));
 } catch(error) {results.delete(id);throw error;}
}
