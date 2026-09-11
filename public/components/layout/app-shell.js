import {icon,button,header,drawer,escape,dropdown,tooltip,initials} from '../ui/index.js';
import {t,onLocaleChange,getLocale,setLocale} from '../../i18n.js';
// Route metadata: only the icon is fixed — title/description are always looked up live from
// the current locale's navigation.json so a language switch relabels every page instantly.
const ROUTE_ICONS={overview:'grid',crm:'users',planning:'calendar',reports:'chart',content:'file',agents:'agent',knowledge:'book',integrations:'plug','control-center':'plug',onboarding:'check',audit:'clock',users:'users'};
const ROUTE_KEYS=Object.keys(ROUTE_ICONS);
function routeTitle(key){return t(`navigation.${key}.title`);}
function routeDescription(key){return t(`navigation.${key}.description`);}
export const routes=new Proxy({},{
 get:(_,key)=>ROUTE_ICONS[key]?[routeTitle(key),routeDescription(key),ROUTE_ICONS[key]]:undefined,
 ownKeys:()=>ROUTE_KEYS,
 has:(_,key)=>key in ROUTE_ICONS,
 getOwnPropertyDescriptor:(_,key)=>ROUTE_ICONS[key]?{enumerable:true,configurable:true}:undefined
});
let currentUser=null,cache=new Map(),apiClient,closeMobile=()=>{};
// The three real nav-group boundaries (already used for the section labels below) become
// the icon rail — one icon per group, jumping to its first page. Not a decorative repeat
// of the panel list: it is the only quick way to jump straight to a group from anywhere.
const RAIL_GROUPS=[['overview','grid','navigation.operationsGroup'],['content','agent','navigation.aiOperationsGroup'],['integrations','plug','navigation.systemGroup']];
const MOBILE_TABS=[['overview','grid'],['crm','users'],['content','file'],['agents','agent']];
function railGroupIndex(route){
 const order=ROUTE_KEYS;const at=key=>order.indexOf(key);
 let idx=0;for(let i=0;i<RAIL_GROUPS.length;i++)if(at(route)>=at(RAIL_GROUPS[i][0]))idx=i;
 return idx;
}
export function installShell(){
 const aside=document.querySelector('body>aside');aside.className='app-sidebar';
 const nav=aside.querySelector('nav');
 const groupSpans=new Map();
 for(const [key] of [['overview'],['content'],['integrations']]){const el=document.createElement('span');el.className='nav-group';nav.querySelector(`[href="#${key}"]`).before(el);groupSpans.set(key,el);}
 const rail=document.createElement('div');rail.className='sidebar-rail';
 rail.innerHTML='<div class="rail-brand">H</div>'+RAIL_GROUPS.map(([key])=>`<button type="button" class="rail-icon" data-rail="${key}"></button>`).join('');
 rail.querySelectorAll('[data-rail]').forEach(b=>b.onclick=()=>navigate(b.dataset.rail));
 document.body.prepend(rail);
 for(const link of nav.querySelectorAll('a')){const id=link.hash.slice(1);link.innerHTML=`<span class="nav-icon"></span><span></span>`;link.onclick=()=>closeMobile();}
 const footer=document.createElement('div');footer.className='sidebar-footer';footer.innerHTML='<button type="button" class="profile-button" id="profile-button"><span class="avatar" id="user-initials">—</span><span class="profile-copy"><strong id="profile-name"></strong><small id="profile-role"></small></span></button>';
 footer.append(document.querySelector('#session-bar'));aside.append(footer);footer.append(aside.querySelector('.local'));
 const top=document.createElement('div');top.className='topbar';top.innerHTML=`<div class="breadcrumbs"><button type="button" class="ghost mobile-nav-button" aria-expanded="false">${icon('menu')}</button><span class="crumb-workspace"></span><span>/</span><strong id="breadcrumb-page"></strong></div><div class="topbar-tools"><button type="button" class="secondary search-trigger" id="global-search">${icon('search')}<span class="search-label"></span><kbd dir="ltr">Ctrl K</kbd></button><span class="system-indicator" id="system-status"></span><button type="button" class="ghost" id="notifications">${icon('bell')}<span id="notification-count">0</span></button></div>`;
 document.querySelector('main').prepend(top);
 const skip=document.createElement('a');skip.href='#protected';skip.className='skip-link';document.body.prepend(skip);document.querySelector('#protected').tabIndex=-1;
 const pageHeaders=new Map();
 for(const key of ROUTE_KEYS){const page=document.querySelector(`[data-page="${key}"]`);if(key==='overview')page.replaceChildren();const el=header(routeTitle(key),routeDescription(key));page.prepend(el);pageHeaders.set(key,el);const duplicate=page.querySelector(':scope>section>.section-title');if(duplicate&&!duplicate.querySelector('button'))duplicate.classList.add('page-intro-duplicate');}
 const dock=document.createElement('nav');dock.className='mobile-tabbar';
 dock.innerHTML=MOBILE_TABS.map(([key,glyph])=>`<button type="button" data-mobile-route="${key}">${icon(glyph)}<span></span></button>`).join('')+`<button type="button" class="mobile-more" aria-expanded="false">${icon('menu')}<span></span></button>`;
 document.body.append(dock);
 dock.querySelectorAll('[data-mobile-route]').forEach(b=>b.onclick=()=>{navigate(b.dataset.mobileRoute);window.scrollTo({top:0,behavior:'instant'});});
 const menuButton=top.querySelector('.mobile-nav-button');let returnFocus;
 dock.querySelector('.mobile-more').onclick=()=>menuButton.click();

 closeMobile=()=>{aside.classList.remove('mobile-open');dock.inert=false;document.body.classList.remove('mobile-menu-open');dock.querySelector('.mobile-more').setAttribute('aria-expanded','false');document.querySelector('.mobile-scrim')?.remove();menuButton.setAttribute('aria-expanded','false');document.querySelector('main').inert=false;if(returnFocus){returnFocus.focus();returnFocus=null;}};
 menuButton.onclick=()=>{returnFocus=document.activeElement;aside.classList.add('mobile-open');dock.inert=true;document.body.classList.add('mobile-menu-open');dock.querySelector('.mobile-more').setAttribute('aria-expanded','true');menuButton.setAttribute('aria-expanded','true');const scrim=document.createElement('div');scrim.className='mobile-scrim';document.body.append(scrim);scrim.onclick=closeMobile;document.querySelector('main').inert=true;nav.querySelector('a.active')?.focus();};
 aside.addEventListener('keydown',e=>{if(!aside.classList.contains('mobile-open'))return;if(e.key==='Escape'){closeMobile();return;}if(e.key==='Tab'){const focus=[...aside.querySelectorAll('a,button')].filter(el=>el.getClientRects().length);if(e.shiftKey&&document.activeElement===focus[0]){e.preventDefault();focus.at(-1).focus();}else if(!e.shiftKey&&document.activeElement===focus.at(-1)){e.preventDefault();focus[0].focus();}}});
 const dismiss=document.createElement('button');dismiss.type='button';dismiss.className='mobile-menu-dismiss';dismiss.onclick=closeMobile;aside.prepend(dismiss);
 document.querySelector('#global-search').onclick=openSearch;
 const notificationTip=tooltip(document.querySelector('#notifications'),'');
 const accountDropdown=dropdown('',[
  ['',()=>document.querySelector('#profile-button').click()],
  ['',()=>navigate(currentUser?.role==='owner'?'users':'integrations')],
  ['',()=>document.querySelector('#logout').click()]
 ]);
 const langSwitch=document.createElement('div');langSwitch.className='lang-switch';langSwitch.setAttribute('role','group');
 langSwitch.innerHTML=`<button type="button" data-locale="ar">AR</button><button type="button" data-locale="en">EN</button>`;
 langSwitch.querySelectorAll('[data-locale]').forEach(b=>b.onclick=()=>changeLocale(b.dataset.locale));
 top.querySelector('.topbar-tools').append(langSwitch,accountDropdown);
 document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'&&currentUser){e.preventDefault();openSearch();}});
 document.querySelector('#profile-button').onclick=()=>{const node=document.createElement('div');node.innerHTML=`<span class="avatar">${escape(initials(currentUser?.name))}</span><h3>${escape(currentUser?.name)}</h3><p dir="ltr">${escape(currentUser?.username)}</p><p>${escape(roleName(currentUser?.role))}</p>`;const settings=button(t('navigation.workspaceSettings'));settings.onclick=()=>{node.closest('dialog').close();navigate(currentUser?.role==='owner'?'users':'integrations');};node.append(settings);drawer(t('navigation.accountProfile'),node,{restore:true});};
 document.querySelector('#notifications').onclick=()=>{const node=document.createElement('div');const approvals=cache.get('/api/approvals?status=PENDING')||[],escalations=cache.get('/api/escalations?status=OPEN')||[],content=(cache.get('/api/state')?.content||[]).filter(c=>['DRAFT','REVIEWED'].includes(c.status));node.innerHTML=`<p>${approvals.length+escalations.length} · ${content.length}</p>`;for(const item of [...approvals,...escalations]){const p=document.createElement('p');p.textContent=item.reason;node.append(p);}const b=button(t('navigation.pendingDecisions'));b.onclick=()=>{node.closest('dialog').close();navigate('agents');};const c=button(routeTitle('content'));c.onclick=()=>{node.closest('dialog').close();navigate('content');};node.append(b,c);drawer(t('navigation.pendingDecisions'),node,{restore:true});};
 window.addEventListener('resize',()=>{if(window.innerWidth>1000)closeMobile();});

 function refreshShellText(){
  aside.setAttribute('aria-label',t('navigation.mainMenu'));
  nav.setAttribute('aria-label',t('navigation.appPages'));
  const groupKeyByLabel={overview:'navigation.operationsGroup',content:'navigation.aiOperationsGroup',integrations:'navigation.systemGroup'};
  for(const [key,el] of groupSpans)el.textContent=t(groupKeyByLabel[key]);
  for(const link of nav.querySelectorAll('a')){const id=link.hash.slice(1);link.querySelector('.nav-icon').innerHTML=icon(ROUTE_ICONS[id]);link.querySelector('span:last-child').textContent=routeTitle(id);}
  rail.querySelectorAll('[data-rail]').forEach((b,i)=>{const [key,iconName,labelKey]=RAIL_GROUPS[i];const label=t(labelKey);b.setAttribute('aria-label',label);b.title=label;b.innerHTML=icon(iconName);});
  aside.querySelector('.local').textContent=`${t('common.appName')} · ${t('navigation.workspace')}`;
  menuButton.setAttribute('aria-label',t('navigation.mainMenu'));
  top.querySelector('.crumb-workspace').textContent=t('navigation.workspace');
  top.querySelector('.search-label').textContent=t('navigation.searchPlaceholder');
  document.querySelector('#global-search').setAttribute('aria-label',t('navigation.searchPlaceholder'));
  document.querySelector('#notifications').setAttribute('aria-label',t('navigation.pendingDecisions'));
  notificationTip.querySelector('.ui-tooltip').textContent=t('navigation.pendingDecisions');
  skip.textContent=t('navigation.skipToContent');
  for(const key of ROUTE_KEYS){const el=pageHeaders.get(key);el.querySelector('h1').textContent=routeTitle(key);el.querySelector('p').textContent=routeDescription(key);}
  dock.setAttribute('aria-label',t('navigation.quickNav'));
  dock.querySelectorAll('[data-mobile-route]').forEach(b=>{b.querySelector('span').textContent=routeTitle(b.dataset.mobileRoute);});
  const more=dock.querySelector('.mobile-more');more.setAttribute('aria-label',t('navigation.morePages'));more.querySelector('span').textContent=t('navigation.morePages');
  dismiss.textContent=t('navigation.closeMenu');
  const [profileEntry,settingsEntry,logoutEntry]=accountDropdown.querySelectorAll('.dropdown-items button');
  profileEntry.textContent=t('navigation.accountProfile');
  settingsEntry.textContent=t('navigation.workspaceSettings');
  logoutEntry.textContent=t('navigation.logout');
  accountDropdown.querySelector('summary').setAttribute('aria-label',t('navigation.accountMenu'));
  langSwitch.querySelectorAll('[data-locale]').forEach(b=>b.classList.toggle('active',b.dataset.locale===getLocale()));
  if(currentUser){document.querySelector('#profile-role').textContent=roleName(currentUser.role);}
  refreshSystemIndicator();
 }
 function refreshSystemIndicator(){
  const frost=cache.get('/api/frost/status');
  document.querySelector('#system-status').textContent=frost?.gate?.paused?t('navigation.frostPaused'):frost?.schedulerRunning?t('navigation.schedulerActive'):t('navigation.connectedSession');
 }
 refreshShellText();
 onLocaleChange(refreshShellText);
}
async function changeLocale(next){
 if(next===getLocale())return;
 await setLocale(next);
 if(currentUser)try{await apiClient('/api/preferences/locale',{locale:next});}catch{}
}
const roleName=role=>({owner:t('navigation.roleOwner'),operator:t('navigation.roleOperator'),reviewer:t('navigation.roleReviewer')}[role]||'');
export function navigate(route){document.querySelector(`nav a[href="#${route}"]`)?.click();}
export function shellPage(route){document.querySelectorAll('[data-mobile-route]').forEach(b=>{const active=b.dataset.mobileRoute===route;b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});document.querySelector('.mobile-more')?.classList.toggle('active',!['overview','crm','content','agents'].includes(route));document.querySelector('#breadcrumb-page').textContent=routeTitle(route)||'';document.title=`${routeTitle(route)} | ${t('common.appName')}`;document.querySelectorAll('nav a').forEach(a=>{if(a.hash==='#'+route)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});const idx=railGroupIndex(route);document.querySelectorAll('.rail-icon').forEach((b,i)=>b.classList.toggle('active',i===idx));}
export function shellData(auth,data,api){currentUser=auth.user;cache=data;apiClient=api;document.body.classList.toggle('signed-out',!currentUser);if(!currentUser){document.querySelectorAll('dialog[open]').forEach(d=>d.close());return;}document.querySelector('#profile-name').textContent=currentUser.name;document.querySelector('#profile-role').textContent=roleName(currentUser.role);document.querySelector('#user-initials').textContent=initials(currentUser.name);document.querySelector('#notification-count').textContent=(data.get('/api/approvals?status=PENDING')?.length||0)+(data.get('/api/escalations?status=OPEN')?.length||0)+(data.get('/api/state')?.content||[]).filter(c=>['DRAFT','REVIEWED'].includes(c.status)).length;const frost=data.get('/api/frost/status');document.querySelector('#system-status').textContent=frost?.gate?.paused?t('navigation.frostPaused'):frost?.schedulerRunning?t('navigation.schedulerActive'):t('navigation.connectedSession');}
function openSearch(){if(!currentUser||document.querySelector('#command-palette'))return;const dialog=document.createElement('dialog');dialog.className='palette';dialog.id='command-palette';dialog.setAttribute('aria-label',t('navigation.searchPlaceholder'));dialog.innerHTML=`<input type="search" placeholder="${escape(t('navigation.searchPlaceholder'))}"><div class="palette-results"></div><div class="palette-hint">Esc · Tab · Enter</div>`;document.body.append(dialog);const input=dialog.querySelector('input'),results=dialog.querySelector('.palette-results');let request=0;
 async function draw(){const id=++request,q=input.value.trim().toLowerCase();results.replaceChildren();const entries=ROUTE_KEYS.filter(key=>(key!=='users'||currentUser.role==='owner')&&(key!=='crm'||currentUser.role!=='reviewer')).map(key=>({title:routeTitle(key),route:key}));for(const c of cache.get('/api/state')?.content||[])entries.push({title:c.title,route:'content'});for(const m of cache.get('/api/memory')||[])entries.push({title:m.key+' · '+m.value,route:'knowledge'});function add(entry){const b=button(entry.title,{variant:'ghost',iconName:ROUTE_ICONS[entry.route]});b.onclick=()=>{dialog.close();navigate(entry.route);if(entry.leadId){const target=document.querySelector(`[data-lead-id="${CSS.escape(entry.leadId)}"]`);target?.click();}};results.append(b);}entries.filter(e=>e.title.toLowerCase().includes(q)).slice(0,20).forEach(add);if(q.length>=2&&currentUser.role!=='reviewer'){try{const response=await apiClient('/api/crm/search?q='+encodeURIComponent(q));if(id!==request)return;const leads=Array.isArray(response)?response:response.leads||response.results||[];leads.slice(0,8).forEach(l=>add({title:l.name,route:'crm',leadId:l.id}));}catch{if(id===request){const p=document.createElement('p');p.textContent=t('errors.networkOrTimeout');results.append(p);}}}if(id===request&&!results.childElementCount)results.textContent=t('common.noResults');}
 input.oninput=draw;dialog.addEventListener('close',()=>dialog.remove(),{once:true});dialog.showModal();draw();}
