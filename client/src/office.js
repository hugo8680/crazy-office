import {mountScene} from './scene.js';
import {createSceneViewController} from './scene-view.js';
import {mountErp} from './erp.js';
import {mountErpPresence} from './erp-presence.js';
import {mountSession} from './session-ui.js';
import {escapeHtml as e} from './erp-ui.mjs';
import {mountWorkspaceViewport} from './workspace-viewport.mjs';
import {CREW,ROOM_SECTIONS,SECTION_ROOMS,sceneProjection,crewDocument,workspaceCounts,createDocumentObserver} from './workspace-state.mjs';

const lab=document.querySelector('#lab');
const dock=document.querySelector('#action-dock');
const viewMenu=document.querySelector('#view-menu');
const viewSwitch=document.querySelector('#view-switch');
const receipt=document.querySelector('#workspace-receipt');
const toastElement=document.querySelector('#toast');
const businessFrame=document.querySelector('#workspace-business');
const workspaceViewport=mountWorkspaceViewport([document.querySelector('#workspace-stage'),businessFrame,document.querySelector('#workspace-chrome')],{boundsTarget:lab});
const observer=createDocumentObserver();
const motionPreference=window.matchMedia?.('(prefers-reduced-motion: reduce)');
const surfaceMotions=new Map();
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
let session=null,account=null,erp=null,presence=null,snapshot={},section=null,sessionEpoch=0,toastTimer,receiptTimer,pollTimer;
let topology=false,preferredDocument=null,dockSignature='',viewSignature='',viewFocus=null;
const navigation=[['desk','工作台','grid'],['projects','项目','book'],['flows','单据','layers'],['inventory','进销存','server'],['people','人员','users'],['reports','报表','activity']];
const icon=name=>`<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const isAuthenticated=()=>!!(session?.actor?.id||session?.user?.id);
const actor=()=>session?.actor||session?.user||{};
function toast(message){clearTimeout(toastTimer);toastElement.textContent=message;toastElement.hidden=false;revealSurface(toastElement,'toast');toastTimer=setTimeout(()=>{toastElement.hidden=true;cancelSurfaceMotion(toastElement);},4500);}
function cleanPrivateState(){
  cancelSurfaceMotions();
  sessionEpoch++;erp?.destroy();erp=null;presence?.destroy();presence=null;session=null;snapshot={};section=null;preferredDocument=null;observer.reset();
  clearTimeout(receiptTimer);clearTimeout(toastTimer);receipt.hidden=true;receipt.innerHTML='';toastElement.hidden=true;toastElement.textContent='';scene.setPresence({enabled:true,people:[],currentUserId:null});scene.update(sceneProjection());scene.setSelectedNode(null);scene.setSelectedAgent(null);renderDock();
}
async function api(path,method='GET',body){
  const epoch=sessionEpoch;
  const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(isAuthenticated()?{'X-Office-Actor':actor().id}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await response.json().catch(()=>({}));
  if(epoch!==sessionEpoch){const error=new Error('会话已变更。');error.status=401;throw error;}
  if(response.status===401){cleanPrivateState();account?.requireLogin('登录已过期，请重新登录。');const error=new Error('请重新登录。');error.status=401;throw error;}
  if(!response.ok){const error=new Error(data.error||data.message||'操作未完成，请重试。');error.status=response.status;throw error;}
  return data;
}
function renderDock(){
  const nextViewSignature=JSON.stringify([scene.mode,scene.pending]);
  if(nextViewSignature!==viewSignature){
    const focusedView=document.activeElement?.closest?.('#view-switch button');
    if(focusedView)viewFocus=focusedView.dataset.officeView;
    viewSignature=nextViewSignature;
    viewSwitch.innerHTML=[['2d','plan','平面视角'],['3d','cube','立体视角']].map(([mode,symbol,label])=>`<button type="button" data-office-view="${mode}" aria-label="${label}" title="${label}" aria-pressed="${scene.mode===mode}" ${scene.pending?'disabled':''}>${icon(symbol)}</button>`).join('')+`<button type="button" data-office-action="fit" aria-label="恢复全景" title="${scene.mode==='3d'?'恢复全景（Home）':'恢复全景'}" ${scene.pending?'disabled':''}>${icon('target')}</button>`;
    if(viewFocus&&!scene.pending){for(const button of viewSwitch.querySelectorAll('button'))if(button.dataset.officeView===viewFocus){button.focus();break;}viewFocus=null;}
  }
  const counts=workspaceCounts(snapshot,actor().id),name=actor().name||'账户';
  const signature=JSON.stringify([actor().id,name,counts.approvals,section,scene.mode,scene.pending,viewMenu.hidden]);
  if(signature===dockSignature)return;dockSignature=signature;
  const focused=document.activeElement?.closest?.('#action-dock button');
  const focusData=focused?{...focused.dataset}:null;
  dock.innerHTML=`<button type="button" class="workspace-home" data-office-action="home" aria-label="办公室" title="办公室"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V9l8-5 8 5v11H4M9 20v-8h6v8"/></svg></button>
    <button type="button" class="workspace-new" data-office-section="flows" aria-label="新建">${icon('plus')}<span>新建</span></button>
    <div class="workspace-navigation">${navigation.map(([id,label,symbol])=>`<button type="button" data-office-section="${id}" class="workspace-nav-item ${section===id?'is-active':''}" ${section===id?'aria-current="page"':''}>${icon(symbol)}<span>${label}</span>${id==='desk'&&counts.approvals?`<em aria-label="${counts.approvals} 项待审批">${counts.approvals}</em>`:''}</button>`).join('')}</div>
    <div class="workspace-utilities"><button type="button" class="workspace-view-button" data-office-action="view" aria-label="视图设置" aria-expanded="${!viewMenu.hidden}">${icon('target')}</button><button type="button" class="workspace-account" data-office-action="account" aria-label="账户：${e(name)}" title="${e(name)}"><span class="workspace-avatar">${e(name.slice(0,1))}</span><span class="workspace-account-name">${e(name)}</span></button></div>`;
  if(focusData)for(const button of dock.querySelectorAll('button'))if(['officeAction','officeSection','officeView'].some(key=>focusData[key]&&button.dataset[key]===focusData[key])){button.focus();break;}
}
function renderViewMenu(){
  viewMenu.innerHTML=`<div class="workspace-view-row"><span>缩放</span><div><button type="button" data-office-action="zoom-out" aria-label="缩小" title="缩小">${icon('minus')}</button><button type="button" data-office-action="zoom-in" aria-label="放大" title="放大">${icon('plus')}</button><button type="button" data-office-action="fit" aria-label="恢复全景" title="${scene.mode==='3d'?'恢复全景（Home）':'恢复全景'}">${icon('target')}</button></div></div>${scene.mode==='3d'?`<div class="workspace-view-row"><span>旋转</span><div><button type="button" data-office-action="rotate-left" aria-label="向左旋转" title="向左旋转">↶</button><button type="button" data-office-action="rotate-right" aria-label="向右旋转" title="向右旋转">↷</button></div></div>`:''}<button type="button" class="workspace-view-option" data-office-action="topology" aria-pressed="${topology}">${icon('network')}<span>网络连线</span><span>${topology?'开':'关'}</span></button><button type="button" class="workspace-view-option" data-office-action="fullscreen">${icon(document.fullscreenElement?'fullscreen-exit':'fullscreen')}<span>${document.fullscreenElement?'退出全屏':'全屏'}</span></button>`;
}
function requireAccount(){if(isAuthenticated()&&erp)return true;account?.requireLogin();return false;}
async function openSection(next,context={}){
  if(!requireAccount())return;
  viewMenu.hidden=true;scene.setSelectedNode(SECTION_ROOMS[next]||null);section=next;renderDock();
  void presence?.moveTo(SECTION_ROOMS[next]||'general_office');
  await erp.open(next,context);
}
async function openDocument(id){
  if(!requireAccount())return;
  preferredDocument=id;receipt.hidden=true;viewMenu.hidden=true;await erp.openDocument(id);
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
    if(!erp.isOpen&&!account?.session?.anonymous)void openDocument(notice.id);
  }
}
const scene=createSceneViewController(document.querySelector('#office-scene'),{
  onSelectNode:id=>void openSection(ROOM_SECTIONS[id]||'desk'),
  onSelectAgent:id=>{if(!requireAccount())return;const document=crewDocument(snapshot,id);if(document)void openDocument(document.id);else void openSection(CREW.find(p=>p.id===id)?.section||'desk');},
  onSelectHuman:()=>void openSection('desk')
},{mount2D:mountScene,onChange:({mode})=>{lab.dataset.view=mode;renderDock();renderViewMenu();try{localStorage.setItem('office-view-mode',mode);}catch{}},onError:()=>toast('3D 暂不可用，已切换为 2D。')});
scene.setTopology(topology);scene.setPresence({enabled:true,people:[],currentUserId:null});scene.update(sceneProjection());
async function startSession(next){
  const nextActor=next?.actor||next?.user;
  if(!nextActor?.id){cleanPrivateState();return;}
  if(isAuthenticated()&&actor().id===nextActor.id){session=next;erp?.updateSession(next);renderDock();return;}
  cleanPrivateState();session=next;
  erp=mountErp({request:api,session,scene,container:businessFrame,onChange:({snapshot:value})=>receiveSnapshot(value),onNavigate:({section:nextSection,opened,documentId})=>{section=opened?nextSection:null;preferredDocument=documentId||null;renderDock();},onClose:()=>{scene.setSelectedNode(null);scene.setSelectedAgent(null);}});
  presence=mountErpPresence({scene,request:api,session,onSelectEmployee:person=>{if(!requireAccount())return;if(person.id===actor().id)void openSection('desk');else void erp.openPerson(person.id);}});
  renderDock();await erp.refresh();
}
async function toggleFullscreen(){try{if(document.fullscreenElement)await document.exitFullscreen();else await lab.requestFullscreen();}catch{toast('浏览器未允许全屏。');}renderViewMenu();}
async function handleOfficeClick(event){
  const target=event.target.closest('[data-office-action],[data-office-section],[data-office-view],[data-office-document]');
  if(!target)return;
  try{
    if(target.dataset.officeSection)return await openSection(target.dataset.officeSection);
    if(target.dataset.officeDocument)return await openDocument(target.dataset.officeDocument);
    if(target.dataset.officeView){viewMenu.hidden=true;return await scene.setMode(target.dataset.officeView);}
    switch(target.dataset.officeAction){
      case 'home':erp?.close();scene.fit();break;
      case 'account':viewMenu.hidden=true;account?.open();break;
      case 'view':viewMenu.hidden=!viewMenu.hidden;renderViewMenu();renderDock();if(!viewMenu.hidden)revealSurface(viewMenu);else cancelSurfaceMotion(viewMenu);break;
      case 'zoom-in':scene.zoom(.14);break;
      case 'zoom-out':scene.zoom(-.14);break;
      case 'fit':scene.resetView();break;
      case 'rotate-left':scene.rotate(-Math.PI/8);break;
      case 'rotate-right':scene.rotate(Math.PI/8);break;
      case 'topology':topology=!topology;scene.setTopology(topology);renderViewMenu();break;
      case 'fullscreen':await toggleFullscreen();break;
      case 'dismiss-receipt':receipt.hidden=true;break;
    }
  }catch(error){if(error.status!==401)toast(/Agent|模型|provider|API|qwen/i.test(error.message)?'操作未完成，请重试。':error.message);}
}
document.addEventListener('click',event=>{void handleOfficeClick(event);if(!viewMenu.hidden&&!event.target.closest('#view-menu,[data-office-action="view"]')){viewMenu.hidden=true;renderDock();}});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!viewMenu.hidden){viewMenu.hidden=true;renderDock();}});
document.addEventListener('fullscreenchange',renderViewMenu);
window.addEventListener('office:session-ended',()=>{cleanPrivateState();account?.requireLogin('请重新登录。');});
renderDock();renderViewMenu();
account=mountSession({container:lab,onAuthenticated:next=>{void startSession(next).catch(error=>{if(error.status!==401)toast('工作数据暂未载入，请重试。');});},onSignedOut:cleanPrivateState,onSessionExpired:cleanPrivateState,onChange:next=>{if(isAuthenticated()&&next?.actor?.id===actor().id){session=next;erp?.updateSession(next);renderDock();}}});
await account.ready;
// Reconcile while the business pane is closed; the pane owns its own visible polling.
pollTimer=setInterval(()=>{if(erp&&!erp.isOpen&&!document.hidden)void erp.refresh({silent:true}).catch(()=>{});},8000);
document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelSurfaceMotions();else if(erp)void erp.refresh({silent:true}).catch(()=>{});});
try{const saved=localStorage.getItem('office-view-mode');if(saved==='3d')void scene.setMode('3d');}catch{}
window.addEventListener('pagehide',event=>{if(event?.persisted)return;workspaceViewport.destroy();cancelSurfaceMotions();motionPreference?.removeEventListener?.('change',updateMotionPreference);clearInterval(pollTimer);clearTimeout(toastTimer);clearTimeout(receiptTimer);presence?.destroy();erp?.destroy();account?.destroy();scene.destroy();});
