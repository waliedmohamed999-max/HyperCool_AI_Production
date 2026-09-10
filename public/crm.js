import {fmtNum,fmtSAR,fmtDateTime,empty,renderBarChart,renderFunnel,stageNames} from './format.js';
const $=selector=>document.querySelector(selector);
const followupNames={DRAFT:'مسودة',APPROVED:'معتمد · غير مرسل',READY_FOR_CHANNEL:'جاهز · ينتظر ربط القناة',HOLD:'متوقف'};
const reasons={OPT_OUT:'رفض التواصل',NO_CONSENT:'لا توجد موافقة للقناة',HUMAN_HOLD:'مراجعة بشرية مطلوبة',CUSTOMER_REPLIED:'وصل رد من العميل',DEAL_CLOSED:'الفرصة مغلقة',STAGE_MISMATCH:'المرحلة تغيرت',NO_CONTACT:'وسيلة التواصل ناقصة',NO_PRODUCT_LINK:'رابط المنتج ناقص',LEAD_CHANGED:'بيانات العميل تغيرت',CONTACT_POLICY_CHANGED:'موافقة التواصل تغيرت',HUMAN_CANCELLED:'إيقاف يدوي',CHANNEL_NOT_CONNECTED:'القناة غير متصلة'};
const intentNames={general:'استفسار عام',quote:'طلب عرض سعر',medical:'سؤال صحي',complaint:'شكوى',legal:'مسألة قانونية',discount_exception:'خصم استثنائي',opt_out:'رفض التواصل'};
let crm=null,selected=null,detail=null,dashboard=null,followupTab='dueToday',inboxTab='all',searchResults=null;
export function resetCRM(){crm=null;selected=null;detail=null;dashboard=null;searchResults=null;for(const selector of ['#crm-detail','#crm-lead-list','#crm-summary'])$(selector)?.replaceChildren();}
const field=(name,label,value='',type='text',extra='')=>`<label>${label}<input name="${name}" type="${type}" value="${value}" ${extra}></label>`;
function dateTime(value){return value?new Date(Date.parse(value)+10800000).toISOString().slice(0,16):'';}

