import {escape,badge,empty,button,drawer,tabs,enhance} from './components/ui/index.js';
const $=selector=>document.querySelector(selector);
export const memoryKinds={brand_voice:'نبرة العلامة',product_fact:'مواصفات المنتجات',price_reference:'مراجع الأسعار',approved_claim:'الادعاءات المعتمدة',faq:'الأسئلة الشائعة',objection:'الاعتراضات',policy:'السياسات',winning_hook:'افتتاحيات ناجحة',losing_hook:'افتتاحيات غير فعالة',lost_deal_reason:'أسباب خسارة الصفقات',process_rule:'قواعد العمل',customer_pattern:'أنماط العملاء',competitor_insight:'ملاحظات المنافسين'};
const agentNames={frost:'Frost',strategy:'استراتيجية المحتوى',copy:'كتابة المحتوى',creative:'التصميم',compliance:'مراجعة الامتثال',publishing:'النشر والجدولة',leads:'العملاء المحتملون',sales:'المحادثات والمبيعات',followup:'المتابعة',intelligence:'رصد السوق',performance:'قياس الأداء',memory:'ذاكرة العلامة',human:'فريق العمل (مقترح بشري)'};
let entries=[],products=[],approvals=[],dashboard=null,user=null,apiClient=null;

function kpiCard(label,value,hint){return `<article class="kpi-card"><span class="kpi-label">${escape(label)}</span><strong class="kpi-value">${escape(value)}</strong><span class="kpi-context">${escape(hint)}</span></article>`;}
function recordStatus(e){return e.status==='REVOKED'?'REVOKED':e.expiresAt&&Date.parse(e.expiresAt)<=Date.now()?'EXPIRED':'APPROVED';}
const statusLabel={REVOKED:'مسحوب',EXPIRED:'منتهي',APPROVED:'معتمد'};
function groupByKey(list){const groups=new Map();for(const e of list){if(!groups.has(e.key))groups.set(e.key,[]);groups.get(e.key).push(e);}return groups;}

