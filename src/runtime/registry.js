import {agents as agentDefs} from '../domain.js';

// AgentRegistry. Prompts stay single-sourced in agents/*.md (read by buildAgentPrompt in
// src/agents.js) and payload schemas stay in src/payload-schemas.js — this table is only
// the thin, DB-backed identity/config row per agent, never a second copy of either.
export function installRegistry(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS agent_registry (id TEXT PRIMARY KEY, name_ar TEXT NOT NULL, role TEXT NOT NULL, description TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, provider TEXT NOT NULL DEFAULT 'anthropic', model TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
}
// Idempotent: running it again never duplicates or overwrites an operator's enabled/disabled choice.
export function seedRegistry(db) {
 const now=new Date().toISOString();
 const insert=db.prepare('INSERT OR IGNORE INTO agent_registry (id,name_ar,role,description,enabled,provider,model,created_at,updated_at) VALUES (?,?,?,?,1,?,?,?,?)');
 let created=0;
 for(const agent of agentDefs) {
  const result=insert.run(agent.id,agent.name,agent.name,agent.purpose,'anthropic',null,now,now);
  created+=Number(result.changes);
 }
 return {seeded:agentDefs.length,created};
}
export function listAgents(db) {
 return db.prepare('SELECT * FROM agent_registry ORDER BY rowid').all();
}
export function getAgent(db,id) {
 return db.prepare('SELECT * FROM agent_registry WHERE id=?').get(id);
}
export function setEnabled(db,id,enabled) {
 if(!getAgent(db,id))return null;
 db.prepare('UPDATE agent_registry SET enabled=?,updated_at=? WHERE id=?').run(enabled?1:0,new Date().toISOString(),id);
 return getAgent(db,id);
}
