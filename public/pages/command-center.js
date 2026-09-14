// Frost Command Center (Phase 7A). Reuses the existing design system entirely (no new
// component library): drawer/promptDrawer/confirmAction/tabs/badge/metric/empty/table from
// components/ui/index.js, the same api()/toast conventions every other page already uses.
// Every number here comes from a real backend read (src/runtime/command-health.js,
// src/runtime/suggestions.js, src/runtime/context-items.js, /api/command/operations/inbox) —
// an empty/not-configured state renders as a real empty state, never a placeholder number.
import {escape,button,badge,empty,metric,drawer,promptDrawer,confirmAction,table,tabs,enhance,icon} from '../components/ui/index.js';
import {navigate} from '../components/layout/app-shell.js';
import {t,getLocale} from '../i18n.js';
import {fmtDateTime} from '../format.js';

const $=s=>document.querySelector('#command-center '+s);
let apiClient,pollTimer=null,currentConversationId=null,renderGeneration=0;
async function api(path,body,method){return apiClient(path,body,method);}
function staleGuard(generation){return generation!==renderGeneration;}

const CONTEXT_TYPES=[
 'company_goal','business_rule','client_note','campaign_note','operational_issue','decision',
 'policy','product_information','brand_information','sales_context',
 'brain_identity','brain_goals','brain_customers','brain_products','brain_brand','brain_rules'
];
const OPERATION_ICON={agent_run:'agent',audit:'clock'};
const INBOX_ICON={crm_lead:'users',crm_followup:'clock',content:'file',escalation:'bell',connection:'plug',webhook:'plug'};

