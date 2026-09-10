import {escape,badge,empty,button,drawer,metric,tabs,table,initials,promptDrawer,enhance} from './components/ui/index.js';
import {fmtDateTime} from './format.js';
import {t} from './i18n.js';
const $=selector=>document.querySelector(selector);
const PERMISSION_LABELS=new Proxy({},{get:(_,code)=>{const key='team.permission'+code.charAt(0)+code.slice(1).toLowerCase();const value=t(key);return value===key?undefined:value;}});
const ACTIVITY_LABELS=new Proxy({},{get:(_,code)=>{const key='operationsLog.actions.'+code;const value=t(key);return value===key?undefined:value;}});
let dashboard=null,apiClient=null;

function relativeTime(iso){
 if(!iso)return null;
 const diff=Date.now()-Date.parse(iso);
 if(diff<60000)return t('team.relJustNow');
 if(diff<3600000)return t('team.relMinutesAgo',{n:Math.floor(diff/60000)});
 if(diff<86400000)return t('team.relHoursAgo',{n:Math.floor(diff/3600000)});
 if(diff<172800000)return t('team.relYesterday');
 if(diff<604800000)return t('team.relDaysAgo',{n:Math.floor(diff/86400000)});
 return fmtDateTime(iso);
}
function lastActiveText(m){
 if(m.hasActiveSession)return t('team.onlineNow');
 if(m.last_login_at)return relativeTime(m.last_login_at);
 return t('team.neverLoggedIn');
}
function statusPill(status){return badge(status==='active'?t('statuses.ACTIVE'):t('statuses.SUSPENDED'),status==='active'?'CONNECTED':'ERROR');}
function memberById(id){return dashboard?.members.find(m=>m.id===id);}

function renderSummary(){
 const s=dashboard.summary;
 $('#team-summary').innerHTML=[
  metric(t('team.totalMembers'),s.total,t('team.totalMembersHint'),'users'),
  metric(t('team.activeMembers'),s.active,t('team.activeMembersHint'),'check'),
  metric(t('team.owners'),s.owners,t('team.ownersHint'),'agent'),
  metric(t('team.pendingInvitations'),s.pendingInvitations,t('team.pendingInvitationsHint'),'info')
 ].join('');
}
function renderMembers(){
 if(!dashboard.members.length){$('#team-members').innerHTML=empty(t('team.noMembersYet'));return;}
 $('#team-members').innerHTML=table(
  [t('team.member'),t('team.username'),t('team.role'),t('team.status'),t('team.lastActive'),t('team.created'),t('team.actions')],
  dashboard.members.map(m=>[
   `<div class="row"><span class="avatar" aria-hidden="true">${escape(initials(m.name))}</span>${escape(m.name)}</div>`,
   `<span dir="ltr">${escape(m.username)}</span>`,
   escape(dashboard.roleNames[m.role]||m.role),
   statusPill(m.status),
   escape(lastActiveText(m)),
   m.created_at?fmtDateTime(m.created_at):t('team.unknownDate'),
   `<div class="row">
     <button type="button" data-team-view="${m.id}">${escape(t('team.detailsButton'))}</button>
     <button type="button" data-team-action="role" data-team-id="${m.id}">${escape(t('team.changeRole'))}</button>
     <button type="button" data-team-action="reset-access" data-team-id="${m.id}">${escape(t('team.resetAccess'))}</button>
     ${m.status==='active'
       ?`<button type="button" class="secondary" data-team-action="suspend" data-team-id="${m.id}" data-team-danger>${escape(t('team.suspend'))}</button>`
       :`<button type="button" class="secondary" data-team-action="reactivate" data-team-id="${m.id}">${escape(t('team.reactivate'))}</button>`}
     <button type="button" class="secondary" data-team-action="remove" data-team-id="${m.id}" data-team-danger>${escape(t('team.remove'))}</button>
    </div>`
  ])
 );
}
function renderRoles(){
 $('#team-roles').innerHTML=Object.entries(dashboard.roleNames).map(([key,label])=>{
  const count=dashboard.members.filter(m=>m.role===key).length;
  return `<article class="card"><div class="row-between"><h3>${escape(label)}</h3><span class="pill">${escape(t('team.memberCountSuffix',{count}))}</span></div><p>${escape(dashboard.roleDescriptions[key]||'')}</p></article>`;
 }).join('');
}
function renderMatrix(){
 const roleKeys=Object.keys(dashboard.roleNames);
 $('#team-matrix').innerHTML=table(
  [t('team.areaCol'),...roleKeys.map(k=>dashboard.roleNames[k])],
  dashboard.roleMatrix.map(row=>[escape(row.area),...roleKeys.map(k=>badge(PERMISSION_LABELS[row[k]]||row[k],row[k]==='MANAGE'?'CONNECTED':row[k]==='NONE'?'ERROR':row[k]==='EDIT'?'NEEDS_SETUP':'CONFIGURED_NO_CONNECTOR'))])
 );
}
function renderInvitations(){
 $('#team-invitations').innerHTML=empty(t('team.noInvitationSystemTitle'),t('team.noInvitationSystemHint'));
}
function renderActivity(){
 if(!dashboard.activity.length){$('#team-activity').innerHTML=empty(t('team.noActivityYet'));return;}
 $('#team-activity').innerHTML=table(
  [t('team.activityTime'),t('team.activityOperation'),t('team.activityBy'),t('team.activityAffectedMember')],
  dashboard.activity.map(a=>[fmtDateTime(a.at),escape(ACTIVITY_LABELS[a.action]||a.action),escape(a.actorName||'—'),escape(a.itemName||'—')])
 );
}

