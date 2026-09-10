import {fmtNum,fmtSAR,fmtDateRange,empty,miniStat,kpiCard,renderBarChart,renderFunnel,stageNames} from './format.js';
const $=selector=>document.querySelector(selector);
const actionTypeNames={publish_content:'نشر محتوى',send_marketing_message:'إرسال رسالة تسويقية',discount:'خصم',large_quote:'عرض سعر كبير',memory_policy_change:'تغيير في ذاكرة العلامة',medical_claim:'ادعاء طبي',agent_permission_change:'تغيير صلاحية وكيل'};
let lastData=null;

function renderPipeline(pipeline,escape) {
 if(!pipeline.hasData)return empty('لا توجد بيانات مبيعات كافية.','أضف عملاء محتملين وقيمة الفرصة التقديرية ليظهر تحليل الإيرادات هنا.');
 const stats=[
  miniStat('قيمة الفرص المفتوحة',fmtSAR(pipeline.pipelineValue)),
  miniStat('إيرادات هذا الأسبوع',fmtSAR(pipeline.wonRevenue)),
  miniStat('متوسط قيمة الصفقة',pipeline.avgDealSize?fmtSAR(pipeline.avgDealSize):'لا صفقات مكتسبة بعد'),
  miniStat('قيمة عروض الأسعار المرسلة',fmtSAR(pipeline.quotesValue))
 ].join('');
 const rows=pipeline.topOpportunities.length?`<div class="calendar-scroll"><table><thead><tr><th>الجهة</th><th>القيمة</th><th>المرحلة</th><th>المدينة</th><th>الاحتياج</th></tr></thead><tbody>${pipeline.topOpportunities.map(o=>`<tr><td>${escape(o.name)}</td><td dir="ltr">${fmtSAR(o.valueSAR)}</td><td><span class="pill" data-status="${escape(o.stage)}">${escape(stageNames[o.stage]||o.stage)}</span></td><td>${escape(o.city||'—')}</td><td>${escape(o.productNeed||'—')}</td></tr>`).join('')}</tbody></table></div>`:'<p>لا توجد فرص بقيمة تقديرية مسجلة بعد.</p>';
 return `<div class="kpi-grid">${stats}</div><h4>أهم الفرص المفتوحة</h4>${rows}`;
}
function renderContent(base,escape) {
 const platforms=Object.entries(base.content.byPlatform);
 return `<div class="kpi-grid">
  ${miniStat('محتوى مخطط هذا الأسبوع',fmtNum(base.content.total))}
  ${miniStat('بانتظار اعتماد المالك',fmtNum(Object.entries(base.content.byStatus).find(([k])=>k==='REVIEWED')?.[1]||0))}
  ${miniStat('محظور بالامتثال الآلي',fmtNum(base.compliance.byClassification?.BLOCK||0))}
  ${miniStat('منشور فعليًا',fmtNum(base.metrics.publishedPosts||0))}
 </div>
 <h4>حسب المنصة</h4>${renderBarChart(platforms,escape)}
 <p><small>${escape(base.metrics.reason)}</small></p>`;
}
function renderAgentsSection(agents,escape) {
 const rows=agents.agents.filter(a=>a.runs>0).sort((a,b)=>b.runs-a.runs);
 if(!rows.length)return empty('لا توجد تشغيلات وكلاء مسجلة هذا الأسبوع بعد.','تعمل الوكلاء تلقائيًا مع كل حدث حقيقي (عميل جديد، رسالة واردة) — أو شغّل «اختبار الوكيل» من صفحة فريق الوكلاء.');
 return `<div class="calendar-scroll"><table><thead><tr><th>الوكيل</th><th>تشغيلات</th><th>نسبة النجاح</th><th>أخطاء</th><th>تصعيدات</th><th>متوسط الاستجابة</th></tr></thead><tbody>${rows.map(a=>`<tr class="agent-perf-row"><td>${escape(a.nameAr)}</td><td dir="ltr">${a.runs}</td><td dir="ltr">${a.successRate===null?'—':a.successRate+'%'}</td><td dir="ltr">${a.failed}</td><td dir="ltr">${a.escalations}</td><td dir="ltr">${a.avgLatencyMs?Math.round(a.avgLatencyMs/1000)+' ث':'—'}</td></tr>`).join('')}</tbody></table></div>`;
}
function renderRisks(risks,escape) {
 const items=[
  ...risks.pendingContentReview.map(i=>({title:`محتوى بانتظار المراجعة: ${i.title}`,meta:i.platform,priority:'P3',page:'content'})),
  ...risks.pendingAgentApprovals.map(a=>({title:`${actionTypeNames[a.actionType]||a.actionType} — ${a.reason}`,meta:'وكيل: '+a.agentId,priority:a.riskLevel==='HIGH'?'P1':a.riskLevel==='MEDIUM'?'P2':'P3',page:'agents'})),
  ...risks.openEscalations.map(e=>({title:e.reason,meta:'وكيل: '+e.agentId,priority:e.priority,page:'agents'}))
 ];
 if(!items.length)return empty('لا قرارات معلّقة حاليًا — كل شيء تحت السيطرة.');
 return `<div class="risk-list">${items.map(item=>`<div class="risk-item${item.page?' clickable':''}"${item.page?` data-report-nav="${item.page}"`:''}><div class="risk-body"><span class="risk-title">${escape(item.title)}</span><span class="risk-meta">${escape(item.meta)}</span></div><span class="pill" data-status="${escape(item.priority)}">${escape(item.priority)}</span></div>`).join('')}</div>`;
}
function renderMarket(market,escape) {
 if(!market.hasData)return empty('لا توجد بيانات منافسين مسجلة بعد.','أضفها من «ذاكرة العلامة» بنوع «ملاحظة عن منافس».');
 return market.signals.map(signal=>`<div class="signal-card"><span class="signal-tag">FACT</span><p>${escape(signal.value)}</p><small>المصدر: ${escape(signal.source)} · اعتماد: ${escape(new Date(signal.approvedAt).toLocaleDateString('ar-SA'))}</small></div>`).join('');
}
function renderRecommendations(quickSummary,escape) {
 if(!quickSummary.hasEnoughData)return empty('لا توجد بيانات كافية بعد لاقتراح توصيات موثوقة.','التوصيات تُبنى من نتائج فعلية فقط — لن تظهر أرقام تقديرية.');
 const items=[
  ...quickSummary.opportunities.map(text=>({priority:'P2',text})),
  ...quickSummary.issues.map(text=>({priority:'P1',text}))
 ].slice(0,5);
 if(!items.length)return empty('لا توصيات إضافية هذا الأسبوع.');
 return `<div class="recommendation-list">${items.map(item=>`<div class="recommendation-card"><span class="pill" data-status="${item.priority}">${item.priority}</span><div class="rec-body"><p>${escape(item.text)}</p></div></div>`).join('')}</div>`;
}
function renderNextWeek(plan,escape) {
 const dayNames=['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
 if(plan.calendarMissing)return empty('لا يوجد تقويم للأسبوع القادم بعد.','أنشئه من صفحة «التقويم والجدولة».');
 return `<div class="week-grid">${plan.days.map((day,index)=>`<div class="week-day"><h5>${dayNames[index]}</h5>${day.planned?`<span>${day.planned} مجدول</span>`:''}${day.gaps.map(g=>`<span class="gap-tag">فجوة: ${escape(g.platform)}</span>`).join('')}${!day.planned&&!day.gaps.length?'<small>—</small>':''}</div>`).join('')}</div>`;
}
function renderSavedReports(saved,escape) {
 if(!saved.length)return empty('لا توجد تقارير محفوظة حتى الآن.','اضغط «حفظ تقرير هذا الأسبوع» أعلاه لبدء الأرشيف.');
 return `<div class="report-cards">${saved.map((report,index)=>{
  const legacy=!report.kpis;
  const revenue=legacy?null:report.kpis.wonRevenue.value;
  const leads=legacy?report.crm.leadsCreated:report.kpis.leadsCreated.value;
  const won=legacy?null:report.kpis.wonDeals.value;
  return `<article class="card report-card" data-saved-report="${index}"><h4>${fmtDateRange(report.weekStart,report.weekEnd)}</h4><p><small>${legacy?'تقرير أساسي (نسخة سابقة)':'تقرير تنفيذي كامل'}</small></p><p>عملاء جدد: <b dir="ltr">${fmtNum(leads)}</b>${won!==null?` · صفقات مكتسبة: <b dir="ltr">${fmtNum(won)}</b>`:''}${revenue!==null?` · إيرادات: <b dir="ltr">${fmtSAR(revenue)}</b>`:''}</p><button type="button" class="secondary" data-view-saved="${index}">عرض التفاصيل</button></article>`;
 }).join('')}</div><div id="saved-report-detail"></div>`;
}
function renderExecutiveSummary(quickSummary,escape) {
 if(!quickSummary.hasEnoughData)return `<p>لا توجد بيانات كافية بعد لبناء ملخص موثوق. سيظهر هنا تلقائيًا فور تسجيل عملاء أو تشغيلات وكلاء حقيقية.</p>`;
 const col=(title,list,fallback)=>`<div class="exec-col"><h4>${title}</h4><ul>${list.length?list.map(t=>`<li>${escape(t)}</li>`).join(''):`<li>${fallback}</li>`}</ul></div>`;
 return `<div class="exec-summary-grid">
  ${col(' أهم النتائج الإيجابية',quickSummary.wins,'لا نتائج بارزة بعد')}
  ${col(' أهم المشكلات',quickSummary.issues,'لا مشكلات مسجلة')}
  ${col('🚀 أهم الفرص',quickSummary.opportunities,'لا فرص إضافية مطروحة')}
 </div>`;
}
function renderBody(r,saved,escape) {
 if(!r.kpis)return `<div class="panel report-error"><p>هذا التقرير من نسخة سابقة ولا يحتوي بيانات لوحة القيادة الكاملة.</p></div>`;
 const kpiDefs=[
  {key:'leadsCreated',label:'عملاء محتملون جدد',good:'up',page:'crm'},
  {key:'qualifiedLeads',label:'عملاء مؤهلون',good:'up',page:'crm'},
  {key:'hotLeads',label:'اهتمام مرتفع',good:'up',page:'crm'},
  {key:'quotesSent',label:'عروض أسعار مُرسلة',good:'up',page:'crm'},
  {key:'wonDeals',label:'صفقات مكتسبة',good:'up',page:'crm'},
  {key:'lostDeals',label:'صفقات مفقودة',good:'down',page:'crm'},
  {key:'wonRevenue',label:'الإيرادات المكتسبة',good:'up',format:'sar',page:'crm'},
  {key:'followupsDrafted',label:'متابعات جُهزت',good:'up',page:'crm'}
 ];
 const kpiCards=kpiDefs.map(def=>kpiCard(def,r.kpis[def.key],escape)).join('')
  +kpiCard({label:'معدل التحويل لصفقة',good:'up',format:'percent'},{value:r.kpis.conversionRate.value||0,note:r.kpis.conversionRate.value===null?'بيانات غير كافية':'من عملاء هذا الأسبوع'},escape)
  +kpiCard({label:'محتوى بانتظار الاعتماد',good:'down',page:'content'},r.kpis.contentPendingApproval,escape)
  +kpiCard({label:'قرارات وكلاء بانتظار الموافقة',good:'down',page:'agents'},r.kpis.agentApprovalsPending,escape);

 const dataNotice=(!r.dataStatus.storeConnected||!r.dataStatus.socialConnected)
  ?`<div class="notice">التقرير يعتمد على البيانات الداخلية المسجلة فقط${!r.dataStatus.storeConnected?' · كتالوج سلة غير متصل':''}${!r.dataStatus.socialConnected?' · لا اتصال بمنصات التواصل بعد':''}.</div>`:'';

 return `${dataNotice}
 <div class="report-section"><div class="kpi-grid">${kpiCards}</div></div>
 <div class="report-section panel"><div class="report-section-head"><h3>ملخص Frost التنفيذي</h3><span>مبني من بيانات فعلية فقط — بلا ذكاء اصطناعي مولّد نصيًا في هذا الإصدار</span></div>${renderExecutiveSummary(r.quickSummary,escape)}</div>
 <div class="report-section"><div class="report-section-head"><h3>قمع المبيعات</h3><span>لقطة حالية</span></div>${renderFunnel(r.funnel,escape)}</div>
 <div class="report-section"><div class="report-section-head"><h3>المبيعات والـPipeline</h3></div>${renderPipeline(r.pipeline,escape)}</div>
 <div class="report-section"><div class="report-section-head"><h3>أداء المحتوى</h3></div>${renderContent(r,escape)}</div>
 <div class="report-section"><div class="report-section-head"><h3>أداء فريق الوكلاء</h3><span>هذا الأسبوع</span></div>${renderAgentsSection(r.agents,escape)}</div>
 <div class="report-section"><div class="report-section-head"><h3>موافقات ومخاطر تحتاج قرارًا</h3></div>${renderRisks(r.approvalsAndRisks,escape)}</div>
 <div class="report-section"><div class="report-section-head"><h3>إشارات المنافسين والسوق</h3></div>${renderMarket(r.market,escape)}</div>
 <div class="report-section"><div class="report-section-head"><h3>ماذا يجب أن نفعل الأسبوع القادم؟</h3></div>${renderRecommendations(r.quickSummary,escape)}</div>
 <div class="report-section"><div class="report-section-head"><h3>خطة الأسبوع القادم — التقويم</h3></div>${renderNextWeek(r.nextWeekPlan,escape)}</div>
 <div class="report-section"><div class="report-section-head"><h3>التقارير المحفوظة</h3></div>${renderSavedReports(saved,escape)}</div>`;
}
export async function renderReports({api,escape}) {
 const weekLabel=$('#report-week-label');
 try {
  const data=await api('/api/reports/weekly');
  lastData=data;
  const r=data.current;
  weekLabel.innerHTML=`<b dir="ltr">${fmtDateRange(r.period.start,r.period.end)}</b><small>مقارنة بالأسبوع ${fmtDateRange(r.period.previousStart,r.period.previousEnd)}</small>`;
    $('#report-content').innerHTML=renderBody(r,data.saved,escape);
    const {enhance}=await import('./components/ui/index.js');enhance($('#report-content'));
 } catch(error) {
  weekLabel.textContent='تعذر تحميل التقرير';
  $('#report-content').innerHTML=`<div class="panel report-error"><p>تعذر تحميل بيانات التقرير الأسبوعي.</p><button type="button" id="report-retry">إعادة المحاولة</button></div>`;
  console.error('weekly report load failed:',error);
 }
}
export async function clickReportAction(target,api,escape) {
 if(target.id==='report-refresh'||target.id==='report-retry'){await renderReports({api,escape});return true;}
 if(target.id==='report-print'){window.print();return true;}
 const navEl=target.closest('[data-report-nav]');
 if(navEl){document.querySelector(`nav a[href="#${navEl.dataset.reportNav}"]`)?.click();return true;}
 const viewButton=target.closest('[data-view-saved]');
 if(viewButton && lastData){
  const report=lastData.saved[Number(viewButton.dataset.viewSaved)];
  const detail=document.querySelector('#saved-report-detail');
  if(detail && report){const {drawer,enhance}=await import('./components/ui/index.js');const node=document.createElement('div');node.innerHTML=renderBody(report,[],escape);drawer('التقرير الأسبوعي المحفوظ',node,{restore:true});enhance(node);}
  return true;
 }
 return false;
}
export async function clickSaveReport(api) {
 const result=await api('/api/reports/weekly',{});
 return result.replayed?'تقرير هذا الأسبوع محفوظ بالفعل':'تم حفظ تقرير الأسبوع';
}
