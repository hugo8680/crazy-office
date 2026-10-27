import {OFFICE_SEATS,departmentById,canonicalDepartmentId} from './organization.mjs';
import {organizationOccupant} from './organization-occupants.mjs';
import {employeeAppearance,employeeAppearanceKey} from './employee-appearance.mjs';
import {escapeHtml as e} from './erp-ui.mjs';

const positionNames=Object.freeze({chairman:'董事长',manager:'经理',head:'部长',staff:'员工'});
const actorOf=session=>session?.authenticated===true?(session.actor||session):null;
const clean=value=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').trim():'';

// A colleague is a person, not a shortcut into a departmental ERP form. This
// card only reads the signed-in directory and live presence already in memory.
export function mountOfficePerson({container,getPeople=()=>[],getSession=()=>null,onClose=()=>{}}={}){
 const doc=container.ownerDocument,dialog=doc.createElement('dialog');dialog.className='office-location-dialog office-person-dialog';dialog.setAttribute('aria-labelledby','office-person-name');container.append(dialog);
 let destroyed=false,target=null,viewerId=null,previousFocus=null,surfaceOpen=false,signature='';
 const notify=()=>{try{const result=onClose();result?.catch?.(()=>{});}catch{}};
 function didClose(){
  if(destroyed||dialog.open||!surfaceOpen)return;
  surfaceOpen=false;target=null;viewerId=null;signature='';dialog.innerHTML='';const focus=previousFocus;previousFocus=null;if(focus?.isConnected!==false)focus?.focus?.({preventScroll:true});notify();
 }
 function close(){if(destroyed||!dialog.open)return;dialog.close();didClose();}
 function resolve(value){
  const raw=typeof value==='string'?{appearanceKey:value}:value||{},valuePeople=getPeople(),people=Array.isArray(valuePeople)?valuePeople:[],byId=raw.id?people.find(person=>person?.online===true&&person.id===raw.id):null;
  const post=OFFICE_SEATS.find(seat=>seat.id===(byId?.appearanceKey||raw.appearanceKey)),directory=post?organizationOccupant(post.id):null,online=byId||people.find(person=>person?.online===true&&directory?.seatIds.includes(person.appearanceKey));
  // A desk's current occupant is not necessarily the directory employee whose
  // home post it is. seatId alone must never become a personal identity match.
  if(!directory&&!online)return null;
  const source=directory||online,name=clean(source.name);if(!name)return null;
  const seatIds=directory?.seatIds||[],departments=[...new Set(seatIds.map(id=>departmentById(OFFICE_SEATS.find(seat=>seat.id===id)?.departmentId)?.name).filter(Boolean))];
  const department=departments.join('、')||departmentById(canonicalDepartmentId(online?.department))?.name||clean(online?.department)||departmentById(online?.nodeId)?.name||'—';
  const title=clean(source.title)||positionNames[post?.role]||'员工',username=clean(source.username||online?.username||online?.email),appearance=employeeAppearance({id:employeeAppearanceKey(online||{appearanceKey:directory?.seatIds?.[0]||post?.id}),outfitId:online?.outfitId||directory?.outfitId});
  return{name,department,title,username,online:!!online,appearance};
 }
 function render(person){
  const key=JSON.stringify(person);if(key===signature)return;signature=key;const a=person.appearance;
  dialog.innerHTML=`<div class="office-location-head"><span>${e(person.department)}</span><button type="button" data-person-close aria-label="关闭"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-close"/></svg></button></div><div class="office-person-identity"><svg class="office-person-portrait" viewBox="0 0 72 76" aria-hidden="true"><rect x="2" y="2" width="68" height="72" rx="20" fill="#e8ede2"/><path d="M14 73V59q0-17 22-17t22 17v14Z" fill="${a.jacket}"/><path d="m29 45 7 9 7-9-2 28H31Z" fill="${a.shirt}"/><path d="M30 39v8q6 6 12 0v-8" fill="${a.skin}"/><ellipse cx="36" cy="28" rx="14" ry="17" fill="${a.skin}"/><path d="M22 30V19q1-14 15-14 17 0 15 22l-8-8-7 4-10-3-1 10Z" fill="${a.hair}"/><circle cx="30" cy="29" r="1.2" fill="${a.eye}"/><circle cx="42" cy="29" r="1.2" fill="${a.eye}"/><path d="M32 36q4 3 8 0" fill="none" stroke="${a.eye}" stroke-width="1" stroke-linecap="round"/></svg><div><h2 id="office-person-name">${e(person.name)}</h2><span class="office-person-status" data-online="${person.online}">${person.online?'在线':'离线'}</span></div></div><dl class="office-person-facts"><div><dt>岗位</dt><dd>${e(person.title)}</dd></div>${person.username?`<div><dt>邮箱</dt><dd>${e(person.username)}</dd></div>`:''}</dl>`;
 }
 function open(value){
  if(destroyed)return false;const actor=actorOf(getSession());if(!actor?.id)return false;const person=resolve(value);if(!person)return false;
  if(!dialog.open)previousFocus=doc.activeElement;target=typeof value==='string'?value:{...value};viewerId=actor.id;render(person);
  if(!dialog.open)try{dialog.showModal();surfaceOpen=true;}catch{return false;}return true;
 }
 function refresh(){
  if(destroyed||!dialog.open)return;
  if(actorOf(getSession())?.id!==viewerId){close();return;}
  const person=resolve(target);if(!person){close();return;}render(person);
 }
 function click(event){if(event.target.closest('[data-person-close]'))close();}
 function cancel(event){event.preventDefault();close();}
 dialog.addEventListener('click',click);dialog.addEventListener('cancel',cancel);dialog.addEventListener('close',didClose);
 return{open,close,refresh,get isOpen(){return dialog.open;},destroy(){if(destroyed)return;destroyed=true;dialog.close();dialog.innerHTML='';dialog.removeEventListener('click',click);dialog.removeEventListener('cancel',cancel);dialog.removeEventListener('close',didClose);dialog.remove();target=null;viewerId=null;previousFocus=null;signature='';}};
}