const QUICK_COMMANDS=['companyHealth','crmFollowups','integrationsHealth'];
export function installCommandCenter() {
 const root=document.querySelector('[data-page="command-center"] #command-center');
 root.innerHTML=`
  <div id="cmdc-health" class="kpi-grid"></div>
  <div class="cmdc-layout">
   <section class="cmdc-chat panel">
    <div class="cmdc-chat-head">
     <select id="cmdc-conversation-select" aria-label="${escape(t('commandCenter.conversationSelectLabel'))}"></select>
     <button type="button" id="cmdc-new-conversation" class="secondary">${escape(t('commandCenter.newConversation'))}</button>
     <button type="button" id="cmdc-run-executive-review" class="secondary">${escape(t('commandCenter.runExecutiveReview'))}</button>
    </div>
    <div class="cmdc-search"><input id="cmdc-search-input" type="search" placeholder="${escape(t('commandCenter.searchPlaceholder'))}"><div id="cmdc-search-results"></div></div>
    <div id="cmdc-quick-commands" class="cmdc-templates"></div>
    <div id="cmdc-messages" class="cmdc-messages"></div>
    <div id="cmdc-ai-notice" class="notice" hidden></div>
    <form id="cmdc-chat-form">
     <textarea name="text" required maxlength="4000" placeholder="${escape(t('commandCenter.chatPlaceholder'))}"></textarea>
     <div class="cmdc-attach-row">
      <input type="file" id="cmdc-attach-input" accept=".pdf,.csv,.xlsx,.docx,.txt,.png,.jpg,.jpeg">
      <span id="cmdc-attach-status"></span>
     </div>
     <button type="submit">${escape(t('commandCenter.send'))}</button>
    </form>
    <div id="cmdc-templates" class="cmdc-templates"></div>
   </section>
   <aside class="cmdc-side">
    <section class="report-section"><div class="report-section-head"><h3>${escape(t('commandCenter.suggestions'))}</h3></div><div id="cmdc-suggestions"></div></section>
    <section class="report-section"><div class="report-section-head"><h3>${escape(t('commandCenter.liveOperations'))}</h3></div><div id="cmdc-operations"></div></section>
   </aside>
  </div>
  <div class="cmdc-layout">
   <section class="report-section" id="cmdc-data-context"><div class="report-section-head"><h3>${escape(t('commandCenter.dataContext'))}</h3></div></section>
   <section class="report-section"><div class="report-section-head"><h3>${escape(t('commandCenter.systemMap'))}</h3><span>${escape(t('commandCenter.systemMapSubtitle'))}</span></div><div id="cmdc-system-map"></div></section>
  </div>`;
 const panels=['inbox','addContext','companyBrain','runbooks','configHistory','attachments'].map(key=>{const el=document.createElement('div');el.id='cmdc-dc-'+key;return el;});
 $('#cmdc-data-context').append(...panels);
 tabs($('#cmdc-data-context'),[
  [t('commandCenter.tabInbox'),panels[0]],
  [t('commandCenter.tabAddContext'),panels[1]],
  [t('commandCenter.tabCompanyBrain'),panels[2]],
  [t('commandCenter.tabRunbooks'),panels[3]],
  [t('commandCenter.tabConfigHistory'),panels[4]],
  [t('commandCenter.tabAttachments'),panels[5]]
 ]);
 panels[1].innerHTML=addContextFormHtml();
 panels[3].innerHTML=`<div id="cmdc-runbooks-list"></div><form id="cmdc-runbook-form"><input name="name" required maxlength="200" placeholder="${escape(t('commandCenter.runbookNamePlaceholder'))}"><input name="commandText" required maxlength="2000" placeholder="${escape(t('commandCenter.runbookCommandPlaceholder'))}"><button type="submit">${escape(t('commandCenter.runbookSave'))}</button></form>`;
 panels[4].innerHTML=`<div id="cmdc-config-history-list"></div>`;
 panels[5].innerHTML=`<div id="cmdc-attachments-list"></div>`;
 $('#cmdc-new-conversation').onclick=onNewConversation;
 $('#cmdc-run-executive-review').onclick=onRunExecutiveReview;
 $('#cmdc-conversation-select').onchange=e=>openConversation(e.target.value);
 $('#cmdc-chat-form').addEventListener('submit',onSendMessage);
 $('#cmdc-data-context').addEventListener('submit',onAddContext);
 $('#cmdc-data-context').addEventListener('submit',onCreateRunbook);
 $('#cmdc-search-input').addEventListener('input',debounce(onSearchInput,300));
 renderQuickCommands();
}
function debounce(fn,ms){let timer=null;return(...args)=>{clearTimeout(timer);timer=setTimeout(()=>fn(...args),ms);};}
function renderQuickCommands() {
 $('#cmdc-quick-commands').innerHTML=QUICK_COMMANDS.map(key=>`<button type="button" class="cmdc-chip" data-quick="${key}">${escape(t('commandCenter.quickCommand.'+key))}</button>`).join('');
 $('#cmdc-quick-commands').querySelectorAll('[data-quick]').forEach(chip=>{
  chip.onclick=()=>{prefillChat(t('commandCenter.quickCommand.'+chip.dataset.quick));$('#cmdc-chat-form').requestSubmit();};
 });
}
async function onSearchInput(event) {
 const query=event.target.value.trim();
 const host=$('#cmdc-search-results');
 if(!query){host.innerHTML='';host.hidden=true;return;}
 const results=await api('/api/command/search?q='+encodeURIComponent(query));
 host.hidden=false;
 host.innerHTML=results.length?results.map(r=>`<button type="button" class="cmdc-search-hit" data-conversation-id="${escape(r.conversationId)}">${escape(r.conversationTitle)} — ${escape(r.snippet)}</button>`).join(''):empty(t('commandCenter.noSearchResults'));
 host.querySelectorAll('[data-conversation-id]').forEach(hitButton=>{
  hitButton.onclick=async()=>{$('#cmdc-conversation-select').value=hitButton.dataset.conversationId;await openConversation(hitButton.dataset.conversationId);host.innerHTML='';host.hidden=true;$('#cmdc-search-input').value='';};
 });
}
async function onRunExecutiveReview() {
 const runbooks=await api('/api/command/runbooks');
 const executive=runbooks.find(r=>r.key==='executive_daily_review');
 if(!executive)return;
 await runRunbook(executive.id);
}

