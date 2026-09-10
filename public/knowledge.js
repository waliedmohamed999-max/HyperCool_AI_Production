const labels={RUNNING:'قيد التنفيذ',COMPLETED:'تم إنشاء المسودة',ERROR:'تعذر التوليد',INTERRUPTED:'انقطع التشغيل — لم يُعد الطلب تلقائيًا',NEEDS_DATA:'بيانات ناقصة',HUMAN_REVIEW:'يتطلب مراجعة بشرية',BLOCKED:'محظور'};
const errors={ANTHROPIC_NOT_CONFIGURED:'إعداد Anthropic غير مكتمل',SALLA_NOT_CONFIGURED:'أضف رمز سلة إلى إعدادات الخادم',CREDENTIALS_REJECTED:'رفض الخدمة لبيانات الدخول',RATE_LIMITED:'تم تجاوز حد الطلبات',NETWORK_OR_TIMEOUT:'انقطع الاتصال أو انتهت المهلة',INVALID_MODEL_OUTPUT:'مخرجات الموديل لا تطابق العقد',INCOMPLETE_MODEL_OUTPUT:'لم يكتمل رد الموديل',CONTEXT_CHANGED:'تغيرت المعلومات أثناء التوليد',MODEL_LINK_MISMATCH:'رابط الناتج مختلف عن رابط المنتج',HUMAN_REVIEW_REQUIRED:'القرار يحتاج مراجعة بشرية'};
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
 select.innerHTML='<option value="">اختر منتجًا مستوردًا</option>'+products.map(p=>`<option value="${escape(p.id)}">${escape(p.name.value)} (${escape(p.id)})</option>`).join('');select.value=selected;
 document.querySelector('#run-list').innerHTML=runs.length?runs.map(run=>`<div class="audit-row"><div class="row-between"><b>${escape(run.title)}</b><span class="pill" data-status="${escape(run.status)}">${labels[run.status]||escape(run.status)}</span></div>${run.errorCode?`<p>${escape(errors[run.errorCode]||run.errorCode)}</p>`:''}${run.decision?.missing_data?.length?`<p>${escape(run.decision.missing_data.join('، '))}</p>`:''}<small>${escape(run.createdAt)}${run.usage?' · Tokens: '+escape(run.usage.input_tokens+run.usage.output_tokens):''}</small></div>`).join(''):'لم يتم تشغيل أي طلب بعد.';
}
export async function submitKnowledge(form,input,api) {
 if(form.id==='memory-form') {
  if(input.intent==='propose') {
   await api('/api/memory/propose',{kind:input.kind,key:input.key,value:input.value,source:input.source,changeReason:input.changeReason,productId:input.productId});
   return 'تم إرسال المعلومة للاعتماد؛ لن تصبح متاحة للوكلاء إلا بعد اعتماد المالك';
  }
  input.expectedVersion=memory.find(entry=>entry.key===input.key.trim())?.version||0;
  if(input.expiresAt)input.expiresAt=new Date(input.expiresAt).toISOString();
  await api('/api/memory',input);return 'تم حفظ إصدار الذاكرة';
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
