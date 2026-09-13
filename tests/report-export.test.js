import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installPlanning} from '../src/planning.js';
import {installCompliance} from '../src/compliance.js';
import {installAutonomy} from '../src/autonomy.js';
import {installCRM,createLead} from '../src/crm.js';
import {installReporting,buildExecutiveReport,currentWeekStart} from '../src/reporting.js';
import {installContent} from '../src/content.js';
import {installAuditLog} from '../src/audit.js';
import {installKnowledge} from '../src/knowledge.js';
import {buildReportWorkbook,buildReportPdfBuffer,loadLabels} from '../src/reportExport.js';

const user={id:'owner-id',name:'Owner',role:'owner'};
function fixture(){
 const store=openStore(':memory:');
 installPlanning(store.db);installCompliance(store.db);installAutonomy(store.db);installCRM(store.db);installReporting(store.db);installContent(store.db);installAuditLog(store.db);installKnowledge(store.db);
 return store;
}
function realReport(store){
 createLead(store,{name:'عميل تجريبي',customerType:'B2C',sourceType:'INBOUND',phone:'+966501234567'},user);
 return buildExecutiveReport(store,currentWeekStart(),{agents:[],agentRuns:[],escalations:[],approvals:[],env:{}});
}

test('loadLabels reads the same ar/en weeklyReport translation files the UI uses',()=>{
 const ar=loadLabels('ar'),en=loadLabels('en');
 assert.equal(typeof ar.executiveSummary,'string');
 assert.equal(typeof en.executiveSummary,'string');
 assert.notEqual(ar.executiveSummary,en.executiveSummary);
});

test('buildReportWorkbook produces a real multi-sheet workbook whose cells match the real report data',async()=>{
 const store=fixture();
 try{
  const report=realReport(store);
  const wb=await buildReportWorkbook(report,{locale:'ar'});
  const sheetNames=wb.worksheets.map(w=>w.name);
  assert.ok(sheetNames.length>=6,'expected multiple real sheets, got: '+sheetNames.join(', '));
  const kpiSheet=wb.worksheets[0];
  assert.equal(kpiSheet.views[0].rightToLeft,true);
  const leadsRow=kpiSheet.getRows(2,kpiSheet.rowCount).find(r=>r.getCell(2).value===report.kpis.leadsCreated.value+'' || r.getCell(2).value===report.kpis.leadsCreated.value);
  assert.ok(leadsRow,'expected a KPI row whose value matches the real report leadsCreated count');

  const enWb=await buildReportWorkbook(report,{locale:'en'});
  assert.equal(enWb.worksheets[0].views[0].rightToLeft,false);
 }finally{store.close();}
});

test('buildReportWorkbook handles a legacy (pre-executive) report without kpis',async()=>{
 const store=fixture();
 try{
  const {buildWeeklyReport}=await import('../src/reporting.js');
  const legacy=buildWeeklyReport(store,currentWeekStart());
  assert.equal(legacy.kpis,undefined);
  const wb=await buildReportWorkbook(legacy,{locale:'ar'});
  assert.equal(wb.worksheets.length,1);
 }finally{store.close();}
});

test('buildReportPdfBuffer produces a real, non-trivial PDF with correct magic bytes',async()=>{
 const store=fixture();
 try{
  const report=realReport(store);
  const buffer=await buildReportPdfBuffer(report,{locale:'ar'});
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.slice(0,5).toString(),'%PDF-');
  assert.ok(buffer.length>2000,'expected a real multi-section PDF, got '+buffer.length+' bytes');
  assert.equal(buffer.slice(-6).toString().trim().endsWith('%%EOF'),true);

  const enBuffer=await buildReportPdfBuffer(report,{locale:'en'});
  assert.equal(enBuffer.slice(0,5).toString(),'%PDF-');
 }finally{store.close();}
});

test('buildReportPdfBuffer never throws on the exact glyph combinations that reproduced pdfkit\'s font-subsetting crash during development (see src/reportExport.js doc comment)',async()=>{
 const store=fixture();
 try{
  // "تقرير" (report) — two or more non-trivial joined Arabic glyphs in one document, the
  // exact condition that crashed pdfkit when the Arabic font was embedded from its original
  // WOFF2 form instead of the bundled pre-decompressed TTF.
  const report=realReport(store);
  report.quickSummary.wins=['تقرير الأسبوع يظهر نموًا في تقرير العملاء وتقرير المبيعات'];
  await assert.doesNotReject(buildReportPdfBuffer(report,{locale:'ar'}));
 }finally{store.close();}
});
