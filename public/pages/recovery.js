// Multi-Tenant Phase 4C-5 — Platform Identity recovery pages: email verification, forgot
// password, and password reset. Same pattern as pages/invite.js: OUTSIDE the normal
// auth-gated `#protected` flow (a visitor may have no session, or an expired one, or be on a
// different device/browser than where they're logged in), rendered into their own
// `#recovery-panel` based on `location.hash` alone, checked BEFORE app.js's normal
// auth-panel/protected toggle. Every token here is read from the hash and is the page's
// entire security context — never persisted to localStorage (Part 18), and the URL is cleaned
// immediately after a successful verify (Part 18) exactly like the invite page already does.
import {escape,button} from '../components/ui/index.js';
import {t} from '../i18n.js';

const $=s=>document.querySelector('#recovery-panel '+s);
export function isRecoveryRoute(){
 return location.hash.startsWith('#verify-email/')||location.hash==='#forgot-password'||location.hash.startsWith('#reset-password/');
}
export function installRecoveryPage(){/* built dynamically per render — nothing to wire once */}

export async function renderRecoveryPage(){
 document.querySelector('#auth-panel').hidden=true;
 document.querySelector('#workspace-select-panel').hidden=true;
 document.querySelector('#protected').hidden=true;
 document.querySelector('#session-bar').hidden=true;
 const panel=document.querySelector('#recovery-panel');
 panel.hidden=false;
 if(location.hash.startsWith('#verify-email/'))return renderVerifyEmail(panel);
 if(location.hash==='#forgot-password')return renderForgotPassword(panel);
 if(location.hash.startsWith('#reset-password/'))return renderResetPassword(panel);
}

async function renderVerifyEmail(panel){
 const token=location.hash.slice('#verify-email/'.length);
 panel.innerHTML=`<h2>${escape(t('account.recovery.verifyingTitle'))}</h2>`;
 try{
  const result=await rawPost('/api/account/email/verify',{token});
  history.replaceState(null,'','#verify-email/done'); // clear the raw token from the visible URL (Part 18)
  panel.innerHTML=`<h2>${escape(t('account.recovery.verifySuccessTitle'))}</h2><p>${escape(t('account.recovery.verifySuccessBody',{email:result.email}))}</p>`;
  panel.append(backButton());
 }catch(error){
  panel.innerHTML=`<h2>${escape(t('account.recovery.verifyFailedTitle'))}</h2><p>${escape(error.message)}</p>`;
  panel.append(backButton());
 }
}
function renderForgotPassword(panel){
 panel.innerHTML=`<h2>${escape(t('account.recovery.forgotTitle'))}</h2><p>${escape(t('account.recovery.forgotHint'))}</p>
  <form id="forgot-form"><label>${escape(t('account.emailInputLabel'))}<input name="email" type="email" required dir="ltr"></label><button type="submit">${escape(t('account.recovery.forgotSubmit'))}</button></form>`;
 panel.append(backButton());
 panel.querySelector('#forgot-form').onsubmit=async event=>{
  event.preventDefault();
  const form=event.target,submitBtn=form.querySelector('button');submitBtn.disabled=true;
  const input=Object.fromEntries(new FormData(form));
  try{
   const result=await rawPost('/api/auth/forgot-password',{email:input.email,locale:document.documentElement.lang});
   panel.innerHTML=`<h2>${escape(t('account.recovery.forgotTitle'))}</h2><p>${escape(result.message)}</p>`;
   panel.append(backButton());
  }catch(error){submitBtn.disabled=false;reportFormError(form,error.message);}
 };
}
function renderResetPassword(panel){
 const token=location.hash.slice('#reset-password/'.length);
 panel.innerHTML=`<h2>${escape(t('account.recovery.resetTitle'))}</h2><p>${escape(t('account.recovery.resetHint'))}</p>
  <form id="reset-form"><label>${escape(t('account.recovery.resetPasswordLabel'))}<input name="password" type="password" required minlength="12" maxlength="256" autocomplete="new-password"></label><button type="submit">${escape(t('account.recovery.resetSubmit'))}</button></form>`;
 panel.querySelector('#reset-form').onsubmit=async event=>{
  event.preventDefault();
  const form=event.target,submitBtn=form.querySelector('button');submitBtn.disabled=true;
  const input=Object.fromEntries(new FormData(form));
  try{
   await rawPost('/api/auth/reset-password',{token,password:input.password});
   panel.innerHTML=`<h2>${escape(t('account.recovery.resetSuccessTitle'))}</h2><p>${escape(t('account.recovery.resetSuccessBody'))}</p>`;
   const go=button(t('account.recovery.goToLogin'),{variant:'primary'});
   go.onclick=()=>{history.replaceState(null,'','#overview');location.reload();};
   panel.append(go);
   history.replaceState(null,'','#reset-password/done'); // clear the raw token (Part 18)
  }catch(error){submitBtn.disabled=false;reportFormError(form,error.message);}
 };
}
function reportFormError(form,message){form.querySelector('.field-error')?.remove();const p=document.createElement('p');p.className='field-error';p.setAttribute('role','alert');p.textContent=message;form.append(p);}
// A real reload (matching pages/invite.js's own `showSuccess()`) rather than a plain hash
// link: leaving this route must restore the normal auth-panel/protected visibility toggles,
// which only a fresh `render()` cycle sets correctly — simplest and safest is the same
// deliberate full-reload pattern already used elsewhere in this codebase for this exact kind
// of "exit a standalone recovery/invite flow back into the normal app" transition.
function backButton(){
 const b=button(t('account.recovery.backToApp'),{variant:'ghost'});
 b.onclick=()=>{history.replaceState(null,'','#overview');location.reload();};
 return b;
}
async function rawPost(path,body){
 const res=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const data=await res.json().catch(()=>({}));
 if(!res.ok)throw new Error(data.error||res.statusText);
 return data;
}
