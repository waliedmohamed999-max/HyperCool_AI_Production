// Multi-Tenant Phase 4C-3 — Invitation acceptance page. Deliberately OUTSIDE the normal
// auth-gated `#protected` flow (an invitee may have no session at all yet): this renders into
// its own `#invite-panel` section based on `location.hash` alone, checked BEFORE app.js's
// normal auth-panel/protected toggle. The invitation TOKEN is read from the hash
// (`#invite/<token>`) and is the page's entire security context — never persisted to
// localStorage, and cleared from the visible URL immediately after a successful accept
// (Part 19).
import {escape,button} from '../components/ui/index.js';
import {t} from '../i18n.js';

const $=s=>document.querySelector('#invite-panel '+s);
// `#invite/accepted` is the post-success sentinel `showSuccess()` below leaves in the visible
// URL — it must NEVER be treated as a route to render again (a page reload on that exact hash,
// e.g. from clicking "Go to workspace", would otherwise call this page with the literal string
// "accepted" as a token, get a real 404 from the preview endpoint, and strand the user on a
// permanent "invalid invitation" screen — found via this phase's own real-browser regression
// testing, see docs/SAAS_ENTRY_FLOW.md).
export function isInviteRoute(){return location.hash.startsWith('#invite/') && location.hash!=='#invite/accepted';}
function tokenFromHash(){return location.hash.slice('#invite/'.length);}

export function installInvitePage(){/* built dynamically per render — nothing to wire once */}

/** Called from app.js's render() BEFORE the normal auth-panel/protected toggle whenever
 * `isInviteRoute()` is true. `auth` is the same `/api/auth` response app.js already fetched
 * this cycle — never a second identity check. */
