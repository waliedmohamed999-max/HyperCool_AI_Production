// Multi-Tenant Phase 4C-5 — Account Settings. USER identity only (Part 36/37) — never a
// workspace/tenant setting; those stay in Control Center. Visible to every authenticated role
// (owner/reviewer/operator) since it is personal, unlike Control Center/Onboarding which are
// owner/operator only.
import {escape,button,badge,promptDrawer,toast as showToast} from '../components/ui/index.js';
import {t} from '../i18n.js';

const $=s=>document.querySelector('#account '+s);
let apiClient,currentAuth,renderGeneration=0;

function toast(text){showToast(text,'success');}
function toastError(text){showToast(text,'error');}
function staleGuard(generation){return generation!==renderGeneration;}

export function installAccountPage(){
 const root=document.querySelector('[data-page="account"] #account');
 root.innerHTML=`<div id="acct-summary" class="panel"></div>`;
}

export async function renderAccountPage({api:client,auth}){
 apiClient=client;currentAuth=auth;
 if(!auth.user)return;
 const generation=++renderGeneration;
 let identity;
 try{identity=await apiClient('/api/account');}
 catch{return;}
 if(staleGuard(generation))return;
 paintAccount(identity,auth);
}

function paintAccount(identity,auth){
 const container=$('#acct-summary');
 container.innerHTML=`<p><strong>${escape(t('account.usernameLabel'))}:</strong> <span dir="ltr">${escape(identity.username)}</span></p>
  <h3>${escape(t('account.emailSection'))}</h3>
  <div id="acct-email-status"></div>
  <h3>${escape(t('account.passwordSection'))}</h3>
  <p id="acct-password-hint"></p>`;
 paintEmailStatus(container.querySelector('#acct-email-status'),identity);
 container.querySelector('#acct-password-hint').textContent=identity.email?t('account.passwordHint'):t('account.passwordNoEmailHint');
}

function paintEmailStatus(host,identity){
 host.innerHTML='';
 if(identity.email) {
  const row=document.createElement('p');
  row.innerHTML=`<span dir="ltr">${escape(identity.email)}</span> ${badge(t('account.verifiedEmail'),'CONNECTED')}`;
  host.append(row);
  const change=button(t('account.changeEmail'),{variant:'secondary'});
  change.onclick=()=>openEmailDrawer();
  host.append(change);
 } else if(identity.pendingEmail) {
  const row=document.createElement('p');
  row.innerHTML=`<span dir="ltr">${escape(identity.pendingEmail)}</span> ${badge(t('account.pendingEmail'),'PENDING')}`;
  host.append(row);
  const resend=button(t('account.resendVerification'),{variant:'secondary'});
  resend.onclick=async()=>{
   resend.disabled=true;
   try{const result=await apiClient('/api/account/email/resend-verification',{});reportDelivery(result);}
   catch(error){toastError(error.message);}
   finally{resend.disabled=false;}
  };
  const change=button(t('account.changeEmail'),{variant:'ghost'});
  change.onclick=()=>openEmailDrawer();
  host.append(resend,change);
 } else {
  const empty=document.createElement('p');empty.textContent=t('account.noEmailHint');host.append(empty);
  const add=button(t('account.addEmail'),{variant:'primary',iconName:'plus'});
  add.onclick=()=>openEmailDrawer();
  host.append(add);
 }
}
function reportDelivery(result){
 if(result.delivered)toast(t('account.deliveredNote'));
 else toastError(t('account.notDeliveredNote'));
 renderAccountPage({api:apiClient,auth:currentAuth}); // re-fetch fresh identity/pending state
}
function openEmailDrawer(){
 promptDrawer(t('account.addEmail'),node=>{
  const input=document.createElement('input');input.name='email';input.type='email';input.required=true;input.maxLength=254;input.dir='ltr';
  const label=document.createElement('label');label.textContent=t('account.emailInputLabel');label.append(input);
  node.append(label);
  return {value:()=>input.value.trim(),focus:()=>input.focus()};
 },{confirmLabel:t('account.save')}).then(async email=>{
  if(!email)return;
  try{
   const result=await apiClient('/api/account/email',{email});
   reportDelivery(result);
  }catch(error){toastError(error.message);}
 });
}