function addContextFormHtml() {
 const typeOption=type=>`<option value="${type}">${escape(t('commandCenter.contextType.'+type))}</option>`;
 return `<form id="cmdc-context-form">
  <div class="row">
   <label>${escape(t('commandCenter.fieldTitle'))}<input name="title" required maxlength="200"></label>
   <label>${escape(t('commandCenter.fieldType'))}<select name="type" required>${CONTEXT_TYPES.map(typeOption).join('')}</select></label>
   <label>${escape(t('commandCenter.fieldPriority'))}<select name="priority"><option value="">—</option><option value="LOW">${escape(t('commandCenter.priorityLow'))}</option><option value="MEDIUM">${escape(t('commandCenter.priorityMedium'))}</option><option value="HIGH">${escape(t('commandCenter.priorityHigh'))}</option></select></label>
  </div>
  <label>${escape(t('commandCenter.fieldDescription'))}<textarea name="description" maxlength="5000"></textarea></label>
  <div class="row">
   <label>${escape(t('commandCenter.fieldCategory'))}<input name="category" maxlength="100"></label>
   <label>${escape(t('commandCenter.fieldTags'))}<input name="tags" placeholder="${escape(t('commandCenter.fieldTagsPlaceholder'))}"></label>
  </div>
  <button type="submit">${escape(t('commandCenter.addContextSubmit'))}</button>
 </form>
 <div id="cmdc-context-just-added"></div>`;
}