function kpiCard(label,value,context,scrollTo){
 return `<div class="kpi-card${scrollTo?' clickable':''}"${scrollTo?` data-crm-scroll="${scrollTo}"`:''}><span class="kpi-label">${label}</span><span class="kpi-value" dir="ltr">${value}</span>${context?`<span class="kpi-context">${context}</span>`:''}</div>`;
}
function renderDataStatus(status,escape){
 const rows=[['CRM',status.crm==='LOCAL'?'CONNECTED':status.crm,'CRM محلي — دائمًا متاح'],['WhatsApp',status.whatsapp,'قناة الرد الآلي'],['Salla',status.salla,'مزامنة الكتالوج'],['وكيل المبيعات الذكي',status.aiSalesAgent,'يحتاج مفتاح Anthropic']];
 $('#crm-data-status').innerHTML=rows.map(([label,value,hint])=>`<span title="${escape(hint)}">${escape(label)}: <span class="pill" data-status="${escape(value)}">${escape(value==='CONNECTED'||value==='ONLINE'?(value==='ONLINE'?'يعمل':'متصل'):value==='LOCAL'?'محلي':'غير متصل')}</span></span>`).join('');
}
function renderKPIs(kpis){
 $('#crm-summary').innerHTML=[
  kpiCard('عملاء جدد',fmtNum(kpis.newLeads.value),`${kpis.newLeads.newThisWeek} هذا الأسبوع`,'crm-kanban'),
  kpiCard('عملاء مؤهلون',fmtNum(kpis.qualifiedLeads.value),'تجاوزوا مرحلة "جديد"','crm-kanban'),
  kpiCard(' عملاء ساخنون',fmtNum(kpis.hotLeads.value),'بحاجة متابعة عاجلة','crm-hot-leads'),
  kpiCard('عروض أسعار مُرسلة',fmtNum(kpis.quotesSent.value),null,'crm-quotes'),
  kpiCard('قيمة الـPipeline',fmtSAR(kpis.pipelineValue.value),'فرص نشطة فقط','crm-forecast'),
  kpiCard('صفقات مكتسبة',fmtNum(kpis.wonDeals.value),null,'crm-kanban'),
  kpiCard('صفقات مفقودة',fmtNum(kpis.lostDeals.value),null,'crm-kanban'),
  kpiCard('متابعات متأخرة',fmtNum(kpis.followupsOverdue.value),null,'crm-followup-center')
 ].join('');
}
function renderKanban(pipeline,escape){
 $('#crm-kanban').innerHTML=`<div class="kanban">${pipeline.map(column=>`<div class="kanban-column" data-stage-column="${column.stage}"><h4><span>${escape(stageNames[column.stage]||column.stage)}</span><span>${column.count}</span></h4>${column.leads.map(lead=>`<div class="kanban-card" draggable="true" data-lead-drag="${lead.id}" data-lead-version="${lead.version}"><b>${escape(lead.name)}</b><span>${lead.valueSAR?fmtSAR(lead.valueSAR):'—'}${lead.city?' · '+escape(lead.city):''}</span><div class="badges"><span class="pill" data-status="${lead.customerType}">${lead.customerType}</span>${lead.temperature==='HOT'?'<span class="pill" data-status="HOT">HOT</span>':''}${lead.humanHold?'<span class="pill" data-status="OVERDUE">يحتاج تدخل بشري</span>':''}</div></div>`).join('')||'<p><small>فارغة</small></p>'}</div>`).join('')}</div>`;
}
function renderHotLeads(hotLeads,escape){
 if(!hotLeads.length){$('#crm-hot-leads').innerHTML=empty('لا يوجد عملاء بدرجة اهتمام مرتفعة الآن.','ارفع درجة اهتمام أي عميل من ملفه ليظهر هنا فور احتياجه متابعة عاجلة.');return;}
 $('#crm-hot-leads').innerHTML=`<div class="grid">${hotLeads.map(lead=>`<article class="card hot-lead-card"><div class="row-between"><b>${escape(lead.name)}</b>${lead.valueSAR?`<span dir="ltr">${fmtSAR(lead.valueSAR)}</span>`:''}</div><p>${escape(lead.productNeed||'—')} ${lead.quantity?'· الكمية: '+lead.quantity:''}</p><p><small>${escape(lead.city||'—')} ${lead.timeline?'· '+escape(lead.timeline):''}</small></p>${lead.lastMessageText?`<p><small>آخر رسالة: ${escape(lead.lastMessageText.slice(0,80))}</small></p>`:''}${lead.humanHold?`<p><small> ${escape(lead.handoffReason||'يحتاج تدخل بشري')}</small></p>`:''}<div class="row"><button type="button" class="secondary" data-open-lead="${lead.id}">فتح الملف</button></div></article>`).join('')}</div>`;
}
function renderFollowupCenter(buckets,escape){
 const tabs=[['dueToday','اليوم',buckets.dueToday],['overdue','متأخرة',buckets.overdue],['thisWeek','هذا الأسبوع',buckets.thisWeek],['onHold','موقوفة',buckets.onHold],['done','منتهية',buckets.done]];
 const active=tabs.find(t=>t[0]===followupTab)?.[2]||[];
 const tabsHtml=`<div class="tabs">${tabs.map(([key,label,list])=>`<button type="button" class="tab${key===followupTab?' active':''}" data-followup-tab="${key}">${label}<span class="count">${list.length}</span></button>`).join('')}</div>`;
 const body=active.length?active.map(f=>`<div class="risk-item"><div class="risk-body"><span class="risk-title">${escape(f.channel)} · رسالة ${f.touch}</span><span class="risk-meta">${escape(new Date(f.dueAt).toLocaleString('ar-SA',{timeZone:'Asia/Riyadh'}))}${f.holdReason?' · '+escape(reasons[f.holdReason]||f.holdReason):''}</span></div><div class="row"><button type="button" class="secondary" data-open-lead="${f.leadId}">فتح الملف</button></div></div>`).join(''):empty('لا عناصر في هذا التصنيف.');
 $('#crm-followup-center').innerHTML=tabsHtml+`<div class="risk-list">${body}</div>`;
}
function renderInbox(conversations,escape){
 if(!conversations.hasData){$('#crm-inbox').innerHTML=empty('لا محادثات مسجلة بعد.','المحادثات تُسجَّل يدويًا من ملف كل عميل حتى تُربط قناة حقيقية.');return;}
 const tabs=[['all','الكل',conversations.rows],['hot',' Hot',conversations.rows.filter(r=>r.temperature==='HOT')],['b2b','B2B',conversations.rows.filter(r=>r.customerType==='B2B')],['awaiting','بانتظار رد',conversations.rows.filter(r=>r.awaitingResponse)]];
 const active=tabs.find(t=>t[0]===inboxTab)?.[1]!==undefined?tabs.find(t=>t[0]===inboxTab)[2]:conversations.rows;
 const tabsHtml=`<div class="tabs">${tabs.map(([key,label,list])=>`<button type="button" class="tab${key===inboxTab?' active':''}" data-inbox-tab="${key}">${label}<span class="count">${list.length}</span></button>`).join('')}</div>`;
 const body=active.length?`<div class="calendar-scroll"><table><thead><tr><th>العميل</th><th>القناة</th><th>آخر رسالة</th><th>الوقت</th><th>الحالة</th></tr></thead><tbody>${active.map(row=>`<tr class="clickable" data-open-lead="${row.leadId}"><td>${escape(row.customer)}</td><td>${escape(row.channel)}</td><td>${escape((row.lastMessage||'').slice(0,60))}</td><td dir="ltr">${fmtDateTime(row.lastMessageAt)}</td><td>${row.awaitingResponse?'<span class="pill" data-status="HOLD">بانتظار رد</span>':'<span class="pill" data-status="COMPLETED">تم الرد</span>'}</td></tr>`).join('')}</tbody></table></div>`:empty('لا محادثات في هذا التصنيف.');
 $('#crm-inbox').innerHTML=tabsHtml+body;
}
function renderB2B(b2b,escape){
 if(!b2b.length){$('#crm-b2b').innerHTML=empty('لا توجد فرص B2B مسجلة بعد.','أضف فرصة من زر «+ إضافة فرصة B2B» أعلاه، أو فعّل وكيل العملاء المحتملين.');return;}
 $('#crm-b2b').innerHTML=`<div class="calendar-scroll"><table><thead><tr><th>الجهة</th><th>الاحتياج</th><th>القيمة</th><th>المرحلة</th><th>الاحتمالية</th><th>الخطوة التالية</th></tr></thead><tbody>${b2b.map(o=>`<tr class="clickable" data-open-lead="${o.id}"><td>${escape(o.company||'—')}</td><td>${escape(o.need||'—')}</td><td dir="ltr">${o.valueSAR?fmtSAR(o.valueSAR):'—'}</td><td><span class="pill" data-status="${escape(o.stage)}">${escape(stageNames[o.stage]||o.stage)}</span></td><td dir="ltr">${o.probability!==null?Math.round(o.probability*100)+'%':'—'}</td><td>${escape(o.nextStep||'—')}</td></tr>`).join('')}</tbody></table></div>`;
}
function renderQuotes(quotes,escape){
 if(!quotes.length){$('#crm-quotes').innerHTML=empty('لا توجد عروض أسعار بعد.','تُنشأ تلقائيًا عند نقل عميل لمرحلة «عرض سعر مُرسل».');return;}
 const statusNames={SENT:'مُرسل',ACCEPTED:'مقبول'};
 $('#crm-quotes').innerHTML=`<div class="calendar-scroll"><table><thead><tr><th>العميل</th><th>المبلغ</th><th>الحالة</th><th>تاريخ الإنشاء</th><th>إجراءات</th></tr></thead><tbody>${quotes.map(q=>`<tr><td>${escape(q.customer)}</td><td dir="ltr">${q.amount?fmtSAR(q.amount):'—'}</td><td><span class="pill" data-status="${q.status}">${statusNames[q.status]||q.status}</span></td><td dir="ltr">${fmtDateTime(q.createdAt)}</td><td><button type="button" class="secondary" data-open-lead="${q.id}">فتح</button> <button type="button" class="secondary" disabled title="يحتاج كيان عرض سعر منفصل — غير مُفعَّل بعد">PDF</button></td></tr>`).join('')}</tbody></table></div>`;
}
function renderForecast(forecast,escape){
 if(!forecast.hasData){$('#crm-forecast').innerHTML=empty('لا توجد بيانات كافية للتوقع.');return;}
 const stats=[kpiCard('إجمالي الـPipeline',fmtSAR(forecast.pipelineTotal)),kpiCard('Pipeline مرجّح بالاحتمالية',fmtSAR(forecast.weightedPipeline),'قيمة × احتمالية تقديرية لكل مرحلة'),kpiCard('إيرادات مكتسبة',fmtSAR(forecast.wonRevenue)),kpiCard('متوسط قيمة الصفقة',forecast.avgDealSize?fmtSAR(forecast.avgDealSize):'لا صفقات مكتسبة بعد')].join('');
 $('#crm-forecast').innerHTML=`<div class="kpi-grid">${stats}</div><h4>القيمة حسب المرحلة</h4>${renderBarChart(forecast.byStage.filter(s=>s.value>0).map(s=>[stageNames[s.stage]||s.stage,s.value]),escape)}<p><small>نموذج الاحتمالية تقديري وليس معدل فوز مُتعلَّمًا: ${Object.entries(forecast.probabilityModel).map(([stage,p])=>`${stageNames[stage]||stage} ${Math.round(p*100)}%`).join('، ')}.</small></p>`;
}
function renderAIInsights(insights,recommendation,escape){
 const rec=recommendation?`<div class="notice"> توصية Frost: ${escape(recommendation.text)}</div>`:'';
 if(!insights.hasEnoughData){$('#crm-ai-insights').innerHTML=rec+empty('بيانات غير كافية لاستخلاص رؤى موثوقة (INSUFFICIENT_DATA).','تحتاج 5 عملاء مسجلين على الأقل.');return;}
 const list=(title,items,render)=>`<div class="exec-col"><h4>${title}</h4><ul>${items.length?items.map(render).join(''):'<li>لا بيانات</li>'}</ul></div>`;
 $('#crm-ai-insights').innerHTML=rec+`<div class="exec-summary-grid">
  ${list('أكثر المنتجات طلبًا',insights.topProducts,([name,count])=>`<li>${escape(name)} (${count})</li>`)}
  ${list('أكثر أنواع الاستفسار',insights.commonInquiryTypes,([intent,count])=>`<li>${escape(intentNames[intent]||intent)} (${count})</li>`)}
  ${list('فرص متوقفة (+14 يوم)',insights.stalledDeals,d=>`<li>${escape(d.name)} · ${d.daysSince} يوم${d.valueSAR?' · '+fmtSAR(d.valueSAR):''}</li>`)}
 </div><div class="exec-summary-grid">
  ${list('تحتاج تدخلًا بشريًا',insights.needsIntervention,d=>`<li>${escape(d.name)}${d.reason?' — '+escape(d.reason):''}</li>`)}
  ${list('أسباب خسارة صفقات',insights.lostReasons,reason=>`<li>${escape(reason)}</li>`)}
  ${list('أفضل مصدر عملاء',insights.bestSource?[insights.bestSource]:[],([source,stats])=>`<li>${escape(source)} — ${stats.won}/${stats.count} مكتسبة</li>`)}
 </div>`;
}
function renderActivity(activity,escape){
 if(!activity.length){$('#crm-activity').innerHTML=empty('لا نشاط مسجل بعد.');return;}
 const actionNames={CRM_LEAD_CREATED:'إنشاء سجل عميل',CRM_LEAD_UPDATED:'تحديث تأهيل فرصة',CRM_INBOUND_RECORDED:'تسجيل محادثة واردة',CRM_CONTACT_POLICY_CHANGED:'تحديث موافقة التواصل',CRM_FOLLOWUPS_DRAFTED:'تجهيز متابعات',CRM_FOLLOWUP_APPROVED:'اعتماد متابعة',CRM_FOLLOWUP_PREPARED:'تجهيز متابعة مستحقة',CRM_FOLLOWUPS_STOPPED:'إيقاف متابعات',AGENT_RUN_COMPLETED:'أكمل تشغيلة'};
 $('#crm-activity').innerHTML=activity.map(entry=>`<div class="audit-row row-between"><span>${entry.source==='AGENT'?' ':' '}${escape(entry.actor)} — ${escape(actionNames[entry.action]||entry.action)}</span><time dir="ltr">${fmtDateTime(entry.at)}</time></div>`).join('');
}
function renderSearchResults(escape){
 const container=$('#crm-search-results');
 if(!searchResults){container.innerHTML='';return;}
 container.innerHTML=`<div class="search-results"><div class="items">${searchResults.length?searchResults.map(lead=>`<div class="search-result-row" data-open-lead="${lead.id}">${escape(lead.name)}${lead.company?' · '+escape(lead.company):''}<small>${escape(lead.phone||lead.email||'')} · ${escape(stageNames[lead.stage]||lead.stage)}</small></div>`).join(''):'<div class="search-result-row">لا نتائج مطابقة</div>'}</div></div>`;
}
export async function renderCRM({api,auth,escape}){
 $('#crm').hidden=auth.user.role==='reviewer';if(auth.user.role==='reviewer'){resetCRM();return;}
 crm=await api('/api/crm');
 try{dashboard=await api('/api/crm/dashboard');}catch(error){dashboard=null;console.error('sales dashboard failed to load:',error);}
 if(dashboard){
  renderDataStatus(dashboard.dataStatus,escape);
  renderKPIs(dashboard.kpis);
  $('#crm-funnel').innerHTML=renderFunnel(dashboard.funnel,escape);
  renderKanban(dashboard.pipeline,escape);
  renderHotLeads(dashboard.hotLeads,escape);
  renderFollowupCenter(dashboard.followups,escape);
  renderInbox(dashboard.conversations,escape);
  renderB2B(dashboard.b2b,escape);
  renderQuotes(dashboard.quotes,escape);
  renderForecast(dashboard.forecast,escape);
  renderAIInsights(dashboard.aiInsights,dashboard.frostRecommendation,escape);
  renderActivity(dashboard.recentActivity,escape);
 } else {
  $('#crm-data-status').innerHTML='<span class="pill" data-status="ERROR">تعذر تحميل لوحة المبيعات</span>';
 }
 $('#crm-run-frost').hidden=auth.user.role!=='owner';
 $('#crm-lead-list').innerHTML=crm.leads.length?crm.leads.map(lead=>`<button class="lead-button" type="button" data-lead-id="${lead.id}"><div class="row-between"><b>${escape(lead.name)}</b><span class="pill" data-status="${escape(lead.stage)}">${stageNames[lead.stage]||lead.stage}</span></div><span>${escape(lead.company||lead.customerType)}</span><small>${lead.temperature==='HOT'?'اهتمام مرتفع · ':''}${lead.optOut?'رفض التواصل':lead.humanHold||lead.replyHold?'متابعة موقوفة':'فتح الملف'}</small></button>`).join(''):'<div class="empty">لا توجد فرص مسجلة بعد.</div>';
 $('#crm-prepare').hidden=auth.user.role!=='owner';
 if(!selected && crm.leads.length)selected=crm.leads[0].id;
 if(!selected){$('#crm-detail').innerHTML='<div class="empty">أضف عميلًا لبدء تسجيل الفرصة والمحادثات.</div>';return;}
 detail=await api('/api/crm/leads/'+selected);const lead=detail.lead;
 const qualification=field('city','المدينة',escape(lead.city))+field('productNeed','الاحتياج',escape(lead.productNeed))+field('productUrl','رابط المنتج',escape(lead.productUrl),'url')+field('quantity','الكمية',lead.quantity??'','number','min="1"')+field('valueSAR','قيمة الفرصة التقديرية SAR — ليست عرض سعر',lead.valueSAR??'','number','min="0" step="0.01"')+field('timeline','التوقيت المطلوب',escape(lead.timeline))+field('budgetBand','نطاق الميزانية',escape(lead.budgetBand));
 $('#crm-detail').innerHTML=`<h3>${escape(lead.name)} ${lead.company?'· '+escape(lead.company):''}</h3><p>${escape(lead.phone||'')} ${escape(lead.email||'')}</p><p>المرحلة: ${stageNames[lead.stage]||lead.stage} · إصدار ${lead.version} · ${lead.optOut?'رفض التواصل':lead.humanHold||lead.replyHold?'متابعة موقوفة':'لا إيقاف نشط'}</p><p>موافقة البريد: ${lead.consent.Email?'موثقة':'غير موجودة'} · واتساب: ${lead.consent.WhatsApp?'موثقة':'غير موجودة'}</p>${lead.research?`<details><summary>مصدر فرصة B2B</summary><p>${escape(lead.research.trigger)}</p><p>${escape(lead.research.sourceUrl)}</p><p>تقييم الملاءمة: ${lead.research.fitScore} · التحقق إقرار بشري</p></details>`:''}
 <details open><summary>تأهيل الفرصة وتعيين المسؤول</summary><form data-crm="update" data-lead="${lead.id}">${qualification}<label>مرحلة الفرصة<select name="stage">${Object.entries(stageNames).map(([v,label])=>`<option value="${v}" ${v===lead.stage?'selected':''}>${label}</option>`).join('')}</select></label><label>درجة الاهتمام<select name="temperature">${['COLD','WARM','HOT'].map(t=>`<option ${t===lead.temperature?'selected':''}>${t}</option>`).join('')}</select></label><label>مسؤول المتابعة<select name="assignedTo"><option value="">غير معين</option>${crm.staff.map(s=>`<option value="${s.id}" ${s.id===lead.assignedTo?'selected':''}>${escape(s.name)}</option>`).join('')}</select></label>${field('nextCheckAt','موعد مراجعة الفرصة المؤجلة — الرياض',dateTime(lead.nextCheckAt),'datetime-local')}${field('reason','سبب التحديث','','text','required maxlength="1000"')}<button>حفظ التأهيل</button></form></details>
 <details><summary>تسجيل رسالة واردة يدويًا</summary><form data-crm="messages" data-lead="${lead.id}"><label>القناة<select name="channel">${['WhatsApp','Email','Instagram','Facebook','X','LinkedIn','Phone'].map(c=>`<option>${c}</option>`).join('')}</select></label><label>التصنيف<select name="intent">${Object.entries(intentNames).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label><label>نص الرسالة<textarea name="text" required maxlength="4000"></textarea></label><p>تسجيل الرد يوقف المتابعات الحالية حتى يراجعها المالك.</p><button>تسجيل الرسالة</button></form></details>
 <details><summary>موافقة التواصل والإيقاف</summary><form data-crm="contact" data-lead="${lead.id}"><label>الإجراء<select name="action"><option value="OPT_OUT">تسجيل رفض التواصل — إيقاف فوري</option>${auth.user.role==='owner'?'<option value="CONSENT">تسجيل موافقة جديدة موثقة</option><option value="RESOLVE_HOLD">تسجيل معالجة الرد / التصعيد</option>':''}</select></label><label>القناة<select name="channel"><option>Email</option><option>WhatsApp</option></select></label>${field('obtainedAt','وقت الموافقة بتوقيت الرياض','','datetime-local')}<label class="check"><input name="confirmed" type="checkbox">أؤكد وجود موافقة صريحة جديدة لهذه القناة</label>${field('evidence','المصدر / سبب الإيقاف أو معالجة الرد','','text','required maxlength="1000"')}<button>حفظ سياسة التواصل</button></form></details>
 <details><summary>تجهيز سلسلة متابعة عربية وإنجليزية</summary><form data-crm="followups" data-lead="${lead.id}"><label>السلسلة<select name="sequence">${crm.sequences.map(s=>`<option value="${s.id}">${s.name}</option>`).join('')}</select></label><label>القناة<select name="channel"><option>Email</option><option>WhatsApp</option></select></label>${field('startAt','أول موعد — الرياض (بعد 48 ساعة على الأقل)','','datetime-local','required')}${field('evidence','دليل الحدث وسبب المتابعة / المحفز الجديد','','text','required maxlength="1000"')}<p>3 مسودات بفواصل 48 ثم 72 ساعة، مع اعتماد مستقل لكل رسالة. لا إرسال فعلي.</p><button>تجهيز المسودات</button></form></details>
 <details><summary>ملخص التحويل وتجهيز عرض السعر</summary><p>الاحتياج: ${escape(lead.productNeed||'غير معلوم')} · المدينة: ${escape(lead.city||'غير معلومة')}</p><p>المسؤول: ${escape(crm.staff.find(s=>s.id===lead.assignedTo)?.name||'غير معين')} · التصعيد: ${escape(lead.handoffReason||'لا يوجد')}</p><p>المتابعة: ${lead.humanHold?'بشرية مطلوبة':'تأهيل / اتصال يباشره الموظف'}</p><p>عرض السعر: ${detail.quoteIntake.status==='NEEDS_DATA'?'بيانات ناقصة: '+escape(detail.quoteIntake.missingFields.join('، ')):'بيانات الطلب جاهزة لتجهيز عرض بشري'}</p><small>لم يتم تسعير أو إصدار عرض رسمي.</small></details>
 <h4>المحادثات المسجلة</h4>${detail.messages.map(m=>`<div class="audit-row"><small>${escape(m.channel)} · إدخال يدوي · ${escape(m.recordedAt)}</small><p>${escape(m.text)}</p></div>`).join('')||'<p>لا توجد رسائل مسجلة.</p>'}
 <h4>المتابعات</h4><button type="button" data-crm-stop="${lead.id}">إيقاف المسودات الحالية</button>${detail.followups.map(f=>`<article class="card"><div class="meta"><span>${escape(f.channel)} · رسالة ${f.touch}</span><span class="pill" data-status="${escape(f.status)}">${followupNames[f.status]}</span></div><p>${escape(f.messageAr)}</p><p dir="ltr">${escape(f.messageEn)}</p><p>${escape(new Date(f.dueAt).toLocaleString('ar-SA',{timeZone:'Asia/Riyadh'}))}</p>${f.holdReason?`<small>${escape(reasons[f.holdReason]||f.holdReason)}</small>`:''}${auth.user.role==='owner'&&f.status==='DRAFT'?`<button type="button" data-followup-approve="${f.id}">اعتماد النصين والموعد</button>`:''}</article>`).join('')}`;
}
export async function submitCRM(form,input,api){
 if(form.id==='crm-create'){
  input.sourceChecked=input.sourceChecked==='on';if(input.triggerDate)input.triggerDate+='T00:00:00+03:00';
  const lead=await api('/api/crm/leads',input);selected=lead.id;form.reset();return 'تم إنشاء سجل العميل؛ لم يتم إرسال أي رسالة';
 }
 if(!form.dataset.crm)return null;
 const action=form.dataset.crm;
 if(action==='update'||action==='contact')input.expectedVersion=detail.lead.version;
 for(const name of ['startAt','obtainedAt','nextCheckAt'])if(input[name])input[name]+=':00+03:00';
 if(action==='contact')input.confirmed=input.confirmed==='on';
 if(action==='messages'||action==='followups'){
  const fingerprint=JSON.stringify(input);if(form.dataset.fingerprint!==fingerprint){form.dataset.fingerprint=fingerprint;form.dataset.requestKey=crypto.randomUUID();}
  input[action==='messages'?'eventKey':'requestKey']=form.dataset.requestKey;
 }
 await api(`/api/crm/leads/${form.dataset.lead}/${action}`,input);return 'تم حفظ الإجراء في سجل العميل';
}
export async function clickCRM(button,api){
 if(button.dataset.leadId||button.dataset.openLead){selected=button.dataset.leadId||button.dataset.openLead;return 'تم فتح سجل العميل';}
 if(button.dataset.followupApprove){await api('/api/crm/followups/'+button.dataset.followupApprove+'/approve',{});return 'تم اعتماد المسودة؛ الإرسال غير متصل';}
 if(button.dataset.crmStop){await api('/api/crm/leads/'+button.dataset.crmStop+'/stop-followups',{});return 'تم إيقاف المتابعات';}
 if(button.id==='crm-prepare'){const result=await api('/api/crm/followups/prepare',{});return `جاهز للقناة: ${result.ready} · موقوف: ${result.held} · مرسل: 0`;}
 if(button.id==='crm-run-frost'){const result=await api('/api/frost/run-now',{});return result.skipped?'الدورة متوقفة حاليًا — استأنف من صفحة فريق الوكلاء':'تم تشغيل دورة Frost يدويًا';}
 if(button.dataset.followupTab){followupTab=button.dataset.followupTab;return 'تم تبديل التصنيف';}
 if(button.dataset.inboxTab){inboxTab=button.dataset.inboxTab;return 'تم تبديل التصنيف';}
 if(button.dataset.quickAction){
  const targets={'add-lead':'crm-create-details','add-b2b':'crm-create-details','followups':'crm-followup-center','inbox':'crm-inbox'};
  const el=document.getElementById(targets[button.dataset.quickAction]);
  if(el){if(el.tagName==='DETAILS')el.open=true;el.scrollIntoView({behavior:'smooth',block:'start'});}
  return null;
 }
 return null;
}
export async function crmSearch(query,api,escape){
 if(!query||query.trim().length<2){searchResults=null;renderSearchResults(escape);return;}
 try{searchResults=await api('/api/crm/search?q='+encodeURIComponent(query.trim()));}catch{searchResults=[];}
 renderSearchResults(escape);
}
// updateLead overwrites every qualification field from the payload (missing ones
// become '' / null), so a drag-and-drop that only sent {stage, reason} would
// silently blank out city/productNeed/quantity/etc. Always re-send the lead's
// current values alongside the new stage.
export async function applyStageChange({leadId,newStage,expectedVersion,reason},api){
 const current=(await api('/api/crm/leads/'+leadId)).lead;
 await api(`/api/crm/leads/${leadId}/update`,{
  stage:newStage,reason,expectedVersion,
  city:current.city,productNeed:current.productNeed,productUrl:current.productUrl,
  quantity:current.quantity,valueSAR:current.valueSAR,timeline:current.timeline,budgetBand:current.budgetBand,
  temperature:current.temperature,assignedTo:current.assignedTo||'',
  nextCheckAt:current.nextCheckAt||''
 });
 if(current.stage!==newStage||leadId===selected)selected=leadId;
}
export function installCRMInteractions(){
 document.addEventListener('click',event=>{
  const scrollTarget=event.target.closest('[data-crm-scroll]');
  if(scrollTarget){document.getElementById(scrollTarget.dataset.crmScroll)?.scrollIntoView({behavior:'smooth',block:'start'});}
 });
 let draggedId=null,draggedVersion=null;
 document.addEventListener('dragstart',event=>{
  const card=event.target.closest('[data-lead-drag]');
  if(!card)return;
  draggedId=card.dataset.leadDrag;draggedVersion=card.dataset.leadVersion;
  event.dataTransfer.effectAllowed='move';
 });
 document.addEventListener('dragover',event=>{
  const column=event.target.closest('[data-stage-column]');
  if(!column||!draggedId)return;
  event.preventDefault();
  column.classList.add('drag-over');
 });
 document.addEventListener('dragleave',event=>{
  const column=event.target.closest('[data-stage-column]');
  if(column)column.classList.remove('drag-over');
 });
 document.addEventListener('drop',async event=>{
  const column=event.target.closest('[data-stage-column]');
  if(!column||!draggedId)return;
  event.preventDefault();
  column.classList.remove('drag-over');
  const newStage=column.dataset.stageColumn,leadId=draggedId,expectedVersion=Number(draggedVersion);
  draggedId=null;draggedVersion=null;
  const {requestReason}=await import('./components/ui/index.js');
  const reason=await requestReason('نقل الفرصة إلى مرحلة "'+(stageNames[newStage]||newStage)+'"');
  if(!reason||!reason.trim())return;
  window.dispatchEvent(new CustomEvent('crm-stage-drop',{detail:{leadId,newStage,expectedVersion,reason:reason.trim()}}));
 });
}
