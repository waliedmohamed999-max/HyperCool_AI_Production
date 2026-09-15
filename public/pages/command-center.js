// Frost Command Center (Phase 7A). Reuses the existing design system entirely (no new
// component library): drawer/promptDrawer/confirmAction/tabs/badge/metric/empty/table from
// components/ui/index.js, the same api()/toast conventions every other page already uses.
// Every number here comes from a real backend read (src/runtime/command-health.js,
// src/runtime/suggestions.js, src/runtime/context-items.js, /api/command/operations/inbox) —
// an empty/not-configured state renders as a real empty state, never a placeholder number.
import {escape,button,badge,empty,metric,drawer,promptDrawer,confirmAction,table,tabs,enhance,icon,toast} from '../components/ui/index.js';
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
// Company Brain (UI-4) — the real category set is exactly this subset of CONTEXT_TYPES, in a
// fixed display order; there is no separate "Knowledge"/"Recent Insights" type in the data
// model, so those are represented by the hero's real "recent updates" count instead of an
// invented category.
const BRAIN_TYPES=['brain_identity','brain_goals','brain_customers','brain_products','brain_brand','brain_rules','decision'];
let currentBrainType=BRAIN_TYPES[0],brainRowsCache=BRAIN_TYPES.map(()=>[]),brainConflictsCache=[],dataContextTabsController=null;
const OPERATION_ICON={agent_run:'agent',audit:'clock'};
const INBOX_ICON={crm_lead:'users',crm_followup:'clock',content:'file',escalation:'bell',connection:'plug',webhook:'plug'};

