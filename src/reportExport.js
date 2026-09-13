// Real Excel (.xlsx) and PDF export for the weekly executive report (src/reporting.js's
// buildExecutiveReport/buildWeeklyReport). Both outputs are built directly from the SAME report
// object the UI renders — no separate data path, so an export can never show different numbers
// than the screen it was downloaded from.
//
// PDF/Arabic note (read before touching the font logic below): pdfkit has no bidi or text-
// shaping engine of its own, so Arabic must be (1) reshaped into its correct joined presentation-
// form glyphs (arabic-reshaper) and (2) visually reordered for right-to-left display (bidi-js) —
// otherwise Arabic renders as disconnected, wrongly-ordered letters. The bundled font
// (assets/fonts/NotoNaskhArabic-*.ttf) is a plain TrueType file **deliberately not sourced as a
// WOFF2** — pdfkit's font subsetter (via fontkit) has a reproducible crash
// ("RangeError: Offset is outside the bounds of the DataView") when embedding these exact Google
// Fonts WOFF2 files once more than ~2 non-trivial Arabic glyphs are used in the same document;
// isolated single letters work, but real report sentences do not. The same font, decompressed
// from WOFF2 to a standalone TTF with the `wawoff2` package (a one-time build step, not a runtime
// dependency — see assets/fonts/LICENSE-NotoNaskhArabic.txt), embeds correctly. This was verified
// by reproducing the crash across three different font families and two fontkit versions, then
// confirming a decompressed-to-TTF copy of the exact same font data does not crash.
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import ArabicReshaper from 'arabic-reshaper';
import bidiFactory from 'bidi-js';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.join(__dirname,'..');
const FONT_REGULAR=path.join(ROOT,'assets/fonts/NotoNaskhArabic-Regular.ttf');
const FONT_BOLD=path.join(ROOT,'assets/fonts/NotoNaskhArabic-Bold.ttf');

const bidi=bidiFactory();
const labelsCache=new Map();
// Reads the SAME translation file the on-screen report uses (public/locales/{locale}/weeklyReport.json)
// so exported labels can never drift out of sync with the UI's own wording.
export function loadLabels(locale='ar') {
 const key=locale==='en'?'en':'ar';
 if(labelsCache.has(key))return labelsCache.get(key);
 const filePath=path.join(ROOT,'public/locales',key,'weeklyReport.json');
 const labels=JSON.parse(readFileSync(filePath,'utf8'));
 labelsCache.set(key,labels);
 return labels;
}
const fmtNum=n=>Number.isFinite(n)?n.toLocaleString('en-US'):'—';
const fmtSAR=(n,locale)=>Number.isFinite(n)?n.toLocaleString('en-US',{maximumFractionDigits:0})+(locale==='en'?' SAR':' ر.س'):'—';
const fmtPct=n=>Number.isFinite(n)?n+'%':'—';

// ---------------------------------------------------------------------------------------------
// Arabic-safe text drawing for pdfkit — see the module doc comment above for why this exists.
// ---------------------------------------------------------------------------------------------
const ARABIC_RE=/[؀-ۿﭐ-﷿ﹰ-﻿]/;
function reshapeMixed(text) {return ArabicReshaper.convertArabic(String(text??''));}
function bidiReorder(text) {return bidi.getReorderedString(text,bidi.getEmbeddingLevels(text));}
function splitRuns(text) {
 const runs=[];let cur='',curKind=null;
 for(const ch of text) {
  const kind=ARABIC_RE.test(ch)?'ar':'la';
  if(kind!==curKind && cur) {runs.push({text:cur,kind:curKind});cur='';}
  curKind=kind;cur+=ch;
 }
 if(cur)runs.push({text:cur,kind:curKind});
 return runs;
}
// Draws one right-aligned (or left-aligned) line built from mixed Arabic/Latin runs at an exact
// y position — pdfkit has no built-in per-run font switching within a single text() call, so each
// run is measured and positioned manually rather than relying on continued:true across fonts.
function drawBidiLine(doc,rawText,{x,y,width,fontSize,color='#111827',bold=false,align='right'}) {
 const arabicFont=bold?'Arabic-Bold':'Arabic',latinFont=bold?'Helvetica-Bold':'Helvetica';
 const visual=bidiReorder(reshapeMixed(rawText));
 const runs=splitRuns(visual);
 doc.fontSize(fontSize).fillColor(color);
 const widths=runs.map(r=>{doc.font(r.kind==='ar'?arabicFont:latinFont);return doc.widthOfString(r.text);});
 const totalWidth=widths.reduce((a,b)=>a+b,0);
 let cx=align==='right'?x+width-totalWidth:x;
 for(let i=0;i<runs.length;i++) {
  doc.font(runs[i].kind==='ar'?arabicFont:latinFont);
  doc.text(runs[i].text,cx,y,{lineBreak:false});
  cx+=widths[i];
 }
 return totalWidth;
}
function textHeight(doc,fontSize) {return fontSize*1.35;}

