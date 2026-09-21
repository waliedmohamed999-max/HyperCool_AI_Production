import {t,onLocaleChange} from '../../i18n.js';
// Generic re-translation for elements whose text would otherwise stay frozen in whatever
// locale was active when they were created — persistent form drawers built once at boot
// (workspace.js's formDrawers), and static markup authored directly in index.html. Tag an
// element with data-i18n-key and it keeps itself current across language switches with no
// page-specific JS. Three shapes, auto-detected: data-i18n-attr="x" rewrites attribute `x`
// (e.g. a placeholder); a <label>Text<input></label> has its label text FIRST, so it uses
// firstChild; everything else (buttons with a leading icon, plain text elements) uses
// lastChild, since a leading icon is always the first child when one exists.
function tagI18n(el,key){el.dataset.i18nKey=key;return el;}
onLocaleChange(()=>{
 document.querySelectorAll('[data-i18n-key]').forEach(el=>{
  const value=t(el.dataset.i18nKey);
  if(el.dataset.i18nAttr){el.setAttribute(el.dataset.i18nAttr,value);return;}
  const node=el.tagName==='LABEL'?el.firstChild:el.lastChild;
  if(node)node.textContent=value;
 });
});
export const escape = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths={grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',users:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M20 21v-2a4 4 0 0 0-3-3.87 M16 3a4 4 0 0 1 0 8',calendar:'M3 5h18v16H3z M16 3v4 M8 3v4 M3 11h18',chart:'M3 3v18h18 M7 16v-5 M12 16V7 M17 16V4',file:'M14 2H6v20h12V6z M14 2v5h5 M8 12h8 M8 16h6',agent:'M5 7h14v13H5z M12 3v4 M2 11v5 M22 11v5 M9 11v2 M15 11v2 M9 17h6',book:'M12 5C8 2 4 3 2 4v16c4-2 7-1 10 1 3-2 6-3 10-1V4c-2-1-6-2-10 1z M12 5v16',plug:'M8 3v5 M16 3v5 M6 8h12v4a6 6 0 0 1-12 0z M12 18v4',clock:'M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',search:'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',bell:'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4',close:'M6 6l12 12 M18 6 6 18',menu:'M3 6h18 M3 12h18 M3 18h18',plus:'M12 5v14 M5 12h14',arrow:'M19 12H5 M11 6l-6 6 6 6',check:'m5 12 4 4L19 6',info:'M12 11v6 M12 7h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0'};
export function icon(name='grid'){return `<svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.grid}"/></svg>`;}
export function badge(text,status=''){return `<span class="pill" data-status="${escape(status)}">${escape(text)}</span>`;}
export function empty(title,hint=''){return `<div class="empty">${icon('file')}<strong>${escape(title)}</strong>${hint?`<p>${escape(hint)}</p>`:''}</div>`;}
export function metric(label,value,hint='',name='chart'){return `<article class="kpi-card"><div class="row-between"><span class="kpi-label">${escape(label)}</span><span class="metric-icon">${icon(name)}</span></div><strong class="kpi-value">${escape(value??'—')}</strong><span class="kpi-context">${escape(hint)}</span></article>`;}
export function initials(name){return (name||'').trim().split(/\s+/).slice(0,2).map(s=>s[0]).join('');}
export function table(headers,rows){return `<div class="table-scroll" tabindex="0" role="region"><table><thead><tr>${headers.map(h=>`<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(cell=>`<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;}
export function button(text,{variant='secondary',iconName='',...attributes}={}){const el=document.createElement('button');el.type='button';el.className=`button ${variant}`;el.innerHTML=(iconName?icon(iconName):'')+escape(text);for(const [key,value] of Object.entries(attributes))el.setAttribute(key,value);return el;}
export function header(title,description){const el=document.createElement('header');el.className='page-header';el.innerHTML=`<div><p class="eyebrow">${escape(t('common.brandEyebrow'))}</p><h1>${escape(title)}</h1><p>${escape(description)}</p></div><div class="page-actions"></div>`;tagI18n(el.querySelector('.eyebrow'),'common.brandEyebrow');return el;}
export function toast(text,type='info'){const region=document.querySelector('#message');region.className=`toast ${type}`;region.replaceChildren();const content=document.createElement('span');content.textContent=text;region.append(content,button(t('common.close'),{variant:'ghost','aria-label':t('common.closeNotification')}));region.lastChild.onclick=()=>region.replaceChildren();clearTimeout(toast.timer);toast.timer=setTimeout(()=>region.replaceChildren(),8000);}

let sequence=0;
export function drawer(title,node,{restore=false}={}){
 const existing=node.closest('dialog');if(existing){existing.showModal();return existing;}
 const marker=document.createComment('drawer return');node.before(marker);
 const dialog=document.createElement('dialog');dialog.className='drawer';const id=`dialog-${++sequence}`;dialog.setAttribute('aria-labelledby',id);
 const head=document.createElement('div');head.className='dialog-head';head.innerHTML=`<div><span class="eyebrow">${escape(t('common.appName'))}</span><h2 id="${id}">${escape(title)}</h2></div>`;
 tagI18n(head.querySelector('.eyebrow'),'common.appName');
 const close=tagI18n(button(t('common.close'),{variant:'ghost',iconName:'close'}),'common.close');close.onclick=()=>dialog.close();head.append(close);
 const body=document.createElement('div');body.className='dialog-body';body.append(node);dialog.append(head,body);document.body.append(dialog);
 dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
 if(restore)dialog.addEventListener('close',()=>{marker.replaceWith(node);dialog.remove();},{once:true});
 dialog.showModal();return dialog;
}
// Shared small-dialog primitive behind every confirm/prompt in the app (confirmAction,
// requestReason, and page-specific prompts like team.js's role/password dialogs) — one
// Promise+drawer+validate pattern instead of a copy per call site. `build(node)` fills the
// dialog body and may return {value(), validate(), focus()}; validate() should itself call
// setCustomValidity/reportValidity and return false to block closing on invalid input.
export function promptDrawer(title,build,{confirmLabel}={}){
 return new Promise(resolve=>{
  const node=document.createElement('div');
  const ctrl=build(node)||{};
  const save=button(confirmLabel||t('common.save'),{variant:'primary'}),cancel=button(t('common.cancel'));
  node.append(save,cancel);
  const d=drawer(title,node,{restore:true});d.className='confirmation';
  let result=null;
  save.onclick=()=>{if(ctrl.validate&&!ctrl.validate())return;result=ctrl.value?ctrl.value():true;d.close();};
  cancel.onclick=()=>d.close();
  d.addEventListener('close',()=>resolve(result),{once:true});
  ctrl.focus?.();
 });
}
export async function confirmAction(title,description){return promptDrawer(title,node=>{node.innerHTML=`<p>${escape(description)}</p>`;},{confirmLabel:t('common.confirm')});}
export async function requestReason(title){
 return promptDrawer(title,node=>{
  const label=document.createElement('label'),input=document.createElement('textarea');
  label.textContent=t('common.reasonLabel');input.required=true;input.maxLength=1000;input.oninput=()=>input.setCustomValidity('');
  label.append(input);node.append(label);
  return {
   value:()=>input.value.trim(),
   validate:()=>{if(!input.value.trim()){input.setCustomValidity(t('common.reasonRequired'));input.reportValidity();return false;}return true;},
   focus:()=>input.focus()
  };
 },{confirmLabel:t('common.saveChange')});
}
export function skeleton(label){return `<div class="skeleton" role="status" aria-label="${escape(label||t('common.loading'))}"><div class="skeleton-block"></div><div class="skeleton-block"></div></div>`;}
export function tooltip(element,text){const wrapper=document.createElement('span');wrapper.className='tooltip-host';const tip=document.createElement('span');tip.className='ui-tooltip';tip.id=`tip-${++sequence}`;tip.setAttribute('role','tooltip');tip.textContent=text;element.setAttribute('aria-describedby',tip.id);element.before(wrapper);wrapper.append(element,tip);return wrapper;}
export function dropdown(label,entries){const menu=document.createElement('details');menu.className='dropdown';const summary=document.createElement('summary');summary.setAttribute('aria-label',label);summary.innerHTML=icon('users');const items=document.createElement('div');items.className='dropdown-items';for(const [text,action] of entries){const b=button(text,{variant:'ghost'});b.onclick=()=>{menu.open=false;action();};items.append(b);}menu.append(summary,items);menu.addEventListener('keydown',e=>{if(e.key==='Escape'){menu.open=false;summary.focus();}});document.addEventListener('click',e=>{if(!menu.contains(e.target))menu.open=false;});return menu;}

/** Keeps original row nodes and their action attributes; never paginates backend data away. */
export function dataTable(table,{pageSize=10}={}){
 if(table.dataset.enhanced||!table.tBodies[0])return;table.dataset.enhanced='true';
 const rows=[...table.tBodies[0].rows];const wrapper=document.createElement('div');wrapper.className='data-table';table.before(wrapper);
 const toolbar=document.createElement('div');toolbar.className='table-toolbar';const search=document.createElement('input');search.type='search';search.placeholder=t('common.searchTable');search.setAttribute('aria-label',t('common.searchTable'));toolbar.append(search);
 const scroll=document.createElement('div');scroll.className='table-scroll';scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label',t('common.scrollableTable'));scroll.append(table);
 const footer=document.createElement('div');footer.className='table-footer';const prev=button(t('common.previous')),next=button(t('common.next')),count=document.createElement('span');count.setAttribute('aria-live','polite');footer.append(count,prev,next);wrapper.append(toolbar,scroll,footer);
 let page=0,sort=-1,direction=1;const filters=[];
 const filterColumns=table.closest('#audit-list')?[0,1]:table.closest('#team-members')?[2,3]:table.closest('#content-library')?[1,3]:[];
 for(const index of filterColumns){const select=document.createElement('select');select.setAttribute('aria-label',t('common.all')+' '+table.tHead.rows[0].cells[index].textContent);select.innerHTML=`<option value="">${escape(t('common.all'))} ${escape(table.tHead.rows[0].cells[index].textContent)}</option>`+[...new Set(rows.map(row=>row.cells[index].textContent.trim()))].map(value=>`<option>${escape(value)}</option>`).join('');select.onchange=()=>{page=0;draw();};toolbar.append(select);filters.push({index,select});}
 function draw(){const filtered=rows.filter(row=>row.textContent.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())&&filters.every(({index,select})=>!select.value||row.cells[index].textContent.trim()===select.value));if(sort>=0)filtered.sort((a,b)=>a.cells[sort].textContent.localeCompare(b.cells[sort].textContent,'ar',{numeric:true})*direction);page=Math.min(page,Math.max(0,Math.ceil(filtered.length/pageSize)-1));rows.forEach(row=>row.hidden=true);filtered.forEach((row,index)=>{table.tBodies[0].append(row);row.hidden=index<page*pageSize||index>=(page+1)*pageSize;});count.textContent=filtered.length?`${page*pageSize+1}–${Math.min((page+1)*pageSize,filtered.length)} ${t('common.of')} ${filtered.length}`:t('common.noResults');prev.disabled=page===0;next.disabled=(page+1)*pageSize>=filtered.length;}
 search.oninput=()=>{page=0;draw();};prev.onclick=()=>{page--;draw();};next.onclick=()=>{page++;draw();};
 [...table.tHead?.rows[0]?.cells||[]].forEach((th,index)=>{th.scope='col';const b=button(th.textContent+' ↕',{variant:'table-sort'});th.replaceChildren(b);b.onclick=()=>{direction=sort===index?-direction:1;sort=index;[...table.tHead.rows[0].cells].forEach(c=>c.removeAttribute('aria-sort'));th.setAttribute('aria-sort',direction===1?'ascending':'descending');draw();};});draw();
}
export function tabs(container,entries){const bar=document.createElement('div');bar.className='ui-tabs';bar.setAttribute('role','tablist');bar.setAttribute('aria-label',t('common.pageSections'));container.prepend(bar);const buttons=[];
 entries.forEach(([label,node],index)=>{const id=`tab-${++sequence}`,b=button(label,{variant:'tab',role:'tab',id,'aria-controls':`${id}-panel`});node.id ||= `${id}-panel`;b.setAttribute('aria-controls',node.id);node.setAttribute('role','tabpanel');node.setAttribute('aria-labelledby',id);bar.append(b);buttons.push(b);b.onclick=()=>select(index);});
 function select(index){entries.forEach(([,node],i)=>{node.hidden=i!==index;buttons[i].setAttribute('aria-selected',String(i===index));buttons[i].tabIndex=i===index?0:-1;});}
 bar.onkeydown=e=>{const i=buttons.indexOf(document.activeElement);if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowLeft'?1:-1)+buttons.length)%buttons.length;select(next);buttons[next].focus();}};select(0);return {select};}
export function enhance(root=document){
 root.querySelectorAll('table:not([data-calendar])').forEach(table=>dataTable(table));
 root.querySelectorAll('input,select,textarea').forEach(el=>{if(!el.labels?.length&&!el.hasAttribute('aria-label'))el.setAttribute('aria-label',el.placeholder||el.name||t('common.field'));if(['url','email','tel','date','datetime-local'].includes(el.type))el.dir='ltr';});
 root.querySelectorAll('[data-report-nav],[data-open-lead]').forEach(el=>{if(el.tagName==='TR'){if(!el.querySelector('[data-row-link]')){const cell=el.cells[0],b=button(cell.textContent,{variant:'ghost','data-row-link':'true'});cell.replaceChildren(b);}return;}if(el.tagName!=='BUTTON'){el.tabIndex=0;el.setAttribute('role','button');el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();el.click();}};}});
}