export function installCommandCenter() {
 const root=document.querySelector('[data-page="command-center"] #command-center');
 root.innerHTML=`
  <div id="cmdc-health" class="kpi-grid"></div>
  <div class="cmdc-layout">
   <div class="cmdc-main">
    <section class="cmdc-chat panel">
     <div class="cmdc-chat-head">
      <span class="cmdc-frost-signature" aria-hidden="true"></span>
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
       <input type="file" id="cmdc-attach-input" class="file-input-native" accept=".pdf,.csv,.xlsx,.docx,.txt,.png,.jpg,.jpeg">
       <label for="cmdc-attach-input" class="button secondary file-input-trigger">${escape(t('commandCenter.chooseFile'))}</label>
       <span id="cmdc-attach-status">${escape(t('commandCenter.noFileChosen'))}</span>
      </div>
      <button type="submit">${escape(t('commandCenter.send'))}</button>
     </form>
     <div id="cmdc-templates" class="cmdc-templates"></div>
    </section>
    <section class="report-section" id="cmdc-data-context"><div class="report-section-head"><h3>${escape(t('commandCenter.dataContext'))}</h3></div></section>
   </div>
   <aside class="cmdc-side">
    <section class="report-section"><div class="report-section-head"><h3>${escape(t('commandCenter.suggestions'))}</h3></div><div id="cmdc-suggestions"></div></section>
    <section class="report-section"><div class="report-section-head"><h3>${escape(t('commandCenter.liveOperations'))}</h3></div><div id="cmdc-operations"></div></section>
    <section class="report-section"><div class="report-section-head"><h3>${escape(t('commandCenter.systemMap'))}</h3><span>${escape(t('commandCenter.systemMapSubtitle'))}</span></div><div id="cmdc-system-map"></div></section>
    <section class="report-section"><div class="report-section-head"><h3>${escape(t('commandCenter.workflowsWidget'))}</h3></div><div id="cmdc-workflows-widget"></div></section>
    <section class="report-section"><div class="report-section-head"><h3>${escape(t('commandCenter.aiUsage'))}</h3></div><div id="cmdc-ai-usage"></div></section>
   </aside>
  </div>`;
 const panels=['inbox','addContext','companyBrain','runbooks','configHistory','attachments'].map(key=>{const el=document.createElement('div');el.id='cmdc-dc-'+key;return el;});
 $('#cmdc-data-context').append(...panels);
 dataContextTabsController=tabs($('#cmdc-data-context'),[
  [t('commandCenter.tabInbox'),panels[0]],
  [t('commandCenter.tabAddContext'),panels[1]],
  [t('commandCenter.tabCompanyBrain'),panels[2]],
  [t('commandCenter.tabRunbooks'),panels[3]],
  [t('commandCenter.tabConfigHistory'),panels[4]],
  [t('commandCenter.tabAttachments'),panels[5]]
 ]);
 panels[1].innerHTML=addContextFormHtml();
 panels[2].innerHTML=`<div class="cmdc-brain-hero" id="cmdc-brain-hero"></div><div class="cmdc-brain-layout"><nav class="cmdc-brain-nav" id="cmdc-brain-nav" role="tablist" aria-label="${escape(t('commandCenter.tabCompanyBrain'))}"></nav><div class="cmdc-brain-content" id="cmdc-brain-content"></div></div>`;
 panels[3].innerHTML=`<div id="cmdc-runbooks-list"></div><form id="cmdc-runbook-form"><input name="name" required maxlength="200" placeholder="${escape(t('commandCenter.runbookNamePlaceholder'))}"><input name="commandText" required maxlength="2000" placeholder="${escape(t('commandCenter.runbookCommandPlaceholder'))}"><button type="submit">${escape(t('commandCenter.runbookSave'))}</button></form>`;
 panels[4].innerHTML=`<div id="cmdc-config-history-list"></div>`;
 panels[5].innerHTML=`<div id="cmdc-attachments-list"></div>`;
 $('#cmdc-new-conversation').onclick=onNewConversation;
 $('#cmdc-run-executive-review').onclick=onRunExecutiveReview;
 $('#cmdc-conversation-select').onchange=e=>openConversation(e.target.value);
 $('#cmdc-chat-form').addEventListener('submit',onSendMessage);
 // File input polish (HyperCool Frost UI Part UI-2, item 30/31) — the native <input type=file>
 // stays in the DOM and fully functional (real keyboard access, real screen-reader label via
 // the <label for>, real .files value) so nothing about the actual upload logic above changes;
 // only its own browser-chrome text ("Choose File" / unlocalized) is visually replaced by a
 // real button label plus this status span, which IS ours to localize.
 $('#cmdc-attach-input').addEventListener('change',e=>{
  $('#cmdc-attach-status').textContent=e.target.files?.[0]?.name||t('commandCenter.noFileChosen');
 });
 $('#cmdc-data-context').addEventListener('submit',onAddContext);
 $('#cmdc-data-context').addEventListener('submit',onCreateRunbook);
 $('#cmdc-search-input').addEventListener('input',debounce(onSearchInput,300));
}
function debounce(fn,ms){let timer=null;return(...args)=>{clearTimeout(timer);timer=setTimeout(()=>fn(...args),ms);};}
// Tenant-aware Quick Commands (spec Part 48-52) — the KEYS come from the server, derived from
// real tenant signals (connected e-commerce integration, mostly-B2B leads book, or generic);
// only the localized phrase mapping lives here.
async function renderQuickCommands() {
 const {keys}=await api('/api/command/quick-commands');
 $('#cmdc-quick-commands').innerHTML=keys.map(key=>`<button type="button" class="cmdc-chip" data-quick="${key}">${escape(t('commandCenter.quickCommand.'+key))}</button>`).join('');
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
 const usage=message.meta?.usage;
 const usageHtml=usage?`<p class="cmdc-sources"><small>${escape(t('commandCenter.usageLine',{tokens:usage.totalTokens,ms:usage.durationMs||0}))}</small></p>`:'';
 const exportHtml=message.role==='assistant'&&message.id?`<button type="button" class="small ghost" data-export-message="${escape(message.id)}">${escape(t('commandCenter.exportMarkdown'))}</button>`:'';
 return `<div class="cmdc-message cmdc-message-${escape(message.role)}"><p>${escape(message.content)}</p>${stepsHtml}${sourcesHtml}${usageHtml}${approvalHtml}${exportHtml}</div>`;
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
let messagesCache=[];
async function renderMessages() {
 if(!currentConversationId)return;
 const messages=await api(`/api/command/conversations/${currentConversationId}/messages`);
 messagesCache=messages;
 const host=$('#cmdc-messages');
 host.innerHTML=messages.length?messages.map(messageBubbleHtml).join(''):empty(t('commandCenter.noMessagesTitle'),t('commandCenter.noMessagesHint'));
 host.scrollTop=host.scrollHeight;
 enhance(host);
}
// Command Result Export (spec Part 46-47) — plain Markdown, built entirely from data already
// visible in this same conversation (never a second fetch of anything secret) — Command,
// Summary, Results (steps), Evidence references, Timestamp. A real file download (this is the
// live app, not a published Artifact, so a blob anchor works normally) — matches the exact
// same pattern platform.js's Integration Builder already uses for exporting a connector.
function buildExportMarkdown(message,precedingUserText) {
 const lines=[
  `# ${t('commandCenter.exportTitle')}`,'',
  `**${t('commandCenter.exportCommand')}:** ${precedingUserText||''}`,'',
  `**${t('commandCenter.exportSummary')}:**`,'',message.content,''
 ];
 if(message.meta?.steps?.length) {
  lines.push(`**${t('commandCenter.exportResults')}:**`,'');
  for(const step of message.meta.steps)lines.push(`- ${step.label} — ${step.delegatedStatus||step.status}`);
  lines.push('');
 }
 if(message.meta?.dataSources?.length)lines.push(`**${t('commandCenter.exportEvidence')}:** ${message.meta.dataSources.join('، ')}`,'');
 lines.push(`**${t('commandCenter.exportTimestamp')}:** ${message.createdAt||new Date().toISOString()}`);
 return lines.join('\n');
}
document.addEventListener('click',event=>{
 const exportButton=event.target.closest('#command-center [data-export-message]');
 if(!exportButton)return;
 const messageId=exportButton.dataset.exportMessage;
 const index=messagesCache.findIndex(m=>m.id===messageId);
 if(index<0)return;
 const message=messagesCache[index];
 const precedingUser=[...messagesCache.slice(0,index)].reverse().find(m=>m.role==='user');
 const markdown=buildExportMarkdown(message,precedingUser?.content);
 const blob=new Blob([markdown],{type:'text/markdown'});
 const url=URL.createObjectURL(blob);
 const a=document.createElement('a');a.href=url;a.download=`frost-command-${messageId.slice(0,8)}.md`;a.click();
 setTimeout(()=>URL.revokeObjectURL(url),1000);
});
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
   $('#cmdc-attach-status').textContent=t('commandCenter.noFileChosen');
   renderAttachmentsList();
  }
  const host=$('#cmdc-messages');
  if(host.querySelector('.empty'))host.innerHTML='';
  host.insertAdjacentHTML('beforeend',messageBubbleHtml({role:'user',content:text}));
  messagesCache.push({role:'user',content:text});
  textarea.value='';
  const result=await api(`/api/command/conversations/${currentConversationId}/messages`,{text,...(attachmentId?{attachmentId}:{})});
  messagesCache.push(result.assistantMessage);
  host.insertAdjacentHTML('beforeend',messageBubbleHtml(result.assistantMessage));
  host.scrollTop=host.scrollHeight;
  enhance(host);
  pulsePolling();
  await Promise.all([renderSuggestions(),renderOperations(),renderAiUsage()]);
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
    ${s.automatable?`<button type="button" class="small" data-suggestion-action="automate">${escape(t('commandCenter.automate'))}</button>`:''}
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
 if(action==='automate') {
  const confirmed=await confirmAction(t('commandCenter.automate'),t('commandCenter.automateConfirm'));
  if(!confirmed)return;
  await api(`/api/command/suggestions/${id}/automate`,{});
  toast(t('commandCenter.automateCreated'),'success');
  navigate('workflows');
  return;
 }
 if(action==='dismiss') {await api(`/api/command/suggestions/${id}/dismiss`,{});await renderSuggestions();}
});

