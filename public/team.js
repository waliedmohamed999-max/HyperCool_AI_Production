import {escape,badge,empty,button,drawer,metric,tabs,table,initials,promptDrawer,enhance} from './components/ui/index.js';
import {fmtDateTime} from './format.js';
const $=selector=>document.querySelector(selector);
const PERMISSION_LABELS={MANAGE:'إدارة كاملة',EDIT:'إنشاء وتعديل',VIEW:'عرض فقط',NONE:'لا وصول'};
const ACTIVITY_LABELS={USER_CREATED:'إنشاء عضو',USER_ROLE_CHANGED:'تغيير الدور',USER_SUSPENDED:'إيقاف عضو',USER_REACTIVATED:'إعادة تفعيل عضو',USER_REMOVED:'حذف عضو',USER_ACCESS_RESET:'إعادة تعيين الوصول',USER_SESSIONS_REVOKED:'إنهاء جلسات عضو'};
let dashboard=null,apiClient=null;

function relativeTime(iso){
 if(!iso)return null;
 const diff=Date.now()-Date.parse(iso);
 if(diff<60000)return 'الآن';
 if(diff<3600000)return `منذ ${Math.floor(diff/60000)} دقيقة`;
 if(diff<86400000)return `منذ ${Math.floor(diff/3600000)} ساعة`;
 if(diff<172800000)return 'أمس';
 if(diff<604800000)return `منذ ${Math.floor(diff/86400000)} يوم`;
 return fmtDateTime(iso);
}
function lastActiveText(m){
 if(m.hasActiveSession)return 'متصل الآن';
 if(m.last_login_at)return relativeTime(m.last_login_at);
 return 'لم يسجل الدخول بعد';
}
function statusPill(status){return badge(status==='active'?'نشط':'موقوف',status==='active'?'CONNECTED':'ERROR');}
function memberById(id){return dashboard?.members.find(m=>m.id===id);}

function renderSummary(){
 const s=dashboard.summary;
 $('#team-summary').innerHTML=[
  metric('إجمالي الأعضاء',s.total,'كل الحسابات المسجلة في النظام','users'),
  metric('الأعضاء النشطون',s.active,'حسابات غير موقوفة','check'),
  metric('المُلّاك',s.owners,'يملكون كامل الصلاحيات بما فيها إدارة الفريق','agent'),
  metric('دعوات معلّقة',s.pendingInvitations,'لا يوجد نظام دعوات بالبريد في هذا الإصدار — الإضافة فورية بكلمة مرور','info')
 ].join('');
}
function renderMembers(){
 if(!dashboard.members.length){$('#team-members').innerHTML=empty('لا يوجد أعضاء بعد');return;}
 $('#team-members').innerHTML=table(
  ['العضو','اسم الدخول','الدور','الحالة','آخر نشاط','تاريخ الإنشاء','إجراءات'],
  dashboard.members.map(m=>[
   `<div class="row"><span class="avatar" aria-hidden="true">${escape(initials(m.name))}</span>${escape(m.name)}</div>`,
   `<span dir="ltr">${escape(m.username)}</span>`,
   escape(dashboard.roleNames[m.role]||m.role),
   statusPill(m.status),
   escape(lastActiveText(m)),
   m.created_at?fmtDateTime(m.created_at):'غير معروف',
   `<div class="row">
     <button type="button" data-team-view="${m.id}">التفاصيل</button>
     <button type="button" data-team-action="role" data-team-id="${m.id}">تغيير الدور</button>
     <button type="button" data-team-action="reset-access" data-team-id="${m.id}">إعادة تعيين الوصول</button>
     ${m.status==='active'
       ?`<button type="button" class="secondary" data-team-action="suspend" data-team-id="${m.id}" data-team-danger>إيقاف</button>`
       :`<button type="button" class="secondary" data-team-action="reactivate" data-team-id="${m.id}">تفعيل</button>`}
     <button type="button" class="secondary" data-team-action="remove" data-team-id="${m.id}" data-team-danger>حذف</button>
    </div>`
  ])
 );
}
function renderRoles(){
 $('#team-roles').innerHTML=Object.entries(dashboard.roleNames).map(([key,label])=>{
  const count=dashboard.members.filter(m=>m.role===key).length;
  return `<article class="card"><div class="row-between"><h3>${escape(label)}</h3><span class="pill">${count} عضو</span></div><p>${escape(dashboard.roleDescriptions[key]||'')}</p></article>`;
 }).join('');
}
function renderMatrix(){
 const roleKeys=Object.keys(dashboard.roleNames);
 $('#team-matrix').innerHTML=table(
  ['المجال',...roleKeys.map(k=>dashboard.roleNames[k])],
  dashboard.roleMatrix.map(row=>[escape(row.area),...roleKeys.map(k=>badge(PERMISSION_LABELS[row[k]]||row[k],row[k]==='MANAGE'?'CONNECTED':row[k]==='NONE'?'ERROR':row[k]==='EDIT'?'NEEDS_SETUP':'CONFIGURED_NO_CONNECTOR'))])
 );
}
function renderInvitations(){
 $('#team-invitations').innerHTML=empty('لا يوجد نظام دعوات بالبريد في هذا الإصدار','إضافة عضو تُنشئ حسابًا فعليًا بكلمة مرور فورية من زر «إضافة عضو» أعلى الصفحة — لا يوجد Invite Flow أو حالة Pending حقيقية بعد.');
}
function renderActivity(){
 if(!dashboard.activity.length){$('#team-activity').innerHTML=empty('لا توجد عمليات إدارة فريق مسجلة بعد');return;}
 $('#team-activity').innerHTML=table(
  ['الوقت','العملية','بواسطة','العضو المتأثر'],
  dashboard.activity.map(a=>[fmtDateTime(a.at),escape(ACTIVITY_LABELS[a.action]||a.action),escape(a.actorName||'—'),escape(a.itemName||'—')])
 );
}