function chooseRole(member){
 return promptDrawer(t('team.changeMemberRoleTitle'),node=>{
  node.innerHTML=`<p>${escape(t('team.memberLabelLine',{name:member.name,role:dashboard.roleNames[member.role]||member.role}))}</p><label>${escape(t('team.newRoleLabel'))}<select></select></label>`;
  const select=node.querySelector('select');
  select.innerHTML=Object.entries(dashboard.roleNames).map(([value,label])=>`<option value="${value}"${value===member.role?' selected':''}>${escape(label)}</option>`).join('');
  return {value:()=>select.value};
 },{confirmLabel:t('team.saveRoleButton')});
}
function choosePassword(member){
 return promptDrawer(t('team.resetAccessTitle'),node=>{
  node.innerHTML=`<p>${escape(t('team.resetAccessWarning',{name:member.name}))}</p><label>${escape(t('team.newPasswordLabel'))}<input type="text" dir="ltr" minlength="12" maxlength="256" required></label>`;
  const input=node.querySelector('input');
  const generate=button(t('team.generateStrongPassword'),{variant:'secondary'});
  generate.onclick=()=>{input.value=crypto.randomUUID().replace(/-/g,'').slice(0,20);input.setCustomValidity('');};
  node.append(generate);
  return {
   value:()=>input.value.trim(),
   validate:()=>{if(input.value.trim().length<12){input.setCustomValidity(t('team.passwordMinLengthError'));input.reportValidity();return false;}return true;}
  };
 },{confirmLabel:t('team.saveNewPasswordButton')});
}
async function openMember(id){
 const m=memberById(id);if(!m)return;
 const profile=document.createElement('div');
 profile.innerHTML=`<p>${escape(t('team.profileNameLine',{name:m.name}))}</p><p>${escape(t('team.profileUsernameLine'))} <span dir="ltr">${escape(m.username)}</span></p><p>${escape(t('team.profileStatusLine'))} ${statusPill(m.status)}</p><p>${escape(t('team.profileCreatedLine'))} ${m.created_at?fmtDateTime(m.created_at):t('team.unknownDate')}</p>`;

 const role=document.createElement('div');
 role.innerHTML=`<p>${escape(t('team.currentRoleLine',{role:dashboard.roleNames[m.role]||m.role}))}</p><p>${escape(dashboard.roleDescriptions[m.role]||'')}</p>`;
 const changeRoleBtn=button(t('team.changeRole'),{variant:'secondary'});
 changeRoleBtn.onclick=async()=>{const text=await performAction(m.id,'role');if(text){drawerEl.close();document.dispatchEvent(new CustomEvent('team-refresh',{detail:text}));}};
 role.append(changeRoleBtn);

 const permissions=document.createElement('div');
 const roleKeys=Object.keys(dashboard.roleNames);
 permissions.innerHTML=table([t('team.areaCol'),...roleKeys.map(k=>dashboard.roleNames[k])],dashboard.roleMatrix.map(row=>[escape(row.area),...roleKeys.map(k=>{const val=PERMISSION_LABELS[row[k]]||row[k];return k===m.role?`<b>${escape(val)}</b>`:escape(val);})]));

 const activity=document.createElement('div');
 activity.innerHTML=`<p role="status">${escape(t('team.loadingActivity'))}</p>`;
 try{
  const state=await apiClient('/api/state');
  const rows=(state.audit||[]).filter(a=>a.actorId===m.id).slice(0,20);
  activity.innerHTML=rows.length?table([t('team.activityTime'),t('team.activityOperation')],rows.map(a=>[fmtDateTime(a.at),escape(ACTIVITY_LABELS[a.action]||a.action)])):empty(t('team.noActivityForMember'));
 }catch(error){activity.innerHTML=empty(t('team.activityLoadFailed'),error.message);}

 const tasks=document.createElement('div');
 tasks.innerHTML=empty(t('team.noTaskSystemTitle'),t('team.noTaskSystemHint'));

 const approvals=document.createElement('div');
 approvals.innerHTML=empty(t('team.noApprovalLinkTitle'),t('team.noApprovalLinkHint'));

 const security=document.createElement('div');
 security.innerHTML=`<p>${escape(t('team.lastLoginLine',{value:m.last_login_at?fmtDateTime(m.last_login_at):t('team.noRecordValue')}))}</p><p>${escape(t('team.currentSessionLine',{value:m.hasActiveSession?t('team.sessionActiveNow'):t('team.noActiveSession')}))}</p><p>${escape(t('team.failedLoginNote'))}</p>`;
 if(m.hasActiveSession){
  const revoke=button(t('team.revokeSessions'),{variant:'secondary'});
  revoke.onclick=async()=>{const text=await performAction(m.id,'revoke-sessions');if(text){drawerEl.close();document.dispatchEvent(new CustomEvent('team-refresh',{detail:text}));}};
  security.append(revoke);
 }

 const node=document.createElement('div');
 node.append(profile,role,permissions,activity,tasks,approvals,security);
 tabs(node,[[t('team.tabProfile'),profile],[t('team.tabRole'),role],[t('team.tabPermissions'),permissions],[t('team.tabRecentActivity'),activity],[t('team.tabAssignedTasks'),tasks],[t('team.tabApprovals'),approvals],[t('team.tabSecurity'),security]]);
 const drawerEl=drawer(m.name,node,{restore:true});
 enhance(node);
}