// ------------------------------------------------------------------------------------------
// Chat
// ------------------------------------------------------------------------------------------
// Phase 7B — Multi-Agent UI (spec Part 9): a delegate_to_agent step renders with its real
// target-agent name and real child-run status (delegatedStatus, from the tool's own structured
// result — command-chat.js's stepsFromToolCalls) — never a generic "tool called" line, and
// never an animated/fake state.
function stepChipHtml(step) {
 const statusLabel=step.delegatedStatus||step.status;
 return `<span class="cmdc-step${step.delegatedAgent?' cmdc-step-delegated':''}" data-status="${escape(statusLabel)}">${escape(step.label)}${step.delegatedAgent?` — ${escape(statusLabel)}`:''}</span>`;
}
function messageBubbleHtml(message) {
 const steps=message.meta?.steps||[];
 const stepsHtml=steps.length?`<div class="cmdc-steps">${steps.map(stepChipHtml).join('')}</div>`:'';
 const sourcesHtml=message.meta?.dataSources?.length?`<p class="cmdc-sources"><small>${escape(t('commandCenter.dataSources'))} ${escape(message.meta.dataSources.join('، '))}</small></p>`:'';
 // NOTE: deliberately NOT named data-approval-decide — that exact attribute name is already a
 // GLOBAL click convention in app.js (id = the approval, wired to public/autonomy.js's
 // clickApprovalCenter with its own, different dataset shape); reusing it here would make
 // app.js's unrelated global handler also fire for this button with the wrong argument shape.
 const approvalHtml=message.meta?.pendingApprovalId?`<div class="cmdc-approval-pending" data-approval-id="${escape(message.meta.pendingApprovalId)}"><p>${escape(t('commandCenter.approvalRequired'))}</p><button type="button" data-cmdc-decide="APPROVED" class="small">${escape(t('commandCenter.approve'))}</button><button type="button" data-cmdc-decide="REJECTED" class="small secondary">${escape(t('commandCenter.reject'))}</button></div>`:'';
 return `<div class="cmdc-message cmdc-message-${escape(message.role)}"><p>${escape(message.content)}</p>${stepsHtml}${sourcesHtml}${approvalHtml}</div>`;
}
async function loadConversations() {
 const conversations=await api('/api/command/conversations');
 const select=$('#cmdc-conversation-select');
 if(!conversations.length) {
  const created=await api('/api/command/conversations',{});
  conversations.push(created);
 }
 select.innerHTML=conversations.map(c=>`<option value="${c.id}">${escape(c.title)}</option>`).join('');
 currentConversationId=conversations[0].id;
 select.value=currentConversationId;
 await renderMessages();
}
async function renderMessages() {
 if(!currentConversationId)return;
 const messages=await api(`/api/command/conversations/${currentConversationId}/messages`);
 const host=$('#cmdc-messages');
 host.innerHTML=messages.length?messages.map(messageBubbleHtml).join(''):empty(t('commandCenter.noMessagesTitle'),t('commandCenter.noMessagesHint'));
 host.scrollTop=host.scrollHeight;
 enhance(host);
}
async function openConversation(id) {
 currentConversationId=id;
 await renderMessages();
}
async function onNewConversation() {
 const created=await api('/api/command/conversations',{});
 const select=$('#cmdc-conversation-select');
 const option=document.createElement('option');option.value=created.id;option.textContent=created.title;
 select.prepend(option);select.value=created.id;
 await openConversation(created.id);
}
export function prefillChat(text) {
 const textarea=$('#cmdc-chat-form textarea');
 if(textarea){textarea.value=text;textarea.focus();}
}
const MIME_BY_EXTENSION={pdf:'application/pdf',csv:'text/csv',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',txt:'text/plain',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg'};
function readFileAsBase64(file) {
 return new Promise((resolve,reject)=>{
  const reader=new FileReader();
  reader.onload=()=>resolve(String(reader.result).split(',')[1]||'');
  reader.onerror=()=>reject(reader.error);
  reader.readAsDataURL(file);
 });
}
async function onSendMessage(event) {
 // app.js's single global `document.addEventListener('submit',...)` unconditionally treats
 // every unrecognized form as a generic /api/content/:id/:action submit — real for every
 // existing content-review form, wrong for this one (conversation-scoped, not id/action-
 // shaped). stopPropagation keeps this form's real per-message flow intact without adding a
 // 6th special case with a different response shape to that shared dispatcher.
 event.preventDefault();
 event.stopPropagation();
 const form=event.target,textarea=form.querySelector('textarea'),button=form.querySelector('button'),fileInput=form.querySelector('#cmdc-attach-input');
 const text=textarea.value.trim();
 if(!text)return;
 button.disabled=true;
 try {
  if(!currentConversationId)await loadConversations();
  let attachmentId=null;
  if(fileInput?.files?.[0]) {
   const file=fileInput.files[0];
   const extension=file.name.split('.').pop().toLowerCase();
   const mimeType=file.type||MIME_BY_EXTENSION[extension]||'application/octet-stream';
   const contentBase64=await readFileAsBase64(file);
   const uploaded=await api('/api/command/attachments',{filename:file.name,mimeType,contentBase64,conversationId:currentConversationId});
   attachmentId=uploaded.id;
   fileInput.value='';
   $('#cmdc-attach-status').textContent='';
   renderAttachmentsList();
  }
  const host=$('#cmdc-messages');
  if(host.querySelector('.empty'))host.innerHTML='';
  host.insertAdjacentHTML('beforeend',messageBubbleHtml({role:'user',content:text}));
  textarea.value='';
  const result=await api(`/api/command/conversations/${currentConversationId}/messages`,{text,...(attachmentId?{attachmentId}:{})});
  host.insertAdjacentHTML('beforeend',messageBubbleHtml(result.assistantMessage));
  host.scrollTop=host.scrollHeight;
  enhance(host);
  pulsePolling();
  await Promise.all([renderSuggestions(),renderOperations()]);
 } finally {button.disabled=false;textarea.focus();}
}
document.addEventListener('click',async event=>{
 const decideButton=event.target.closest('#command-center [data-cmdc-decide]');
 if(!decideButton)return;
 const card=decideButton.closest('[data-approval-id]');
 const decision=decideButton.dataset.cmdcDecide;
 const confirmed=await confirmAction(decision==='APPROVED'?t('commandCenter.confirmApproveTitle'):t('commandCenter.confirmRejectTitle'),t('commandCenter.confirmApprovalBody'));
 if(!confirmed)return;
 await api(`/api/approvals/${card.dataset.approvalId}/decide`,{decision});
 card.outerHTML=`<p class="cmdc-approval-decided">${escape(decision==='APPROVED'?t('commandCenter.approvedNotice'):t('commandCenter.rejectedNotice'))}</p>`;
 // An approved configuration-change tool call (update_agent_tool_connection) writes a real
 // Configuration History row at decide-time (tools.js) — refresh that tab too, not just Live
 // Operations, so Undo is immediately available without a full page reload.
 await Promise.all([renderOperations(),renderConfigHistoryList()]);
});