function renderSummary(){
 if(!dashboard)return;
 const s=dashboard.summary;
 $('#memory-summary').innerHTML=[
  kpiCard('إجمالي السجلات',s.totalRecords.value,s.totalRecords.hint),
  kpiCard('Verified',s.verified.value,s.verified.hint),
  kpiCard('Needs Review',s.needsReview.value,s.needsReview.hint),
  kpiCard('Expired',s.expired.value,s.expired.hint),
  kpiCard('Pending Approval',s.pendingApproval.value,s.pendingApproval.hint),
  kpiCard('Products Synced',s.productsSynced.value,s.productsSynced.hint)
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
 if(!dashboard){$('#memory-health-list').innerHTML=empty('جارٍ التحميل…');return;}
 const h=dashboard.health;
 const rows=[
  ...h.priceConflicts.map(c=>({severity:'HIGH',text:`تعارض سعر: ${c.productName} — الذاكرة تقول ${c.memoryAmount} بينما آخر سعر من سلة ${c.liveAmount} ${c.liveCurrency||'SAR'}`,key:c.key})),
  ...h.expiredClaims.map(c=>({severity:'MEDIUM',text:`منتهي: ${memoryKinds[c.kind]||c.kind} — ${c.key}`,key:c.key})),
  ...h.weakSource.map(c=>({severity:'LOW',text:`مصدر ضعيف يستحق التقوية: ${c.key} (${escape(c.source)})`,key:c.key})),
  ...h.needsReview.map(c=>({severity:'LOW',text:`بدون تاريخ انتهاء لحقيقة حسّاسة للوقت: ${c.key}`,key:c.key}))
 ];
 if(!rows.length){$('#memory-health-list').innerHTML=empty('لا مشاكل مكتشفة الآن','الفحوصات: تعارض الأسعار مع سلة، مصادر ضعيفة، ادعاءات منتهية، حقائق بلا تاريخ مراجعة.');return;}
 $('#memory-health-list').innerHTML=`<div class="risk-list">${rows.map(r=>`<div class="risk-item"><div class="risk-body"><span class="risk-title">${escape(r.text)}</span></div>${badge(r.severity==='HIGH'?'عالٍ':r.severity==='MEDIUM'?'متوسط':'منخفض',r.severity==='HIGH'?'BLOCKED':r.severity==='MEDIUM'?'PENDING':'APPROVED')}<button type="button" class="ghost" data-memory-open-key="${escape(r.key)}">فتح</button></div>`).join('')}</div>`;
}
function renderApprovals(){
 if(!approvals.length){$('#memory-approvals-list').innerHTML=empty('لا توجد اقتراحات ذاكرة معلّقة الآن');return;}
 $('#memory-approvals-list').innerHTML=`<div class="risk-list">${approvals.map(a=>{
  const p=a.proposed_output,current=groupByKey(entries).get(p.key)?.[0];
  return `<div class="risk-item"><div class="risk-body"><span class="risk-title">${escape(agentNames[a.agent_id]||a.agent_id)} يقترح: ${escape(memoryKinds[p.type]||p.type)} — ${escape(p.key)}</span><span class="risk-meta">القيمة الحالية: ${current?escape(current.value):'لا توجد'} ← المقترحة: ${escape(p.newValue)}${p.confidence!=null?' · الثقة: '+Math.round(p.confidence*100)+'%':''}</span><span class="risk-meta">الدليل: ${escape(p.evidence||'—')} · السبب: ${escape(a.reason)}</span></div><div class="row"><button type="button" data-memory-apply-approval="${a.id}">تحويل إلى سجل ذاكرة</button><button type="button" data-approval-decide="${a.id}" data-decision="APPROVED">اعتماد</button><button type="button" class="secondary" data-approval-decide="${a.id}" data-decision="REJECTED">رفض</button></div></div>`;
 }).join('')}</div>`;
}
function renderProducts(){
 if(!products.length){$('#product-list').innerHTML=empty('كتالوج المنتجات فارغ','حدّث الكتالوج بعد إعداد تكامل سلة.');return;}
 $('#product-list').innerHTML=`<table><thead><tr><th>المنتج</th><th title="معرف سلة يُستخدم كمرجع SKU">SKU / المعرف</th><th>السعر</th><th>المخزون</th><th title="غير مستورد من سلة حاليًا">التصنيف</th><th>آخر مزامنة</th><th>التحقق</th><th></th></tr></thead><tbody>${products.map(p=>`<tr><td>${escape(p.name.value)}</td><td dir="ltr">${escape(p.id)}</td><td dir="ltr">${p.price.value?escape(p.price.value.amount)+' '+escape(p.price.value.currency||'SAR'):'غير معلوم'} <span class="pill" data-status="COMPLETED" title="من آخر مزامنة سلة مباشرة">Live</span></td><td>${escape(p.stock.value??'غير معلوم')}</td><td>—</td><td dir="ltr">${new Date(p.syncedAt).toLocaleDateString('ar-SA')}</td><td><span class="pill" data-status="${p.available.value===false?'BLOCKED':'COMPLETED'}">${p.available.value===false?'غير متاح':'متاح'}</span></td><td><button type="button" class="ghost" data-product-view="${escape(p.id)}">عرض</button></td></tr>`).join('')}</tbody></table>`;
 enhance($('#product-list'));
 $('#product-list').querySelectorAll('[data-product-view]').forEach(b=>b.onclick=()=>{
  const p=products.find(x=>x.id===b.dataset.productView);
  const linked=groupByKey(entries.filter(e=>e.productId===p.id)).size;
  const node=document.createElement('div');
  node.innerHTML=`<p><b>${escape(p.name.value)}</b></p><p>SKU: <span dir="ltr">${escape(p.id)}</span></p><p>السعر: <span dir="ltr">${p.price.value?escape(p.price.value.amount)+' '+escape(p.price.value.currency||'SAR'):'غير معلوم'}</span> · مصدر: <span dir="ltr">${escape(p.price.source||'—')}</span></p><p>المخزون: ${escape(p.stock.value??'غير معلوم')}</p><p>آخر مزامنة: <span dir="ltr">${new Date(p.syncedAt).toLocaleString('ar-SA')}</span></p><p><a href="${escape(p.url.value)}" target="_blank" rel="noopener noreferrer">فتح صفحة المنتج ↗</a></p><p>${linked} سجل ذاكرة مرتبط بهذا المنتج</p>`;
  const refresh=button('تحديث الكتالوج كاملًا',{variant:'secondary'});refresh.title='لا يوجد تحديث لمنتج واحد في تكامل سلة الحالي — يعيد مزامنة الكتالوج بالكامل';refresh.onclick=()=>{node.closest('dialog').close();$('#salla-sync')?.click();};
  const notes=button('تعديل ملاحظات محلية');notes.disabled=true;notes.title='غير مفعّل — لا يوجد حقل ملاحظات محلية منفصل في البيانات الحالية؛ أضف مواصفة منتج (Product Fact) في ذاكرة العلامة بدلًا من ذلك.';
  node.append(refresh,notes);
  drawer('تفاصيل المنتج',node,{restore:true});
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
 if(!visible.length){$('#memory-list').innerHTML=empty('لا توجد معلومات مطابقة','أضف معلومة معتمدة أو غيّر تصنيف البحث.');return;}
 $('#memory-list').innerHTML=`<table><thead><tr><th>المفتاح</th><th>النوع</th><th>القيمة</th><th>الحالة</th><th>المصدر</th><th>آخر تحديث</th><th>الإصدار</th></tr></thead><tbody>${visible.map(([key,versions])=>{
  const e=versions[0],status=recordStatus(e);
  return `<tr class="clickable" data-memory-row="${escape(key)}"><td dir="auto">${escape(key)}</td><td>${escape(memoryKinds[e.kind]||e.kind)}</td><td>${escape(e.value.slice(0,80))}${e.value.length>80?'…':''}</td><td>${badge(statusLabel[status],status)}</td><td>${escape(e.source.slice(0,40))}</td><td dir="ltr">${new Date(e.verifiedAt).toLocaleDateString('ar-SA')}</td><td dir="ltr">v${e.version}</td></tr>`;
 }).join('')}</tbody></table>`;
 enhance($('#memory-list'));
 $('#memory-list').querySelectorAll('[data-memory-row]').forEach(row=>row.onclick=()=>openMemoryDetail(row.dataset.memoryRow,groups.get(row.dataset.memoryRow)));
}
async function openMemoryDetail(key,versions){
 const e=versions[0],status=recordStatus(e);
 const productName=e.productId?products.find(p=>p.id===e.productId)?.name.value:null;
 const details=document.createElement('div');
 details.innerHTML=`<div class="row-between"><span>${escape(memoryKinds[e.kind]||e.kind)}</span>${badge(statusLabel[status],status)}</div><h3 dir="auto">${escape(e.key)}</h3><p>${escape(e.value)}</p>${e.productId?`<p>المنتج المرتبط: ${escape(productName||e.productId)}</p>`:''}<p>المصدر / الدليل: ${escape(e.source)}</p><p>الثقة: غير محسوبة لسجلات الذاكرة المحفوظة (تتوفر فقط لمقترحات الوكلاء قبل الاعتماد)</p><p>أنشأه/اعتمده: ${escape(e.approvedByName||'—')}</p><p>الإصدار: ${e.version} · آخر تحديث: <span dir="ltr">${new Date(e.verifiedAt).toLocaleString('ar-SA')}</span></p>${e.expiresAt?`<p>ينتهي في: <span dir="ltr">${new Date(e.expiresAt).toLocaleString('ar-SA')}</span></p>`:''}`;
 if(user.role==='owner'){
  const edit=button('إضافة إصدار جديد');
  edit.onclick=()=>{node.closest('dialog').close();prefillMemoryForm(e);};
  details.append(edit);
 }
 const history=document.createElement('div');
 history.innerHTML=versions.map(v=>`<article class="panel"><div class="row-between"><h3>الإصدار ${v.version}</h3>${badge(statusLabel[recordStatus(v)],recordStatus(v))}</div><p>${escape(v.value)}</p><p>المصدر: ${escape(v.source)}</p><small>${escape(v.approvedByName)} · ${escape(v.changeReason)} · <span dir="ltr">${new Date(v.verifiedAt).toLocaleString('ar-SA')}</span></small>${user.role==='owner'?'':''}</article>`).join('');
 if(user.role==='owner'){
  [...history.children].forEach((card,i)=>{
   if(i===0)return; // latest version — "restore" only makes sense for an older one
   const restore=button('استعادة كإصدار جديد',{variant:'secondary'});
   restore.onclick=()=>{node.closest('dialog').close();prefillMemoryForm(versions[i]);};
   card.append(restore);
  });
 }
 const usage=document.createElement('div');
 usage.innerHTML='<p role="status">جارٍ تحميل بيانات الاستخدام…</p>';
 apiClient('/api/memory/usage?key='+encodeURIComponent(key)).then(rows=>{
  usage.innerHTML=rows.length?rows.map(r=>`<p>${escape(agentNames[r.agentId]||r.agentId)} · آخر استخدام: <span dir="ltr">${new Date(r.lastAccessedAt).toLocaleString('ar-SA')}</span></p>`).join(''):empty('لا يوجد استخدام مسجل لهذا السجل بعد','يُحسب من استدعاءات أدوات الوكلاء الفعلية (search_brand_memory / get_competitor_data).');
 }).catch(()=>{usage.innerHTML='<p>تعذر تحميل بيانات الاستخدام.</p>';});
 const related=document.createElement('div');
 const relatedEntries=[...groupByKey(entries.filter(x=>x.key!==key&&((e.productId&&x.productId===e.productId)||x.kind===e.kind))).values()].slice(0,10);
 related.innerHTML=relatedEntries.length?relatedEntries.map(v=>`<p><b>${escape(v[0].key)}</b> — ${escape(v[0].value.slice(0,60))}</p>`).join(''):empty('لا سجلات مرتبطة');
 const node=document.createElement('div');
 node.append(details,history,usage,related);
 tabs(node,[['التفاصيل',details],['السجل',history],['استخدام الوكلاء',usage],['سجلات مرتبطة',related]]);
 drawer('تفاصيل سجل الذاكرة',node,{restore:true});
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
 form.elements.changeReason.value=`اعتماد اقتراح وكيل (${agentNames[approval.agent_id]||approval.agent_id}): ${approval.reason}`;
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
