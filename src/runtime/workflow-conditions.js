// Frost Command Center Phase 7C — the Workflow Engine's declarative Condition Engine (spec
// Part 8-9). Deliberately NOT eval()/new Function()/any JS execution: a condition is always a
// plain {field, op, value} object (or {all:[...]}/{any:[...]} for combining them), field paths
// are resolved by simple dot-path lookup against the run's own accumulated context (trigger
// payload + prior step outputs) — never arbitrary code, so a workflow definition can safely be
// authored by an LLM (Frost) or a human without ever executing untrusted logic.
export const CONDITION_OPERATORS=['equals','not_equals','greater_than','less_than','contains','exists','in'];

function getByPath(obj,path) {
 if(!path)return undefined;
 return path.split('.').reduce((node,key)=>(node==null?undefined:node[key]),obj);
}
function typeAwareCompare(a,b) {
 if(typeof a==='number'||typeof b==='number') {
  const na=Number(a),nb=Number(b);
  if(!Number.isNaN(na)&&!Number.isNaN(nb))return na-nb;
 }
 return String(a).localeCompare(String(b));
}
export function evaluateSingleCondition(condition,context) {
 const {field,op,value}=condition;
 const actual=getByPath(context,field);
 switch(op) {
  case 'equals': return actual===value;
  case 'not_equals': return actual!==value;
  case 'greater_than': return typeof actual!=='undefined' && typeAwareCompare(actual,value)>0;
  case 'less_than': return typeof actual!=='undefined' && typeAwareCompare(actual,value)<0;
  case 'contains': return Array.isArray(actual)?actual.includes(value):typeof actual==='string'&&actual.includes(String(value));
  case 'exists': return actual!==undefined && actual!==null;
  case 'in': return Array.isArray(value)&&value.includes(actual);
  default: throw new Error('UNKNOWN_CONDITION_OPERATOR');
 }
}
/** A condition tree is either one leaf {field,op,value}, or a combinator {all:[...]}/{any:[...]}
 * of further condition trees — recursive but bounded (no loops possible, plain data). */
export function evaluateCondition(condition,context) {
 if(!condition)return true; // no condition configured = always true (an unconditional step)
 if(Array.isArray(condition.all))return condition.all.every(c=>evaluateCondition(c,context));
 if(Array.isArray(condition.any))return condition.any.some(c=>evaluateCondition(c,context));
 return evaluateSingleCondition(condition,context);
}
/** Validates a condition tree's shape BEFORE it is ever evaluated — a malformed operator/field
 * must fail at authoring/publish time, never surface as a silent false at run time. */
export function validateCondition(condition,path='condition') {
 if(condition==null)return [];
 if(Array.isArray(condition.all))return condition.all.flatMap((c,i)=>validateCondition(c,`${path}.all[${i}]`));
 if(Array.isArray(condition.any))return condition.any.flatMap((c,i)=>validateCondition(c,`${path}.any[${i}]`));
 const errors=[];
 if(typeof condition.field!=='string'||!condition.field.trim())errors.push(`${path}.field مطلوب`);
 if(!CONDITION_OPERATORS.includes(condition.op))errors.push(`${path}.op غير معروف: ${condition.op}`);
 if(condition.op==='in' && !Array.isArray(condition.value))errors.push(`${path}.value يجب أن تكون قائمة لعملية in`);
 return errors;
}
