const results=new Map(),keys=new Map();
const labels={PASS:'مطابق',PASS_WITH_EDITS:'مطابق مع ملاحظات',BLOCK:'محظور'};
const severities={LOW:'منخفض',MEDIUM:'متوسط',HIGH:'عالٍ'};
const errors={ANTHROPIC_NOT_CONFIGURED:'إعداد Anthropic غير مكتمل',CREDENTIALS_REJECTED:'رفض الخدمة لبيانات الدخول',RATE_LIMITED:'تم تجاوز حد الطلبات',NETWORK_OR_TIMEOUT:'انقطع الاتصال أو انتهت المهلة',INVALID_MODEL_OUTPUT:'مخرجات الموديل لا تطابق العقد',INCOMPLETE_MODEL_OUTPUT:'لم يكتمل رد الموديل',CONTENT_CHANGED:'تغير المحتوى أثناء الفحص؛ أعد التشغيل',CHECK_FAILED:'تعذر تشغيل الفحص'};
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
 const body=stale?'<p>لم يُشغَّل فحص آلي على هذه النسخة بعد.</p>'
  :entry.status==='RUNNING'?'<p>الفحص قيد التنفيذ…</p>'
  :entry.status!=='COMPLETED'?`<p>${escape(errors[entry.errorCode]||entry.errorCode||'تعذر إكمال الفحص')}</p>`
  :`<p><b>${escape(labels[entry.decision.payload?.classification]||entry.decision.status)}</b>${entry.decision.payload?.reason?' — '+escape(entry.decision.payload.reason):''}</p>${(entry.decision.payload?.issues||[]).map(issue=>`<p>${escape(severities[issue.severity]||issue.severity)} · ${escape(issue.field)}: ${escape(issue.problem)}${issue.correction?' — اقتراح: '+escape(issue.correction):''}</p>`).join('')||'<p>لا ملاحظات من الفحص الآلي.</p>'}`;
 return `<details class="compliance-check"><summary>فحص الامتثال الآلي (مساعد فقط)</summary>${body}<p><small>هذا الفحص مساعد للمراجع البشري ولا يغني عن تعبئة نموذج المراجعة أدناه ولا يعتمد كمراجعة موثقة.</small></p><button type="button" data-compliance-check="${item.id}" data-fp="${escape(fp)}" data-request-key="${key}">${stale?'تشغيل الفحص':'إعادة التشغيل على هذه النسخة'}</button></details>`;
}
export async function clickCompliance(button,api) {
 const id=button.dataset.complianceCheck,fp=button.dataset.fp,requestKey=button.dataset.requestKey;
 results.set(id,{fingerprint:fp,status:'RUNNING'});
 try {
  const run=await api(`/api/content/${id}/compliance`,{requestKey});
  results.set(id,{fingerprint:fp,status:run.status,decision:run.decision,errorCode:run.errorCode});
  return run.replayed?'نتيجة الفحص لهذه النسخة محفوظة بالفعل':run.status==='COMPLETED'?'تم تشغيل فحص الامتثال الآلي — مساعد فقط':(errors[run.errorCode]||'تعذر إكمال الفحص');
 } catch(error) {results.delete(id);throw error;}
}