// ------------------------------------------------------------------------------------------
// Suggestions
// ------------------------------------------------------------------------------------------
const PRIORITY_STATUS={HIGH:'ERROR',MEDIUM:'PENDING',LOW:'CONNECTED'};
async function renderSuggestions() {
 const suggestions=await api('/api/command/suggestions');
 const host=$('#cmdc-suggestions');
 host.innerHTML=suggestions.length?suggestions.map(s=>`
  <article class="card cmdc-suggestion" data-suggestion-id="${s.id}">
   <div class="row-between"><strong>${escape(s.title)}</strong>${badge(s.priority,PRIORITY_STATUS[s.priority])}</div>
   <p>${escape(s.reason)}</p>
   <div class="row">
    <button type="button" class="small ghost" data-suggestion-action="evidence">${escape(t('commandCenter.why'))}</button>
    <button type="button" class="small ghost" data-suggestion-action="ask">${escape(t('commandCenter.askFrost'))}</button>
    <button type="button" class="small" data-suggestion-action="task">${escape(t('commandCenter.createTask'))}</button>
    <button type="button" class="small secondary" data-suggestion-action="dismiss">${escape(t('commandCenter.dismiss'))}</button>
   </div>
  </article>`).join(''):empty(t('commandCenter.noSuggestionsTitle'),t('commandCenter.noSuggestionsHint'));
}
document.addEventListener('click',async event=>{
 const actionButton=event.target.closest('#command-center [data-suggestion-action]');
 if(!actionButton)return;
 const card=actionButton.closest('[data-suggestion-id]');
 const id=card.dataset.suggestionId,action=actionButton.dataset.suggestionAction;
 if(action==='evidence') {
  const suggestions=await api('/api/command/suggestions');
  const suggestion=suggestions.find(s=>s.id===id);
  const node=document.createElement('div');
  node.innerHTML=`<p>${escape(suggestion.reason)}</p><p><strong>${escape(t('commandCenter.impact'))}</strong> ${escape(suggestion.impact||'—')}</p><pre>${escape(JSON.stringify(suggestion.evidence,null,2))}</pre>`;
  drawer(t('commandCenter.evidenceTitle'),node,{restore:true});
  return;
 }
 if(action==='ask') {navigate('command-center');prefillChat(card.querySelector('strong').textContent);return;}
 if(action==='task') {await api(`/api/command/suggestions/${id}/create-task`,{});await renderSuggestions();return;}
 if(action==='dismiss') {await api(`/api/command/suggestions/${id}/dismiss`,{});await renderSuggestions();}
});

// ------------------------------------------------------------------------------------------
// Live Operations (safe polling — no SSE/WebSocket exists anywhere in this app; paused when
// the tab/page is hidden, matching spec item 73's "safe polling is acceptable initially")
// ------------------------------------------------------------------------------------------
async function renderOperations() {
 const {items}=await api('/api/command/operations');
 const host=$('#cmdc-operations');
 host.innerHTML=items.length?`<div class="cmdc-ops-list">${items.map(op=>`<button type="button" class="cmdc-op-row" data-op-kind="${escape(op.kind)}" data-op-id="${escape(op.id)}">${icon(OPERATION_ICON[op.kind]||'clock')}<span class="cmdc-op-label">${escape(op.action||op.triggerType||op.agentId||'')}</span><time>${escape(fmtDateTime(op.at))}</time></button>`).join('')}</div>`:empty(t('commandCenter.noOperationsTitle'));
}
document.addEventListener('click',async event=>{
 const row=event.target.closest('#command-center .cmdc-op-row');
 if(!row||row.dataset.opKind!=='agent_run')return;
 const run=await api(`/api/agents/runs/${row.dataset.opId}`);
 const node=document.createElement('div');
 node.innerHTML=`<p>${escape(t('commandCenter.opStatusLabel'))} ${escape(run.status)}</p>
  <div class="cmdc-ops-list">${(run.toolCalls||[]).map(tc=>`<div class="cmdc-op-row"><span>${escape(tc.tool)}</span>${badge(tc.status,tc.status==='OK'?'CONNECTED':tc.status==='WAITING_APPROVAL'?'PENDING':'ERROR')}</div>`).join('')||empty(t('commandCenter.noStepsTitle'))}</div>`;
 drawer(t('commandCenter.operationDetailTitle'),node,{restore:true});
});
// Smart polling (spec Part 30): fast (3s) for a short burst right after the user sends a
// command — this is exactly the window a delegated multi-agent run's child steps are actually
// still RUNNING in — then falls back to a slower, idle-appropriate 15s so a quiet tab doesn't
// keep hammering the DB. No new transport — still the same GET /api/command/operations poll.
function startPolling(intervalMs=15000) {
 stopPolling();
 pollTimer=setInterval(()=>{if(document.visibilityState==='visible' && location.hash==='#command-center')renderOperations().catch(()=>{});},intervalMs);
}
function stopPolling() {if(pollTimer){clearInterval(pollTimer);pollTimer=null;}}
function pulsePolling() {
 startPolling(3000);
 setTimeout(()=>{if(location.hash==='#command-center')startPolling(15000);},20000);
}