// ------------------------------------------------------------------------------------------
// Live Operations (safe polling — no SSE/WebSocket exists anywhere in this app; paused when
// the tab/page is hidden, matching spec item 73's "safe polling is acceptable initially")
// ------------------------------------------------------------------------------------------
function operationLabel(op) {
 if(op.kind==='workflow_run')return `${t('commandCenter.opWorkflowPrefix')} ${op.workflowName}`;
 return op.action||op.triggerType||op.agentId||'';
}
async function renderOperations() {
 const {items}=await api('/api/command/operations');
 const host=$('#cmdc-operations');
 host.innerHTML=items.length?`<div class="cmdc-ops-list">${items.map(op=>`<button type="button" class="cmdc-op-row" data-op-kind="${escape(op.kind)}" data-op-id="${escape(op.id)}">${icon(OPERATION_ICON[op.kind]||'clock')}<span class="cmdc-op-label">${escape(operationLabel(op))}</span>${badge(op.status,op.status==='COMPLETED'?'CONNECTED':op.status==='FAILED'?'ERROR':'PENDING')}<time>${escape(fmtDateTime(op.at))}</time></button>`).join('')}</div>`:empty(t('commandCenter.noOperationsTitle'));
}
document.addEventListener('click',async event=>{
 const row=event.target.closest('#command-center .cmdc-op-row');
 if(!row)return;
 if(row.dataset.opKind==='agent_run') {
  const run=await api(`/api/agents/runs/${row.dataset.opId}`);
  const node=document.createElement('div');
  node.innerHTML=`<p>${escape(t('commandCenter.opStatusLabel'))} ${escape(run.status)}</p>
   <div class="cmdc-ops-list">${(run.toolCalls||[]).map(tc=>`<div class="cmdc-op-row"><span>${escape(tc.tool)}</span>${badge(tc.status,tc.status==='OK'?'CONNECTED':tc.status==='WAITING_APPROVAL'?'PENDING':'ERROR')}</div>`).join('')||empty(t('commandCenter.noStepsTitle'))}</div>`;
  drawer(t('commandCenter.operationDetailTitle'),node,{restore:true});
  return;
 }
 if(row.dataset.opKind==='workflow_run') {
  const run=await api(`/api/workflow-runs/${row.dataset.opId}`);
  const node=document.createElement('div');
  node.innerHTML=`<p>${escape(t('commandCenter.opStatusLabel'))} ${escape(run.status)}</p>
   <div class="cmdc-ops-list">${(run.steps||[]).map(s=>`<div class="cmdc-op-row"><span>${escape(s.stepType)} (${escape(s.stepId)})</span>${badge(s.status,s.status==='COMPLETED'?'CONNECTED':s.status==='FAILED'?'ERROR':'PENDING')}</div>`).join('')||empty(t('commandCenter.noStepsTitle'))}</div>
   <div class="report-actions" id="cmdc-wf-run-actions"></div>`;
  const dialog=drawer(t('commandCenter.operationDetailTitle'),node,{restore:true});
  if(['PENDING','RUNNING','WAITING','WAITING_APPROVAL','CANCEL_REQUESTED'].includes(run.status)) {
   const cancelButton=document.createElement('button');cancelButton.type='button';cancelButton.className='button danger';cancelButton.textContent=t('commandCenter.cancelRun');
   cancelButton.onclick=async()=>{
    const confirmed=await confirmAction(t('commandCenter.cancelRun'),t('commandCenter.cancelRunExplain'));
    if(!confirmed)return;
    await api(`/api/workflow-runs/${run.id}/cancel`,{});
    dialog.close();
    await renderOperations();
   };
   node.querySelector('#cmdc-wf-run-actions').append(cancelButton);
  }
 }
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
// Spec items 41-43 (Phase 7B) + Phase UI-4 information-architecture pass — Pinned
// Decisions/Active Goals are just the existing decision/brain_goals types (no new data model);
// conflicts (two ACTIVE singleton-brain records) and freshness (STALE = ACTIVE but past its own
// expiry) are shown explicitly, never silently resolved by picking one. UI-4 adds: a real-count
// hero, a category nav so only one section is read at a time instead of 7 stacked blocks, and
// wires the already-existing (but previously unused by this page) PATCH/archive endpoints to
// real Pin/Edit/Archive actions — no new backend capability, just surfacing what already exists.
async function renderCompanyBrain() {
 const [rows,conflicts]=await Promise.all([
  Promise.all(BRAIN_TYPES.map(type=>api('/api/command/context?type='+type))),
  api('/api/command/context/conflicts')
 ]);
 brainRowsCache=rows;brainConflictsCache=conflicts;
 if(!BRAIN_TYPES.includes(currentBrainType))currentBrainType=BRAIN_TYPES[0];
 renderBrainHero();
 renderBrainCategory();
}
function renderBrainHero() {
 const all=brainRowsCache.flat();
 const countOf=type=>brainRowsCache[BRAIN_TYPES.indexOf(type)].length;
 const weekAgo=Date.now()-7*24*60*60*1000;
 const recentCount=all.filter(item=>Date.parse(item.updatedAt)>=weekAgo).length;
 const stat=(value,label)=>`<div class="cmdc-brain-stat"><strong>${escape(String(value))}</strong><span>${escape(label)}</span></div>`;
 $('#cmdc-brain-hero').innerHTML=`
  <div class="cmdc-brain-hero-top"><h4>${escape(t('commandCenter.brainHeroTitle'))}</h4><p class="cmdc-muted">${escape(t('commandCenter.brainHeroSubtitle'))}</p></div>
  <div class="cmdc-brain-hero-stats">
   ${stat(all.length,t('commandCenter.brainStatActive'))}
   ${stat(countOf('brain_goals'),t('commandCenter.brainStatGoals'))}
   ${stat(countOf('brain_rules'),t('commandCenter.brainStatRules'))}
   ${stat(countOf('decision'),t('commandCenter.brainStatDecisions'))}
   ${stat(recentCount,t('commandCenter.brainStatRecent'))}
  </div>`;
}
function brainSourceLabel(source) {
 const key='commandCenter.brainSource.'+source;
 const translated=t(key);
 return translated===key?source:translated;
}
function brainItemCardHtml(item) {
 const important=item.pinned||item.priority==='HIGH';
 const badges=[
  item.pinned?badge(t('commandCenter.brainPinned'),'CONNECTED'):'',
  (!item.pinned&&item.priority==='HIGH')?badge(t('commandCenter.priorityHigh'),'BLOCKED'):'',
  item.freshness==='STALE'?badge(t('commandCenter.stale'),'PENDING'):''
 ].filter(Boolean).join('');
 return `<article class="cmdc-brain-card${important?' cmdc-brain-card-important':''}">
  <div class="cmdc-brain-card-head"><h5>${escape(item.title)}</h5><div class="cmdc-brain-card-badges">${badges}</div></div>
  <p class="cmdc-brain-card-summary">${item.description?escape(item.description):`<span class="cmdc-muted">${escape(t('commandCenter.brainNoDescription'))}</span>`}</p>
  <div class="cmdc-brain-card-meta">
   <span class="cmdc-brain-source-chip">${escape(brainSourceLabel(item.source))}</span>
   <span>${escape(t('commandCenter.brainUpdated'))} ${escape(fmtDateTime(item.updatedAt))}</span>
   ${item.confidence!=null?`<span>${escape(t('commandCenter.brainConfidence',{pct:Math.round(item.confidence*100)}))}</span>`:''}
  </div>
  <div class="row cmdc-brain-card-actions">
   <button type="button" class="small ghost" data-brain-pin="${escape(item.id)}">${escape(item.pinned?t('commandCenter.brainUnpin'):t('commandCenter.brainPin'))}</button>
   <button type="button" class="small ghost" data-brain-edit="${escape(item.id)}">${escape(t('commandCenter.brainEdit'))}</button>
   <button type="button" class="small ghost" data-brain-archive="${escape(item.id)}">${escape(t('commandCenter.brainArchive'))}</button>
  </div>
 </article>`;
}
function renderBrainNav() {
 const conflictTypes=new Set(brainConflictsCache.map(c=>c.type));
 $('#cmdc-brain-nav').innerHTML=BRAIN_TYPES.map((type,i)=>`<button type="button" class="cmdc-brain-nav-item" data-brain-type="${type}" aria-current="${type===currentBrainType}">
   <span>${escape(t('commandCenter.contextType.'+type))}</span>
   <span class="cmdc-brain-nav-count">${brainRowsCache[i].length}</span>
   ${conflictTypes.has(type)?`<span class="cmdc-brain-nav-flag" title="${escape(t('commandCenter.conflict'))}"></span>`:''}
  </button>`).join('');
}
function renderBrainCategory() {
 renderBrainNav();
 const index=BRAIN_TYPES.indexOf(currentBrainType);
 const items=brainRowsCache[index]||[];
 const hasConflict=brainConflictsCache.some(c=>c.type===currentBrainType);
 const conflictHtml=hasConflict?`<div class="cmdc-brain-conflict">${badge(t('commandCenter.conflict'),'PENDING')}<span>${escape(t('commandCenter.brainConflictNote'))}</span></div>`:'';
 const bodyHtml=items.length
  ?items.map(brainItemCardHtml).join('')
  :`<div class="empty">${icon('book')}<strong>${escape(t('commandCenter.brainEmptyCategory',{category:t('commandCenter.contextType.'+currentBrainType)}))}</strong><p>${escape(t('commandCenter.brainEmptyCategoryHint'))}</p><button type="button" class="small secondary" data-brain-add-type="${currentBrainType}">${escape(t('commandCenter.brainAddForCategory'))}</button></div>`;
 $('#cmdc-brain-content').innerHTML=conflictHtml+bodyHtml;
}
function findCachedBrainItem(id) {
 for(const rows of brainRowsCache){const found=rows.find(item=>item.id===id);if(found)return found;}
 return null;
}
function brainEditFormFields(node,item) {
 node.innerHTML=`
  <label>${escape(t('commandCenter.fieldTitle'))}<input name="title" required maxlength="200" value="${escape(item.title)}"></label>
  <label>${escape(t('commandCenter.fieldPriority'))}<select name="priority"><option value="">—</option><option value="LOW">${escape(t('commandCenter.priorityLow'))}</option><option value="MEDIUM">${escape(t('commandCenter.priorityMedium'))}</option><option value="HIGH">${escape(t('commandCenter.priorityHigh'))}</option></select></label>
  <label>${escape(t('commandCenter.fieldDescription'))}<textarea name="description" maxlength="5000">${escape(item.description)}</textarea></label>
  <label>${escape(t('commandCenter.fieldCategory'))}<input name="category" maxlength="100" value="${escape(item.category||'')}"></label>
  <label>${escape(t('commandCenter.fieldTags'))}<input name="tags" placeholder="${escape(t('commandCenter.fieldTagsPlaceholder'))}" value="${escape((item.tags||[]).join(', '))}"></label>`;
 const titleInput=node.querySelector('[name=title]');
 node.querySelector('[name=priority]').value=item.priority||'';
 return {
  value:()=>({
   title:node.querySelector('[name=title]').value.trim(),
   description:node.querySelector('[name=description]').value.trim(),
   category:node.querySelector('[name=category]').value.trim()||null,
   priority:node.querySelector('[name=priority]').value||null,
   tags:node.querySelector('[name=tags]').value.split(',').map(s=>s.trim()).filter(Boolean)
  }),
  validate:()=>{if(!titleInput.value.trim()){titleInput.setCustomValidity(t('common.reasonRequired'));titleInput.reportValidity();return false;}titleInput.setCustomValidity('');return true;},
  focus:()=>titleInput.focus()
 };
}
async function openBrainEdit(item) {
 const patch=await promptDrawer(t('commandCenter.brainEditTitle'),node=>brainEditFormFields(node,item),{confirmLabel:t('common.save')});
 if(!patch)return;
 await api(`/api/command/context/${item.id}`,patch,'PATCH');
 await renderCompanyBrain();
}
async function toggleBrainPin(item) {
 await api(`/api/command/context/${item.id}`,{pinned:!item.pinned},'PATCH');
 await renderCompanyBrain();
}
async function archiveBrainItem(item) {
 const confirmed=await confirmAction(t('commandCenter.brainArchiveConfirmTitle'),t('commandCenter.brainArchiveConfirmBody'));
 if(!confirmed)return;
 await api(`/api/command/context/${item.id}/archive`,{},'POST');
 await renderCompanyBrain();
}
document.addEventListener('click',async event=>{
 const navButton=event.target.closest('#command-center [data-brain-type]');
 if(navButton){currentBrainType=navButton.dataset.brainType;renderBrainCategory();return;}
 const addTypeButton=event.target.closest('#command-center [data-brain-add-type]');
 if(addTypeButton){
  dataContextTabsController?.select(1);
  const typeSelect=$('#cmdc-context-form [name=type]');
  if(typeSelect)typeSelect.value=addTypeButton.dataset.brainAddType;
  return;
 }
 const pinButton=event.target.closest('#command-center [data-brain-pin]');
 if(pinButton){const item=findCachedBrainItem(pinButton.dataset.brainPin);if(item)await toggleBrainPin(item);return;}
 const editButton=event.target.closest('#command-center [data-brain-edit]');
 if(editButton){const item=findCachedBrainItem(editButton.dataset.brainEdit);if(item)await openBrainEdit(item);return;}
 const archiveButton=event.target.closest('#command-center [data-brain-archive]');
 if(archiveButton){const item=findCachedBrainItem(archiveButton.dataset.brainArchive);if(item)await archiveBrainItem(item);}
});

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
// Workflows widget (spec Part 36) — real counts only, links to the full Workflows/Automation
// page rather than rebuilding it here (same "link, don't duplicate" rule as System Map).
// ------------------------------------------------------------------------------------------
async function renderWorkflowsWidget() {
 const summary=await api('/api/command/workflows-summary');
 const host=$('#cmdc-workflows-widget');
 host.innerHTML=`<div class="kpi-grid">
   ${metric(t('commandCenter.wfActive'),summary.active,'','clock')}
   ${metric(t('commandCenter.wfRunning'),summary.running,'','clock')}
   ${metric(t('commandCenter.wfWaitingApproval'),summary.waitingApproval,'','bell')}
   ${metric(t('commandCenter.wfFailedRecent'),summary.failedRecent,'','bell')}
   ${metric(t('commandCenter.wfScheduledToday'),summary.scheduledToday,'','clock')}
  </div>
  <button type="button" class="secondary" id="cmdc-open-workflows">${escape(t('commandCenter.openWorkflows'))}</button>`;
 host.querySelector('#cmdc-open-workflows').onclick=()=>navigate('workflows');
}

// ------------------------------------------------------------------------------------------
// AI Usage (spec Part 43-45) — real token counts already recorded on every agent_runs row;
// no monetary figure shown unless a real pricing table has been filled in (llmProvider.js).
// ------------------------------------------------------------------------------------------
let aiUsagePeriod='today';
async function renderAiUsage() {
 const summary=await api('/api/command/ai-usage?period='+aiUsagePeriod);
 const host=$('#cmdc-ai-usage');
 const periodButtons=['today','7d','30d'].map(p=>`<button type="button" class="small ${p===aiUsagePeriod?'':'ghost'}" data-usage-period="${p}">${escape(t('commandCenter.usagePeriod.'+p))}</button>`).join('');
 const byAgentRows=Object.entries(summary.byAgent).map(([agentId,a])=>`<div class="cmdc-op-row"><span>${escape(agentId)}</span><span class="cmdc-muted">${a.calls} · ${a.tokensInput+a.tokensOutput} tokens</span></div>`).join('');
 host.innerHTML=`<div class="row">${periodButtons}</div>
  <div class="kpi-grid">
   ${metric(t('commandCenter.usageCalls'),summary.totals.calls,'','agent')}
   ${metric(t('commandCenter.usageTokens'),summary.totals.tokensInput+summary.totals.tokensOutput,'','file')}
  </div>
  ${summary.totals.hasCostData?`<p class="kpi-context">${escape(t('commandCenter.usageCost'))} ${summary.totals.estimatedCost.toFixed(4)}</p>`:''}
  ${byAgentRows||empty(t('commandCenter.noUsage'))}`;
 host.querySelectorAll('[data-usage-period]').forEach(btn=>{btn.onclick=()=>{aiUsagePeriod=btn.dataset.usagePeriod;renderAiUsage();};});
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
  await Promise.all([loadConversations(),renderSuggestions(),renderOperations(),renderInbox(),renderCompanyBrain(),renderSystemMap(),renderWorkflowsWidget(),renderAiUsage(),renderRunbooksList(),renderConfigHistoryList(),renderAttachmentsList(),renderQuickCommands()]);
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
