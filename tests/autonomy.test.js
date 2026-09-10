import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installAutonomy,currentAutonomy,setAutonomy,listAutonomyLog,levels} from '../src/autonomy.js';

const user={id:'owner-id',name:'Owner',role:'owner'};
function fixture(){const store=openStore(':memory:');installAutonomy(store.db);return store;}

test('every agent defaults to L0 with no history',()=>{
 const store=fixture();
 try{
  const state=currentAutonomy(store.db);
  assert.equal(Object.keys(state).length,12);
  assert.ok(Object.values(state).every(entry=>entry.level==='L0'&&entry.version===0));
  assert.deepEqual(listAutonomyLog(store.db,'copy'),[]);
 }finally{store.close();}
});

test('promotion moves one level at a time and is rejected on stale version or skipped levels',()=>{
 const store=fixture();
 try{
  const first=setAutonomy(store,'copy',{level:'L1',reason:'14 clean days, zero compliance breaches',expectedVersion:0},user);
  assert.equal(first.direction,'PROMOTED');assert.equal(first.version,1);
  assert.equal(currentAutonomy(store.db).copy.level,'L1');
  assert.throws(()=>setAutonomy(store,'copy',{level:'L3',reason:'skip ahead',expectedVersion:1},user),/خطوة واحدة/);
  assert.throws(()=>setAutonomy(store,'copy',{level:'L2',reason:'stale',expectedVersion:0},user),/تغيّر/);
  assert.throws(()=>setAutonomy(store,'copy',{level:'L1',reason:'same level',expectedVersion:1},user),/بالفعل/);
  const second=setAutonomy(store,'copy',{level:'L2',reason:'clean run continues',expectedVersion:1},user);
  assert.equal(second.version,2);
  assert.equal(listAutonomyLog(store.db,'copy').length,2);
 }finally{store.close();}
});

test('demotion can drop more than one level as an immediate safety valve and is logged to audit',()=>{
 const store=fixture();
 try{
  setAutonomy(store,'publishing',{level:'L1',reason:'promote',expectedVersion:0},user);
  const promoted=setAutonomy(store,'publishing',{level:'L2',reason:'promote again',expectedVersion:1},user);
  assert.equal(promoted.version,2);
  const demoted=setAutonomy(store,'publishing',{level:'L0',reason:'compliance breach detected',expectedVersion:2},user);
  assert.equal(demoted.direction,'DEMOTED');assert.equal(demoted.level,'L0');
  assert.equal(currentAutonomy(store.db).publishing.level,'L0');
  const audit=store.read().audit;
  assert.equal(audit[0].action,'AGENT_DEMOTED');
  assert.equal(audit.filter(entry=>entry.action==='AGENT_PROMOTED').length,2);
 }finally{store.close();}
});

test('unknown agent, invalid level and missing reason are rejected',()=>{
 const store=fixture();
 try{
  assert.throws(()=>setAutonomy(store,'unknown-agent',{level:'L1',reason:'test',expectedVersion:0},user),/غير موجود/);
  assert.throws(()=>setAutonomy(store,'copy',{level:'L9',reason:'test',expectedVersion:0},user),/غير صالح/);
  assert.throws(()=>setAutonomy(store,'copy',{level:'L1',reason:'  ',expectedVersion:0},user),/سبب/);
  assert.equal(levels.length,4);
 }finally{store.close();}
});
