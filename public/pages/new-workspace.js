// Multi-Tenant Phase 4C-6 — Create Workspace. Reachable in TWO situations (Part 8/48): a
// verified user with zero real workspaces (routed here instead of a dead end), and an existing
// user with at least one workspace who wants another (up to the self-service limit) via the
// workspace switcher's own "+ Create Workspace" entry. Placed OUTSIDE the normal
// `workspace.ready`-gated app shell — same rationale as pages/invite.js and pages/recovery.js —
// since the very case this exists for is "no workspace is ready yet".
import {escape,button} from '../components/ui/index.js';
import {t,getLocale} from '../i18n.js';

const $=s=>document.querySelector('#new-workspace-panel '+s);
export function isNewWorkspaceRoute(){return location.hash==='#new-workspace';}
export function installNewWorkspacePage(){/* built dynamically per render — nothing to wire once */}

export async function renderNewWorkspacePage(auth,api){
 document.querySelector('#auth-panel').hidden=true;
 document.querySelector('#workspace-select-panel').hidden=true;
 document.querySelector('#protected').hidden=true;
 document.querySelector('#session-bar').hidden=true;
 const panel=document.querySelector('#new-workspace-panel');
 panel.hidden=false;
 let eligibility;
 try{eligibility=await api('/api/workspaces/eligibility');}
 catch(error){panel.innerHTML=`<p class="field-error">${escape(error.message)}</p>`;return;}
 panel.innerHTML=`<h2>${escape(t('workspace.newWorkspace.title'))}</h2><p>${escape(t('workspace.newWorkspace.subtitle'))}</p>`;
 if(!eligibility.allowed){panel.innerHTML+=`<p class="field-error">${escape(t('workspace.newWorkspace.notAllowed'))}</p>`;appendBack(panel);return;}
 if(!eligibility.emailVerified){panel.innerHTML+=`<p class="field-error">${escape(t('workspace.newWorkspace.emailRequired'))}</p>`;const go=button(t('workspace.goToAccountSettings'),{variant:'primary'});go.onclick=()=>{location.hash='#account';};panel.append(go);return;}
 if(eligibility.ownedCount>=eligibility.maxOwnedWorkspaces){panel.innerHTML+=`<p class="field-error">${escape(t('workspace.newWorkspace.limitReached',{limit:eligibility.maxOwnedWorkspaces}))}</p>`;appendBack(panel);return;}

 panel.innerHTML+=`<p class="kpi-context">${escape(t('workspace.newWorkspace.trialNote',{days:eligibility.trialDays}))}</p>
  <form id="new-workspace-form">
   <label>${escape(t('workspace.newWorkspace.companyNameLabel'))}<input name="companyName" required maxlength="100"></label>
   <label>${escape(t('workspace.newWorkspace.slugLabel'))}<input name="slug" maxlength="60" dir="ltr" pattern="[a-z0-9]+(-[a-z0-9]+)*"><small>${escape(t('workspace.newWorkspace.slugHint'))}</small></label>
   <label>${escape(t('workspace.newWorkspace.languageLabel'))}<select name="defaultLocale"><option value="ar"${getLocale()==='ar'?' selected':''}>العربية</option><option value="en"${getLocale()==='en'?' selected':''}>English</option></select></label>
   <label>${escape(t('workspace.newWorkspace.timezoneLabel'))}<input name="timezone" value="${escape(Intl.DateTimeFormat().resolvedOptions().timeZone||'Asia/Riyadh')}" maxlength="60"></label>
   <button type="submit">${escape(t('workspace.newWorkspace.submit'))}</button>
  </form>`;
 appendBack(panel);
 const form=panel.querySelector('#new-workspace-form');
 form.onsubmit=async event=>{
  event.preventDefault();
  // `stopPropagation` matters here: app.js's own generic `document.addEventListener('submit',
  // ...)` delegate also listens for every submit event bubbling from anywhere in the
  // document, including this standalone-flow form — without this it falls through that
  // delegate's own ternary to a bogus `/api/content/undefined/undefined` POST (harmless, since
  // it 404s and is ignored either side, but a real stray request worth not sending at all).
  event.stopPropagation();
  const submitBtn=form.querySelector('button');
  submitBtn.disabled=true;submitBtn.textContent=t('workspace.newWorkspace.submitting');
  form.querySelector('.field-error')?.remove();
  const input=Object.fromEntries(new FormData(form));
  if(!input.slug)delete input.slug;
  try{
   // A raw fetch, not the shared `api()` helper: on a 409 WORKSPACE_SLUG_TAKEN this endpoint's
   // body carries a real `suggestion` field alongside `error` — `api()` only ever preserves
   // `error.message`, exactly the same reason workspace-switcher.js's own `raw()` exists.
   const response=await fetch('/api/workspaces',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':auth.csrf||''},body:JSON.stringify(input)});
   const value=await response.json();
   if(!response.ok) {
    const message=value.error==='WORKSPACE_SLUG_TAKEN' && value.suggestion?t('workspace.newWorkspace.slugTaken',{suggestion:value.suggestion}):value.error;
    throw new Error(message);
   }
   // The new workspace is already the session's active one server-side (Part 22) — jump
   // straight into the existing Guided Onboarding wizard (Part 23/24) rather than the
   // default overview, via a real reload so the whole app boots fresh into the new context.
   history.replaceState(null,'','#onboarding');
   location.reload();
  }catch(error){
   submitBtn.disabled=false;submitBtn.textContent=t('workspace.newWorkspace.submit');
   const note=document.createElement('p');note.className='field-error';note.setAttribute('role','alert');note.textContent=error.message;form.append(note);
  }
 };
}
function appendBack(panel){
 const back=button(t('account.recovery.backToApp'),{variant:'ghost'});
 back.onclick=()=>{history.replaceState(null,'','#overview');location.reload();};
 panel.append(back);
}
