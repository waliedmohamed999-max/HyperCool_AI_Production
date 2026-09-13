import {fmtNum,fmtSAR,fmtDate,fmtDateRange,empty,miniStat,kpiCard,renderBarChart,renderFunnel,stageNames,renderTrendChart,installTrendChart,chartColors} from './format.js';
import {t,getLocale} from './i18n.js';
const $=selector=>document.querySelector(selector);
const actionTypeNames=new Proxy({},{get:(_,code)=>{const key='weeklyReport.actionType'+code.split('_').map(p=>p.charAt(0).toUpperCase()+p.slice(1).toLowerCase()).join('');const value=t(key);return value===key?undefined:value;}});
let lastData=null,viewedWeekStart=null;
function dateLocale(){return getLocale()==='en'?'en-US':'ar-SA';}
// Same "current + saved reports, deduped by week, sorted, last 8" shape as the Overview page's
// own weeklySeries (public/pages/workspace.js) — kept as a small local copy rather than a shared
// export since it's five lines and this page already has its own dateLocale()-style local helpers.
function weeklySeries(data,pick) {
 const byWeek=new Map();
 for(const entry of data?.saved||[])if(entry.kpis)byWeek.set(entry.weekStart,entry);
 if(data?.current?.kpis)byWeek.set(data.current.weekStart,data.current);
 return [...byWeek.values()].sort((a,b)=>a.weekStart.localeCompare(b.weekStart)).slice(-8).map(entry=>({label:fmtDate(entry.weekStart),value:pick(entry.kpis)}));
}

