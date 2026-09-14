import {resolveActiveTenantId} from '../tenancy.js';

// Command Center Phase 7B (spec item 44) — search past Frost conversations/commands.
// Tenant-isolated by construction (every query is scoped to tenant_id, exactly like every
// other command-chat.js query). A plain LIKE search over the existing command_messages/
// command_conversations tables — no new index/engine needed at this data volume.
export function searchCommands(db,tenantId,query,{limit=30}={}) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const cleanQuery=typeof query==='string'?query.trim():'';
 if(!cleanQuery)return [];
 const like=`%${cleanQuery.replace(/[%_]/g,c=>'\\'+c)}%`;
 const rows=db.prepare(`
  SELECT m.id AS message_id,m.conversation_id,m.role,m.content,m.created_at,c.title AS conversation_title
  FROM command_messages m JOIN command_conversations c ON c.id=m.conversation_id
  WHERE m.tenant_id=? AND c.tenant_id=? AND m.content LIKE ? ESCAPE '\\'
  ORDER BY m.created_at DESC LIMIT ?
 `).all(resolvedTenantId,resolvedTenantId,like,limit);
 return rows.map(r=>({messageId:r.message_id,conversationId:r.conversation_id,conversationTitle:r.conversation_title,role:r.role,
  snippet:r.content.length>220?r.content.slice(0,220)+'…':r.content,createdAt:r.created_at}));
}
