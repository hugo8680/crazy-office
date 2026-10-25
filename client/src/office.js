import {setOrganizationOccupants} from './organization-occupants.mjs';
import {ORGANIZATION_DEPARTMENTS} from './organization.mjs';
import {mountScene} from './scene.js';
import {createSceneViewController} from './scene-view.js';
import {mountErp} from './erp.js';
import {mountErpPresence} from './erp-presence.js';
import {mountSession} from './session-ui.js';
import {mountBulletinCenter} from './bulletin-center.js';
import {mountOfficeLocation} from './office-location.js';
import {mountOfficePerson} from './office-person.js';
import {createOfficeNavigation} from './office-navigation.mjs';
import {createOfficeAudio} from './office-audio.mjs';
import {mountOfficeInput} from './office-input.mjs';
import {escapeHtml as e} from './erp-ui.mjs';
import {mountWorkspaceViewport} from './workspace-viewport.mjs';
import {CREW,ROOM_SECTIONS,SECTION_ROOMS,sceneProjection,crewDocument,workspaceCounts,createDocumentObserver} from './workspace-state.mjs';

const lab=document.querySelector('#lab');
const dock=document.querySelector('#action-dock');
const viewSwitch=document.querySelector('#view-switch');
const fullscreenControl=document.querySelector('#workspace-fullscreen');
const receipt=document.querySelector('#workspace-receipt');
const toastElement=document.querySelector('#toast');
const businessFrame=document.querySelector('#workspace-business');
const workspaceViewport=mountWorkspaceViewport([document.querySelector('#workspace-stage'),businessFrame,document.querySelector('#workspace-chrome')],{boundsTarget:lab});
const observer=createDocumentObserver();
const motionPreference=window.matchMedia?.('(prefers-reduced-motion: reduce)');
const surfaceMotions=new Map();
const officeAudio=createOfficeAudio({window,storage:localStorage,isVisible:()=>!document.hidden});
document.addEventListener('pointerdown',()=>officeAudio.unlock(),{passive:true});
document.addEventListener('keydown',()=>officeAudio.unlock(),{passive:true});
function cancelSurfaceMotion(element){surfaceMotions.get(element)?.cancel();surfaceMotions.delete(element);}
function revealSurface(element,kind='menu'){
  cancelSurfaceMotion(element);
  if(motionPreference?.matches||document.hidden||typeof element.animate!=='function')return;
  const transforms=kind==='toast'?['translate(-50%,10px)','translate(-50%,0)']:kind==='receipt'?['translateY(12px)','translateY(0)']:['translateY(10px) scale(.98)','translateY(0) scale(1)'];
  const animation=element.animate([{opacity:0,transform:transforms[0]},{opacity:1,transform:transforms[1]}],{duration:kind==='receipt'?300:220,easing:'cubic-bezier(.2,.75,.25,1)'});
  surfaceMotions.set(element,animation);
  animation.onfinish=()=>{if(surfaceMotions.get(element)===animation)surfaceMotions.delete(element);};
}
const cancelSurfaceMotions=()=>{for(const element of surfaceMotions.keys())cancelSurfaceMotion(element);};
const updateMotionPreference=()=>{if(motionPreference?.matches)cancelSurfaceMotions();};
motionPreference?.addEventListener?.('change',updateMotionPreference);
let session=null,account=null,erp=null,presence=null,bulletin=null,locationMenu=null,personMenu=null,snapshot={},section=null,sessionEpoch=0,toastTimer,receiptTimer,pollTimer;
let preferredDocument=null,dockSignature='',viewSignature='',viewFocus=null;
let pendingLoginLocation=false,officeNavigation=null,officeInput=null,returnTicket=0;
const departmentIDs=new Set(ORGANIZATION_DEPARTMENTS.map(item=>item.id));
const navigation=[['desk','工作台','grid'],['projects','项目','book'],['flows','单据','layers'],['inventory','进销存','server'],['people','人员','users'],['reports','报表','activity']];
const icon=name=>`<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const isAuthenticated=()=>!!(session?.actor?.id||session?.user?.id);
const actor=()=>session?.actor||session?.user||{};
function toast(message){clearTimeout(toastTimer);toastElement.textContent=message;toastElement.hidden=false;revealSurface(toastElement,'toast');toastTimer=setTimeout(()=>{toastElement.hidden=true;cancelSurfaceMotion(toastElement);},4500);}
function cleanPrivateState(){
  cancelSurfaceMotions();
  pendingLoginLocation=false;officeNavigation?.reset();officeInput?.stop('session');returnTicket++;
  sessionEpoch++;setOrganizationOccupants([]);bulletin?.destroy();bulletin=null;locationMenu?.destroy();locationMenu=null;personMenu?.destroy();personMenu=null;erp?.destroy();erp=null;presence?.destroy();presence=null;session=null;snapshot={};section=null;preferredDocument=null;observer.reset();
  clearTimeout(receiptTimer);clearTimeout(toastTimer);receipt.hidden=true;receipt.innerHTML='';toastElement.hidden=true;toastElement.textContent='';scene.setPresence({enabled:true,people:[],currentUserId:null});scene.update(sceneProjection());scene.setSelectedNode(null);scene.setSelectedAgent(null);scene.resetView();renderDock();
}
async function api(path,method='GET',body,{signal}={}){
  const epoch=sessionEpoch;
  const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',...(signal?{signal}:{}),headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(isAuthenticated()?{'X-Office-Actor':actor().id}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await response.json().catch(()=>({}));
  if(epoch!==sessionEpoch){const error=new Error('会话已变更。');error.status=401;throw error;}
  if(response.status===401){cleanPrivateState();account?.requireLogin('登录已过期，请重新登录。');const error=new Error('请重新登录。');error.status=401;throw error;}
  if(!response.ok){const error=new Error(data.error||data.message||'操作未完成，请重试。');error.status=response.status;throw error;}
  return data;
}
async function refreshOfficeDirectory(){
  const epoch=sessionEpoch,result=await api('/api/erp/organization');
  if(epoch===sessionEpoch&&isAuthenticated()){setOrganizationOccupants(result.employees);personMenu?.refresh?.();}
}
function renderDock(){
  const fullscreenLabel=document.fullscreenElement?'退出全屏':'全屏';
  if(fullscreenControl.getAttribute('aria-label')!==fullscreenLabel){fullscreenControl.setAttribute('aria-label',fullscreenLabel);fullscreenControl.setAttribute('title',fullscreenLabel);fullscreenControl.innerHTML=icon(document.fullscreenElement?'fullscreen-exit':'fullscreen');}
  const nextViewSignature=JSON.stringify([scene.mode,scene.pending]);
  if(nextViewSignature!==viewSignature){
    const focusedView=document.activeElement?.closest?.('#view-switch button');
    if(focusedView)viewFocus=focusedView.dataset.officeView;
    viewSignature=nextViewSignature;
    viewSwitch.setAttribute('aria-busy',String(scene.pending));
    viewSwitch.innerHTML=[['3d','cube','立体视角'],['2d','plan','平面视角']].map(([mode,symbol,label])=>`<button type="button" data-office-view="${mode}" aria-label="${label}" title="${label}" aria-pressed="${scene.mode===mode}">${icon(symbol)}</button>`).join('');
    if(viewFocus&&!scene.pending){for(const button of viewSwitch.querySelectorAll('button'))if(button.dataset.officeView===viewFocus){button.focus();break;}viewFocus=null;}
  }
  const counts=workspaceCounts(snapshot,actor().id),name=actor().name||'账户';
  const signature=JSON.stringify([actor().id,name,counts.approvals,section,scene.mode,scene.pending,!!document.fullscreenElement,officeAudio.muted]);
  if(signature===dockSignature)return;dockSignature=signature;
  const focused=document.activeElement?.closest?.('#action-dock button');
  const focusData=focused?{...focused.dataset}:null;
  dock.innerHTML=`<button type="button" class="workspace-home" data-office-action="home" aria-label="办公室" title="办公室"><img src="./brand-mark.svg" width="27" height="27" alt="莱森购"></button>
    <div class="workspace-navigation">${navigation.map(([id,label,symbol])=>`<button type="button" data-office-section="${id}" class="workspace-nav-item ${section===id?'is-active':''}" ${section===id?'aria-current="page"':''}>${icon(symbol)}<span>${label}</span>${id==='desk'&&counts.approvals?`<em aria-label="${counts.approvals} 项待审批">${counts.approvals}</em>`:''}</button>`).join('')}</div>
    <div class="workspace-utilities"><button type="button" class="workspace-sound" data-office-action="sound" aria-label="${officeAudio.muted?'开启音效':'关闭音效'}" title="${officeAudio.muted?'开启音效':'关闭音效'}" aria-pressed="${!officeAudio.muted}"><svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4Z"/>${officeAudio.muted?'<path d="m16 9 5 6m0-6-5 6"/>':'<path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>'}</svg></button><button type="button" class="workspace-account" data-office-action="account" aria-label="账户：${e(name)}" title="${e(name)}"><span class="workspace-avatar">${e(name.slice(0,1))}</span><span class="workspace-account-name">${e(name)}</span></button></div>`;
  if(focusData)for(const button of dock.querySelectorAll('button'))if(['officeAction','officeSection','officeView'].some(key=>focusData[key]&&button.dataset[key]===focusData[key])){button.focus();break;}
}
function requireAccount(){if(isAuthenticated()&&erp)return true;account?.requireLogin();return false;}
async function openSection(next,context={}){
  if(!requireAccount())return;
  officeInput?.stop('surface');
  personMenu?.close();bulletin?.hidePreview();
  scene.setSelectedNode(SECTION_ROOMS[next]||null);section=next;renderDock();
  await erp.open(next,context);
}
async function openBulletin(section='dashboard'){
  if(!requireAccount())return;
  officeInput?.stop('surface');
  erp?.close();locationMenu?.close();personMenu?.close();bulletin?.hidePreview();
  await bulletin?.open(section,{expanded:true});
}
async function openDocument(id){
  if(!requireAccount())return;
  officeInput?.stop('surface');
  personMenu?.close();preferredDocument=id;receipt.hidden=true;await erp.openDocument(id);
}
function receiveSnapshot(value){
  if(!isAuthenticated())return;
  snapshot=value||{};
  const current=snapshot.currentUser;
  if(current?.id&&current.id!==actor().id){cleanPrivateState();void account?.refresh?.();return;}
  if(current?.id===actor().id){session={...session,actor:current};}
  scene.update(sceneProjection(snapshot,preferredDocument));
  const changes=observer.observe(snapshot.documents);
  renderDock();
  const notice=changes.find(n=>n.kind==='approval')||changes[0];
  if(notice){
    clearTimeout(receiptTimer);
    receipt.innerHTML=`<button type="button" data-office-document="${e(notice.id)}"><span class="workspace-receipt-mark">${icon(notice.kind==='approval'?'clock':notice.kind==='error'?'info':'check')}</span><span><small>${e(notice.label)}</small><strong>${e(notice.title)}</strong></span>${icon('arrow')}</button><button type="button" data-office-action="dismiss-receipt" aria-label="关闭通知">${icon('close')}</button>`;
    receipt.hidden=false;revealSurface(receipt,'receipt');receiptTimer=setTimeout(()=>{receipt.hidden=true;cancelSurfaceMotion(receipt);},18000);
    // New work is opened directly when the person is in the office. Never replace a form.
    if(!erp.isOpen&&!bulletin?.isOpen&&!locationMenu?.isOpen&&!personMenu?.isOpen&&!document.querySelector('dialog[open]')&&!account?.session?.anonymous)void openDocument(notice.id);
  }
}
const scene=createSceneViewController(document.querySelector('#office-scene'),{
  onSelectNode:id=>{if(id==='bulletin'){void openBulletin();return;}if(departmentIDs.has(id))return;void openSection(ROOM_SECTIONS[id]||'desk');},
  onEnterArea:id=>{pendingLoginLocation=false;void officeNavigation?.enterArea(id);},
  onNavigationContext:id=>{officeNavigation?.setContext(id);officeAudio.context(id);},
  onDepartmentHover:id=>officeAudio.hover(id),
  onPresenceStep:step=>{officeNavigation?.observePresence(step);officeAudio.step(step);},
  onCameraIntent:()=>officeNavigation?.cancelAutoFocus(),
  onSelectBulletin:section=>{void openBulletin(section);},
  onHoverBulletin:(section,anchor)=>{if(isAuthenticated()&&!erp?.isOpen&&!locationMenu?.isOpen&&!personMenu?.isOpen)void bulletin?.preview(section,anchor);},
  onLeaveBulletin:section=>bulletin?.hidePreview(section),
  onMovePoint:point=>{pendingLoginLocation=false;officeInput?.stop('pointer');void officeNavigation?.movePoint(point);},
  onSelectSeat:id=>{if(requireAccount()){officeInput?.stop('surface');erp?.close();personMenu?.close();bulletin?.hidePreview();locationMenu?.openSeat(id);}},
  onSelectPostEmployee:id=>{if(requireAccount()){officeInput?.stop('surface');erp?.close();bulletin?.hidePreview();locationMenu?.close();personMenu?.open(id);}},
  onSelectAgent:id=>{if(!requireAccount())return;const document=crewDocument(snapshot,id);if(document)void openDocument(document.id);else void openSection(CREW.find(p=>p.id===id)?.section||'desk');},
  onSelectHuman:()=>void openSection('desk')
},{mount2D:mountScene,initialMode:'3d',onChange:({mode})=>{lab.dataset.view=mode;renderDock();focusLoginLocation();},onError:()=>toast('3D 暂不可用，已切换为 2D。')});
officeNavigation=createOfficeNavigation({scene,getPresence:()=>presence,requireAccount,isBlocked:()=>!!erp?.isOpen||!!bulletin?.isOpen||!!locationMenu?.isOpen||!!personMenu?.isOpen||!!account?.isOpen});
officeInput=mountOfficeInput({document,window,isEnabled:()=>isAuthenticated()&&!!presence?.self&&!scene.pending,isBlocked:()=>!!erp?.isOpen||!!bulletin?.isOpen||!!locationMenu?.isOpen||!!personMenu?.isOpen||!!account?.isOpen,
 onStart:()=>{pendingLoginLocation=false;return officeNavigation.beginKeyboard();},
 onStep:(direction,milliseconds)=>officeNavigation.stepKeyboard(direction,milliseconds),
 onStop:()=>{void officeNavigation.finishKeyboard();},
 onEscape:()=>{
  if(erp?.isOpen||bulletin?.isOpen||locationMenu?.isOpen||personMenu?.isOpen||account?.isOpen)return false;
  bulletin?.hidePreview();
  if(officeNavigation.walking){void officeNavigation.stopWalking();return true;}
  if(officeNavigation.areaId){pendingLoginLocation=false;officeNavigation.home();return true;}
  scene.setSelectedNode(null);scene.setSelectedAgent(null);scene.setSelectedHuman?.(null);return false;
 },
 onHome:()=>{pendingLoginLocation=false;officeNavigation.home();return true;},
});
function returnToOffice(){const epoch=sessionEpoch,ticket=++returnTicket;void Promise.resolve().then(()=>{if(epoch!==sessionEpoch||ticket!==returnTicket||!isAuthenticated()||document.hidden)return;if(pendingLoginLocation)focusLoginLocation();else officeNavigation.restore();});}
scene.setTopology(false);scene.setPresence({enabled:true,people:[],currentUserId:null});scene.update(sceneProjection());
function focusLoginLocation(){if(pendingLoginLocation&&!scene.pending&&presence?.self&&officeNavigation.locateSelf())pendingLoginLocation=false;}
async function startSession(next){
  const nextActor=next?.actor||next?.user;
  if(!nextActor?.id){cleanPrivateState();return;}
  if(isAuthenticated()&&actor().id===nextActor.id){session=next;erp?.updateSession(next);renderDock();return;}
  cleanPrivateState();session=next;pendingLoginLocation=true;
  erp=mountErp({request:api,session,scene,container:businessFrame,onChange:({snapshot:value})=>receiveSnapshot(value),onNavigate:({section:nextSection,opened,documentId})=>{section=opened?nextSection:null;preferredDocument=documentId||null;renderDock();},onClose:()=>{scene.setSelectedNode(null);scene.setSelectedAgent(null);returnToOffice();}});
  presence=mountErpPresence({scene,request:api,session,onError:toast,onUpdate:()=>{locationMenu?.refresh?.();personMenu?.refresh?.();},onSelectEmployee:person=>{if(!requireAccount())return;officeInput?.stop('surface');erp?.close();bulletin?.hidePreview();if(person.id===actor().id){personMenu?.close();locationMenu?.openSelf();}else{locationMenu?.close();personMenu?.open(person);}}});
  locationMenu=mountOfficeLocation({container:lab,presence,scene,getActor:actor,onWork:()=>void openSection('desk'),onError:toast,onClose:returnToOffice});
  personMenu=mountOfficePerson({container:lab,getPeople:()=>presence?.people||[],getSession:()=>session,onClose:returnToOffice});
  bulletin=mountBulletinCenter({container:lab,chrome:document.querySelector('#workspace-chrome'),request:api,session,getSnapshot:()=>snapshot,onError:toast,onClose:returnToOffice,onOpenNotices:()=>void openSection('notices'),isBlocked:()=>!!erp?.isOpen||!!locationMenu?.isOpen||!!personMenu?.isOpen||!!document.querySelector('dialog[open]')});
  renderDock();
  const directoryEpoch=sessionEpoch;
  const results=await Promise.allSettled([erp.refresh(),api('/api/erp/organization')]);
  if(directoryEpoch!==sessionEpoch)return;
  if(results[1].status==='fulfilled')setOrganizationOccupants(results[1].value.employees);
  else if(results[1].reason?.status!==401)toast('通讯录暂未载入，请刷新重试。');
  await presence?.ready;if(directoryEpoch===sessionEpoch)focusLoginLocation();
}
async function toggleFullscreen(){try{if(document.fullscreenElement)await document.exitFullscreen();else await lab.requestFullscreen();}catch{toast('浏览器未允许全屏。');}renderDock();}
async function handleOfficeClick(event){
  const target=event.target.closest('[data-office-action],[data-office-section],[data-office-view],[data-office-document]');
  if(!target)return;
  try{
    if(target.dataset.officeSection)return await openSection(target.dataset.officeSection);
    if(target.dataset.officeDocument)return await openDocument(target.dataset.officeDocument);
    if(target.dataset.officeView){officeInput?.stop('view');bulletin?.hidePreview();return await scene.setMode(target.dataset.officeView);}
    switch(target.dataset.officeAction){
      case 'home':officeInput?.stop('home');erp?.close();void bulletin?.close();locationMenu?.close();personMenu?.close();pendingLoginLocation=false;officeNavigation.home();break;
      case 'account':officeInput?.stop('surface');personMenu?.close();bulletin?.hidePreview();account?.open();break;
      case 'sound':officeAudio.setMuted(!officeAudio.muted);officeAudio.unlock();renderDock();break;
      case 'fullscreen':await toggleFullscreen();break;
      case 'dismiss-receipt':receipt.hidden=true;break;
    }
  }catch(error){if(error.status!==401)toast(/Agent|模型|provider|API|qwen/i.test(error.message)?'操作未完成，请重试。':error.message);}
}
document.addEventListener('click',event=>{void handleOfficeClick(event);});
document.addEventListener('fullscreenchange',renderDock);
window.addEventListener('office:session-ended',()=>{cleanPrivateState();account?.requireLogin('请重新登录。');});
renderDock();
account=mountSession({container:lab,onClose:returnToOffice,onLocate:()=>{erp?.close();void bulletin?.close();locationMenu?.close();personMenu?.close();returnTicket++;pendingLoginLocation=true;focusLoginLocation();},onAuthenticated:next=>{void startSession(next).catch(error=>{if(error.status!==401)toast('工作数据暂未载入，请重试。');});},onSignedOut:cleanPrivateState,onSessionExpired:cleanPrivateState,onChange:next=>{if(isAuthenticated()&&next?.actor?.id===actor().id){const appearanceChanged=next.actor.outfitId!==actor().outfitId;session=next;erp?.updateSession(next);renderDock();personMenu?.refresh?.();if(appearanceChanged)void Promise.allSettled([presence?.refresh(),refreshOfficeDirectory()]);}}});
await account.ready;
// Reconcile while the business pane is closed; the pane owns its own visible polling.
pollTimer=setInterval(()=>{if(erp&&!erp.isOpen&&!document.hidden)void erp.refresh({silent:true}).catch(()=>{});},8000);
document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelSurfaceMotions();officeAudio.pause();}else if(erp)void erp.refresh({silent:true}).catch(()=>{});});
window.addEventListener('pagehide',event=>{if(event?.persisted)return;workspaceViewport.destroy();cancelSurfaceMotions();motionPreference?.removeEventListener?.('change',updateMotionPreference);clearInterval(pollTimer);clearTimeout(toastTimer);clearTimeout(receiptTimer);officeNavigation?.destroy();officeInput?.destroy();officeAudio.destroy();returnTicket++;bulletin?.destroy();locationMenu?.destroy();personMenu?.destroy();presence?.destroy();erp?.destroy();account?.destroy();scene.destroy();});
