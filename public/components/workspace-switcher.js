// Phase 4C-1 — minimal Workspace Switcher UI. Backend-first by design (see
// docs/WORKSPACE_SELECTION.md): this module only ever calls the real
// GET /api/workspaces[/active] and PUT /api/workspaces/active endpoints — it never assumes,
// caches independently, or invents a workspace id. For the one real deployment that exists
// today (a single tenant, one membership per user) this renders nothing at all: `renderSwitcher`
// is a no-op below 2 workspaces (Part K: "for one workspace, keep UX simple").
import {icon,escape,button} from './ui/index.js';
import {t} from '../i18n.js';

const $=selector=>document.querySelector(selector);
const ROLE_LABEL={owner:'workspace.roleOwner',reviewer:'workspace.roleReviewer',operator:'workspace.roleOperator'};

/**
 * Raw fetch, deliberately bypassing app.js's generic `api()` helper: that helper only ever
 * preserves `error.message` on a non-2xx response, but the workspace-selection endpoints put
 * real, needed data (the `workspaces` list) inside a non-2xx body too (409/403) — this reads
 * the full JSON body regardless of status, and never throws on the expected
 * TENANT_SELECTION_REQUIRED/NO_WORKSPACE_ACCESS outcomes.
 */
async function raw(path,input,method,csrf) {
 const hasBody=input!==undefined && input!==null;
 const response=await fetch(path,{method:method||(hasBody?'PUT':'GET'),headers:{...(hasBody?{'Content-Type':'application/json'}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},...(hasBody?{body:JSON.stringify(input)}:{})});
 let data=null;try{data=await response.json();}catch{/* no body */}
 return {status:response.status,ok:response.ok,data};
}
/**
 * Called once per render() cycle, right after `auth` resolves, BEFORE any tenant-scoped
 * dashboard call is made (Part L: "Do not load tenant-scoped dashboards before workspace is
 * selected"). Returns `{ready:true}` once a workspace is genuinely active (including the
 * common case of exactly one membership, resolved with zero friction), or
 * `{ready:false, reason, workspaces}` when the caller must show the selection gate instead of
 * proceeding — `reason` is the real backend error code, never invented client-side.
 */
export async function resolveActiveWorkspace(csrf) {
 const result=await raw('/api/workspaces/active',null,'GET');
 if(result.status===200)return {ready:true,workspace:result.data};
 return {ready:false,reason:result.data?.error||'TENANT_SELECTION_REQUIRED',workspaces:result.data?.workspaces||[]};
}
async function activate(workspaceId,csrf) {
 return raw('/api/workspaces/active',{workspaceId},'PUT',csrf);
}
function roleLabel(role){return t(ROLE_LABEL[role]||'')||role;}

/** The full-page "choose your workspace" gate (Part L). Never auto-picks the first item. */
export function renderWorkspaceGate({reason,workspaces},csrf,onActivated) {
 $('#workspace-select-panel').hidden=false;
 const list=$('#workspace-select-list'),empty=$('#workspace-select-empty');
 list.replaceChildren();
 empty.hidden=reason!=='NO_WORKSPACE_ACCESS' && workspaces.length>0;
 if(empty.hidden===false)return;
 for(const workspace of workspaces) {
  const row=document.createElement('div');row.className='workspace-select-item';
  const info=document.createElement('div');info.innerHTML=`<strong>${escape(workspace.name)}</strong><span>${escape(roleLabel(workspace.role))}</span>`;
  const pick=button(t('common.confirm')||'اختيار',{variant:'primary'});
  pick.onclick=async()=>{
   pick.disabled=true;
   try{
    const result=await activate(workspace.id,csrf);
    if(!result.ok)throw new Error(result.data?.error||t('workspace.activateFailed'));
    onActivated(result.data);
   }catch(error){pick.disabled=false;const note=document.createElement('p');note.className='field-error';note.textContent=error.message;row.append(note);}
  };
  row.append(info,pick);list.append(row);
 }
}
export function hideWorkspaceGate(){$('#workspace-select-panel').hidden=true;}

/**
 * The session-bar switcher — rendered only when the user actually has more than one real
 * workspace (Part K), so the single-tenant deployment sees no UI change at all. `workspaces`
 * always comes from a fresh `GET /api/workspaces` call, never memoized across renders, so a
 * membership change (added/removed) is reflected the next time this runs.
 */
export async function renderWorkspaceSwitcher(active,csrf,onSwitched) {
 const host=$('#workspace-switcher');
 host.replaceChildren();
 const listResult=await raw('/api/workspaces',null,'GET');
 const workspaces=listResult.ok?listResult.data:[];
 if(workspaces.length<2)return; // single workspace: no switcher shown at all
 const menu=document.createElement('details');menu.className='dropdown workspace-switcher';
 const summary=document.createElement('summary');summary.setAttribute('aria-label',t('workspace.switchAriaLabel'));
 summary.innerHTML=`${icon('grid')}<span>${escape(active?.name||'')}</span>`;
 const items=document.createElement('div');items.className='dropdown-items';
 for(const workspace of workspaces) {
  const b=button('',{variant:'ghost'});
  b.innerHTML=`<span class="workspace-switcher-item"><span>${escape(workspace.name)}</span>${workspace.isActive?`<span class="pill">${escape(t('workspace.currentBadge'))}</span>`:''}</span>`;
  b.onclick=async()=>{
   menu.open=false;
   if(workspace.isActive)return;
   const result=await activate(workspace.id,csrf);
   if(result.ok)onSwitched(result.data);
  };
  items.append(b);
 }
 menu.append(summary,items);
 menu.addEventListener('keydown',e=>{if(e.key==='Escape'){menu.open=false;summary.focus();}});
 document.addEventListener('click',e=>{if(!menu.contains(e.target))menu.open=false;});
 host.append(menu);
}