// ------------------------------------------------------------------------------------------
// Data & Context
// ------------------------------------------------------------------------------------------
async function renderInbox() {
 const {items}=await api('/api/command/inbox');
 $('#cmdc-dc-inbox').innerHTML=items.length?`<div class="cmdc-ops-list">${items.map(i=>`<div class="cmdc-op-row">${icon(INBOX_ICON[i.kind]||'file')}<span class="cmdc-op-label">${escape(i.title||'—')}</span><time>${escape(fmtDateTime(i.at))}</time></div>`).join('')}</div>`:empty(t('commandCenter.noInboxTitle'));
}
async function onAddContext(event) {
 if(event.target.id!=='cmdc-context-form')return;
 event.preventDefault();
 event.stopPropagation(); // see onSendMessage's comment above — same reason
 const form=event.target;
 const input={
  type:form.type.value,title:form.title.value.trim(),description:form.description.value.trim(),
  category:form.category.value.trim()||undefined,priority:form.priority.value||undefined,
  tags:form.tags.value.split(',').map(s=>s.trim()).filter(Boolean)
 };
 await api('/api/command/context',input);
 form.reset();
 $('#cmdc-context-just-added').innerHTML=`<p class="notice">${escape(t('commandCenter.contextAdded'))}</p>`;
 await Promise.all([renderInbox(),renderCompanyBrain()]);
}
// Spec items 41-43 — Pinned Decisions/Active Goals are just the existing decision/brain_goals
// types rendered here too (no new data model); conflicts (two ACTIVE singleton-brain records)
// and freshness (STALE = ACTIVE but past its own expiry) are shown explicitly, never silently
// resolved by picking one.
async function renderCompanyBrain() {
 const brainTypes=['brain_identity','brain_goals','brain_customers','brain_products','brain_brand','brain_rules','decision'];
 const [rows,conflicts]=await Promise.all([
  Promise.all(brainTypes.map(type=>api('/api/command/context?type='+type))),
  api('/api/command/context/conflicts')
 ]);
 const conflictTypes=new Set(conflicts.map(c=>c.type));
 const itemHtml=item=>`<p class="${item.freshness==='STALE'?'cmdc-stale':''}"><strong>${escape(item.title)}</strong> — ${escape(item.description)}${item.freshness==='STALE'?` ${badge(t('commandCenter.stale'),'ERROR')}`:''}</p>`;
 const sections=brainTypes.map((type,i)=>`<div class="cmdc-brain-section">
   <h4>${escape(t('commandCenter.contextType.'+type))}${conflictTypes.has(type)?` ${badge(t('commandCenter.conflict'),'ERROR')}`:''}</h4>
   ${rows[i].length?rows[i].map(itemHtml).join(''):`<p class="cmdc-muted">${escape(t('commandCenter.noBrainItem'))}</p>`}
  </div>`);
 $('#cmdc-dc-companyBrain').innerHTML=sections.join('');
}