export async function renderInvitePage(auth,api){
 document.querySelector('#auth-panel').hidden=true;
 document.querySelector('#workspace-select-panel').hidden=true;
 document.querySelector('#protected').hidden=true;
 document.querySelector('#session-bar').hidden=true;
 const panel=document.querySelector('#invite-panel');
 panel.hidden=false;
 const token=tokenFromHash();
 panel.innerHTML=`<p>${escape(t('common.loading'))}</p>`;
 let preview;
 try{preview=await rawGet(`/api/invitations/${token}/preview`);}
 catch(error){panel.innerHTML=`<h2>${escape(t('invitations.invalidTitle'))}</h2><p>${escape(error.message)}</p>`+backLink();return;}
 if(preview.status!=='PENDING'){
  const key=preview.status==='EXPIRED'?'invitations.statusExpiredMessage':preview.status==='REVOKED'?'invitations.statusRevokedMessage':'invitations.statusAcceptedMessage';
  panel.innerHTML=`<h2>${escape(t('invitations.invalidTitle'))}</h2><p>${escape(t(key))}</p>`+backLink();
  return;
 }
 const roleLabel=t('workspace.role'+preview.role.charAt(0).toUpperCase()+preview.role.slice(1));
 if(auth.user){
  panel.innerHTML=`<h2>${escape(t('invitations.acceptTitle',{workspace:preview.workspaceName}))}</h2>
   <p>${escape(t('invitations.roleWillBe',{role:roleLabel}))}</p>`;
  const acceptBtn=button(t('invitations.joinButton'),{variant:'primary'});
  panel.append(acceptBtn);
  acceptBtn.onclick=async()=>{
   acceptBtn.disabled=true;
   try{
    await api(`/api/invitations/${token}/accept`,{});
    showSuccess(panel,preview.workspaceName);
   }catch(error){acceptBtn.disabled=false;const p=document.createElement('p');p.className='field-error';p.textContent=error.message;panel.append(p);}
  };
  return;
 }
 // Not authenticated: offer both a login form (existing account) and a registration form
 // (brand-new account) — never auto-creating or auto-joining without an explicit submit.
 panel.innerHTML=`<h2>${escape(t('invitations.inviteTitle',{workspace:preview.workspaceName}))}</h2>
  <p>${escape(t('invitations.roleWillBe',{role:roleLabel}))}</p>
  <div class="ui-tabs" role="tablist"><button type="button" class="button tab" data-mode="login" aria-selected="true">${escape(t('common.login'))}</button><button type="button" class="button tab" data-mode="register" aria-selected="false">${escape(t('invitations.createAccount'))}</button></div>
  <form id="invite-login-form" hidden>
   <label>${escape(t('common.usernameLabel'))}<input name="username" required autocomplete="username" dir="ltr"></label>
   <label>${escape(t('common.passwordLabel'))}<input name="password" type="password" required minlength="12" maxlength="256" autocomplete="current-password"></label>
   <button type="submit">${escape(t('common.login'))}</button>
  </form>
  <form id="invite-register-form">
   <label>${escape(t('common.nameLabel'))}<input name="name" required maxlength="100"></label>
   <label>${escape(t('common.usernameLabel'))}<input name="username" required autocomplete="username" pattern="[a-zA-Z0-9_.\\-]{3,40}" dir="ltr"></label>
   <label>${escape(t('common.passwordLabel'))}<input name="password" type="password" required minlength="12" maxlength="256" autocomplete="new-password"></label>
   <button type="submit">${escape(t('invitations.createAccountAndJoin'))}</button>
  </form>`;
 const loginForm=panel.querySelector('#invite-login-form'),registerForm=panel.querySelector('#invite-register-form');
 panel.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{
  const isLogin=b.dataset.mode==='login';
  loginForm.hidden=!isLogin;registerForm.hidden=isLogin;
  panel.querySelectorAll('[data-mode]').forEach(x=>x.setAttribute('aria-selected',String(x===b)));
 });
 loginForm.onsubmit=async event=>{
  event.preventDefault();
  // See recovery.js's identical comment: stops this bubbling into app.js's generic
  // document-level submit delegate, which would otherwise 404 a stray, harmless request.
  event.stopPropagation();
  const input=Object.fromEntries(new FormData(loginForm));
  const submitBtn=loginForm.querySelector('button');submitBtn.disabled=true;
  try{
   const result=await rawPost('/api/login',input);
   await rawPostWithCsrf(`/api/invitations/${token}/accept`,{},result.csrf);
   showSuccess(panel,preview.workspaceName);
  }catch(error){submitBtn.disabled=false;reportFormError(loginForm,error.message);}
 };
 registerForm.onsubmit=async event=>{
  event.preventDefault();
  event.stopPropagation();
  const input=Object.fromEntries(new FormData(registerForm));
  const submitBtn=registerForm.querySelector('button');submitBtn.disabled=true;
  try{
   await rawPost(`/api/invitations/${token}/register`,input);
   showSuccess(panel,preview.workspaceName);
  }catch(error){submitBtn.disabled=false;reportFormError(registerForm,error.message);}
 };
}
function reportFormError(form,message){form.querySelector('.field-error')?.remove();const p=document.createElement('p');p.className='field-error';p.setAttribute('role','alert');p.textContent=message;form.append(p);}
function showSuccess(panel,workspaceName){
 panel.innerHTML=`<h2>${escape(t('invitations.successTitle'))}</h2><p>${escape(t('invitations.successMessage',{workspace:workspaceName}))}</p>`;
 const go=button(t('invitations.goToWorkspace'),{variant:'primary'});
 go.onclick=()=>{history.replaceState(null,'','#overview');location.reload();};
 panel.append(go);
 // Remove the token from the visible URL immediately (Part 19) — the acceptance already
 // happened server-side; there is nothing left for the token to authorize on this page.
 history.replaceState(null,'','#invite/accepted');
}
function backLink(){
 const el=document.createElement('p');
 const link=document.createElement('a');link.href='#overview';link.textContent=t('invitations.backToApp');
 el.append(link);
 return el.outerHTML;
}
async function rawGet(path){
 const res=await fetch(path);
 const data=await res.json().catch(()=>({}));
 if(!res.ok)throw new Error(data.error||res.statusText);
 return data;
}
async function rawPost(path,body){
 const res=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const data=await res.json().catch(()=>({}));
 if(!res.ok)throw new Error(data.error||res.statusText);
 return data;
}
async function rawPostWithCsrf(path,body,csrf){
 const res=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});
 const data=await res.json().catch(()=>({}));
 if(!res.ok)throw new Error(data.error||res.statusText);
 return data;
}
