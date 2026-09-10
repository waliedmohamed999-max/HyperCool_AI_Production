import {fmtNum,fmtSAR,fmtDateTime,empty,renderBarChart,renderFunnel,stageNames} from './format.js';
import {t,getLocale} from './i18n.js';
import {icon} from './components/ui/index.js';
const $=selector=>document.querySelector(selector);
const followupNames=new Proxy({},{get:(_,code)=>t('sales.followupStatus.'+code)});
const reasons=new Proxy({},{get:(_,code)=>t('sales.holdReason.'+code)});
const intentNames=new Proxy({},{get:(_,code)=>t('sales.intent.'+code)});
let crm=null,selected=null,detail=null,dashboard=null,followupTab='dueToday',inboxTab='all',searchResults=null;
export function resetCRM(){crm=null;selected=null;detail=null;dashboard=null;searchResults=null;for(const selector of ['#crm-detail','#crm-lead-list','#crm-summary'])$(selector)?.replaceChildren();}
const field=(name,label,value='',type='text',extra='')=>`<label>${label}<input name="${name}" type="${type}" value="${value}" ${extra}></label>`;
function dateTime(value){return value?new Date(Date.parse(value)+10800000).toISOString().slice(0,16):'';}

function kpiCard(label,value,context,scrollTo){
 return `<button type="button" class="kpi-card sales-metric${scrollTo?' clickable':''}"${scrollTo?` data-crm-scroll="${scrollTo}"`:''}><span class="sales-metric-top"><span>${icon(scrollTo==='crm-forecast'?'chart':scrollTo==='crm-followup-center'?'clock':scrollTo==='crm-quotes'?'file':'users')}</span>${icon('arrow')}</span><span class="kpi-label">${label}</span><span class="kpi-value" dir="ltr">${value}</span>${context?`<span class="kpi-context">${context}</span>`:''}</button>`;
}
function styleSalesWorkspace(escape){
 const L=(ar,en)=>getLocale()==='en'?en:ar;
 let hero=$('#sales-hero');if(!hero){hero=document.createElement('section');hero.id='sales-hero';$('#crm').prepend(hero);}
 const active=crm.leads.filter(l=>!['WON','LOST','PARKED'].includes(l.stage));
 hero.innerHTML=`<div class="sales-hero-copy"><span class="sales-eyebrow">HYPERCOOL / SALES DESK</span><h2>${escape(L('علاقات أقوى. فرص أقرب.','Stronger relationships. Closer opportunities.'))}</h2><p>${escape(L('من أول تواصل إلى إغلاق الصفقة، كل التفاصيل في مساحة واحدة.','From first contact to closing a deal, every detail in one workspace.'))}</p><div class="sales-hero-tags"><span>${icon('users')}${fmtNum(crm.leads.length)} ${escape(L('عميل مسجل','registered customers'))}</span><span>${icon('chart')}${fmtNum(active.length)} ${escape(L('فرصة مفتوحة','open opportunities'))}</span></div></div><div class="sales-hero-aside"><span class="sales-hero-symbol">${icon('users')}</span><span>${escape(L('المتابعات المتأخرة','Overdue follow-ups'))}</span><strong>${dashboard?fmtNum(dashboard.kpis.followupsOverdue.value):'—'}</strong><button type="button" data-crm-scroll="crm-followup-center">${escape(L('افتح مركز المتابعة','Open follow-up center'))}${icon('arrow')}</button></div>`;
 let nav=$('#sales-section-nav');if(!nav){nav=document.createElement('nav');nav.id='sales-section-nav';$('#crm-summary').after(nav);}nav.setAttribute('aria-label',L('أقسام المبيعات','Sales sections'));
 nav.innerHTML=[['crm-kanban','users',L('مسار الصفقات','Deal pipeline')],['crm-hot-leads','bell',L('فرص واعدة','Hot leads')],['crm-followup-center','clock',L('المتابعات','Follow-ups')],['crm-inbox','file',L('المحادثات','Conversations')],['crm-forecast','chart',L('توقع الإيرادات','Revenue forecast')],['crm-lead-list','book',L('سجل العملاء','Customers')]].map(([id,glyph,title],index)=>`<button type="button" data-crm-scroll="${id}" class="sales-nav-tile tone-${index}" aria-pressed="false"><span class="sales-nav-glyph">${icon(glyph)}</span><span class="sales-nav-label">${escape(title)}</span><span class="sales-nav-arrow" aria-hidden="true">${icon('arrow')}</span></button>`).join('');
 $('#crm').querySelectorAll('.report-section').forEach((section,i)=>{let n=section.querySelector('.sales-section-number');if(!n){n=document.createElement('span');n.className='sales-section-number';section.querySelector('.report-section-head')?.prepend(n);}n.textContent=String(i+1).padStart(2,'0');});
}
function renderSalesDetailPanels(escape){
 if(!dashboard)return;
 const L=(ar,en)=>getLocale()==='en'?en:ar;
 const avatar=name=>`<span class="sales-contact-avatar">${escape((name||'—').trim().split(/\s+/).slice(0,2).map(s=>Array.from(s)[0]).join(''))}</span>`;
 const blank=(id,glyph,title,hint,target,cta)=>{const el=$('#'+id);el.innerHTML=`<div class="sales-empty-state"><div class="sales-empty-art">${icon(glyph)}<span></span><span></span></div><h4>${escape(title)}</h4><p>${escape(hint)}</p>${target?`<button type="button" class="sales-text-action" data-quick-action="${target}">${escape(cta)}${icon('arrow')}</button>`:''}</div>`;};
 // Pair related work areas without hiding their contents or changing existing IDs.
 for(const [name,ids] of [['work',['crm-hot-leads','crm-followup-center']],['commercial',['crm-b2b','crm-quotes']],['insights',['crm-ai-insights','crm-activity']]]){
  if(!$('#sales-pair-'+name)){const sections=ids.map(id=>$('#'+id).closest('.report-section'));const pair=document.createElement('div');pair.id='sales-pair-'+name;pair.className='sales-panel-pair';sections[0].before(pair);pair.append(...sections);}
 }
 const captions={
  'crm-hot-leads':L('أولوية التواصل','CONTACT PRIORITY'), 'crm-followup-center':L('إيقاع المتابعة','FOLLOW-UP DESK'),
  'crm-inbox':L('آخر تواصل مع عملائك','CUSTOMER CONVERSATIONS'), 'crm-b2b':L('فرص الشركات','BUSINESS OPPORTUNITIES'),
  'crm-quotes':L('قرارات الشراء','PURCHASE DECISIONS'), 'crm-forecast':L('قيمة الفرص الحالية','PIPELINE VALUE'),
  'crm-ai-insights':L('إشارات من بياناتك','SIGNALS FROM YOUR DATA'), 'crm-activity':L('سجل المبيعات','SALES TIMELINE')};
 for(const [id,title] of Object.entries(captions)){const section=$('#'+id).closest('.report-section');section.classList.add('sales-detail-panel');section.dataset.salesPanel=id;let subtitle=section.querySelector('.sales-panel-caption');if(!subtitle){subtitle=document.createElement('div');subtitle.className='sales-panel-caption';section.prepend(subtitle);}subtitle.textContent=title;}
 if(!dashboard.hotLeads.length)blank('crm-hot-leads','bell',L('الفرصة القادمة تبدأ بتواصل','Your next opportunity starts with a conversation'),L('سيظهر هنا العملاء ذوو الاهتمام المرتفع لتعرف بمن تبدأ.','High-interest customers appear here so you know who to contact first.'),'add-lead',L('أضف عميلًا','Add a customer'));
 if(!dashboard.conversations.hasData)blank('crm-inbox','users',L('كل محادثة لها مكان','Every conversation has a place'),L('آخر رسائل العملاء وحالة الرد ستظهر هنا عند تسجيل المحادثات.','Recent customer messages and response status appear here as conversations are recorded.'),null,'');
 if(!dashboard.b2b.length)blank('crm-b2b','users',L('ابنِ علاقات مع الشركات','Build business relationships'),L('تابع الجهة والاحتياج وقيمة الفرصة والخطوة التالية في بطاقة واحدة.','Track the company, its needs, opportunity value and next step together.'),'add-b2b',L('إضافة فرصة شركة','Add business opportunity'));
 else $('#crm-b2b').innerHTML=`<div class="sales-business-cards">${dashboard.b2b.map(o=>`<article class="sales-business-card"><div class="sales-contact-head">${avatar(o.company)}<div><h4>${escape(o.company||'—')}</h4><span class="pill" data-status="${escape(o.stage)}">${escape(stageNames[o.stage]||o.stage)}</span></div></div><p>${escape(o.need||L('لم يُسجل الاحتياج','No need recorded'))}</p><div class="sales-business-value"><strong>${o.valueSAR==null?'—':fmtSAR(o.valueSAR)}</strong><span>${o.probability==null?'—':Math.round(o.probability*100)+'%'} ${escape(L('احتمال مرجح','stage probability'))}</span></div><div class="sales-next-step"><small>${escape(L('الخطوة التالية','NEXT STEP'))}</small><span>${escape(o.nextStep||'—')}</span></div><button type="button" class="sales-text-action" data-open-lead="${escape(o.id)}">${escape(L('ملف الفرصة','Open opportunity'))}${icon('arrow')}</button></article>`).join('')}</div>`;
 if(!dashboard.quotes.length)blank('crm-quotes','file',L('من الاهتمام إلى قرار الشراء','From interest to a purchase decision'),L('العملاء في مرحلة إرسال عرض السعر يظهرون هنا مع قيمة الفرصة وحالتها.','Customers at the quote stage appear here with their opportunity value and status.'),null,'');
 else $('#crm-quotes').innerHTML=`<div class="sales-quote-list">${dashboard.quotes.map(q=>`<article class="sales-quote-card"><span class="sales-quote-icon">${icon('file')}</span><div><h4>${escape(q.customer)}</h4><small>${fmtDateTime(q.createdAt)}</small><span class="pill" data-status="${escape(q.status)}">${escape(q.status==='ACCEPTED'?t('sales.quotesSection.statusAccepted'):t('sales.quotesSection.statusSent'))}</span></div><strong>${q.amount==null?'—':fmtSAR(q.amount)}</strong><button type="button" class="sales-text-action" data-open-lead="${escape(q.id)}">${escape(t('sales.quotesSection.open'))}${icon('arrow')}</button></article>`).join('')}</div>`;
 const f=dashboard.forecast;
 if(!f.hasData)$('#crm-forecast').innerHTML=`<div class="sales-forecast-empty"><div><span class="sales-panel-caption">${escape(L('الرؤية المالية','FINANCIAL OUTLOOK'))}</span><h4>${escape(L('اعرف قيمة الفرص التي تعمل عليها','See the value of your pipeline'))}</h4><p>${escape(L('تبدأ المؤشرات عند تسجيل فرص بقيمها ومراحلها. التوقع المرجح تقدير بحسب المرحلة، وليس إيرادًا مؤكدًا.','Metrics become available as opportunities are recorded. Weighted forecasts use stage probabilities, not guaranteed revenue.'))}</p></div><div class="sales-forecast-placeholders">${[t('sales.forecastSection.totalPipeline'),t('sales.forecastSection.weightedPipeline'),t('sales.forecastSection.wonRevenue')].map(title=>`<div><span>${escape(title)}</span><strong>—</strong><small>${escape(L('لا توجد بيانات','No data yet'))}</small></div>`).join('')}</div></div>`;
 const insight=$('#crm-ai-insights');if(!dashboard.aiInsights.hasEnoughData){const notice=insight.querySelector('.notice');blank('crm-ai-insights','agent',L('رؤى تتكوّن من العمل الحقيقي','Insights built from real activity'),L('تظهر أنماط الطلب والصفقات المتعثرة بعد توفر بيانات كافية.','Demand patterns and stalled deals appear when enough data is available.'),null,'');if(notice)insight.prepend(notice);}
 if(dashboard.recentActivity.length)$('#crm-activity').querySelectorAll('.audit-row').forEach(row=>{const mark=document.createElement('span');mark.className='sales-event-mark';mark.innerHTML=icon('clock');row.prepend(mark);});
 else blank('crm-activity','clock',L('سجل واضح لكل خطوة','A clear record of every step'),L('إضافة العملاء وتحديث المراحل والمتابعات تظهر هنا بترتيبها الزمني.','Customer creation, stage changes and follow-ups appear here chronologically.'),null,'');
 $('#crm-lead-list').querySelectorAll('.lead-button').forEach(b=>{const name=b.querySelector('b')?.textContent;b.insertAdjacentHTML('afterbegin',avatar(name));});
}
function renderDataStatus(status,escape){
 const rows=[[t('sales.dataStatus.crm'),status.crm==='LOCAL'?'CONNECTED':status.crm,t('sales.dataStatus.crmHint')],[t('sales.dataStatus.whatsapp'),status.whatsapp,t('sales.dataStatus.whatsappHint')],[t('sales.dataStatus.salla'),status.salla,t('sales.dataStatus.sallaHint')],[t('sales.dataStatus.aiAgent'),status.aiSalesAgent,t('sales.dataStatus.aiAgentHint')]];
 $('#crm-data-status').innerHTML=rows.map(([label,value,hint])=>`<span title="${escape(hint)}">${escape(label)}: <span class="pill" data-status="${escape(value)}">${escape(value==='CONNECTED'||value==='ONLINE'?(value==='ONLINE'?t('sales.dataStatus.online'):t('sales.dataStatus.connected')):value==='LOCAL'?t('sales.dataStatus.local'):t('sales.dataStatus.notConnected'))}</span></span>`).join('');
}
function renderKPIs(kpis){
 $('#crm-summary').innerHTML=[
  kpiCard(t('sales.kpi.newLeads'),fmtNum(kpis.newLeads.value),t('sales.kpi.newLeadsThisWeek',{count:kpis.newLeads.newThisWeek}),'crm-kanban'),
  kpiCard(t('sales.kpi.qualifiedLeads'),fmtNum(kpis.qualifiedLeads.value),t('sales.kpi.qualifiedLeadsHint'),'crm-kanban'),
  kpiCard(t('sales.kpi.hotLeads'),fmtNum(kpis.hotLeads.value),t('sales.kpi.hotLeadsHint'),'crm-hot-leads'),
  kpiCard(t('sales.kpi.quotesSent'),fmtNum(kpis.quotesSent.value),null,'crm-quotes'),
  kpiCard(t('sales.kpi.pipelineValue'),fmtSAR(kpis.pipelineValue.value),t('sales.kpi.pipelineValueHint'),'crm-forecast'),
  kpiCard(t('sales.kpi.wonDeals'),fmtNum(kpis.wonDeals.value),null,'crm-kanban'),
  kpiCard(t('sales.kpi.lostDeals'),fmtNum(kpis.lostDeals.value),null,'crm-kanban'),
  kpiCard(t('sales.kpi.followupsOverdue'),fmtNum(kpis.followupsOverdue.value),null,'crm-followup-center')
 ].join('');
}
function renderKanban(pipeline,escape){
 $('#crm-kanban').innerHTML=`<div class="kanban">${pipeline.map(column=>`<div class="kanban-column" data-stage-column="${column.stage}"><h4><span>${escape(stageNames[column.stage]||column.stage)}</span><span>${column.count}</span></h4>${column.leads.map(lead=>`<div class="kanban-card" draggable="true" data-lead-drag="${lead.id}" data-lead-version="${lead.version}"><b>${escape(lead.name)}</b><span>${lead.valueSAR?fmtSAR(lead.valueSAR):'—'}${lead.city?' · '+escape(lead.city):''}</span><div class="badges"><span class="pill" data-status="${lead.customerType}">${lead.customerType}</span>${lead.temperature==='HOT'?'<span class="pill" data-status="HOT">HOT</span>':''}${lead.humanHold?`<span class="pill" data-status="OVERDUE">${t('sales.kanban.needsHumanIntervention')}</span>`:''}</div></div>`).join('')||`<p><small>${t('sales.kanban.empty')}</small></p>`}</div>`).join('')}</div>`;
}
function renderHotLeads(hotLeads,escape){
 if(!hotLeads.length){$('#crm-hot-leads').innerHTML=empty(t('sales.hotLeadsSection.emptyTitle'),t('sales.hotLeadsSection.emptyHint'));return;}
 $('#crm-hot-leads').innerHTML=`<div class="grid">${hotLeads.map(lead=>`<article class="card hot-lead-card"><div class="row-between"><b>${escape(lead.name)}</b>${lead.valueSAR?`<span dir="ltr">${fmtSAR(lead.valueSAR)}</span>`:''}</div><p>${escape(lead.productNeed||'—')} ${lead.quantity?'· '+t('sales.hotLeadsSection.quantityLabel')+': '+lead.quantity:''}</p><p><small>${escape(lead.city||'—')} ${lead.timeline?'· '+escape(lead.timeline):''}</small></p>${lead.lastMessageText?`<p><small>${t('sales.hotLeadsSection.lastMessageLabel')}: ${escape(lead.lastMessageText.slice(0,80))}</small></p>`:''}${lead.humanHold?`<p><small> ${escape(lead.handoffReason||t('sales.hotLeadsSection.needsInterventionDefault'))}</small></p>`:''}<div class="row"><button type="button" class="secondary" data-open-lead="${lead.id}">${t('sales.hotLeadsSection.openFile')}</button></div></article>`).join('')}</div>`;
}
function renderFollowupCenter(buckets,escape){
 const tabs=[['dueToday',t('sales.followupCenterSection.today'),buckets.dueToday],['overdue',t('sales.followupCenterSection.overdue'),buckets.overdue],['thisWeek',t('sales.followupCenterSection.thisWeek'),buckets.thisWeek],['onHold',t('sales.followupCenterSection.onHold'),buckets.onHold],['done',t('sales.followupCenterSection.done'),buckets.done]];
 const active=tabs.find(row=>row[0]===followupTab)?.[2]||[];
 const tabsHtml=`<div class="tabs">${tabs.map(([key,label,list])=>`<button type="button" class="tab${key===followupTab?' active':''}" data-followup-tab="${key}">${label}<span class="count">${list.length}</span></button>`).join('')}</div>`;
 const body=active.length?active.map(f=>`<div class="risk-item"><div class="risk-body"><span class="risk-title">${escape(f.channel)} · ${t('sales.followupCenterSection.messageNumber',{touch:f.touch})}</span><span class="risk-meta">${escape(new Date(f.dueAt).toLocaleString(getLocale()==='en'?'en-US':'ar-SA',{timeZone:'Asia/Riyadh'}))}${f.holdReason?' · '+escape(reasons[f.holdReason]||f.holdReason):''}</span></div><div class="row"><button type="button" class="secondary" data-open-lead="${f.leadId}">${t('sales.hotLeadsSection.openFile')}</button></div></div>`).join(''):empty(t('sales.followupCenterSection.empty'));
 $('#crm-followup-center').innerHTML=tabsHtml+`<div class="risk-list">${body}</div>`;
}
function renderInbox(conversations,escape){
 if(!conversations.hasData){$('#crm-inbox').innerHTML=empty(t('sales.inboxSection.emptyTitle'),t('sales.inboxSection.emptyHint'));return;}
 const tabs=[['all',t('sales.inboxSection.all'),conversations.rows],['hot',t('sales.inboxSection.hot'),conversations.rows.filter(r=>r.temperature==='HOT')],['b2b',t('sales.inboxSection.b2b'),conversations.rows.filter(r=>r.customerType==='B2B')],['awaiting',t('sales.inboxSection.awaiting'),conversations.rows.filter(r=>r.awaitingResponse)]];
 const active=tabs.find(row=>row[0]===inboxTab)?.[1]!==undefined?tabs.find(row=>row[0]===inboxTab)[2]:conversations.rows;
 const tabsHtml=`<div class="tabs">${tabs.map(([key,label,list])=>`<button type="button" class="tab${key===inboxTab?' active':''}" data-inbox-tab="${key}">${label}<span class="count">${list.length}</span></button>`).join('')}</div>`;
 const body=active.length?`<div class="calendar-scroll"><table><thead><tr><th>${t('sales.inboxSection.customer')}</th><th>${t('sales.inboxSection.channel')}</th><th>${t('sales.inboxSection.lastMessage')}</th><th>${t('sales.inboxSection.time')}</th><th>${t('sales.inboxSection.status')}</th></tr></thead><tbody>${active.map(row=>`<tr class="clickable" data-open-lead="${row.leadId}"><td>${escape(row.customer)}</td><td>${escape(row.channel)}</td><td>${escape((row.lastMessage||'').slice(0,60))}</td><td dir="ltr">${fmtDateTime(row.lastMessageAt)}</td><td>${row.awaitingResponse?`<span class="pill" data-status="HOLD">${t('sales.inboxSection.awaitingReply')}</span>`:`<span class="pill" data-status="COMPLETED">${t('sales.inboxSection.replied')}</span>`}</td></tr>`).join('')}</tbody></table></div>`:empty(t('sales.inboxSection.emptyCategory'));
 $('#crm-inbox').innerHTML=tabsHtml+body;
}
function renderB2B(b2b,escape){
 if(!b2b.length){$('#crm-b2b').innerHTML=empty(t('sales.b2bSection.emptyTitle'),t('sales.b2bSection.emptyHint'));return;}
 $('#crm-b2b').innerHTML=`<div class="calendar-scroll"><table><thead><tr><th>${t('sales.b2bSection.company')}</th><th>${t('sales.b2bSection.need')}</th><th>${t('sales.b2bSection.value')}</th><th>${t('sales.b2bSection.stage')}</th><th>${t('sales.b2bSection.probability')}</th><th>${t('sales.b2bSection.nextStep')}</th></tr></thead><tbody>${b2b.map(o=>`<tr class="clickable" data-open-lead="${o.id}"><td>${escape(o.company||'—')}</td><td>${escape(o.need||'—')}</td><td dir="ltr">${o.valueSAR?fmtSAR(o.valueSAR):'—'}</td><td><span class="pill" data-status="${escape(o.stage)}">${escape(stageNames[o.stage]||o.stage)}</span></td><td dir="ltr">${o.probability!==null?Math.round(o.probability*100)+'%':'—'}</td><td>${escape(o.nextStep||'—')}</td></tr>`).join('')}</tbody></table></div>`;
}
function renderQuotes(quotes,escape){
 if(!quotes.length){$('#crm-quotes').innerHTML=empty(t('sales.quotesSection.emptyTitle'),t('sales.quotesSection.emptyHint'));return;}
 const statusNames={SENT:t('sales.quotesSection.statusSent'),ACCEPTED:t('sales.quotesSection.statusAccepted')};
 $('#crm-quotes').innerHTML=`<div class="calendar-scroll"><table><thead><tr><th>${t('sales.quotesSection.customer')}</th><th>${t('sales.quotesSection.amount')}</th><th>${t('sales.quotesSection.status')}</th><th>${t('sales.quotesSection.createdDate')}</th><th>${t('sales.quotesSection.actions')}</th></tr></thead><tbody>${quotes.map(q=>`<tr><td>${escape(q.customer)}</td><td dir="ltr">${q.amount?fmtSAR(q.amount):'—'}</td><td><span class="pill" data-status="${q.status}">${statusNames[q.status]||q.status}</span></td><td dir="ltr">${fmtDateTime(q.createdAt)}</td><td><button type="button" class="secondary" data-open-lead="${q.id}">${t('sales.quotesSection.open')}</button> <button type="button" class="secondary" disabled title="${t('sales.quotesSection.pdfDisabledTitle')}">PDF</button></td></tr>`).join('')}</tbody></table></div>`;
}
function renderForecast(forecast,escape){
 if(!forecast.hasData){$('#crm-forecast').innerHTML=empty(t('sales.forecastSection.empty'));return;}
 const stats=[kpiCard(t('sales.forecastSection.totalPipeline'),fmtSAR(forecast.pipelineTotal)),kpiCard(t('sales.forecastSection.weightedPipeline'),fmtSAR(forecast.weightedPipeline),t('sales.forecastSection.weightedHint')),kpiCard(t('sales.forecastSection.wonRevenue'),fmtSAR(forecast.wonRevenue)),kpiCard(t('sales.forecastSection.avgDealSize'),forecast.avgDealSize?fmtSAR(forecast.avgDealSize):t('sales.forecastSection.noWonDealsYet'))].join('');
 $('#crm-forecast').innerHTML=`<div class="kpi-grid">${stats}</div><h4>${t('sales.forecastSection.valueByStage')}</h4>${renderBarChart(forecast.byStage.filter(s=>s.value>0).map(s=>[stageNames[s.stage]||s.stage,s.value]),escape)}<p><small>${t('sales.forecastSection.probabilityModelNote',{model:Object.entries(forecast.probabilityModel).map(([stage,p])=>`${stageNames[stage]||stage} ${Math.round(p*100)}%`).join(getLocale()==='en'?', ':'، ')})}</small></p>`;
}
function renderAIInsights(insights,recommendation,escape){
 const rec=recommendation?`<div class="notice">${t('sales.aiInsightsSection.frostRecommendation',{text:escape(recommendation.text)})}</div>`:'';
 if(!insights.hasEnoughData){$('#crm-ai-insights').innerHTML=rec+empty(t('sales.aiInsightsSection.insufficientData'),t('sales.aiInsightsSection.insufficientDataHint'));return;}
 const list=(title,items,render)=>`<div class="exec-col"><h4>${title}</h4><ul>${items.length?items.map(render).join(''):`<li>${t('sales.aiInsightsSection.noData')}</li>`}</ul></div>`;
 $('#crm-ai-insights').innerHTML=rec+`<div class="exec-summary-grid">
  ${list(t('sales.aiInsightsSection.topProducts'),insights.topProducts,([name,count])=>`<li>${escape(name)} (${count})</li>`)}
  ${list(t('sales.aiInsightsSection.commonInquiryTypes'),insights.commonInquiryTypes,([intent,count])=>`<li>${escape(intentNames[intent]||intent)} (${count})</li>`)}
  ${list(t('sales.aiInsightsSection.stalledDeals'),insights.stalledDeals,d=>`<li>${escape(d.name)} · ${t('sales.aiInsightsSection.stalledDealsDays',{days:d.daysSince})}${d.valueSAR?' · '+fmtSAR(d.valueSAR):''}</li>`)}
 </div><div class="exec-summary-grid">
  ${list(t('sales.aiInsightsSection.needsIntervention'),insights.needsIntervention,d=>`<li>${escape(d.name)}${d.reason?' — '+escape(d.reason):''}</li>`)}
  ${list(t('sales.aiInsightsSection.lostReasons'),insights.lostReasons,reason=>`<li>${escape(reason)}</li>`)}
  ${list(t('sales.aiInsightsSection.bestSource'),insights.bestSource?[insights.bestSource]:[],([source,stats])=>`<li>${escape(source)} — ${t('sales.aiInsightsSection.bestSourceStat',{won:stats.won,count:stats.count})}</li>`)}
 </div>`;
}
function renderActivity(activity,escape){
 if(!activity.length){$('#crm-activity').innerHTML=empty(t('sales.activitySection.empty'));return;}
 const actionNames=new Proxy({},{get:(_,code)=>code==='AGENT_RUN_COMPLETED'?t('sales.activitySection.agentRunCompleted'):(()=>{const key='operationsLog.actions.'+code,value=t(key);return value===key?undefined:value;})()});
 $('#crm-activity').innerHTML=activity.map(entry=>`<div class="audit-row row-between"><span>${escape(entry.actor)} — ${escape(actionNames[entry.action]||entry.action)}</span><time dir="ltr">${fmtDateTime(entry.at)}</time></div>`).join('');
}
function renderSearchResults(escape){
 const container=$('#crm-search-results');
 if(!searchResults){container.innerHTML='';return;}
 container.innerHTML=`<div class="search-results"><div class="items">${searchResults.length?searchResults.map(lead=>`<div class="search-result-row" data-open-lead="${lead.id}">${escape(lead.name)}${lead.company?' · '+escape(lead.company):''}<small>${escape(lead.phone||lead.email||'')} · ${escape(stageNames[lead.stage]||lead.stage)}</small></div>`).join(''):`<div class="search-result-row">${t('sales.searchNoMatches')}</div>`}</div></div>`;
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
  $('#crm-data-status').innerHTML=`<span class="pill" data-status="ERROR">${t('sales.dataStatus.dashboardLoadError')}</span>`;
 }
 $('#crm-run-frost').hidden=auth.user.role!=='owner';
 styleSalesWorkspace(escape);
 $('#crm-lead-list').innerHTML=crm.leads.length?crm.leads.map(lead=>`<button class="lead-button" type="button" data-lead-id="${lead.id}"><div class="row-between"><b>${escape(lead.name)}</b><span class="pill" data-status="${escape(lead.stage)}">${stageNames[lead.stage]||lead.stage}</span></div><span>${escape(lead.company||lead.customerType)}</span><small>${lead.temperature==='HOT'?t('sales.leadList.highInterest'):''}${lead.optOut?t('sales.leadList.optedOut'):lead.humanHold||lead.replyHold?t('sales.leadList.followupOnHold'):t('sales.leadList.openFile')}</small></button>`).join(''):`<div class="empty">${t('sales.leadList.empty')}</div>`;
 $('#crm-prepare').hidden=auth.user.role!=='owner';
 renderSalesDetailPanels(escape);
 if(!selected && crm.leads.length)selected=crm.leads[0].id;
 if(!selected){$('#crm-detail').innerHTML=`<div class="empty">${t('sales.leadDetail.emptyPrompt')}</div>`;return;}
 detail=await api('/api/crm/leads/'+selected);const lead=detail.lead;
 const qf=key=>t('sales.qualificationForm.'+key);
 const qualification=field('city',qf('city'),escape(lead.city))+field('productNeed',qf('productNeed'),escape(lead.productNeed))+field('productUrl',qf('productLink'),escape(lead.productUrl),'url')+field('quantity',qf('quantity'),lead.quantity??'','number','min="1"')+field('valueSAR',qf('estimatedValue'),lead.valueSAR??'','number','min="0" step="0.01"')+field('timeline',qf('timeline'),escape(lead.timeline))+field('budgetBand',qf('budgetRange'),escape(lead.budgetBand));
 $('#crm-detail').innerHTML=`<h3>${escape(lead.name)} ${lead.company?'· '+escape(lead.company):''}</h3><p>${escape(lead.phone||'')} ${escape(lead.email||'')}</p><p>${t('sales.leadDetail.stage')}: ${stageNames[lead.stage]||lead.stage} · ${t('sales.leadDetail.version')} ${lead.version} · ${lead.optOut?t('sales.leadList.optedOut'):lead.humanHold||lead.replyHold?t('sales.leadList.followupOnHold'):t('sales.leadDetail.noActiveHold')}</p><p>${t('sales.leadDetail.emailConsent')}: ${lead.consent.Email?t('sales.leadDetail.documented'):t('sales.leadDetail.notDocumented')} · ${t('sales.leadDetail.whatsappConsent')}: ${lead.consent.WhatsApp?t('sales.leadDetail.documented'):t('sales.leadDetail.notDocumented')}</p>${lead.research?`<details><summary>${t('sales.leadDetail.b2bSource')}</summary><p>${escape(lead.research.trigger)}</p><p>${escape(lead.research.sourceUrl)}</p><p>${t('sales.leadDetail.fitScore')}: ${lead.research.fitScore} · ${t('sales.leadDetail.humanConfirmation')}</p></details>`:''}
 <details open><summary>${qf('summary')}</summary><form data-crm="update" data-lead="${lead.id}">${qualification}<label>${qf('stageLabel')}<select name="stage">${Object.entries(stageNames).map(([v,label])=>`<option value="${v}" ${v===lead.stage?'selected':''}>${label}</option>`).join('')}</select></label><label>${qf('temperatureLabel')}<select name="temperature">${['COLD','WARM','HOT'].map(temp=>`<option ${temp===lead.temperature?'selected':''}>${temp}</option>`).join('')}</select></label><label>${qf('assignedTo')}<select name="assignedTo"><option value="">${qf('unassigned')}</option>${crm.staff.map(s=>`<option value="${s.id}" ${s.id===lead.assignedTo?'selected':''}>${escape(s.name)}</option>`).join('')}</select></label>${field('nextCheckAt',qf('reviewDate'),dateTime(lead.nextCheckAt),'datetime-local')}${field('reason',qf('updateReason'),'','text','required maxlength="1000"')}<button>${qf('save')}</button></form></details>
 <details><summary>${t('sales.messageForm.summary')}</summary><form data-crm="messages" data-lead="${lead.id}"><label>${t('sales.messageForm.channel')}<select name="channel">${['WhatsApp','Email','Instagram','Facebook','X','LinkedIn','Phone'].map(c=>`<option>${c}</option>`).join('')}</select></label><label>${t('sales.messageForm.category')}<select name="intent">${Object.entries(intentNames).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label><label>${t('sales.messageForm.messageText')}<textarea name="text" required maxlength="4000"></textarea></label><p>${t('sales.messageForm.note')}</p><button>${t('sales.messageForm.save')}</button></form></details>
 <details><summary>${t('sales.contactForm.summary')}</summary><form data-crm="contact" data-lead="${lead.id}"><label>${t('sales.contactForm.action')}<select name="action"><option value="OPT_OUT">${t('sales.contactForm.optOutOption')}</option>${auth.user.role==='owner'?`<option value="CONSENT">${t('sales.contactForm.consentOption')}</option><option value="RESOLVE_HOLD">${t('sales.contactForm.resolveHoldOption')}</option>`:''}</select></label><label>${t('sales.contactForm.channel')}<select name="channel"><option>Email</option><option>WhatsApp</option></select></label>${field('obtainedAt',t('sales.contactForm.consentTime'),'','datetime-local')}<label class="check"><input name="confirmed" type="checkbox">${t('sales.contactForm.confirmCheckbox')}</label>${field('evidence',t('sales.contactForm.evidence'),'','text','required maxlength="1000"')}<button>${t('sales.contactForm.save')}</button></form></details>
 <details><summary>${t('sales.followupForm.summary')}</summary><form data-crm="followups" data-lead="${lead.id}"><label>${t('sales.followupForm.sequence')}<select name="sequence">${crm.sequences.map(s=>`<option value="${s.id}">${s.name}</option>`).join('')}</select></label><label>${t('sales.followupForm.channel')}<select name="channel"><option>Email</option><option>WhatsApp</option></select></label>${field('startAt',t('sales.followupForm.startTime'),'','datetime-local','required')}${field('evidence',t('sales.followupForm.evidence'),'','text','required maxlength="1000"')}<p>${t('sales.followupForm.note')}</p><button>${t('sales.followupForm.save')}</button></form></details>
 <details><summary>${t('sales.handoffSummary.summary')}</summary><p>${t('sales.handoffSummary.need')}: ${escape(lead.productNeed||t('sales.handoffSummary.unknown'))} · ${t('sales.handoffSummary.city')}: ${escape(lead.city||t('sales.handoffSummary.cityUnknown'))}</p><p>${t('sales.handoffSummary.assignedTo')}: ${escape(crm.staff.find(s=>s.id===lead.assignedTo)?.name||t('sales.handoffSummary.unassigned'))} · ${t('sales.handoffSummary.escalation')}: ${escape(lead.handoffReason||t('sales.handoffSummary.none'))}</p><p>${t('sales.handoffSummary.followupLabel')}: ${lead.humanHold?t('sales.handoffSummary.humanRequired'):t('sales.handoffSummary.staffQualification')}</p><p>${t('sales.handoffSummary.quoteStatus')}: ${detail.quoteIntake.status==='NEEDS_DATA'?t('sales.handoffSummary.missingData',{fields:detail.quoteIntake.missingFields.join(getLocale()==='en'?', ':'، ')}):t('sales.handoffSummary.readyForHumanQuote')}</p><small>${t('sales.handoffSummary.noQuoteYet')}</small></details>
 <h4>${t('sales.messagesSection.title')}</h4>${detail.messages.map(m=>`<div class="audit-row"><small>${escape(m.channel)} · ${t('sales.messagesSection.manualEntry')} · ${escape(m.recordedAt)}</small><p>${escape(m.text)}</p></div>`).join('')||`<p>${t('sales.messagesSection.none')}</p>`}
 <h4>${t('sales.followupsSection.title')}</h4><button type="button" data-crm-stop="${lead.id}">${t('sales.followupsSection.stopDrafts')}</button>${detail.followups.map(f=>`<article class="card"><div class="meta"><span>${escape(f.channel)} · ${t('sales.followupCenterSection.messageNumber',{touch:f.touch})}</span><span class="pill" data-status="${escape(f.status)}">${followupNames[f.status]}</span></div><p>${escape(f.messageAr)}</p><p dir="ltr">${escape(f.messageEn)}</p><p>${escape(new Date(f.dueAt).toLocaleString(getLocale()==='en'?'en-US':'ar-SA',{timeZone:'Asia/Riyadh'}))}</p>${f.holdReason?`<small>${escape(reasons[f.holdReason]||f.holdReason)}</small>`:''}${auth.user.role==='owner'&&f.status==='DRAFT'?`<button type="button" data-followup-approve="${f.id}">${t('sales.followupsSection.approveBothAndTime')}</button>`:''}</article>`).join('')}`;
}
export async function submitCRM(form,input,api){
 if(form.id==='crm-create'){
  input.sourceChecked=input.sourceChecked==='on';if(input.triggerDate)input.triggerDate+='T00:00:00+03:00';
  const lead=await api('/api/crm/leads',input);selected=lead.id;form.reset();return t('sales.toasts.leadCreated');
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
 await api(`/api/crm/leads/${form.dataset.lead}/${action}`,input);return t('sales.toasts.actionSaved');
}
export async function clickCRM(button,api){
 if(button.dataset.leadId||button.dataset.openLead){selected=button.dataset.leadId||button.dataset.openLead;return t('sales.toasts.leadOpened');}
 if(button.dataset.followupApprove){await api('/api/crm/followups/'+button.dataset.followupApprove+'/approve',{});return t('sales.toasts.followupApproved');}
 if(button.dataset.crmStop){await api('/api/crm/leads/'+button.dataset.crmStop+'/stop-followups',{});return t('sales.toasts.followupsStopped');}
 if(button.id==='crm-prepare'){const result=await api('/api/crm/followups/prepare',{});return t('sales.toasts.followupsPrepareResult',{ready:result.ready,held:result.held});}
 if(button.id==='crm-run-frost'){const result=await api('/api/frost/run-now',{});return result.skipped?t('sales.toasts.frostPausedNotice'):t('sales.toasts.frostRunManual');}
 if(button.dataset.followupTab){followupTab=button.dataset.followupTab;return t('sales.toasts.categorySwitched');}
 if(button.dataset.inboxTab){inboxTab=button.dataset.inboxTab;return t('sales.toasts.categorySwitched');}
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
  if(scrollTarget){document.querySelectorAll('#sales-section-nav button').forEach(b=>{const active=b.dataset.crmScroll===scrollTarget.dataset.crmScroll;b.classList.toggle('selected',active);b.setAttribute('aria-pressed',String(active));});document.getElementById(scrollTarget.dataset.crmScroll)?.scrollIntoView({behavior:'smooth',block:'start'});}
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
  const reason=await requestReason(t('sales.toasts.moveToStagePrompt',{stage:stageNames[newStage]||newStage}));
  if(!reason||!reason.trim())return;
  window.dispatchEvent(new CustomEvent('crm-stage-drop',{detail:{leadId,newStage,expectedVersion,reason:reason.trim()}}));
 });
}