// ------------------------------------------------------------------------------------------
// Runbooks / Favorites (spec Part 12-14/45) — "Run" sends the SAME real command text through
// the exact same chat pipeline (POST .../runbooks/:id/run -> sendCommandMessage server-side).
// ------------------------------------------------------------------------------------------
async function renderRunbooksList() {
 const runbooks=await api('/api/command/runbooks');
 const host=$('#cmdc-runbooks-list');
 host.innerHTML=runbooks.map(r=>`<article class="card cmdc-runbook" data-runbook-id="${escape(r.id)}">
   <div class="row-between"><strong>${escape(r.name)}</strong>${r.isBuiltin?badge(t('commandCenter.builtin'),'CONNECTED'):''}</div>
   <p class="cmdc-muted">${escape(r.description||r.commandText)}</p>
   <div class="row">
    <button type="button" class="small" data-runbook-action="run">${escape(t('commandCenter.runbookRun'))}</button>
    ${r.isBuiltin?'':`<button type="button" class="small secondary" data-runbook-action="archive">${escape(t('commandCenter.runbookArchive'))}</button>`}
   </div>
  </article>`).join('');
}
async function runRunbook(id) {
 const conversations=await api('/api/command/conversations');
 const conversationId=currentConversationId||conversations[0]?.id;
 const result=await api(`/api/command/runbooks/${id}/run`,conversationId?{conversationId}:{});
 currentConversationId=result.conversationId;
 $('#cmdc-conversation-select').value=result.conversationId;
 await renderMessages();
 pulsePolling();
 await Promise.all([renderSuggestions(),renderOperations()]);
}
document.addEventListener('click',async event=>{
 const actionButton=event.target.closest('#command-center [data-runbook-action]');
 if(!actionButton)return;
 const card=actionButton.closest('[data-runbook-id]');
 if(actionButton.dataset.runbookAction==='run')await runRunbook(card.dataset.runbookId);
 else {await api(`/api/command/runbooks/${card.dataset.runbookId}/archive`,{});await renderRunbooksList();}
});
async function onCreateRunbook(event) {
 if(event.target.id!=='cmdc-runbook-form')return;
 event.preventDefault();
 event.stopPropagation();
 const form=event.target;
 await api('/api/command/runbooks',{name:form.name.value.trim(),commandText:form.commandText.value.trim()});
 form.reset();
 await renderRunbooksList();
}

// ------------------------------------------------------------------------------------------
// Configuration History + Undo (spec Part 20-23)
// ------------------------------------------------------------------------------------------
async function renderConfigHistoryList() {
 const history=await api('/api/command/configuration-history');
 const host=$('#cmdc-config-history-list');
 host.innerHTML=history.length?history.map(h=>`<div class="cmdc-op-row" data-history-id="${escape(h.id)}">
   <span>${escape(h.entityType)} · ${escape(h.field)}</span>
   <span class="cmdc-muted">${escape(JSON.stringify(h.previousValue))} → ${escape(JSON.stringify(h.newValue))}</span>
   <time>${escape(fmtDateTime(h.createdAt))}</time>
   ${h.revertedAt?badge(t('commandCenter.reverted'),'DISCONNECTED'):(h.reversible?`<button type="button" class="small secondary" data-undo-history="${escape(h.id)}">${escape(t('commandCenter.undo'))}</button>`:badge(t('commandCenter.irreversible'),'ERROR'))}
  </div>`).join(''):empty(t('commandCenter.noConfigHistory'));
}
document.addEventListener('click',async event=>{
 const undoButton=event.target.closest('#command-center [data-undo-history]');
 if(!undoButton)return;
 const confirmed=await confirmAction(t('commandCenter.confirmUndoTitle'),t('commandCenter.confirmUndoBody'));
 if(!confirmed)return;
 try{await api(`/api/command/configuration-history/${undoButton.dataset.undoHistory}/undo`,{});await renderConfigHistoryList();}
 catch(error){/* toast handled by shared api() error path */}
});

