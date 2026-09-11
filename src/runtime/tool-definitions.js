// ToolDefinition — Multi-Tenant Phase 4B (Part 3/4). GLOBAL, never per-tenant (a tool's
// shape, risk, and integration dependency don't change per customer). Derived EXCLUSIVELY
// from `TOOL_METADATA` in `src/runtime/tools.js` — the actual, real Tool Registry this
// codebase executes — never hand-typed a second time here. A tool that only exists in a
// prompt file but has no real handler in tools.js is never seeded (Part 4: "لا تنشئ
// ToolDefinition لتول موجود فقط في prompt").
import {listToolMetadata} from './tools.js';

export function installToolDefinitions(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS tool_definitions (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  risk_level TEXT NOT NULL CHECK(risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  action_type TEXT NOT NULL CHECK(action_type IN ('READ','INTERNAL_WRITE','EXTERNAL_SEND','EXTERNAL_PUBLISH','DESTRUCTIVE','SECURITY')),
  integration_slug TEXT,
  requires_connection INTEGER NOT NULL DEFAULT 0,
  is_read_only INTEGER NOT NULL DEFAULT 0,
  is_external_action INTEGER NOT NULL DEFAULT 0,
  capability TEXT,
  requires_approval_below_level TEXT,
  min_level TEXT NOT NULL,
  allowed_agents TEXT,
  input_schema TEXT NOT NULL,
  is_available INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_tool_definitions_category ON tool_definitions(category);`);
 seedToolDefinitions(db);
}
const EXTERNAL_ACTION_TYPES=['EXTERNAL_SEND','EXTERNAL_PUBLISH','DESTRUCTIVE'];
function seedToolDefinitions(db) {
 const now=new Date().toISOString();
 const insert=db.prepare(`INSERT INTO tool_definitions (id,slug,description,category,risk_level,action_type,integration_slug,requires_connection,is_read_only,is_external_action,capability,requires_approval_below_level,min_level,allowed_agents,input_schema,is_available,created_at,updated_at)
  VALUES (@slug,@slug,@description,@category,@riskLevel,@actionType,@integrationSlug,@requiresConnection,@isReadOnly,@isExternalAction,@capability,@requiresApprovalBelowLevel,@minLevel,@allowedAgents,@inputSchema,@isAvailable,@now,@now)
  ON CONFLICT(slug) DO UPDATE SET description=excluded.description,category=excluded.category,risk_level=excluded.risk_level,action_type=excluded.action_type,integration_slug=excluded.integration_slug,requires_connection=excluded.requires_connection,is_read_only=excluded.is_read_only,is_external_action=excluded.is_external_action,capability=excluded.capability,requires_approval_below_level=excluded.requires_approval_below_level,min_level=excluded.min_level,allowed_agents=excluded.allowed_agents,input_schema=excluded.input_schema,is_available=excluded.is_available,updated_at=excluded.updated_at`);
 for(const tool of listToolMetadata()) {
  insert.run({
   slug:tool.name,description:tool.description,category:tool.category,riskLevel:tool.riskLevel,actionType:tool.actionType,
   integrationSlug:tool.integrationSlug||null,requiresConnection:tool.requiresConnection?1:0,isReadOnly:tool.isReadOnly?1:0,
   isExternalAction:EXTERNAL_ACTION_TYPES.includes(tool.actionType)?1:0,capability:tool.capability||null,
   requiresApprovalBelowLevel:tool.requiresApprovalBelowLevel||null,minLevel:tool.minLevel,
   allowedAgents:tool.allowedAgents?JSON.stringify(tool.allowedAgents):null,inputSchema:JSON.stringify(tool.inputSchema),
   isAvailable:tool.isAvailable===false?0:1,now
  });
 }
}
function hydrate(row) {
 return {
  id:row.id,slug:row.slug,description:row.description,category:row.category,riskLevel:row.risk_level,actionType:row.action_type,
  integrationSlug:row.integration_slug,requiresConnection:!!row.requires_connection,isReadOnly:!!row.is_read_only,isExternalAction:!!row.is_external_action,
  capability:row.capability,requiresApprovalBelowLevel:row.requires_approval_below_level,minLevel:row.min_level,
  allowedAgents:row.allowed_agents?JSON.parse(row.allowed_agents):null,inputSchema:JSON.parse(row.input_schema),
  isAvailable:!!row.is_available,createdAt:row.created_at,updatedAt:row.updated_at
 };
}
// A fixture/test store that never called installToolDefinitions() (i.e. every test fixture
// that predates this phase) has no `tool_definitions` table at all — rather than throw, this
// falls back to the exact same static catalog (`listToolMetadata()`, pure in-memory, no DB
// dependency) the table is itself seeded from, so behavior is IDENTICAL whether or not the
// table happens to be installed in a given store. Only `is_available`/overrides an operator
// might persist directly into the DB row would differ — nothing writes those outside seeding
// today, so this fallback is safe both in tests and in a not-yet-migrated production DB.
function metadataFallback() {
 return listToolMetadata().map(tool=>({
  id:tool.name,slug:tool.name,description:tool.description,category:tool.category,riskLevel:tool.riskLevel,actionType:tool.actionType,
  integrationSlug:tool.integrationSlug||null,requiresConnection:!!tool.requiresConnection,isReadOnly:!!tool.isReadOnly,
  isExternalAction:EXTERNAL_ACTION_TYPES.includes(tool.actionType),capability:tool.capability||null,
  requiresApprovalBelowLevel:tool.requiresApprovalBelowLevel||null,minLevel:tool.minLevel,allowedAgents:tool.allowedAgents||null,
  inputSchema:tool.inputSchema,isAvailable:tool.isAvailable!==false,createdAt:null,updatedAt:null
 }));
}
export function listToolDefinitions(db,{category}={}) {
 let rows;
 try{rows=(category?db.prepare('SELECT * FROM tool_definitions WHERE category=? ORDER BY slug').all(category):db.prepare('SELECT * FROM tool_definitions ORDER BY category,slug').all()).map(hydrate);}
 catch{rows=metadataFallback().filter(t=>!category||t.category===category);}
 return rows;
}
export function getToolDefinition(db,slug) {
 let row=null;
 try{row=db.prepare('SELECT * FROM tool_definitions WHERE slug=?').get(slug);}catch{row=null;}
 if(row)return hydrate(row);
 return metadataFallback().find(t=>t.slug===slug)||null;
}