// ---------------------------------------------------------------------------------------------
// Excel export
// ---------------------------------------------------------------------------------------------
export async function buildReportWorkbook(report,{locale='ar'}={}) {
 const L=loadLabels(locale);
 const rtl=locale!=='en';
 const wb=new ExcelJS.Workbook();
 wb.creator='HyperCool AI';
 wb.created=new Date(report.generatedAt||Date.now());
 const sheetOpts={views:[{rightToLeft:rtl}]};
 const headerRow=ws=>{const row=ws.getRow(1);row.font={bold:true};row.alignment={horizontal:rtl?'right':'left'};};
 // Excel hard-caps worksheet names at 31 characters (exceljs only warns and silently
 // truncates) — some real translated labels (e.g. the English "Approvals & Risks Needing a
 // Decision") run longer than that, so every addWorksheet call below goes through this first.
 const sheetName=name=>String(name||'Sheet').slice(0,31);
 const addSheet=name=>wb.addWorksheet(sheetName(name),sheetOpts);

 // --- KPIs ---
 if(report.kpis) {
  const ws=addSheet(L.title||'Weekly Report');
  ws.columns=[
   {header:locale==='en'?'Metric':'المؤشر',key:'label',width:32},
   {header:locale==='en'?'This period':'هذه الفترة',key:'value',width:18},
   {header:locale==='en'?'Previous period':'الفترة السابقة',key:'previous',width:18},
   {header:locale==='en'?'Change %':'نسبة التغير %',key:'change',width:14}
  ];
  headerRow(ws);
  const kpiRows=[
   [L.kpiNewLeads,report.kpis.leadsCreated],[L.kpiQualifiedLeads,report.kpis.qualifiedLeads],
   [L.kpiHotInterest,report.kpis.hotLeads],[L.kpiQuotesSent,report.kpis.quotesSent],
   [L.kpiWonDeals,report.kpis.wonDeals],[L.kpiLostDeals,report.kpis.lostDeals],
   [L.kpiRevenueEarned,report.kpis.wonRevenue],[L.kpiFollowupsPrepared,report.kpis.followupsDrafted]
  ];
  for(const [label,kpi] of kpiRows)ws.addRow({label,value:kpi?.value??null,previous:kpi?.previous??null,change:kpi?.changePercent??null});
  ws.addRow({label:L.kpiConversionRateLabel,value:report.kpis.conversionRate?.value??null,previous:report.kpis.conversionRate?.previous??null,change:null});
  ws.addRow({label:L.kpiContentAwaitingApproval,value:report.kpis.contentPendingApproval?.value??null});
  ws.addRow({label:L.kpiAgentApprovalsPending,value:report.kpis.agentApprovalsPending?.value??null});

  // --- Sales funnel ---
  const funnelSheet=addSheet(L.salesSummary||'Sales funnel');
  funnelSheet.columns=[{header:locale==='en'?'Stage':'المرحلة',key:'label',width:24},{header:locale==='en'?'Count':'العدد',key:'count',width:12},{header:locale==='en'?'Drop-off %':'نسبة التسرب %',key:'dropOff',width:16}];
  headerRow(funnelSheet);
  for(const stage of report.funnel.stages)funnelSheet.addRow({label:stage.label,count:stage.count,dropOff:stage.dropOffPercent});

  // --- Pipeline & top opportunities ---
  const pipeSheet=addSheet(L.pipelineAnalysis||'Pipeline');
  pipeSheet.addRow([L.openPipelineValue,report.pipeline.pipelineValue]);
  pipeSheet.addRow([L.weekRevenue,report.pipeline.wonRevenue]);
  pipeSheet.addRow([L.avgDealSize,report.pipeline.avgDealSize]);
  pipeSheet.addRow([L.quotesSentValue,report.pipeline.quotesValue]);
  pipeSheet.addRow([]);
  const oppHeaderIdx=pipeSheet.rowCount+1;
  pipeSheet.addRow([L.oppTableParty,L.oppTableValue,L.oppTableStage,L.oppTableCity,L.oppTableNeed]);
  pipeSheet.getRow(oppHeaderIdx).font={bold:true};
  for(const opp of report.pipeline.topOpportunities)pipeSheet.addRow([opp.name,opp.valueSAR,opp.stage,opp.city||'—',opp.productNeed||'—']);
  pipeSheet.columns.forEach(c=>{c.width=20;});
  pipeSheet.views=[{rightToLeft:rtl}];

  // --- Content performance ---
  const contentSheet=addSheet(L.contentPerformance||'Content');
  contentSheet.columns=[{header:locale==='en'?'Platform':'المنصة',key:'platform',width:20},{header:locale==='en'?'Count':'العدد',key:'count',width:12}];
  headerRow(contentSheet);
  for(const [platform,count] of Object.entries(report.content.byPlatform))contentSheet.addRow({platform,count});

  // --- Agent performance ---
  const agentSheet=addSheet(L.agentTeamPerformance||'Agents');
  agentSheet.columns=[
   {header:L.agentTableAgent,key:'name',width:22},{header:L.agentTableRuns,key:'runs',width:10},
   {header:L.agentTableSuccessRate,key:'successRate',width:14},{header:L.agentTableErrors,key:'errors',width:10},
   {header:L.agentTableEscalations,key:'escalations',width:14},{header:L.agentTableAvgResponse,key:'avgResponse',width:16}
  ];
  headerRow(agentSheet);
  for(const agent of report.agents.agents.filter(a=>a.runs>0))
   agentSheet.addRow({name:agent.nameAr,runs:agent.runs,successRate:agent.successRate,errors:agent.failed,escalations:agent.escalations,avgResponse:agent.avgLatencyMs?Math.round(agent.avgLatencyMs/1000):null});

  // --- Risks & approvals ---
  const riskSheet=addSheet(L.risksAndDecisions||'Risks');
  riskSheet.columns=[{header:locale==='en'?'Item':'العنصر',key:'title',width:40},{header:locale==='en'?'Type':'النوع',key:'type',width:18},{header:locale==='en'?'Priority':'الأولوية',key:'priority',width:12}];
  headerRow(riskSheet);
  for(const item of report.approvalsAndRisks.pendingContentReview)riskSheet.addRow({title:item.title,type:locale==='en'?'Content review':'مراجعة محتوى',priority:'P3'});
  for(const item of report.approvalsAndRisks.pendingAgentApprovals)riskSheet.addRow({title:item.reason,type:locale==='en'?'Agent approval':'موافقة وكيل',priority:item.riskLevel==='HIGH'?'P1':item.riskLevel==='MEDIUM'?'P2':'P3'});
  for(const item of report.approvalsAndRisks.openEscalations)riskSheet.addRow({title:item.reason,type:locale==='en'?'Escalation':'تصعيد',priority:item.priority});

  // --- Market signals ---
  const marketSheet=addSheet(L.competitorSignals||'Market');
  marketSheet.columns=[{header:locale==='en'?'Signal':'الإشارة',key:'value',width:50},{header:locale==='en'?'Source':'المصدر',key:'source',width:24}];
  headerRow(marketSheet);
  for(const signal of report.market.signals)marketSheet.addRow({value:signal.value,source:signal.source});

  // --- Next week plan ---
  const planSheet=addSheet(L.nextWeekPlan||'Next week');
  planSheet.columns=[{header:locale==='en'?'Date':'التاريخ',key:'date',width:14},{header:locale==='en'?'Planned':'مخطط',key:'planned',width:10},{header:locale==='en'?'Gaps':'فجوات',key:'gaps',width:30}];
  headerRow(planSheet);
  for(const day of report.nextWeekPlan.days)planSheet.addRow({date:day.date,planned:day.planned,gaps:day.gaps.map(g=>g.platform).join(', ')});
 } else {
  // Legacy report (pre-executive-dashboard) — only the base weekly fields exist.
  const ws=addSheet(L.title||'Weekly Report');
  ws.addRow([locale==='en'?'Week':'الأسبوع',`${report.weekStart} → ${report.weekEnd}`]);
  ws.addRow([locale==='en'?'Content planned':'محتوى مخطط',report.content.total]);
  ws.addRow([locale==='en'?'New leads':'عملاء جدد',report.crm.leadsCreated]);
  ws.columns.forEach(c=>{c.width=28;});
 }
 return wb;
}