function chooseRole(member){
 return promptDrawer('تغيير دور العضو',node=>{
  node.innerHTML=`<p>العضو: ${escape(member.name)} — الدور الحالي: ${escape(dashboard.roleNames[member.role]||member.role)}</p><label>الدور الجديد<select></select></label>`;
  const select=node.querySelector('select');
  select.innerHTML=Object.entries(dashboard.roleNames).map(([value,label])=>`<option value="${value}"${value===member.role?' selected':''}>${escape(label)}</option>`).join('');
  return {value:()=>select.value};
 },{confirmLabel:'حفظ الدور'});
}
function choosePassword(member){
 return promptDrawer('إعادة تعيين وصول العضو',node=>{
  node.innerHTML=`<p>سيتم استبدال كلمة مرور ${escape(member.name)} فورًا وإنهاء كل جلساته الحالية.</p><label>كلمة المرور الجديدة (12–256 حرفًا)<input type="text" dir="ltr" minlength="12" maxlength="256" required></label>`;
  const input=node.querySelector('input');
  const generate=button('توليد كلمة مرور قوية',{variant:'secondary'});
  generate.onclick=()=>{input.value=crypto.randomUUID().replace(/-/g,'').slice(0,20);input.setCustomValidity('');};
  node.append(generate);
  return {
   value:()=>input.value.trim(),
   validate:()=>{if(input.value.trim().length<12){input.setCustomValidity('12 حرفًا على الأقل');input.reportValidity();return false;}return true;}
  };
 },{confirmLabel:'حفظ كلمة المرور الجديدة'});
}
async function openMember(id){
 const m=memberById(id);if(!m)return;
 const profile=document.createElement('div');
 profile.innerHTML=`<p>الاسم: ${escape(m.name)}</p><p>اسم الدخول: <span dir="ltr">${escape(m.username)}</span></p><p>الحالة: ${statusPill(m.status)}</p><p>تاريخ الإنشاء: ${m.created_at?fmtDateTime(m.created_at):'غير معروف'}</p>`;

 const role=document.createElement('div');
 role.innerHTML=`<p>الدور الحالي: <b>${escape(dashboard.roleNames[m.role]||m.role)}</b></p><p>${escape(dashboard.roleDescriptions[m.role]||'')}</p>`;
 const changeRoleBtn=button('تغيير الدور',{variant:'secondary'});
 changeRoleBtn.onclick=async()=>{const text=await performAction(m.id,'role');if(text){drawerEl.close();document.dispatchEvent(new CustomEvent('team-refresh',{detail:text}));}};
 role.append(changeRoleBtn);

 const permissions=document.createElement('div');
 const roleKeys=Object.keys(dashboard.roleNames);
 permissions.innerHTML=table(['المجال',...roleKeys.map(k=>dashboard.roleNames[k])],dashboard.roleMatrix.map(row=>[escape(row.area),...roleKeys.map(k=>{const val=PERMISSION_LABELS[row[k]]||row[k];return k===m.role?`<b>${escape(val)}</b>`:escape(val);})]));

 const activity=document.createElement('div');
 activity.innerHTML='<p role="status">جارٍ تحميل النشاط…</p>';
 try{
  const state=await apiClient('/api/state');
  const rows=(state.audit||[]).filter(a=>a.actorId===m.id).slice(0,20);
  activity.innerHTML=rows.length?table(['الوقت','العملية'],rows.map(a=>[fmtDateTime(a.at),escape(ACTIVITY_LABELS[a.action]||a.action)])):empty('لا يوجد نشاط مسجل لهذا العضو بعد');
 }catch(error){activity.innerHTML=empty('تعذر تحميل النشاط',error.message);}

 const tasks=document.createElement('div');
 tasks.innerHTML=empty('لا يوجد نظام لإسناد مهام فردية لعضو في هذا الإصدار','راجع صفحات المحتوى والتقويم للاطلاع على العناصر العامة.');

 const approvals=document.createElement('div');
 approvals.innerHTML=empty('لا يوجد نظام يربط موافقات محددة بعضو منفرد في هذا الإصدار','راجع «مركز الموافقات والتصعيدات» لعرض القرارات المعلقة لكل الفريق.');

 const security=document.createElement('div');
 security.innerHTML=`<p>آخر تسجيل دخول: ${m.last_login_at?fmtDateTime(m.last_login_at):'لا يوجد سجل'}</p><p>الجلسة الحالية: ${m.hasActiveSession?'نشطة الآن':'لا توجد جلسة نشطة'}</p><p>محاولات الدخول الفاشلة: غير متاحة لكل عضو — التتبع الحالي في هذا الإصدار بحسب عنوان IP فقط.</p>`;
 if(m.hasActiveSession){
  const revoke=button('إنهاء كل الجلسات',{variant:'secondary'});
  revoke.onclick=async()=>{const text=await performAction(m.id,'revoke-sessions');if(text){drawerEl.close();document.dispatchEvent(new CustomEvent('team-refresh',{detail:text}));}};
  security.append(revoke);
 }

 const node=document.createElement('div');
 node.append(profile,role,permissions,activity,tasks,approvals,security);
 tabs(node,[['الملف الشخصي',profile],['الدور',role],['الصلاحيات',permissions],['النشاط الأخير',activity],['المهام المسندة',tasks],['الموافقات',approvals],['الأمان',security]]);
 const drawerEl=drawer(m.name,node,{restore:true});
 enhance(node);
}