// ------------------------------------------------------------------------------------------
// Attachments (spec Part 15-19) — safe, tenant-scoped, never auto-pinned to Company Brain.
// ------------------------------------------------------------------------------------------
async function renderAttachmentsList() {
 const attachments=await api('/api/command/attachments');
 const host=$('#cmdc-attachments-list');
 host.innerHTML=attachments.length?attachments.map(a=>`<div class="cmdc-op-row" data-attachment-id="${escape(a.id)}">
   ${icon('file')}<span class="cmdc-op-label">${escape(a.filename)}</span>
   <span class="cmdc-muted">${escape(a.uploadedByName||'—')} · ${escape(fmtDateTime(a.createdAt))}</span>
   ${a.savedToBrainContextId?badge(t('commandCenter.savedToBrain'),'CONNECTED'):`<button type="button" class="small secondary" data-pin-attachment="${escape(a.id)}">${escape(t('commandCenter.pinToBrain'))}</button>`}
  </div>`).join(''):empty(t('commandCenter.noAttachments'));
}
document.addEventListener('click',async event=>{
 const pinButton=event.target.closest('#command-center [data-pin-attachment]');
 if(!pinButton)return;
 await api(`/api/command/attachments/${pinButton.dataset.pinAttachment}/pin-to-brain`,{});
 await Promise.all([renderAttachmentsList(),renderCompanyBrain()]);
});

// ------------------------------------------------------------------------------------------
// System Map (compact — the full interactive Agent/Tool/Connection map already exists in
// Control Center; this links to it rather than rebuilding it, per the architectural rule).
// ------------------------------------------------------------------------------------------
async function renderSystemMap() {
 const map=await api('/api/command/system-map');
 const agents=map.agents||map.items||[];
 const ready=agents.filter(a=>a.status==='READY').length;
 const host=$('#cmdc-system-map');
 host.innerHTML=`<div class="kpi-grid">${metric(t('commandCenter.agentsReady'),`${ready}/${agents.length}`,'','agent')}</div>
  <button type="button" class="secondary" id="cmdc-open-full-map">${escape(t('commandCenter.openFullMap'))}</button>`;
 host.querySelector('#cmdc-open-full-map').onclick=()=>navigate('control-center');
}

// ------------------------------------------------------------------------------------------
export async function renderCommandCenter({api:client}) {
 apiClient=client;
 const generation=++renderGeneration;
 stopPolling();
 currentConversationId=null;
 try {
  const health=await api('/api/command/health');
  if(staleGuard(generation))return;
  renderHealthFrom(health);
  await Promise.all([loadConversations(),renderSuggestions(),renderOperations(),renderInbox(),renderCompanyBrain(),renderSystemMap(),renderRunbooksList(),renderConfigHistoryList(),renderAttachmentsList()]);
  if(staleGuard(generation))return;
  startPolling();
 } catch(error) {
  console.error('command center load failed:',error);
 }
}
function renderHealthFrom(health) {
 const cards=[
  [metric(t('commandCenter.metricPendingApprovals'),health.pendingApprovals,t('commandCenter.metricPendingApprovalsHint'),'bell'),'agents'],
  [metric(t('commandCenter.metricOpenTasks'),health.openEscalations,t('commandCenter.metricOpenTasksHint'),'clock'),'agents'],
  [metric(t('commandCenter.metricUnhealthyConnections'),health.unhealthyConnections.length,t('commandCenter.metricUnhealthyConnectionsHint'),'plug'),'integrations'],
  [metric(t('commandCenter.metricNewLeads'),health.newLeadsThisWeek,t('commandCenter.metricNewLeadsHint'),'users'),'crm'],
  [metric(t('commandCenter.metricContentPlanned'),health.contentPlannedThisWeek,t('commandCenter.metricContentPlannedHint'),'file'),'content']
 ];
 $('#cmdc-health').innerHTML=cards.map(([html])=>html).join('');
 $('#cmdc-health').querySelectorAll('.kpi-card').forEach((card,i)=>{card.classList.add('clickable');card.onclick=()=>navigate(cards[i][1]);});
}
