import test from 'node:test';
import assert from 'node:assert/strict';
import {createContent} from '../src/domain.js';
import {computeContentKPIs,computeContentPipeline,computeComplianceIssues,computeContentLibrary,computeFrostContentInsights,buildContentWorkspace} from '../src/content-ops.js';
import {openStore} from '../src/store.js';
import {installKnowledge} from '../src/knowledge.js';
import {installPlanning,contentHash} from '../src/planning.js';
import {installCompliance,latestComplianceByContent} from '../src/compliance.js';
import {installContent,insertContent} from '../src/content.js';
import {installAuditLog} from '../src/audit.js';

const draft=(overrides={})=>createContent({title:'t',body:'body text',platform:'Instagram',date:'2026-01-01',url:'https://hyper-cool.com/p',...overrides});

test('computeContentKPIs never fabricates a nonzero number with no content',()=>{
 const kpis=computeContentKPIs([],[]);
 assert.equal(kpis.drafts.value,0);
 assert.equal(kpis.scheduled.value,0);
 assert.equal(kpis.published.value,0); // always 0 — no publishing connector exists yet
});
test('computeContentKPIs counts each real status once and never double-counts approved+scheduled',()=>{
 const approvedNotScheduled={...draft(),status:'APPROVED'};
 const approvedScheduled={...draft(),id:'c2',status:'APPROVED'};
 const jobs=[{contentId:approvedScheduled.id,status:'SCHEDULED',scheduledAt:'2026-01-02T00:00:00.000Z'}];
 const kpis=computeContentKPIs([approvedNotScheduled,approvedScheduled],jobs);
 assert.equal(kpis.approved.value,1); // only the unscheduled one
 assert.equal(kpis.scheduled.value,1);
});
test('computeContentKPIs counts REJECTED as blocked, matching the real terminal status',()=>{
 const kpis=computeContentKPIs([{...draft(),status:'REJECTED'}],[]);
 assert.equal(kpis.blocked.value,1);
});

test('computeContentPipeline exposes only real persisted states, no fabricated COPY_READY/CREATIVE_READY stage',()=>{
 const pipeline=computeContentPipeline([draft()],[],[],new Map());
 const stages=pipeline.map(column=>column.stage);
 assert.deepEqual(stages,['DRAFT','REVIEWED','APPROVED','SCHEDULED','PUBLISHED','REJECTED']);
});
test('computeContentPipeline attributes owner from the real audit trail, not a guess',()=>{
 const item=draft();
 const audit=[{action:'DRAFT_CREATED',itemId:item.id,actorName:'Sara'}];
 const pipeline=computeContentPipeline([item],[],audit,new Map());
 assert.equal(pipeline[0].cards[0].owner,'Sara');
});

test('computeComplianceIssues only surfaces issues from COMPLETED runs, categorized from real field text',()=>{
 const item=draft();
 const complianceByContent=new Map([[item.id,{status:'COMPLETED',finishedAt:'2026-01-01T00:00:00.000Z',decision:{payload:{classification:'PASS_WITH_EDITS',issues:[{severity:'HIGH',field:'Price mention',problem:'states a price not in product_facts'}]}}}]]);
 const issues=computeComplianceIssues(complianceByContent,[item]);
 assert.equal(issues.rows.length,1);
 assert.equal(issues.rows[0].category,'PRICE');
 assert.equal(issues.bySeverity.HIGH,1);
});
test('computeComplianceIssues ignores RUNNING/ERROR runs — never shows issues from an incomplete check',()=>{
 const item=draft();
 const complianceByContent=new Map([[item.id,{status:'ERROR',errorCode:'CHECK_FAILED'}]]);
 const issues=computeComplianceIssues(complianceByContent,[item]);
 assert.equal(issues.rows.length,0);
 assert.equal(issues.hasData,false);
});

test('computeContentLibrary never invents a publishedAt — always null with no publishing connector',()=>{
 const rows=computeContentLibrary([{...draft(),status:'APPROVED'}],[],[]);
 assert.equal(rows[0].publishedAt,null);
});

test('computeFrostContentInsights stays silent with no content, never fabricates a bullet',()=>{
 const insights=computeFrostContentInsights([],[],{rows:[],bySeverity:{}});
 assert.equal(insights.hasData,false);
 assert.equal(insights.bullets.length,0);
});
test('computeFrostContentInsights flags real unresolved high-severity compliance issues',()=>{
 const item={...draft(),status:'DRAFT'};
 const issues={rows:[{severity:'HIGH',status:'DRAFT'}],bySeverity:{HIGH:1}};
 const insights=computeFrostContentInsights([item],[],issues);
 assert.ok(insights.bullets.some(b=>b.text.includes('1 ملاحظة امتثال عالية الخطورة')));
});

test('buildContentWorkspace assembles the full workspace end to end from real DB state',()=>{
 const store=openStore(':memory:');
 installKnowledge(store.db);installPlanning(store.db);installCompliance(store.db);installContent(store.db);installAuditLog(store.db);
 const owner={id:'owner-1',name:'Owner',role:'owner'};
 const item=draft();insertContent(store.db,item);
 const workspace=buildContentWorkspace(store,{complianceByContent:latestComplianceByContent(store.db)});
 assert.equal(workspace.kpis.drafts.value,1);
 assert.equal(workspace.library.length,1);
 assert.equal(workspace.library[0].id,item.id);
 assert.equal(workspace.complianceIssues.hasData,false);
});