// ---------------------------------------------------------------------------------------------
// PDF export
// ---------------------------------------------------------------------------------------------
export async function buildReportPdfBuffer(report,{locale='ar'}={}) {
 const L=loadLabels(locale);
 return new Promise((resolve,reject)=>{
  const doc=new PDFDocument({size:'A4',margin:40,bufferPages:true});
  const chunks=[];
  doc.on('data',c=>chunks.push(c));
  doc.on('end',()=>resolve(Buffer.concat(chunks)));
  doc.on('error',reject);
  doc.registerFont('Arabic',FONT_REGULAR);
  doc.registerFont('Arabic-Bold',FONT_BOLD);

  const marginX=40,contentWidth=doc.page.width-marginX*2;
  let y=marginX;
  const line=(text,{fontSize=11,bold=false,color='#111827',gap=6}={})=>{
   drawBidiLine(doc,text,{x:marginX,y,width:contentWidth,fontSize,bold,color});
   y+=textHeight(doc,fontSize)+gap;
  };
  const ensureSpace=needed=>{if(y+needed>doc.page.height-marginX){doc.addPage();y=marginX;}};
  const sectionHeading=text=>{ensureSpace(40);line(text,{fontSize:16,bold:true,color:'#0f766e',gap:10});doc.moveTo(marginX,y-4).lineTo(doc.page.width-marginX,y-4).strokeColor('#e2e8f0').stroke();y+=6;};

  line(`HyperCool AI — ${L.title||'Weekly Report'}`,{fontSize:22,bold:true,color:'#0f766e',gap:4});
  line(`${report.weekStart} - ${report.weekEnd}`,{fontSize:11,color:'#64748b',gap:16});

  if(!report.kpis) {
   line(L.legacyReportNotice||'Legacy report',{fontSize:12});
   line(`${locale==='en'?'Content planned':'محتوى مخطط'}: ${fmtNum(report.content.total)}`,{fontSize:11});
   line(`${locale==='en'?'New leads':'عملاء جدد'}: ${fmtNum(report.crm.leadsCreated)}`,{fontSize:11});
   doc.end();
   return;
  }

  sectionHeading(L.executiveSummary||'Executive summary');
  if(report.quickSummary.hasEnoughData) {
   for(const w of report.quickSummary.wins)line('• '+w,{fontSize:10.5,gap:4});
   for(const i of report.quickSummary.issues)line('• '+i,{fontSize:10.5,color:'#991b1b',gap:4});
  } else line(L.notEnoughDataForSummary||'Not enough data yet.',{fontSize:10.5,gap:4});
  y+=8;

  sectionHeading(locale==='en'?'Key metrics':'المؤشرات الرئيسية');
  const kpiRows=[
   [L.kpiNewLeads,report.kpis.leadsCreated],[L.kpiWonDeals,report.kpis.wonDeals],
   [L.kpiRevenueEarned,report.kpis.wonRevenue],[L.kpiLostDeals,report.kpis.lostDeals]
  ];
  for(const [label,kpi] of kpiRows) {
   ensureSpace(20);
   const valueText=kpi?.value==null?'—':(label===L.kpiRevenueEarned?fmtSAR(kpi.value,locale):fmtNum(kpi.value));
   line(`${label}: ${valueText}`,{fontSize:11,gap:5});
  }
  y+=8;

  sectionHeading(L.pipelineAnalysis||'Pipeline');
  line(`${L.openPipelineValue}: ${fmtSAR(report.pipeline.pipelineValue,locale)}`,{fontSize:11,gap:5});
  line(`${L.weekRevenue}: ${fmtSAR(report.pipeline.wonRevenue,locale)}`,{fontSize:11,gap:5});
  if(report.pipeline.topOpportunities.length) {
   y+=4;line(L.topOpportunitiesHeading||'Top opportunities',{fontSize:12,bold:true,gap:6});
   for(const opp of report.pipeline.topOpportunities.slice(0,5)) {
    ensureSpace(20);
    line(`${opp.name} — ${fmtSAR(opp.valueSAR,locale)} — ${opp.stage}`,{fontSize:10.5,gap:4});
   }
  }
  y+=8;

  sectionHeading(L.agentTeamPerformance||'Agent performance');
  const activeAgents=report.agents.agents.filter(a=>a.runs>0);
  if(activeAgents.length)for(const agent of activeAgents.slice(0,8)) {
   ensureSpace(20);
   line(`${agent.nameAr} — ${locale==='en'?'runs':'تشغيلات'}: ${fmtNum(agent.runs)} — ${locale==='en'?'success':'نجاح'}: ${fmtPct(agent.successRate)}`,{fontSize:10.5,gap:4});
  } else line(L.noAgentRunsTitle||'No agent runs yet.',{fontSize:10.5,gap:4});
  y+=8;

  sectionHeading(L.risksAndDecisions||'Risks & decisions');
  const risks=[...report.approvalsAndRisks.pendingContentReview.map(i=>i.title),...report.approvalsAndRisks.pendingAgentApprovals.map(a=>a.reason),...report.approvalsAndRisks.openEscalations.map(e=>e.reason)];
  if(risks.length)for(const r of risks.slice(0,10)) {ensureSpace(18);line('• '+r,{fontSize:10.5,gap:4});}
  else line(L.noPendingDecisions||'Nothing pending.',{fontSize:10.5,gap:4});

  doc.end();
 });
}
