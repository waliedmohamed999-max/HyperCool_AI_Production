import {escape,badge,empty,button,drawer,tabs,enhance} from './components/ui/index.js';
const $=selector=>document.querySelector(selector);
const categoryNames={AI:'الذكاء الاصطناعي',Commerce:'التجارة الإلكترونية',Messaging:'المراسلات',Social:'شبكات التواصل',Productivity:'الإنتاجية'};
const statusNames={CONNECTED:'متصل',NEEDS_SETUP:'يحتاج إعداد',ERROR:'به خطأ',CONFIGURED_NO_CONNECTOR:'يحتاج انتباه',NOT_SUPPORTED:'غير مدعوم'};
const errorLabels={AUTH_FAILED:'فشل التحقق من الهوية',RATE_LIMITED:'تجاوز حد الطلبات',NETWORK_ERROR:'خطأ شبكة أو مهلة',NOT_CONFIGURED:'غير مُعد',OK:'الاتصال يعمل'};
let dashboard=null,apiClient=null,currentCategory='';

function kpiCard(label,value,hint,filterStatus){
 return `<article class="kpi-card clickable" data-integration-kpi="${filterStatus}"><span class="kpi-label">${escape(label)}</span><strong class="kpi-value">${escape(value)}</strong><span class="kpi-context">${escape(hint)}</span></article>`;
}
function renderSummary(){
 const s=dashboard.summary;
 $('#integrations-summary').innerHTML=[
  kpiCard('Connected',s.connected,'خدمات متصلة وتعمل فعليًا','CONNECTED'),
  kpiCard('Needs Setup',s.needsSetup,'بانتظار إضافة بيانات الاعتماد','NEEDS_SETUP'),
  kpiCard('Attention Required',s.attentionRequired,'الإعداد موجود لكن لا يوجد ربط فعلي بعد','CONFIGURED_NO_CONNECTOR'),
  kpiCard('Errors',s.errors,'يحتاج مراجعة الآن','ERROR')
 ].join('');
}
function renderCategoryFilters(){
 const counts={};for(const i of dashboard.integrations)counts[i.category]=(counts[i.category]||0)+1;
 const cats=['','AI','Commerce','Messaging','Social','Productivity'];
 $('#integrations-category-filters').innerHTML=cats.map(c=>`<button type="button" class="tab${c===currentCategory?' active':''}" data-integration-category="${c}">${c?escape(categoryNames[c]):'الكل'}<span class="count">${c?counts[c]||0:dashboard.integrations.length}</span></button>`).join('');
}
function statusFor(id){return dashboard.integrations.find(i=>i.id===id);}
function primaryLabel(status){return status==='CONNECTED'?'إدارة':status==='ERROR'?'إعادة الاتصال':status==='CONFIGURED_NO_CONNECTOR'?'عرض التفاصيل':status==='NOT_SUPPORTED'?'غير مدعوم':'ربط';}
function healthLabel(i){
 if(!i.connectorImplemented)return 'غير قابلة للقياس (لا يوجد اتصال فعلي)';
 if(i.status==='ERROR')return 'تحتاج انتباه';
 if(i.status==='CONNECTED')return 'جيدة';
 return '—';
}
function renderCards(){
 const list=dashboard.integrations.filter(i=>!currentCategory||i.category===currentCategory);
 $('#integration-list').className='grid integrations-grid';
 $('#integration-list').innerHTML=list.map(i=>`<article class="card integration-card">
  <div class="row-between"><span class="integration-logo" dir="ltr">${escape(i.name.slice(0,2))}</span>${badge(statusNames[i.status],i.status)}</div>
  <h3 dir="ltr">${escape(i.name)}</h3><p>${escape(i.description)}</p>
  <div class="integration-meta">
   <div><span>${i.id==='salla'?'آخر مزامنة':'آخر نشاط'}</span><strong>${i.lastActivity?new Date(i.lastActivity.at).toLocaleDateString('ar-SA',{timeZone:'Asia/Riyadh'}):'لا يوجد بعد'}</strong></div>
   <div><span>الصحة</span><strong>${escape(healthLabel(i))}</strong></div>
  </div>
  <div class="row"><button type="button" data-integration-primary="${i.id}"${i.status==='NOT_SUPPORTED'?' disabled title="لا يوجد دعم لهذه الخدمة في هذا الإصدار"':''}>${primaryLabel(i.status)}</button><button type="button" class="secondary" data-integration-details="${i.id}">عرض التفاصيل</button></div>
 </article>`).join('')||empty('لا توجد تكاملات في هذا التصنيف');
}
function renderSyncLog(){
 const rows=dashboard.recentSyncActivity;
 if(!rows.length){$('#integrations-sync-log').innerHTML=empty('لا يوجد نشاط مزامنة مسجل بعد');return;}
 $('#integrations-sync-log').innerHTML=`<table><thead><tr><th>الوقت</th><th>التكامل</th><th>العملية</th><th>الحالة</th><th>السجلات</th><th>المدة</th></tr></thead><tbody>${rows.map(r=>`<tr><td dir="ltr">${new Date(r.at).toLocaleString('ar-SA',{timeZone:'Asia/Riyadh'})}</td><td dir="ltr">${escape(r.integration)}</td><td>${escape(r.operation)}</td><td>${badge(r.status==='COMPLETED'?'مكتمل':r.status==='ERROR'||r.status==='FAILED'?'فشل':escape(r.status),r.status)}</td><td dir="ltr">${r.records??'—'}</td><td dir="ltr">${r.durationMs!=null?(r.durationMs/1000).toFixed(1)+'s':'—'}</td></tr>`).join('')}</tbody></table>`;
}
function renderErrorsList(){
 const rows=dashboard.integrations.flatMap(i=>i.recentErrors.map(e=>({...e,integration:i.name})));
 if(!rows.length){$('#integrations-errors').innerHTML=empty('لا توجد أخطاء مسجلة حاليًا');return;}
 $('#integrations-errors').innerHTML=`<div class="risk-list">${rows.slice(0,15).map(e=>`<div class="risk-item"><div class="risk-body"><span class="risk-title" dir="ltr">${escape(e.integration)} — ${escape(errorLabels[e.code]||e.code)}</span><span class="risk-meta">${escape(e.action)}</span></div><small dir="ltr">${new Date(e.at).toLocaleString('ar-SA',{timeZone:'Asia/Riyadh'})}</small></div>`).join('')}</div>`;
}
function renderDependencyMap(){
 const rows=dashboard.integrations.filter(i=>i.agentsUsing.length);
 if(!rows.length){$('#integrations-dependency-map').innerHTML=empty('لا توجد اعتماديات مسجلة للوكلاء على التكاملات الحالية');return;}
 $('#integrations-dependency-map').innerHTML=`<div class="risk-list">${rows.map(i=>`<div class="risk-item"><div class="risk-body"><span class="risk-title" dir="ltr">${escape(i.name)}</span><span class="risk-meta">يُستخدم بواسطة: ${i.agentsUsing.map(a=>escape(a.name)).join('، ')}</span></div>${badge(statusNames[i.status],i.status)}</div>`).join('')}</div>`;
}
function envGuidance(i){
 if(!i.envVars.length)return '<p>لا يوجد مسار إعداد لهذه الخدمة في هذا الإصدار — لا متغير بيئة ولا اتصال فعلي مبني بعد.</p>';
 const rows=i.envVars.map(v=>`<p>${escape(v.name)}: ${badge(v.configured?'مُعد':'غير مُعد',v.configured?'CONNECTED':'NEEDS_SETUP')}</p>`).join('');
 return `${rows}<p><small>تُدار هذه القيم من متغيرات بيئة الخادم (.env) — لا يمكن إضافتها أو تعديلها من هذه الواجهة، ولا تُعرض قيمتها هنا لأي دور.</small></p>`;
}
async function openDetail(id,initialTab=0){
 const i=statusFor(id);if(!i)return;
 const overview=document.createElement('div');
 overview.innerHTML=`<div class="row-between">${badge(statusNames[i.status],i.status)}<span>${escape(i.authType)}</span></div>
  <p>${escape(i.description)}</p>
  ${i.id==='salla'&&i.lastActivity?`<p>آخر مزامنة ناجحة: <span dir="ltr">${new Date(i.lastActivity.at).toLocaleString('ar-SA',{timeZone:'Asia/Riyadh'})}</span> بواسطة ${escape(i.lastActivity.by||'—')} — ${i.lastActivity.count} منتج</p>`:''}
  ${i.id==='anthropic'&&i.lastActivity?`<p>آخر نشاط ناجح: <span dir="ltr">${new Date(i.lastActivity.at).toLocaleString('ar-SA',{timeZone:'Asia/Riyadh'})}</span> (${escape(i.lastActivity.note)})</p>`:''}
  ${!i.lastActivity?`<p>${i.connectorImplemented?'لا يوجد نشاط مسجل بعد.':'لا يوجد اتصال فعلي بهذه الخدمة في هذا الإصدار — الإعداد إن وُجد لا يُستخدم من أي كود حالي.'}</p>`:''}
  <p>الصحة: ${escape(healthLabel(i))}</p>`;

 const config=document.createElement('div');
 config.innerHTML=envGuidance(i);
 if(i.connectorImplemented){
  const testBtn=button('اختبار الاتصال',{variant:'secondary'});
  const result=document.createElement('p');
  testBtn.onclick=async()=>{testBtn.disabled=true;result.textContent='جارٍ الفحص…';try{const r=await apiClient(`/api/integrations/${i.id}/test`,{});result.textContent=r.result==='OK'?'Connection OK — الاتصال يعمل':r.result==='AUTH_FAILED'?'Authentication failed — تحقق من صحة المفتاح':r.result==='NOT_CONFIGURED'?'الإعداد غير مكتمل بعد':errorLabels[r.result]||r.result;}catch(error){result.textContent=error.message;}finally{testBtn.disabled=false;}};
  config.append(testBtn,result);
 } else {
  const disabled=button('اختبار الاتصال',{variant:'secondary'});disabled.disabled=true;disabled.title='لا يوجد اتصال فعلي مبني لهذه الخدمة بعد في هذا الإصدار';
  config.append(disabled);
 }

 const permissions=document.createElement('div');
 permissions.innerHTML=i.scopes.length?i.scopes.map(s=>`<p dir="ltr">${escape(s.name)}</p><p><small>${escape(s.note)} — <b>غير مُتحقق حيًا (لا يوجد OAuth متصل بعد)</b></small></p>`).join(''):'<p>لا يوجد نظام صلاحيات مجزّأ (Scopes) لهذه الخدمة — بيانات الاعتماد الحالية تمنح وصولًا كاملًا عند توفرها.</p>';

 const history=document.createElement('div');
 const relevant=dashboard.recentSyncActivity.filter(r=>r.integration===i.name);
 history.innerHTML=relevant.length?`<table><thead><tr><th>الوقت</th><th>العملية</th><th>الحالة</th><th>السجلات</th></tr></thead><tbody>${relevant.map(r=>`<tr><td dir="ltr">${new Date(r.at).toLocaleString('ar-SA',{timeZone:'Asia/Riyadh'})}</td><td>${escape(r.operation)}</td><td>${badge(r.status,r.status)}</td><td dir="ltr">${r.records??'—'}</td></tr>`).join('')}</tbody></table>`:empty('لا يوجد سجل مزامنة لهذا التكامل بعد');

 const usage=document.createElement('div');
 usage.innerHTML=i.agentsUsing.length?`<p>الوكلاء المعتمدون على هذا التكامل:</p><ul>${i.agentsUsing.map(a=>`<li>${escape(a.name)}</li>`).join('')}</ul><p><small>إذا انقطع هذا التكامل: تبقى هذه الوكلاء Online، لكن الأداة المرتبطة به تصبح غير متاحة (INTEGRATION_REQUIRED) حتى إعادة الربط.</small></p>`:'<p>لا يوجد وكيل يعتمد على هذا التكامل حاليًا.</p>';

 const errors=document.createElement('div');
 errors.innerHTML=i.recentErrors.length?`<div class="risk-list">${i.recentErrors.map(e=>`<div class="risk-item"><div class="risk-body"><span class="risk-title">${escape(errorLabels[e.code]||e.code)}</span><span class="risk-meta">${escape(e.action)}</span></div><small dir="ltr">${new Date(e.at).toLocaleString('ar-SA',{timeZone:'Asia/Riyadh'})}</small></div>`).join('')}</div>`:empty('لا توجد أخطاء مسجلة لهذا التكامل');

 const node=document.createElement('div');
 node.append(overview,config,permissions,history,usage,errors);
 tabs(node,[['نظرة عامة',overview],['الإعداد',config],['الصلاحيات',permissions],['سجل المزامنة',history],['الاستخدام',usage],['الأخطاء',errors]]);
 const dialog=drawer(i.name,node,{restore:true});
 enhance(node);
 const tabButtons=dialog.querySelectorAll('.ui-tabs .tab');
 if(tabButtons[initialTab])tabButtons[initialTab].click();
}
export async function renderIntegrations({api}){
 apiClient=api;
 try{dashboard=await api('/api/integrations/dashboard');}catch(error){dashboard=null;console.error('integrations dashboard failed to load:',error);}
 if(!dashboard){$('#integration-list').innerHTML=empty('تعذر تحميل حالة التكاملات');return;}
 renderSummary();renderCategoryFilters();renderCards();renderSyncLog();renderErrorsList();renderDependencyMap();
}
export function installIntegrationInteractions(){
 document.addEventListener('click',e=>{
  const cat=e.target.closest('[data-integration-category]');
  if(cat){currentCategory=cat.dataset.integrationCategory;renderCategoryFilters();renderCards();return;}
  const kpi=e.target.closest('[data-integration-kpi]');
  if(kpi){currentCategory='';renderCategoryFilters();renderCards();$('#integration-list').scrollIntoView({behavior:'smooth',block:'start'});return;}
  const primary=e.target.closest('[data-integration-primary]');
  if(primary){openDetail(primary.dataset.integrationPrimary,1);return;}
  const details=e.target.closest('[data-integration-details]');
  if(details){openDetail(details.dataset.integrationDetails,0);return;}
 });
}
export async function checkAllIntegrations(api,message){
 const implemented=dashboard?.integrations.filter(i=>i.connectorImplemented)||[];
 for(const i of implemented){
  try{const r=await api(`/api/integrations/${i.id}/test`,{});message(`${i.name}: ${r.result==='OK'?'الاتصال يعمل':errorLabels[r.result]||r.result}`);}
  catch(error){message(`${i.name}: ${error.message}`);}
 }
 if(!implemented.length)message('لا يوجد تكامل فعلي حاليًا قابل للفحص');
}
