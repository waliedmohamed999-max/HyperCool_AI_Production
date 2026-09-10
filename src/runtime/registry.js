import {agents as agentDefs} from '../domain.js';

// AgentRegistry. Prompts stay single-sourced in agents/*.md (read by buildAgentPrompt in
// src/agents.js) and payload schemas stay in src/payload-schemas.js — this table is only
// the thin, DB-backed identity/config row per agent, never a second copy of either.
export function installRegistry(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS agent_registry (id TEXT PRIMARY KEY, name_ar TEXT NOT NULL, role TEXT NOT NULL, description TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, provider TEXT NOT NULL DEFAULT 'anthropic', model TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
 // Additive, guarded columns — safe to run against a database created before per-agent
 // model overrides existed. `provider`/`model` above already let an operator pin a
 // specific provider/model per agent; temperature/max_tokens are the same idea for
 // sampling behavior (e.g. compliance wants deterministic, copywriting wants creative).
 const columns=db.prepare("PRAGMA table_info(agent_registry)").all().map(c=>c.name);
 if(!columns.includes('temperature'))db.exec('ALTER TABLE agent_registry ADD COLUMN temperature REAL');
 if(!columns.includes('max_tokens'))db.exec('ALTER TABLE agent_registry ADD COLUMN max_tokens INTEGER');
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
const SUPPORTED_PROVIDERS=['anthropic','openai'];
// Per-agent override of the account-default provider/model/sampling (A3/A4 in the AI
// provider spec) — e.g. pin compliance to a specific low-temperature model while sales
// keeps the account default. Any field left undefined keeps its current stored value;
// pass null for model/temperature/max_tokens to clear an override back to the account default.
export function setModelConfig(db,id,{provider,model,temperature,maxTokens}={}) {
 const row=getAgent(db,id);
 if(!row)return null;
 if(provider!==undefined && !SUPPORTED_PROVIDERS.includes(provider))throw Object.assign(new Error('Unsupported provider: '+provider),{status:400});
 if(temperature!==undefined && temperature!==null && (typeof temperature!=='number'||temperature<0||temperature>2))throw Object.assign(new Error('temperature must be between 0 and 2'),{status:400});
 if(maxTokens!==undefined && maxTokens!==null && (!Number.isInteger(maxTokens)||maxTokens<1||maxTokens>32000))throw Object.assign(new Error('max_tokens must be a positive integer'),{status:400});
 db.prepare('UPDATE agent_registry SET provider=COALESCE(?,provider),model=CASE WHEN ?=1 THEN ? ELSE model END,temperature=CASE WHEN ?=1 THEN ? ELSE temperature END,max_tokens=CASE WHEN ?=1 THEN ? ELSE max_tokens END,updated_at=? WHERE id=?')
  .run(provider??null,model!==undefined?1:0,model??null,temperature!==undefined?1:0,temperature??null,maxTokens!==undefined?1:0,maxTokens??null,new Date().toISOString(),id);
 return getAgent(db,id);
}
