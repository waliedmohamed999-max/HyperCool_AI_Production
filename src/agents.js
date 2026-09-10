import {readFileSync} from 'node:fs';
import Ajv from 'ajv';
import {agents} from './domain.js';
import {payloadSchemas} from './payload-schemas.js';
const schema=JSON.parse(readFileSync(new URL('../schemas/decision.json',import.meta.url),'utf8'));
const validate=new Ajv({allErrors:true}).compile(schema);
export const globalPrompt=readFileSync(new URL('../agents/global.md',import.meta.url),'utf8');
export const agentDefinitions=agents.map(agent=>({...agent,source:'Playbook v2',prompt:readFileSync(new URL(`../agents/${agent.id}.md`,import.meta.url),'utf8'),outputSchema:{...schema,properties:{...schema.properties,payload:{anyOf:[{type:'null'},payloadSchemas[agent.id]]}}},allowedTools:[],autonomy:'L0'}));
const payloadValidators=Object.fromEntries(Object.entries(payloadSchemas).map(([id,schema])=>[id,new Ajv({allErrors:true}).compile(schema)]));
export function validateDecision(value) {
 if(!validate(value)) throw new Error('Invalid agent decision: '+JSON.stringify(validate.errors));
 if(value.status==='NEEDS_DATA' && !value.missing_data.length) throw new Error('Missing data must be specified');
 if(value.status==='HUMAN_REVIEW' && !value.escalation_required) throw new Error('Human review requires escalation');
 if(value.risk_level==='HIGH' && !value.escalation_required) throw new Error('High risk requires escalation');
 return value;
}
export function validateAgentDecision(id,value) {
 if(!payloadValidators[id]) throw new Error('Unknown agent');
 validateDecision(value);
 if(value.status==='OK' && value.payload===null) throw new Error('Successful decision requires payload');
 if(value.payload!==null && !payloadValidators[id](value.payload)) throw new Error('Invalid agent payload: '+JSON.stringify(payloadValidators[id].errors));
 if(id==='compliance' && value.payload?.classification==='BLOCK' && value.status!=='BLOCKED') throw new Error('Blocked compliance cannot pass');
 return value;
}
export function buildAgentPrompt(id) {
 const agent=agentDefinitions.find(agent=>agent.id===id);
 if(!agent) throw new Error('Unknown agent');
 return `${globalPrompt}\n\n${agent.prompt}\n\nRUNTIME CONTRACT ADAPTER\nReturn a decision envelope matching this JSON schema. Agent-specific fields belong inside payload. For missing data, blocked or failed tasks payload may be null. ASSET_REQUIRED, FACT_REQUIRED and INSUFFICIENT_DATA map to NEEDS_DATA with missing_data. No tools or external actions are enabled.\n${JSON.stringify(agent.outputSchema)}`;
}