function renderPipeline(pipeline,escape) {
 if(!pipeline.hasData)return empty(t('weeklyReport.pipelineNoDataTitle'),t('weeklyReport.pipelineNoDataHint'));
 const stats=[
  miniStat(t('weeklyReport.openPipelineValue'),fmtSAR(pipeline.pipelineValue)),
  miniStat(t('weeklyReport.weekRevenue'),fmtSAR(pipeline.wonRevenue)),
  miniStat(t('weeklyReport.avgDealSize'),pipeline.avgDealSize?fmtSAR(pipeline.avgDealSize):t('weeklyReport.noWonDealsYet')),
  miniStat(t('weeklyReport.quotesSentValue'),fmtSAR(pipeline.quotesValue))
 ].join('');
 const rows=pipeline.topOpportunities.length?`<div class="calendar-scroll"><table><thead><tr><th>${escape(t('weeklyReport.oppTableParty'))}</th><th>${escape(t('weeklyReport.oppTableValue'))}</th><th>${escape(t('weeklyReport.oppTableStage'))}</th><th>${escape(t('weeklyReport.oppTableCity'))}</th><th>${escape(t('weeklyReport.oppTableNeed'))}</th></tr></thead><tbody>${pipeline.topOpportunities.map(o=>`<tr><td>${escape(o.name)}</td><td dir="ltr">${fmtSAR(o.valueSAR)}</td><td><span class="pill" data-status="${escape(o.stage)}">${escape(stageNames[o.stage]||o.stage)}</span></td><td>${escape(o.city||'—')}</td><td>${escape(o.productNeed||'—')}</td></tr>`).join('')}</tbody></table></div>`:`<p>${escape(t('weeklyReport.noOpportunitiesYet'))}</p>`;
 return `<div class="kpi-grid">${stats}</div><h4>${escape(t('weeklyReport.topOpportunitiesHeading'))}</h4>${rows}`;
}
function renderContent(base,escape) {
 const platforms=Object.entries(base.content.byPlatform);
 return `<div class="kpi-grid">
  ${miniStat(t('weeklyReport.contentPlannedThisWeek'),fmtNum(base.content.total))}
  ${miniStat(t('weeklyReport.awaitingOwnerApproval'),fmtNum(Object.entries(base.content.byStatus).find(([k])=>k==='REVIEWED')?.[1]||0))}
  ${miniStat(t('weeklyReport.blockedByAutoCompliance'),fmtNum(base.compliance.byClassification?.BLOCK||0))}
  ${miniStat(t('weeklyReport.actuallyPublished'),fmtNum(base.metrics.publishedPosts||0))}
 </div>
 <h4>${escape(t('weeklyReport.byPlatformHeading'))}</h4>${renderBarChart(platforms,escape)}
 <p><small>${escape(base.metrics.reason)}</small></p>`;
}
function renderAgentsSection(agents,escape) {
 const rows=agents.agents.filter(a=>a.runs>0).sort((a,b)=>b.runs-a.runs);
 if(!rows.length)return empty(t('weeklyReport.noAgentRunsTitle'),t('weeklyReport.noAgentRunsHint'));
 return `<div class="calendar-scroll"><table><thead><tr><th>${escape(t('weeklyReport.agentTableAgent'))}</th><th>${escape(t('weeklyReport.agentTableRuns'))}</th><th>${escape(t('weeklyReport.agentTableSuccessRate'))}</th><th>${escape(t('weeklyReport.agentTableErrors'))}</th><th>${escape(t('weeklyReport.agentTableEscalations'))}</th><th>${escape(t('weeklyReport.agentTableAvgResponse'))}</th></tr></thead><tbody>${rows.map(a=>`<tr class="agent-perf-row"><td>${escape(a.nameAr)}</td><td dir="ltr">${a.runs}</td><td dir="ltr">${a.successRate===null?'—':a.successRate+'%'}</td><td dir="ltr">${a.failed}</td><td dir="ltr">${a.escalations}</td><td dir="ltr">${a.avgLatencyMs?Math.round(a.avgLatencyMs/1000)+' '+t('weeklyReport.secondsSuffix'):'—'}</td></tr>`).join('')}</tbody></table></div>`;
}
function renderRisks(risks,escape) {
 const items=[
  ...risks.pendingContentReview.map(i=>({title:t('weeklyReport.pendingContentReviewPrefix',{title:i.title}),meta:i.platform,priority:'P3',page:'content'})),
  ...risks.pendingAgentApprovals.map(a=>({title:`${actionTypeNames[a.actionType]||a.actionType} — ${a.reason}`,meta:t('weeklyReport.agentPrefix',{id:a.agentId}),priority:a.riskLevel==='HIGH'?'P1':a.riskLevel==='MEDIUM'?'P2':'P3',page:'agents'})),
  ...risks.openEscalations.map(e=>({title:e.reason,meta:t('weeklyReport.agentPrefix',{id:e.agentId}),priority:e.priority,page:'agents'}))
 ];
 if(!items.length)return empty(t('weeklyReport.noPendingDecisions'));
 return `<div class="risk-list">${items.map(item=>`<div class="risk-item${item.page?' clickable':''}"${item.page?` data-report-nav="${item.page}"`:''}><div class="risk-body"><span class="risk-title">${escape(item.title)}</span><span class="risk-meta">${escape(item.meta)}</span></div><span class="pill" data-status="${escape(item.priority)}">${escape(item.priority)}</span></div>`).join('')}</div>`;
}
function renderMarket(market,escape) {
 if(!market.hasData)return empty(t('weeklyReport.noMarketDataTitle'),t('weeklyReport.noMarketDataHint'));
 const locale=dateLocale();
 return market.signals.map(signal=>`<div class="signal-card"><span class="signal-tag">FACT</span><p>${escape(signal.value)}</p><small>${escape(t('weeklyReport.sourceLabel'))} ${escape(signal.source)} · ${escape(t('weeklyReport.approvedOnLabel'))} ${escape(new Date(signal.approvedAt).toLocaleDateString(locale))}</small></div>`).join('');
}
function renderRecommendations(quickSummary,escape) {
 if(!quickSummary.hasEnoughData)return empty(t('weeklyReport.noReliableRecommendationsTitle'),t('weeklyReport.noReliableRecommendationsHint'));
 const items=[
  ...quickSummary.opportunities.map(text=>({priority:'P2',text})),
  ...quickSummary.issues.map(text=>({priority:'P1',text}))
 ].slice(0,5);
 if(!items.length)return empty(t('weeklyReport.noExtraRecommendations'));
 return `<div class="recommendation-list">${items.map(item=>`<div class="recommendation-card"><span class="pill" data-status="${item.priority}">${item.priority}</span><div class="rec-body"><p>${escape(item.text)}</p></div></div>`).join('')}</div>`;
}
function renderNextWeek(plan,escape) {
 const dayNames=t('weeklyReport.dayNames');
 if(plan.calendarMissing)return empty(t('weeklyReport.noNextWeekCalendarTitle'),t('weeklyReport.noNextWeekCalendarHint'));
 return `<div class="week-grid">${plan.days.map((day,index)=>`<div class="week-day"><h5>${dayNames[index]}</h5>${day.planned?`<span>${day.planned} ${escape(t('weeklyReport.scheduledSuffix'))}</span>`:''}${day.gaps.map(g=>`<span class="gap-tag">${escape(t('weeklyReport.gapPrefix',{platform:g.platform}))}</span>`).join('')}${!day.planned&&!day.gaps.length?'<small>—</small>':''}</div>`).join('')}</div>`;
}
function renderTrends(data,escape) {
 const metrics=[
  ['trendRevenue',k=>k.wonRevenue.value,chartColors[0]],
  ['trendLeads',k=>k.leadsCreated.value,chartColors[1]],
  ['trendWonDeals',k=>k.wonDeals.value,chartColors[2]],
  ['trendContentPlanned',k=>k.contentPlanned.value,chartColors[3]]
 ];
 return `<div class="report-trend-grid">${metrics.map(([key,pick,colorClass])=>{
  const points=weeklySeries(data,pick);
  return `<div class="report-trend-card"><h4>${escape(t('weeklyReport.'+key))}</h4>${renderTrendChart(points,escape,colorClass)}</div>`;
 }).join('')}</div>`;
}
function renderSavedReports(saved,escape) {
 if(!saved.length)return empty(t('weeklyReport.noSavedReportsTitle'),t('weeklyReport.noSavedReportsHint'));
 return `<div class="report-cards">${saved.map((report,index)=>{
  const legacy=!report.kpis;
  const revenue=legacy?null:report.kpis.wonRevenue.value;
  const leads=legacy?report.crm.leadsCreated:report.kpis.leadsCreated.value;
  const won=legacy?null:report.kpis.wonDeals.value;
  return `<article class="card report-card" data-saved-report="${index}"><h4>${fmtDateRange(report.weekStart,report.weekEnd)}</h4><p><small>${legacy?escape(t('weeklyReport.legacyReportBasic')):escape(t('weeklyReport.fullExecutiveReport'))}</small></p><p>${escape(t('weeklyReport.newLeadsLabel'))} <b dir="ltr">${fmtNum(leads)}</b>${won!==null?` · ${escape(t('weeklyReport.wonDealsLabel'))} <b dir="ltr">${fmtNum(won)}</b>`:''}${revenue!==null?` · ${escape(t('weeklyReport.revenueLabel'))} <b dir="ltr">${fmtSAR(revenue)}</b>`:''}</p><button type="button" class="secondary" data-view-saved="${index}">${escape(t('weeklyReport.viewDetailsButton'))}</button></article>`;
 }).join('')}</div><div id="saved-report-detail"></div>`;
}
function renderExecutiveSummary(quickSummary,escape) {
 if(!quickSummary.hasEnoughData)return `<p>${escape(t('weeklyReport.notEnoughDataForSummary'))}</p>`;
 const col=(title,list,fallback)=>`<div class="exec-col"><h4>${title}</h4><ul>${list.length?list.map(t=>`<li>${escape(t)}</li>`).join(''):`<li>${fallback}</li>`}</ul></div>`;
 return `<div class="exec-summary-grid">
  ${col(t('weeklyReport.topWinsHeading'),quickSummary.wins,t('weeklyReport.noOutstandingResultsYet'))}
  ${col(t('weeklyReport.topIssuesHeading'),quickSummary.issues,t('weeklyReport.noIssuesRecorded'))}
  ${col(t('weeklyReport.topOpportunitiesColHeading'),quickSummary.opportunities,t('weeklyReport.noAdditionalOpportunities'))}
 </div>`;
}
function renderBody(r,saved,escape) {
 if(!r.kpis)return `<div class="panel report-error"><p>${escape(t('weeklyReport.legacyReportNotice'))}</p></div>`;
 const kpiDefs=[
  {key:'leadsCreated',label:t('weeklyReport.kpiNewLeads'),good:'up',page:'crm'},
  {key:'qualifiedLeads',label:t('weeklyReport.kpiQualifiedLeads'),good:'up',page:'crm'},
  {key:'hotLeads',label:t('weeklyReport.kpiHotInterest'),good:'up',page:'crm'},
  {key:'quotesSent',label:t('weeklyReport.kpiQuotesSent'),good:'up',page:'crm'},
  {key:'wonDeals',label:t('weeklyReport.kpiWonDeals'),good:'up',page:'crm'},
  {key:'lostDeals',label:t('weeklyReport.kpiLostDeals'),good:'down',page:'crm'},
  {key:'wonRevenue',label:t('weeklyReport.kpiRevenueEarned'),good:'up',format:'sar',page:'crm'},
  {key:'followupsDrafted',label:t('weeklyReport.kpiFollowupsPrepared'),good:'up',page:'crm'}
 ];
 const kpiCards=kpiDefs.map(def=>kpiCard(def,r.kpis[def.key],escape)).join('')
  +kpiCard({label:t('weeklyReport.kpiConversionRateLabel'),good:'up',format:'percent'},{value:r.kpis.conversionRate.value||0,note:r.kpis.conversionRate.value===null?t('weeklyReport.kpiInsufficientData'):t('weeklyReport.kpiFromThisWeekLeads')},escape)
  +kpiCard({label:t('weeklyReport.kpiContentAwaitingApproval'),good:'down',page:'content'},r.kpis.contentPendingApproval,escape)
  +kpiCard({label:t('weeklyReport.kpiAgentApprovalsPending'),good:'down',page:'agents'},r.kpis.agentApprovalsPending,escape);

 const dataNotice=(!r.dataStatus.storeConnected||!r.dataStatus.socialConnected)
  ?`<div class="notice">${escape(t('weeklyReport.dataNoticeBase'))}${!r.dataStatus.storeConnected?escape(t('weeklyReport.storeDisconnectedSuffix')):''}${!r.dataStatus.socialConnected?escape(t('weeklyReport.socialDisconnectedSuffix')):''}.</div>`:'';

 return `${dataNotice}
 <div class="report-section"><div class="kpi-grid">${kpiCards}</div></div>
 <div class="report-section panel"><div class="report-section-head"><h3>${escape(t('weeklyReport.executiveSummary'))}</h3><span>${escape(t('weeklyReport.executiveSummarySubtitle'))}</span></div>${renderExecutiveSummary(r.quickSummary,escape)}</div>
 <div class="report-section"><div class="report-section-head"><h3>${escape(t('weeklyReport.salesSummary'))}</h3><span>${escape(t('weeklyReport.currentSnapshot'))}</span></div>${renderFunnel(r.funnel,escape)}</div>
 <div class="report-section"><div class="report-section-head"><h3>${escape(t('weeklyReport.pipelineAnalysis'))}</h3></div>${renderPipeline(r.pipeline,escape)}</div>
 <div class="report-section"><div class="report-section-head"><h3>${escape(t('weeklyReport.contentPerformance'))}</h3></div>${renderContent(r,escape)}</div>
 <div class="report-section"><div class="report-section-head"><h3>${escape(t('weeklyReport.agentTeamPerformance'))}</h3><span>${escape(t('weeklyReport.thisWeekLabel'))}</span></div>${renderAgentsSection(r.agents,escape)}</div>
 <div class="report-section"><div class="report-section-head"><h3>${escape(t('weeklyReport.risksAndDecisions'))}</h3></div>${renderRisks(r.approvalsAndRisks,escape)}</div>
 <div class="report-section"><div class="report-section-head"><h3>${escape(t('weeklyReport.competitorSignals'))}</h3></div>${renderMarket(r.market,escape)}</div>
 <div class="report-section"><div class="report-section-head"><h3>${escape(t('weeklyReport.nextWeekFocus'))}</h3></div>${renderRecommendations(r.quickSummary,escape)}</div>
 <div class="report-section"><div class="report-section-head"><h3>${escape(t('weeklyReport.nextWeekPlan'))}</h3></div>${renderNextWeek(r.nextWeekPlan,escape)}</div>
 <div class="report-section"><div class="report-section-head"><h3>${escape(t('weeklyReport.trendsHeading'))}</h3><span>${escape(t('weeklyReport.trendsSubtitle'))}</span></div>${renderTrends({current:r,saved},escape)}</div>
 <div class="report-section"><div class="report-section-head"><h3>${escape(t('weeklyReport.savedReports'))}</h3></div>${renderSavedReports(saved,escape)}</div>`;
}
// Options are real, already-known Sundays only (the current week + every saved week) —
// deliberately not a free date input, so every value this control can send back is guaranteed
// to be a real Sunday the server already knows about (no client-side week-math duplication).
function populateWeekSelect(data) {
 const select=$('#report-week-select');
 if(!select)return;
 const seen=new Set([data.current.weekStart]);
 const options=[{weekStart:data.current.weekStart,weekEnd:data.current.weekEnd,isCurrent:true}];
 for(const report of data.saved) {
  if(seen.has(report.weekStart))continue;
  seen.add(report.weekStart);
  options.push({weekStart:report.weekStart,weekEnd:report.weekEnd});
 }
 options.sort((a,b)=>b.weekStart.localeCompare(a.weekStart));
 select.innerHTML=options.map(o=>`<option value="${o.weekStart}">${o.isCurrent?t('weeklyReport.weekPickerCurrentOption')+' — ':''}${fmtDateRange(o.weekStart,o.weekEnd)}</option>`).join('');
 select.value=data.current.weekStart;
}
export async function renderReports({api,escape,weekStart}={}) {
 const weekLabel=$('#report-week-label');
 try {
  const data=await api('/api/reports/weekly'+(weekStart?`?weekStart=${encodeURIComponent(weekStart)}`:''));
  lastData=data;
  viewedWeekStart=data.current.weekStart;
  const r=data.current;
  weekLabel.innerHTML=`<b dir="ltr">${fmtDateRange(r.period.start,r.period.end)}</b><small>${escape(t('weeklyReport.compareToWeekLabel',{range:fmtDateRange(r.period.previousStart,r.period.previousEnd)}))}</small>`;
    $('#report-content').innerHTML=renderBody(r,data.saved,escape);
    const {enhance}=await import('./components/ui/index.js');enhance($('#report-content'));
    installTrendChart($('#report-content'));
    populateWeekSelect(data);
 } catch(error) {
  weekLabel.textContent=t('weeklyReport.loadFailed');
  $('#report-content').innerHTML=`<div class="panel report-error"><p>${escape(t('weeklyReport.loadFailedBody'))}</p><button type="button" id="report-retry">${escape(t('weeklyReport.retryButton'))}</button></div>`;
  console.error('weekly report load failed:',error);
 }
}
// Same-origin GET with the real session cookie already attached by the browser — a transient
// anchor click lets the browser handle the save dialog itself via the server's real
// Content-Disposition: attachment header, exactly like a normal file download link.
function downloadReport(kind) {
 const weekStart=viewedWeekStart||lastData?.current?.weekStart;
 const url=`/api/reports/weekly/export.${kind}?locale=${encodeURIComponent(getLocale())}`+(weekStart?`&weekStart=${encodeURIComponent(weekStart)}`:'');
 const a=document.createElement('a');
 a.href=url;a.rel='noopener';
 document.body.append(a);a.click();a.remove();
}
export async function clickReportAction(target,api,escape) {
 if(target.id==='report-refresh'||target.id==='report-retry'){await renderReports({api,escape,weekStart:viewedWeekStart});return true;}
 if(target.id==='report-print'){window.print();return true;}
 if(target.id==='report-export-xlsx'){downloadReport('xlsx');return true;}
 if(target.id==='report-export-pdf'){downloadReport('pdf');return true;}
 const navEl=target.closest('[data-report-nav]');
 if(navEl){document.querySelector(`nav a[href="#${navEl.dataset.reportNav}"]`)?.click();return true;}
 const viewButton=target.closest('[data-view-saved]');
 if(viewButton && lastData){
  const report=lastData.saved[Number(viewButton.dataset.viewSaved)];
  const detail=document.querySelector('#saved-report-detail');
  if(detail && report){const {drawer,enhance}=await import('./components/ui/index.js');const node=document.createElement('div');node.innerHTML=renderBody(report,[],escape);drawer(t('weeklyReport.savedReportDrawerTitle'),node,{restore:true});enhance(node);installTrendChart(node);}
  return true;
 }
 return false;
}
export async function changeReportAction(target,api,escape) {
 if(target.id==='report-week-select'){await renderReports({api,escape,weekStart:target.value});return true;}
 return false;
}
export async function clickSaveReport(api) {
 const result=await api('/api/reports/weekly',{});
 return result.replayed?t('weeklyReport.alreadySavedToast'):t('weeklyReport.savedToast');
}
