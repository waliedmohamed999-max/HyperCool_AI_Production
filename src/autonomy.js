import {randomUUID} from 'node:crypto';
import {fail} from './auth.js';
import {agents} from './domain.js';

export const levels=['L0','L1','L2','L3'];
const agentIds=agents.map(agent=>agent.id);

export function installAutonomy(db) {
 // Append-only, like memory: current level is the highest version per agent. Never overwritten in place, so the promotion history survives.
 db.exec(`CREATE TABLE IF NOT EXISTS agent_autonomy (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, level TEXT NOT NULL, version INTEGER NOT NULL, direction TEXT NOT NULL, reason TEXT NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(agent_id,version));`);
}
export function listAutonomyLog(db,agentId) {
 if(!agentIds.includes(agentId))fail(404,'وكيل غير موجود');
 return db.prepare('SELECT id,level,version,direction,reason,actor_name AS actorName,at FROM agent_autonomy WHERE agent_id=? ORDER BY version DESC').all(agentId);
}
export function listAutonomyChanges(db,sinceIso) {
 return db.prepare('SELECT agent_id AS agentId,level,direction,reason,actor_name AS actorName,at FROM agent_autonomy WHERE at>=? ORDER BY at DESC').all(sinceIso);
}
export function currentAutonomy(db) {
 const rows=db.prepare(`SELECT agent_id AS agentId,level,version,reason,actor_name AS actorName,at FROM agent_autonomy a WHERE version=(SELECT MAX(version) FROM agent_autonomy b WHERE b.agent_id=a.agent_id)`).all();
 const map=new Map(rows.map(row=>[row.agentId,row]));
 return Object.fromEntries(agentIds.map(id=>[id,map.get(id)||{agentId:id,level:'L0',version:0,reason:null,actorName:null,at:null}]));
}
export function setAutonomy(store,agentId,input,user) {
 if(!agentIds.includes(agentId))fail(404,'وكيل غير موجود');
 if(!levels.includes(input.level))fail(400,'مستوى صلاحية غير صالح');
 const reason=typeof input.reason==='string'?input.reason.trim():'';
 if(!reason||reason.length>1000)fail(400,'سبب تغيير الصلاحية مطلوب (حتى 1000 حرف)');
 return store.mutate(state=>{
  const last=store.db.prepare('SELECT level,version FROM agent_autonomy WHERE agent_id=? ORDER BY version DESC LIMIT 1').get(agentId);
  const current=last?.level||'L0',currentVersion=last?.version||0;
  if(input.expectedVersion!==currentVersion)fail(409,'تغيّر مستوى صلاحية الوكيل؛ حدّث الصفحة قبل الحفظ');
  const currentIndex=levels.indexOf(current),nextIndex=levels.indexOf(input.level);
  if(nextIndex===currentIndex)fail(409,'الوكيل على هذا المستوى بالفعل');
  // Promotion is capped at one step, matching the scope's autonomy ladder. Demotion can drop further in one action — an immediate safety valve needs no ladder.
  if(nextIndex>currentIndex+1)fail(409,'الترقية خطوة واحدة في كل مرة؛ لا يمكن تخطي مستويات');
  const direction=nextIndex>currentIndex?'PROMOTED':'DEMOTED';
  const entry={id:randomUUID(),agentId,level:input.level,version:currentVersion+1,direction,reason,actorId:user.id,actorName:user.name,at:new Date().toISOString(),previousLevel:current};
  store.db.prepare('INSERT INTO agent_autonomy VALUES (?,?,?,?,?,?,?,?,?)').run(entry.id,agentId,entry.level,entry.version,direction,reason,user.id,user.name,entry.at);
  state.audit.unshift({id:randomUUID(),action:direction==='PROMOTED'?'AGENT_PROMOTED':'AGENT_DEMOTED',itemId:agentId,actorId:user.id,actorName:user.name,actorRole:user.role,at:entry.at,detail:`${current} → ${input.level}`});
  return entry;
 });
}