export async function renderTeam({api}){
 apiClient=api;
 try{dashboard=await api('/api/team/dashboard');}catch(error){dashboard=null;console.error('team dashboard failed to load:',error);}
 if(!dashboard){$('#team-members').innerHTML=empty(t('team.dashboardLoadFailed'));return;}
 renderSummary();renderMembers();renderRoles();renderMatrix();renderInvitations();renderActivity();
}
async function performAction(id,action){
 const member=memberById(id);if(!member)return null;
 if(action==='role'){
  const role=await chooseRole(member);
  if(!role||role===member.role)return null;
  await apiClient(`/api/users/${id}/role`,{role});
  return t('team.toastRoleUpdated');
 }
 if(action==='reset-access'){
  const password=await choosePassword(member);
  if(!password)return null;
  await apiClient(`/api/users/${id}/reset-access`,{password});
  return t('team.toastAccessReset');
 }
 if(action==='suspend'){await apiClient(`/api/users/${id}/suspend`,{});return t('team.toastSuspended');}
 if(action==='reactivate'){await apiClient(`/api/users/${id}/reactivate`,{});return t('team.toastReactivated');}
 if(action==='remove'){await apiClient(`/api/users/${id}/remove`,{});return t('team.toastRemoved');}
 if(action==='revoke-sessions'){await apiClient(`/api/users/${id}/revoke-sessions`,{});return t('team.toastSessionsRevoked');}
 return null;
}
export function installTeamInteractions(){
 document.addEventListener('click',e=>{
  const view=e.target.closest('[data-team-view]');
  if(view){openMember(view.dataset.teamView);return;}
 });
}
export async function clickTeam(button){
 return performAction(button.dataset.teamId,button.dataset.teamAction);
}