export async function renderTeam({api}){
 apiClient=api;
 try{dashboard=await api('/api/team/dashboard');}catch(error){dashboard=null;console.error('team dashboard failed to load:',error);}
 if(!dashboard){$('#team-members').innerHTML=empty('تعذر تحميل بيانات الفريق');return;}
 renderSummary();renderMembers();renderRoles();renderMatrix();renderInvitations();renderActivity();
}
async function performAction(id,action){
 const member=memberById(id);if(!member)return null;
 if(action==='role'){
  const role=await chooseRole(member);
  if(!role||role===member.role)return null;
  await apiClient(`/api/users/${id}/role`,{role});
  return 'تم تحديث دور العضو';
 }
 if(action==='reset-access'){
  const password=await choosePassword(member);
  if(!password)return null;
  await apiClient(`/api/users/${id}/reset-access`,{password});
  return 'تم إعادة تعيين وصول العضو — شارك كلمة المرور الجديدة معه بقناة آمنة';
 }
 if(action==='suspend'){await apiClient(`/api/users/${id}/suspend`,{});return 'تم إيقاف العضو';}
 if(action==='reactivate'){await apiClient(`/api/users/${id}/reactivate`,{});return 'تمت إعادة تفعيل العضو';}
 if(action==='remove'){await apiClient(`/api/users/${id}/remove`,{});return 'تم حذف العضو';}
 if(action==='revoke-sessions'){await apiClient(`/api/users/${id}/revoke-sessions`,{});return 'تم إنهاء كل جلسات العضو';}
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
