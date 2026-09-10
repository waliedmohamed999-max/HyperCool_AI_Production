import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const text=readFileSync(new URL('../docs/playbook-extracted.txt',import.meta.url),'utf8').replace(/\r/g,'');
const names=['Frost — AI CMO Orchestrator','Content Strategy Agent','Copywriting Agent','Creative Agent','Brand & Compliance Agent','Publishing & Scheduling Agent','Lead Generation Agent','Conversation & Closing Agent','Follow-up Agent','Competitor & Trend Intelligence Agent','Performance & Growth Agent','Memory & Learning Agent'];
const ids=['frost','strategy','copy','creative','compliance','publishing','leads','sales','followup','intelligence','performance','memory'];
const starts=names.map((name,i)=>text.indexOf(`\n${i+1}. ${name}\n`));
if(starts.some(i=>i<0)) throw new Error('Missing source heading');
const folder=new URL('../agents/',import.meta.url);mkdirSync(folder,{recursive:true});
const global=text.slice(text.indexOf('SYSTEM — HYPERCOOL GLOBAL OPERATING RULES'),starts[0]).trim();
const security=text.slice(text.indexOf('SYSTEM SECURITY ADDENDUM'),text.indexOf('\n17. قائمة')).trim();
writeFileSync(new URL('global.md',folder),global+'\n\n'+security+'\n');
for(let i=0;i<ids.length;i++) {
 const section=text.slice(starts[i],starts[i+1]??text.indexOf('\n13. Task Prompt Library')).trim();
 writeFileSync(new URL(ids[i]+'.md',folder),section+'\n');
}
writeFileSync(new URL('tasks.md',folder),text.slice(text.indexOf('\n13. Task Prompt Library'),text.indexOf('\n14. JSON Schemas')).trim()+'\n');
console.log(`Extracted ${ids.length} agents, shared guardrails and task library`);
