import {BULLETIN_SECTIONS,bulletinTile} from './bulletin-sections.mjs';
import * as THREE from './vendor/three.module.js';
import { NODE_META } from './scene.js';
import { HUMAN_EMPLOYEES } from './people.js';
import { OFFICE3D_ROOMS, OFFICE3D_BOUNDS, OFFICE3D_CENTER, AGENT3D_HOMES, OFFICE3D_COLORS, createOffice3DAssets, createOffice3DLayout } from './scene3d-layout.js';
import { createOffice3DActor } from './scene3d-actors.js';
import { createScene3DMotion } from './scene3d-motion.js';
import { createOfficePresenceMotion } from './erp-presence.js';
import { createViewTween } from './scene-motion.js';
import {clampOfficeScale,officeWheelScale,officePinchScale,officeCameraChanged} from './office-camera.mjs';
import { greetingForPerson } from './person-greeting.mjs';
import { mountOfficeAmbient } from './office-ambient.mjs';
import { OFFICE_SEATS, OFFICE_WORLD, OFFICE_SHARED_AREAS, OFFICE_BULLETIN_AREA, OFFICE_CONVENIENCE_AREA, OFFICE_RECREATION_AREA, OFFICE_DATA_CENTER, OFFICE_DETAIL_ZOOM, officeTeamDetail,officeDisplayPoint,officeCanonicalPoint,officePointInTeam } from './organization.mjs';
import { selectOfficeNameLabels } from './person-labels.mjs';
import { organizationOccupant, subscribeOrganizationOccupants } from './organization-occupants.mjs';

let greetingSequence=0;
const greetingFaces={
  human:'<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect x=".65" y=".65" width="30.7" height="30.7" rx="11" fill="#f6eadf" stroke="#dfcdbd" stroke-width="1.1"/><circle cx="16" cy="16" r="10.6" fill="#f0cfab"/><path d="M9.7 14q1.7-2.2 3.5 0m5.6 0q1.7-2.2 3.5 0" stroke="#71513f" stroke-width="1.55" stroke-linecap="round"/><path d="M11 18.6q5 5.8 10 0" fill="#fffdf6" stroke="#9b6651" stroke-width="1.15" stroke-linecap="round"/><circle cx="9.2" cy="17.5" r="1.45" fill="#d2947e" opacity=".6"/><circle cx="22.8" cy="17.5" r="1.45" fill="#d2947e" opacity=".6"/><path d="m25.2 5.8.8-1.6.8 1.6 1.6.8-1.6.8-.8 1.6-.8-1.6-1.6-.8Z" fill="#ba896c"/></svg>',
  robot:'<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect x=".65" y=".65" width="30.7" height="30.7" rx="11" fill="#eef2e6" stroke="#d3ddcd" stroke-width="1.1"/><path d="M16 8V4.5m-12 11v5m24-5v5" stroke="#709480" stroke-width="1.5" stroke-linecap="round"/><circle cx="16" cy="4" r="1.55" fill="#ba8267"/><rect x="6" y="8" width="20" height="18" rx="6" fill="#fffdf6" stroke="#5f8875" stroke-width="1.2"/><path d="M9.8 15.4q1.7-2.8 3.4 0m5.6 0q1.7-2.8 3.4 0" stroke="#3c7160" stroke-width="1.6" stroke-linecap="round"/><path d="M11.8 20q4.2 4.4 8.4 0" fill="#e4edde" stroke="#3c7160" stroke-width="1.15" stroke-linecap="round"/><path d="M9 18.2h1.5m11 0H23" stroke="#bb9277" stroke-width="1.25" stroke-linecap="round"/></svg>',
};

export class Scene3DUnavailableError extends Error {
  constructor(message='当前设备无法创建 3D 画面',cause){super(message,{cause});this.name='Scene3DUnavailableError';this.code='WEBGL_UNAVAILABLE';}
}
export const OFFICE3D_CAMERA_OFFSET=Object.freeze([-330,760,1200]);
export const OFFICE3D_LINKS=Object.freeze([
  ['internet','firewall'],['firewall','core'],['core','server'],['core','storage'],['core','access'],['access','workstations'],['core','executive'],['access','meeting'],['access','reception'],['access','finance'],['access','investment'],['investment','general_office'],
]);
const bounds=OFFICE3D_BOUNDS;
const V=new THREE.Vector3(),Y_AXIS=new THREE.Vector3(0,1,0);
const fixedLabels=new Set(['server','firewall','core']);
const shortDepartmentNames=Object.freeze({business:'商务',hr_admin:'人事行政',finance:'财务',legal:'法务合规',channels:'渠道',research:'研发',operations:'运营',general_office:'总经办',ai_data:'AI数据',investment:'投资者关系',maintenance:'运维',public_affairs:'公共事务'});
const departmentTitleBreaks=Object.freeze({hr_admin:'人力资源与\n行政管理部',public_affairs:'公共事务\n关系部',investment:'投资者\n关系部',legal:'法务与\n合规部'});
const roleCountText=counts=>[['chairman','董事长'],['manager','经理'],['head','部长'],['staff','员工']].filter(([key])=>counts?.[key]>0).map(([key,label])=>`${counts[key]} ${label}`).join(' · ');
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const defaultAzimuth=Math.atan2(OFFICE3D_CAMERA_OFFSET[0],OFFICE3D_CAMERA_OFFSET[2]);
const defaultElevation=Math.atan2(OFFICE3D_CAMERA_OFFSET[1],Math.hypot(OFFICE3D_CAMERA_OFFSET[0],OFFICE3D_CAMERA_OFFSET[2]));
const safeStatus=value=>['online','warning','offline','recovering'].includes(value)?value:'online';
function nodeStatus(nodes,id){return safeStatus(typeof nodes?.[id]==='string'?nodes[id]:nodes?.[id]?.status);}

/* Fit the rotated office bounds instead of fitting an unrotated approximation. */
export function office3DFrustum(aspect=1.6,{azimuth=defaultAzimuth,elevation=defaultElevation,padding=1.035}={}){
  aspect=Math.max(.15,Number(aspect)||1.6);azimuth=Number.isFinite(azimuth)?azimuth:defaultAzimuth;elevation=clamp(Number.isFinite(elevation)?elevation:defaultElevation,.42,1.28);
  const direction=new THREE.Vector3(Math.sin(azimuth)*Math.cos(elevation),Math.sin(elevation),Math.cos(azimuth)*Math.cos(elevation)),right=new THREE.Vector3().crossVectors(Y_AXIS,direction).normalize(),up=new THREE.Vector3().crossVectors(direction,right).normalize();
  let xMin=Infinity,xMax=-Infinity,yMin=Infinity,yMax=-Infinity;
  for(const x of[bounds.min.x,bounds.max.x])for(const y of[bounds.min.y,bounds.max.y])for(const z of[bounds.min.z,bounds.max.z]){const p=new THREE.Vector3(x-OFFICE3D_CENTER.x,y-OFFICE3D_CENTER.y,z-OFFICE3D_CENTER.z),px=p.dot(right),py=p.dot(up);xMin=Math.min(xMin,px);xMax=Math.max(xMax,px);yMin=Math.min(yMin,py);yMax=Math.max(yMax,py);}
  const height=Math.max(yMax-yMin,(xMax-xMin)/aspect)*Math.max(1.01,padding);return {width:height*aspect,height,direction,right,up,centerX:(xMin+xMax)/2,centerY:(yMin+yMax)/2};
}

// Focus uses the destination's viewing frame. Projecting into the frame before
// a rotation can crop the room or leave it far off-centre after the turn.
export function office3DRegionView(region,{width=1440,height=900,azimuth=defaultAzimuth}={}){
  if(!region||![region.x,region.y,region.w,region.h].every(Number.isFinite)||region.w<=0||region.h<=0)return null;
  width=Number.isFinite(Number(width))&&Number(width)>0?Number(width):1440;height=Number.isFinite(Number(height))&&Number(height)>0?Number(height):900;azimuth=Number.isFinite(azimuth)?azimuth:defaultAzimuth;
  const reserved=Math.min(100,Math.max(72,height*.095)),usable=Math.max(1,height-reserved),frame=office3DFrustum(width/usable);
  const gutter=Math.min(48,Math.max(20,width*.025)),verticalGutter=Math.min(40,Math.max(20,usable*.045));
  let left=Infinity,right=-Infinity,bottom=Infinity,top=-Infinity;
  const altitude=region.id==='data_center'?100:76;
  for(const x of[region.x-8,region.x+region.w+8])for(const y of[0,altitude])for(const z of[region.y-8,region.y+region.h+8]){
    const point=new THREE.Vector3(x-OFFICE3D_CENTER.x,y-OFFICE3D_CENTER.y,z-OFFICE3D_CENTER.z),px=point.dot(frame.right),py=point.dot(frame.up);
    left=Math.min(left,px);right=Math.max(right,px);bottom=Math.min(bottom,py);top=Math.max(top,py);
  }
  const scale=clampOfficeScale(Math.min(frame.width/(right-left)*Math.max(.1,1-gutter*2/width),frame.height/(top-bottom)*Math.max(.1,1-verticalGutter*2/usable)),{automatic:true});
  const bearing=azimuth+Math.atan2(Math.sin(defaultAzimuth-azimuth),Math.cos(defaultAzimuth-azimuth));
  return {scale,panX:(left+right)/2-frame.centerX,panY:(bottom+top)/2-frame.centerY,azimuth:bearing,elevation:defaultElevation};
}

export function scene3DFramePolicy(previous=0,current=0,{reducedMotion=false,interacting=false,urgent=false,ambientOnly=false,force=false,dirty=false,busy=true}={}) {
  const delta=previous?Math.min(100,Math.max(0,current-previous)):16;
  const interval=ambientOnly?1000/30:interacting||urgent?14:30;
  return {render:!previous||force||dirty&&!interacting||reducedMotion||delta+.001>=interval,delta,continue:interacting||busy||dirty};
}
// Keep common Retina desktops at native resolution. Large surfaces remain bounded
// by both the framebuffer budget and the device's actual renderbuffer limits.
export function scene3DPixelRatio(width,height,deviceRatio=1,{maxDimension=8192}={}){
  const positive=(value,fallback)=>Number.isFinite(Number(value))&&Number(value)>0?Number(value):fallback;
  width=positive(width,1);height=positive(height,1);maxDimension=positive(maxDimension,8192);
  return Math.min(positive(deviceRatio,1),2,Math.sqrt(9000000/(width*height)),maxDimension/width,maxDimension/height);
}
export function scene3DGestureMode(event,touches=1){return touches>1?'touch':event.pointerType==='touch'||event.button===2?'orbit':'pan';}

export function mountScene3D(container,{
  onSelectNode=()=>{},onSelectBulletin=()=>{},onHoverBulletin=()=>{},onLeaveBulletin=()=>{},onEnterArea=()=>{},onNavigationContext=()=>{},onSelectSeat=()=>{},onMovePoint=()=>{},onSelectAgent=()=>{},onSelectHuman=()=>{},onDelivery=()=>{},onViewChange=()=>{},onUnavailable=()=>{},
  rendererFactory=options=>new THREE.WebGLRenderer(options),ambientEnabled=true,ambientRandom=Math.random,ambientNow=()=>performance.now(),
}={}) {
  if(!container||!globalThis.document)throw new Scene3DUnavailableError('缺少 3D 显示容器');
  let renderer;try{renderer=rendererFactory({antialias:true,alpha:true,powerPreference:'high-performance'});}catch(error){throw new Scene3DUnavailableError('当前设备未提供可用的 WebGL，已保留 2D 视图',error);}
  const assets=createOffice3DAssets(),layout=createOffice3DLayout(assets),scene=new THREE.Scene();scene.background=null;
  scene.add(layout.root);scene.add(new THREE.HemisphereLight('#f7fbff','#b8c5b3',2.05));const sun=new THREE.DirectionalLight('#fff6e7',2);sun.position.set(-300,1000,400);scene.add(sun);
  renderer.shadowMap.enabled=false;renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.NeutralToneMapping;renderer.toneMappingExposure=1;
  let maxBufferDimension=8192;
  try{const gl=renderer.getContext?.();for(const limit of [renderer.capabilities?.maxTextureSize,gl?.getParameter(gl.MAX_RENDERBUFFER_SIZE),...(gl?.getParameter(gl.MAX_VIEWPORT_DIMS)||[])])if(Number.isFinite(limit)&&limit>0)maxBufferDimension=Math.min(maxBufferDimension,limit);}catch{/* Retain the conservative size limit if the context cannot report it. */}
  const wrapper=document.createElement('div');wrapper.className='office-scene3d';wrapper.dataset.view='3d';wrapper.tabIndex=0;wrapper.setAttribute('aria-label','办公室');
  const canvas=renderer.domElement;canvas.className='office-scene3d-canvas';canvas.setAttribute('aria-hidden','true');canvas.style.touchAction='none';canvas.style.width='100%';canvas.style.height='100%';
  const labels=document.createElement('div');labels.className='office-scene3d-labels';
  wrapper.append(canvas,labels);container.append(wrapper);
  const postTooltip=document.createElement('div');postTooltip.className='office3d-post-tooltip';postTooltip.hidden=true;postTooltip.setAttribute('role','tooltip');
  const postTitle=document.createElement('strong'),postDepartment=document.createElement('small');postTooltip.append(postTitle,postDepartment);labels.append(postTooltip);
  const postsById=new Map(OFFICE_SEATS.map(seat=>[seat.id,seat])),roleLabels=new Map(),teamLabels=new Map(),teamsById=new Map(OFFICE3D_ROOMS.flatMap(room=>room.teamZones).map(team=>[team.id,team]));let hoveredPost=null,hoveredRegion=null;
  const greetingElement=document.createElement('div');greetingElement.className='office3d-greeting';greetingElement.id=`office3d-person-greeting-${++greetingSequence}`;greetingElement.hidden=true;greetingElement.setAttribute('role','tooltip');greetingElement.setAttribute('aria-hidden','true');
  const greetingFace=document.createElement('span');greetingFace.className='office3d-greeting-face';greetingFace.setAttribute('aria-hidden','true');const greetingText=document.createElement('span');greetingText.className='office3d-greeting-text';const greetingTail=document.createElement('span');greetingTail.className='office3d-greeting-tail';greetingTail.setAttribute('aria-hidden','true');greetingTail.innerHTML='<svg viewBox="0 0 22 13" fill="none" aria-hidden="true"><path class="office3d-greeting-tail-outline" d="M1 1H21L7 11.2Q4.8 12.7 5 10L5.7 1Z"/><path class="office3d-greeting-tail-seam" d="M1 1H21"/></svg>';greetingElement.append(greetingFace,greetingText,greetingTail);labels.append(greetingElement);
  const camera=new THREE.OrthographicCamera(-600,600,450,-450,1,10000),target=new THREE.Vector3(OFFICE3D_CENTER.x,OFFICE3D_CENTER.y,OFFICE3D_CENTER.z);
  let azimuth=defaultAzimuth,elevation=defaultElevation,cameraFrame=office3DFrustum(),pixelRatio=1;
  const stats={renders:0,actorUpdates:0,instanceUploads:0,staticPoseUploads:0,drawCalls:0,triangles:0,lastRenderMs:0,frameMs:0,pixelRatio:1,width:0,height:0,bufferWidth:0,bufferHeight:0,resizes:0,staticInstances:layout.statistics.staticInstances,organizationPeople:layout.statistics.people,workplaces:layout.statistics.workplaces};
  const nodeButtons=new Map(),agentButtons=new Map(),humanButtons=new Map(),roomButtons=new Map();
  const agents=new Map(),humans=new Map(),motionAgents=new Map(),motionHumans=new Map();const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2(),picks=[];
  const actualPeople=new Map(),employeeButtons=new Map();let presenceState={enabled:false,people:[]};
  const links=new THREE.Group(),routes=new THREE.Group();scene.add(links,routes);
  const linkMaterials=new Map();
  const pickMaterial=new THREE.MeshBasicMaterial({visible:false});
  const pickGeometry=new THREE.BoxGeometry(24,52,24);
  const routeMaterial=new THREE.MeshBasicMaterial({color:'#b95b43'});
  const linkMaterial=(status='online')=>{if(!linkMaterials.has(status))linkMaterials.set(status,new THREE.MeshBasicMaterial({color:({online:'#7a9a8a',warning:'#b88b46',offline:'#bd5c48',recovering:'#89a399'})[status]||'#7a9a8a'}));return linkMaterials.get(status);};
  let destroyed=false,active=true,inactiveAt=null,contextLost=false,frame=0,lastFrame=0,width=1,height=1,scale=1,panX=0,panY=0,drag=null,suppressClickUntil=0;
  const touches=new Map();let touchGesture=null,nativeGesture=null;
  let selectedNode=null,selectedAgent=null,selectedHuman=null,topologyVisible=true,latestState={},hiddenAt=document.hidden?performance.now():null;
  const motionPreference=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');let reducedMotion=motionPreference?.matches||false;
  let routeSignature='',currentRouteMeshes=[],labelsDirty=true,renderDirty=true,urgentRenderDirty=true,forceFrame=false,pendingResize=null,hoveredKey='',selectionTimer=null,pendingSelection=null,lastClickTarget=null,greeting=null,ambient=null,detailFocus=null,manualDetail=false,focusedRegion=null,cameraMotionKind=null,motionAnchor=null,teamZoomCandidate=null,overviewEnterGuardUntil=0;
  const actorList=()=>[...agents.values(),...humans.values()];
  const disposables=[];
  const schedule=()=>{if(!frame&&active&&!destroyed&&!contextLost&&!document.hidden)frame=requestAnimationFrame(renderFrame);};
  const markDirty=reason=>{labelsDirty=true;renderDirty=true;if(reason!=='ambient')urgentRenderDirty=true;ambient?.refresh();schedule();};
  const viewState=()=>({scale,panX,panY,azimuth,elevation});
  const viewTween=createViewTween({read:viewState,write:value=>{({scale,panX,panY,azimuth,elevation}=value);if(motionAnchor)({panX,panY}=anchoredPan(motionAnchor,scale,azimuth,elevation));setCamera();labelsDirty=true;renderDirty=true;},onStart:()=>{forceFrame=true;markDirty();}});
  const controller=createScene3DMotion({agents:motionAgents,humans:motionHumans,reducedMotion,onDelivery:event=>{onDelivery(event);markDirty();},onChange:markDirty});
  const presenceMotion=createOfficePresenceMotion({reducedMotion,onChange:entry=>positionEmployee(entry)});
  function listen(element,type,handler,options){element.addEventListener(type,handler,options);disposables.push(()=>element.removeEventListener(type,handler,options));}
  const buttonAnimations=new WeakMap();
  function clearGreeting({redraw=true}={}){
    if(!greeting)return;const previous=greeting;greeting=null;previous.actor.setGreeting(false);previous.anchor?.removeAttribute?.('aria-describedby');if(previous.anchor)delete previous.anchor.dataset.greeting;
    greetingElement.hidden=true;greetingElement.setAttribute('aria-hidden','true');greetingText.textContent='';greetingFace.innerHTML='';delete greetingElement.dataset.person;delete greetingElement.dataset.kind;if(redraw&&!destroyed)markDirty();
  }
  function positionGreeting(){
    if(!greeting)return;const {actor}=greeting,at=project(actor.point,actor.height+13);
    if(!actor.root.visible||!at?.visible||at.x<0||at.y<0||at.x>width||at.y>height){clearGreeting();return;}
    greetingElement.style.left=`${clamp(at.x,85,Math.max(85,width-85)).toFixed(1)}px`;greetingElement.style.top=`${clamp(at.y,62,Math.max(62,height-20)).toFixed(1)}px`;
  }
  function showGreeting(type,id,anchor){
    if(destroyed||document.hidden||drag||touches.size||!['agent','human','employee'].includes(type))return;clearPost();
    const actor=type==='agent'?agents.get(id):humans.get(id);if(!actor?.root.visible||type==='human'&&presenceState.enabled)return;
    const key=`${type}:${id}`;if(greeting?.key===key){positionGreeting();return;}clearGreeting();
    const message=greetingForPerson({virtual:type==='agent'});greeting={key,type,id,actor,anchor:anchor||(type==='agent'?agentButtons.get(id):type==='employee'?employeeButtons.get(id):humanButtons.get(id))};
    greetingFace.innerHTML=greetingFaces[message.kind]||greetingFaces.human;greetingText.textContent=message.text;greetingElement.dataset.kind=message.kind;greetingElement.dataset.person=id;greetingElement.hidden=false;greetingElement.setAttribute('aria-hidden','false');ambient?.refresh();
    if(greeting.anchor){greeting.anchor.dataset.greeting='true';greeting.anchor.setAttribute('aria-describedby',greetingElement.id);}actor.setGreeting(true,{animated:!reducedMotion});positionGreeting();markDirty();
  }
  function clearPost(){hoveredPost=null;hoveredRegion=null;postTooltip.hidden=true;delete postTooltip.dataset.post;delete postTooltip.dataset.department;delete postTooltip.dataset.team;ambient?.refresh();}
  function positionPost(){
    if(!hoveredPost&&!hoveredRegion)return;
    const geometry=hoveredPost?layout.seatGeometry(hoveredPost.id):{x:hoveredRegion.x+hoveredRegion.w/2,y:hoveredRegion.y+24,scale:1};if(!geometry){clearPost();return;}const at=project(geometry,hoveredPost?48*geometry.scale:34);
    if(!at?.visible){clearPost();return;}postTooltip.style.left=`${clamp(at.x,100,Math.max(100,width-100)).toFixed(1)}px`;postTooltip.style.top=`${clamp(at.y-8,50,Math.max(50,height-20)).toFixed(1)}px`;
  }
  function showPost(seat){if(!seat||!layout.isSeatVisible(seat.id)||!layout.seatGeometry(seat.id)||destroyed||document.hidden||drag||touches.size)return;clearGreeting();clearPost();hoveredPost=seat;postTitle.textContent=organizationOccupant(seat)?.name||'工位';postDepartment.textContent=OFFICE3D_ROOMS.find(room=>room.id===seat.departmentId)?.title||'';postTooltip.dataset.post=seat.id;postTooltip.hidden=false;positionPost();ambient?.refresh();}
  function showRegion(type,id){
    const region=type==='team'?teamsById.get(id):OFFICE3D_ROOMS.find(room=>room.id===id);if(!region||destroyed||document.hidden||drag||touches.size)return false;
    clearGreeting();clearPost();hoveredRegion=type==='team'&&layout.localTeamId===id?{...region,...region.detailBounds}:region;postTitle.textContent=type==='team'?`AI数据算法部 · ${region.title}`:region.title;postDepartment.textContent=roleCountText(type==='team'?{head:1,staff:region.staffCount}:region.roleCounts);postTooltip.dataset[type==='team'?'team':'department']=id;postTooltip.hidden=false;positionPost();ambient?.refresh();return true;
  }
  function leavePerson(type,id){if(greeting?.key===`${type}:${id}`)clearGreeting();hoveredKey='';}
  function feedback(type,id,kind='hover',element){
    if(reducedMotion||destroyed)return;
    const actor=type==='agent'?agents.get(id):humans.get(id);if(actor){actor.react(kind);markDirty();}
    if(element?.animate){buttonAnimations.get(element)?.cancel();buttonAnimations.set(element,element.animate([{translate:'0 0',scale:1},{translate:kind==='press'?'0 1px':'0 -2px',scale:kind==='press'?.97:1.035},{translate:'0 0',scale:1}],{duration:kind==='press'?250:320,easing:'cubic-bezier(.2,.7,.2,1)'}));}
  }
  function identityFor(el){for(const type of ['agent','human','employee','post','team','bulletin','node'])if(el?.dataset?.[type])return {type,id:el.dataset[type]};return null;}
  function clearSelectionTimer(){clearTimeout(selectionTimer);selectionTimer=null;pendingSelection=null;}
  function overviewTeamForPost(id){const seat=postsById.get(id);return !layout.localTeamId&&seat?.teamId&&layout.isSeatVisible(id)?seat.teamId:null;}
  const localEntryGuard=()=>!!layout.localTeamId&&performance.now()<overviewEnterGuardUntil;
  function enterTeamFromInput(id){const fromOverview=!layout.localTeamId,focused=focusTeam(id);if(focused){if(fromOverview){overviewEnterGuardUntil=performance.now()+520;suppressClickUntil=Math.max(suppressClickUntil,overviewEnterGuardUntil);}onEnterArea(id);}return focused;}
  function focusObject(type,id){
    if(type==='bulletin')return select(type,id);
    if(type==='team')return localEntryGuard()&&layout.localTeamId===id?true:enterTeamFromInput(id);
    if(type==='post'&&localEntryGuard())return true;
    const team=type==='post'?overviewTeamForPost(id):null;if(team)return enterTeamFromInput(team);
    clearSelectionTimer();select(type,id,false);feedback(type,id,'press');
    if(type==='node'&&OFFICE3D_ROOMS.some(room=>room.id===id)){const focused=focusDepartment(id);if(focused)onEnterArea(id);return focused;}
    const point=type==='post'?layout.seatGeometry(id):type==='agent'?agents.get(id)?.point:type==='human'||type==='employee'?humans.get(id)?.point:NODE_META[id];return focusPoint(point);
  }
  function queueSelection(type,id,detail=1){
    if(localEntryGuard()&&(type==='post'||type==='team'&&layout.localTeamId===id))return;
    const team=type==='team'?id:type==='post'?overviewTeamForPost(id):null;if(team){clearSelectionTimer();enterTeamFromInput(team);return;}
    if(pendingSelection?.type===type&&pendingSelection.id===id||detail>1){focusObject(type,id);return;}
    clearSelectionTimer();pendingSelection={type,id};feedback(type,id,'press');selectionTimer=setTimeout(()=>{clearSelectionTimer();if(!destroyed)select(type,id);},350);
  }
  function button(className,label,choose){const el=document.createElement('button');el.type='button';el.className=className;el.setAttribute('aria-label',label);el.setAttribute('aria-pressed','false');el.style.position='absolute';el.style.pointerEvents='auto';
    listen(el,'pointerdown',e=>{e.stopPropagation();const p=identityFor(el);if(p)onDown(e,p);});listen(el,'contextmenu',e=>e.preventDefault());
    listen(el,'pointerenter',()=>{const p=identityFor(el);if(!p)return;if(['agent','human','employee'].includes(p.type))showGreeting(p.type,p.id,el);else if(p.type==='bulletin')showBulletin(p.id);else if(p.type==='post')showPost(postsById.get(p.id));else if(p.type==='team'||p.type==='node'&&OFFICE3D_ROOMS.some(room=>room.id===p.id))showRegion(p.type==='team'?'team':'department',p.id);else{clearPost();clearGreeting();feedback(p.type,p.id,'hover',el);}});
    listen(el,'pointerleave',()=>{const p=identityFor(el);if(p){if(p.type==='bulletin'&&document.activeElement!==el)onLeaveBulletin(p.id);leavePerson(p.type,p.id);if(['post','team','node'].includes(p.type))clearPost();}});listen(el,'focus',()=>{const p=identityFor(el);if(p?.type==='bulletin')showBulletin(p.id);else if(p?.type==='post')showPost(postsById.get(p.id));else if(p?.type==='team'||p?.type==='node'&&OFFICE3D_ROOMS.some(room=>room.id===p.id))showRegion(p.type==='team'?'team':'department',p.id);else if(p)showGreeting(p.type,p.id,el);});listen(el,'blur',()=>{const p=identityFor(el);if(p){if(p.type==='bulletin'&&!el.matches?.(':hover'))onLeaveBulletin(p.id);leavePerson(p.type,p.id);if(['post','team','node'].includes(p.type))clearPost();}});
    listen(el,'click',e=>{e.stopPropagation();if(e.detail!==0&&performance.now()<suppressClickUntil)return;const p=identityFor(el);if(p){feedback(p.type,p.id,'press',el);if(e.detail===0){clearSelectionTimer();select(p.type,p.id);}else if(p.type==='bulletin'){clearSelectionTimer();select(p.type,p.id);}else queueSelection(p.type,p.id,e.detail);}else choose();});listen(el,'dblclick',e=>{e.preventDefault();e.stopPropagation();const p=identityFor(el);if(p)focusObject(p.type,p.id);});labels.append(el);return el;}
  function select(type,id,notify=true){
    if(type==='bulletin'){clearSelectionTimer();onLeaveBulletin();if(notify)onSelectBulletin(id);return;}
    if(type==='team'){if(notify)enterTeamFromInput(id);else focusTeam(id);return;}
    if(type==='post'){const seat=postsById.get(id),point=layout.seatGeometry(id);if(!seat||!point||!layout.isSeatVisible(id))return;const team=overviewTeamForPost(id);if(team){if(notify)enterTeamFromInput(team);else focusTeam(team);return;}showPost(seat);if(notify)onSelectSeat(id,{x:seat.x,y:seat.y,nodeId:seat.departmentId});return;}
    if(type==='node')selectedNode=id;else if(id)selectedNode=null;
    if(type==='agent')selectedAgent=id;else if(id)selectedAgent=null;
    if(type==='human'||type==='employee')selectedHuman=id;else if(id)selectedHuman=null;
    for(const [key,el]of nodeButtons)el.setAttribute('aria-pressed',String(key===selectedNode));for(const [key,el]of agentButtons)el.setAttribute('aria-pressed',String(key===selectedAgent));for(const [key,el]of humanButtons)el.setAttribute('aria-pressed',String(key===selectedHuman));
    for(const [key,el]of employeeButtons)el.setAttribute('aria-pressed',String(key===selectedHuman));
    if(notify&&id){if(type==='employee'){const person=presenceMotion.entries.get(id)?.person;if(presenceState.enabled&&person)presenceState.onSelectEmployee({...person});}else({node:onSelectNode,agent:onSelectAgent,human:onSelectHuman})[type]?.(id);}markDirty();}
  function addPick(root,type,id,x=0,y=25,z=0,w=1,h=1,d=1){const hit=new THREE.Mesh(pickGeometry,pickMaterial);hit.position.set(x,y,z);hit.scale.set(w,h,d);hit.userData={type,id};root.add(hit);picks.push(hit);}
  function placeActor(actor,canonical,seat=null){
    actor.canonicalPoint={x:canonical.x,y:canonical.y};actor.point=seat?{x:seat.x,y:seat.y}:officeDisplayPoint(actor.canonicalPoint,layout.localTeamId);actor.setPosition(actor.point);actor.setScale(seat?.scale||(layout.localTeamId?.72:1.12));
    const id=actor.root.userData.actorId,visible=(actor.identity.virtual||actualPeople.has(id)||!presenceState.enabled)&&(!layout.localTeamId||officePointInTeam(actor.canonicalPoint,layout.localTeamId,{margin:0}));
    if(actor.root.visible!==visible){actor.root.visible=visible;actor.invalidate();}
  }
  // Motion and business state always use canonical coordinates. The rendering
  // actor can live in a separate, full-size team room without altering routes.
  function motionActor(actor){
    const facade=Object.create(actor);Object.defineProperty(facade,'point',{get:()=>actor.canonicalPoint||actor.point,set:point=>{actor.canonicalPoint={x:point.x,y:point.y};}});
    facade.setPosition=point=>placeActor(actor,point);facade.facePoint=point=>actor.facePoint(officeDisplayPoint(point,layout.localTeamId));return facade;
  }
  function setActorInitial(actor,meta){actor.homeSeated=!!meta.seated;placeActor(actor,{x:meta.x,y:meta.y});if(meta.seated){actor.setPose({seated:true});actor.root.rotation.y=Math.PI;actor.animate(0,{reducedMotion:true});}scene.add(actor.root);}
  for(const [id,home]of Object.entries(AGENT3D_HOMES)){
    const actor=createOffice3DActor(assets,{...home,id},{virtual:true,scale:1.12});setActorInitial(actor,home);agents.set(id,actor);motionAgents.set(id,motionActor(actor));addPick(actor.root,'agent',id);
    const el=button('office3d-hotspot office3d-person-hit',`${home.name}，${home.role}`,()=>select('agent',id));el.dataset.agent=id;
    const name=document.createElement('span');name.className='office3d-person-label';name.textContent=home.name;el.append(name);agentButtons.set(id,el);
  }
  for(const meta of HUMAN_EMPLOYEES){
    const actor=createOffice3DActor(assets,meta,{scale:1.12});setActorInitial(actor,meta);humans.set(meta.id,actor);motionHumans.set(meta.id,motionActor(actor));addPick(actor.root,'human',meta.id);
    const el=button('office3d-hotspot office3d-person-hit',`${meta.name}，${meta.role}`,()=>select('human',meta.id));el.dataset.human=meta.id;
    const name=document.createElement('span');name.className='office3d-person-label';name.textContent=meta.name;el.append(name);humanButtons.set(meta.id,el);
  }
  const postPicks=new THREE.InstancedMesh(pickGeometry,pickMaterial,OFFICE_SEATS.length),postMatrix=new THREE.Object3D();postPicks.name='organization-workplace-picks';postPicks.userData={type:'post'};const postZeroMatrix=new THREE.Matrix4().makeScale(0,0,0);
  function updatePostPicks(){OFFICE_SEATS.forEach((post,index)=>{const seat=layout.isSeatVisible(post.id)?layout.seatGeometry(post.id):null;if(!seat){postPicks.setMatrixAt(index,postZeroMatrix);return;}postMatrix.position.set(seat.x,1.9+20*seat.scale,seat.y);postMatrix.scale.set(.72*seat.scale,40*seat.scale/52,.72*seat.scale);postMatrix.updateMatrix();postPicks.setMatrixAt(index,postMatrix.matrix);});postPicks.instanceMatrix.needsUpdate=true;postPicks.computeBoundingSphere();}
  updatePostPicks();scene.add(postPicks);picks.push(postPicks);
  const deskPicks=new THREE.InstancedMesh(pickGeometry,pickMaterial,OFFICE_SEATS.length);deskPicks.name='organization-desktop-picks';deskPicks.userData={type:'post'};
  function updateDeskPicks(){for(let index=0;index<OFFICE_SEATS.length;index++){const seat=layout.isSeatVisible(OFFICE_SEATS[index].id)?layout.seatGeometry(OFFICE_SEATS[index].id):null;if(!seat){deskPicks.setMatrixAt(index,postZeroMatrix);continue;}const desk=seat.desk;postMatrix.position.set(desk.x,14*seat.scale,desk.y);postMatrix.scale.set(desk.w/24,28*seat.scale/52,desk.h/24);postMatrix.updateMatrix();deskPicks.setMatrixAt(index,postMatrix.matrix);}deskPicks.instanceMatrix.needsUpdate=true;deskPicks.computeBoundingSphere();}
  updateDeskPicks();deskPicks.computeBoundingSphere();scene.add(deskPicks);picks.push(deskPicks);
  for(const seat of OFFICE_SEATS){
    const el=button('office3d-role-label office3d-name-label','工位',()=>select('post',seat.id));el.dataset.post=seat.id;roleLabels.set(seat.id,el);
  }
  // Real objects and room titles share one node action, with keyboard access.
  for(const [id,meta]of Object.entries(NODE_META)){
    if(id==='bulletin')continue;const el=button('office3d-hotspot office3d-node-hit',`查看${meta.label}`,()=>select('node',id));el.dataset.node=id;
    const dot=document.createElement('span');dot.className='office3d-node-dot';dot.setAttribute('aria-hidden','true');const text=document.createElement('span');text.className='office3d-device-label';text.textContent=meta.label;el.append(dot,text);nodeButtons.set(id,el);
    const hit=new THREE.Group();hit.position.set(meta.x,0,meta.y);addPick(hit,'node',id,0,18,0,2.3,.75,1.6);scene.add(hit);
  }
  const shopLabel=document.createElement('div');shopLabel.className='office3d-room-label office3d-area-label';shopLabel.dataset.area='convenience';shopLabel.setAttribute('role','img');shopLabel.setAttribute('aria-label',OFFICE_CONVENIENCE_AREA.title);shopLabel.setAttribute('title',OFFICE_CONVENIENCE_AREA.title);shopLabel.style.pointerEvents='auto';shopLabel.style.cursor='grab';
  const shopTitle=document.createElement('strong');shopTitle.textContent=OFFICE_CONVENIENCE_AREA.title;shopLabel.append(shopTitle);labels.append(shopLabel);
  listen(shopLabel,'pointerenter',()=>{shopTitle.style.color='var(--office-ui-accent)';});listen(shopLabel,'pointerleave',()=>{shopTitle.style.color='';});listen(shopLabel,'pointerdown',event=>onDown(event));listen(shopLabel,'contextmenu',event=>event.preventDefault());
  const sceneryLabels=new Map();
  for(const area of[OFFICE_RECREATION_AREA,OFFICE_DATA_CENTER]){
    const el=document.createElement('div');el.className='office3d-room-label office3d-area-label';el.dataset.area=area.id;el.setAttribute('role','img');el.setAttribute('aria-label',area.title);el.setAttribute('title',area.title);el.style.pointerEvents='auto';el.style.cursor='grab';const title=document.createElement('strong');title.textContent=area.title;el.append(title);labels.append(el);sceneryLabels.set(area.id,el);listen(el,'pointerdown',event=>onDown(event));listen(el,'contextmenu',event=>event.preventDefault());
  }
  const bulletinButton=document.createElement('div');bulletinButton.className='office3d-room-label office3d-bulletin-label';bulletinButton.setAttribute('aria-label',OFFICE_BULLETIN_AREA.title);bulletinButton.style.pointerEvents='none';const bulletinTitle=document.createElement('strong');bulletinTitle.textContent=OFFICE_BULLETIN_AREA.title;bulletinButton.append(bulletinTitle);labels.append(bulletinButton);nodeButtons.set('bulletin',bulletinButton);
  const bulletinButtons=new Map();
  function showBulletin(id){
    if(destroyed||document.hidden||drag||touches.size)return;const tile=bulletinTile(OFFICE_BULLETIN_AREA,id)?.world;if(!tile)return;clearPost();clearGreeting();const at=project({x:tile.x,y:tile.y},tile.height+tile.h/2),rect=canvas.getBoundingClientRect();if(at)onHoverBulletin(id,{x:rect.left+at.x*rect.width/width,y:rect.top+at.y*rect.height/height});
  }
  for(const item of BULLETIN_SECTIONS){
    const tile=bulletinTile(OFFICE_BULLETIN_AREA,item.id).world,el=button('office3d-bulletin-section',item.title,()=>select('bulletin',item.id));el.dataset.bulletin=item.id;el.dataset.bulletinSection=item.id;el.setAttribute('aria-haspopup','dialog');el.style.color=item.accent;el.textContent=item.title;bulletinButtons.set(item.id,el);
    const pick=new THREE.Group();pick.position.set(tile.x,tile.height,tile.y);addPick(pick,'bulletin',item.id,0,0,0,tile.w/24,tile.h/52,1.4/24);scene.add(pick);
  }
  for(const room of OFFICE3D_ROOMS){const el=button('office3d-room-label',`查看${room.title}`,()=>select('node',room.id));el.dataset.node=room.id;el.setAttribute('title',room.title);const title=document.createElement('strong');title.textContent=room.title;const english=document.createElement('small');english.textContent=`${room.headcount} 个岗位`;el.append(title,english);roomButtons.set(room.id,el);}
  for(const team of teamsById.values()){
    const el=button('office3d-room-label office3d-team-label',`${team.title}，${team.staffCount} 名员工`,()=>focusTeam(team.id));el.dataset.team=team.id;el.setAttribute('title',`${team.title} · ${team.staffCount} 人`);
    const title=document.createElement('strong');title.textContent=`${team.title} · ${team.staffCount} 人`;el.append(title);teamLabels.set(team.id,el);
  }
  // One shared instance batch also includes logged-in employees. Only changed
  // colleagues upload their matrix ranges; static figures keep their GPU data.
  const actorBatches=new Map(),actorDrawLayer=new THREE.Group();actorDrawLayer.name='office-colleague-instances';scene.add(actorDrawLayer);
  const zeroMatrix=new THREE.Matrix4().makeScale(0,0,0);
  function rebuildActorInstances(){
    for(const actor of actorList())actor.root.updateMatrixWorld(true);
    for(const batch of actorBatches.values()){actorDrawLayer.remove(batch.mesh);batch.mesh.dispose();}actorBatches.clear();
    for(const actor of actorList())actor.root.traverse(source=>{
      if(!source.isMesh||source.material===pickMaterial)return;
      const key=source.geometry.uuid;
      if(!actorBatches.has(key))actorBatches.set(key,{geometry:source.geometry,material:assets.material('#ffffff'),sources:[],ranges:new Map()});
      const batch=actorBatches.get(key),index=batch.sources.length;batch.sources.push({source,actor});source.visible=false;
      const range=batch.ranges.get(actor);if(range)range.count++;else batch.ranges.set(actor,{start:index,count:1});
    });
    for(const batch of actorBatches.values()){batch.mesh=new THREE.InstancedMesh(batch.geometry,batch.material,batch.sources.length);batch.mesh.frustumCulled=false;batch.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);batch.sources.forEach(({source},index)=>batch.mesh.setColorAt(index,source.material.color));actorDrawLayer.add(batch.mesh);}
    updateActorInstances(new Set(actorList()));actorDrawLayer.updateMatrixWorld(true);
  }
  function updateActorInstances(changed){
    for(const batch of actorBatches.values()){
      let uploaded=false;
      for(const actor of changed){const range=batch.ranges.get(actor);if(!range)continue;
        for(let index=range.start;index<range.start+range.count;index++){const {source}=batch.sources[index];let visible=true;for(let parent=source.parent;parent&&parent!==scene;parent=parent.parent)if(!parent.visible){visible=false;break;}batch.mesh.setMatrixAt(index,visible?source.matrixWorld:zeroMatrix);stats.instanceUploads++;}
        batch.mesh.instanceMatrix.addUpdateRange(range.start*16,range.count*16);uploaded=true;
      }
      if(uploaded)batch.mesh.instanceMatrix.needsUpdate=true;
    }
  }
  rebuildActorInstances();
  const inScene=point=>{const at=project(point,20);return at?.visible&&at.x>=8&&at.x<=width-8&&at.y>=8&&at.y<=height-84;};
  function staticIdlePeople(){const away=layout.awaySeatIds;return OFFICE_SEATS.filter(seat=>seat.primarySeat&&seat.occupantVisible&&hoveredPost?.id!==seat.id&&layout.isSeatVisible(seat.id)&&!away.has(seat.id)).map(seat=>layout.seatGeometry(seat.id)).filter(Boolean).filter(inScene).map(seat=>({id:`post:${seat.id}`,seatId:seat.id,kind:'post',areaId:seat.departmentId,x:seat.x,y:seat.y,seated:true,canSip:false,busy:false}));}
  function idlePeople(){return [...actorList().filter(actor=>actor.root.visible&&inScene(actor.point)).map(actor=>({id:actor.root.userData.actorId,kind:actor.identity.virtual?'virtual':'human',areaId:OFFICE3D_ROOMS.find(room=>actor.point.x>=room.x&&actor.point.x<=room.x+room.w&&actor.point.y>=room.z&&actor.point.y<=room.z+room.d)?.id||'shared',x:actor.point.x,y:actor.point.y,seated:actor.target.seated,busy:actor.greetingActive||actor.target.walking||actor.target.working||actor.target.carrying||actor.target.offering||actor.target.receiving||controller.queue.locked(actor.root.userData.actorId)})),...staticIdlePeople()];}
  if(ambientEnabled)ambient=mountOfficeAmbient({
    now:ambientNow,random:ambientRandom,
    getPeople:idlePeople,
    isBlocked:()=>destroyed||!active||contextLost||document.hidden||reducedMotion||!!drag||!!nativeGesture||touches.size>0||viewTween.active,
    onStart:activity=>{for(const participant of activity.participants){const partner=activity.participants.find(person=>person.id===participant.partnerId)||null,options={duration:participant.duration||activity.duration,delay:participant.delay||0,startedAt:activity.startedAt};if(participant.kind==='post')layout.setIdlePose(participant.seatId,participant.pose,{...options,partner});else(agents.get(participant.id)||humans.get(participant.id))?.setAmbient(participant.pose,partner,options);}markDirty('ambient');},
    onEnd:activity=>{for(const participant of activity.participants){if(participant.kind==='post')layout.clearIdlePose(participant.seatId);else(agents.get(participant.id)||humans.get(participant.id))?.clearAmbient();}markDirty('ambient');},
  });

  const approvalMarker=button('office3d-approval-marker','需要你审批',()=>select('human',latestState.approvalHumanId||'owner'));approvalMarker.textContent='!';approvalMarker.hidden=true;
  function positionEmployee(entry){
    const actor=actualPeople.get(entry.person.id);if(!actor)return;
    const seated=entry.person.posture==='seated'&&!entry.motion,seat=seated?layout.seatGeometry(entry.person.seatId):null;
    placeActor(actor,entry.point,seat);
    actor.setPose({seated,seatSupport:seated&&!seat,walking:!!entry.motion,heading:entry.sample?.heading||'down',stride:entry.sample?.stride||0,bob:entry.sample?.bob||0});
    if(seat)actor.facePoint({x:seat.x,y:seat.y-10});
  }
  function setPresence(value={}){if(destroyed)return;presenceState=presenceMotion.set(value);const wanted=new Set(presenceMotion.entries.keys());let rosterChanged=false;
    layout.setAwaySeats(new Set([...presenceMotion.entries.values()].flatMap(entry=>[entry.person.appearanceKey,entry.person.posture==='seated'?entry.person.seatId:null]).filter(Boolean)));
    if(greeting?.type==='employee'&&!wanted.has(greeting.id)||greeting?.type==='human'&&presenceState.enabled)clearGreeting();
    for(const [id,actor]of actualPeople)if(!wanted.has(id)){rosterChanged=true;for(let i=picks.length-1;i>=0;i--)if(picks[i].userData.type==='employee'&&picks[i].userData.id===id)picks.splice(i,1);scene.remove(actor.root);humans.delete(id);motionHumans.delete(id);actualPeople.delete(id);employeeButtons.get(id)?.remove();employeeButtons.delete(id);}
    for(const meta of HUMAN_EMPLOYEES){const actor=humans.get(meta.id);if(actor)placeActor(actor,actor.canonicalPoint||actor.point);const el=humanButtons.get(meta.id);if(el)el.hidden=presenceState.enabled||!actor?.root.visible;}
    for(const [id,entry]of presenceMotion.entries){let actor=actualPeople.get(id);if(!actor){rosterChanged=true;actor=createOffice3DActor(assets,{...entry.person,id},{scale:1.12});scene.add(actor.root);actualPeople.set(id,actor);humans.set(id,actor);motionHumans.set(id,motionActor(actor));addPick(actor.root,'employee',id);
        const el=button('office3d-hotspot office3d-person-hit',entry.person.name,()=>select('employee',id));el.dataset.employee=id;const name=document.createElement('span');name.className='office3d-person-label';el.append(name);labels.append(el);employeeButtons.set(id,el);}
      const p=entry.person,el=employeeButtons.get(id);el.setAttribute('aria-label',`${p.name}，${p.title||'员工'}${p.current?'，你':''}`);el.dataset.current=String(p.current);el.firstChild.textContent=p.name+(p.current?' · 你':'');positionEmployee(entry);
    }
    if(rosterChanged){for(const actor of actualPeople.values())actor.root.updateMatrixWorld(true);rebuildActorInstances();}
    markDirty();
  }
  function addLine(group,a,b,material,radius=.65){const from=new THREE.Vector3(a.x,a.height??3.1,a.y),to=new THREE.Vector3(b.x,b.height??3.1,b.y),delta=to.clone().sub(from),length=delta.length();if(length<.01)return null;const mesh=new THREE.Mesh(assets.geometries.cylinder,material);mesh.position.copy(from).add(to).multiplyScalar(.5);mesh.quaternion.setFromUnitVectors(Y_AXIS,delta.normalize());mesh.scale.set(radius,length,radius);group.add(mesh);return mesh;}
  for(const [a,b]of OFFICE3D_LINKS){
    const na=NODE_META[a],nb=NODE_META[b];if(!na||!nb)continue;
    const route=[{x:na.x,y:na.y},{x:na.x,y:OFFICE_WORLD.y+OFFICE_WORLD.height-65},{x:nb.x,y:OFFICE_WORLD.y+OFFICE_WORLD.height-65},{x:nb.x,y:nb.y}];
    const group=new THREE.Group();group.userData={a,b};for(let i=1;i<route.length;i++)addLine(group,route[i-1],route[i],linkMaterial());links.add(group);
  }
  function updateRoutes(){
    const entries=[...controller.walks.values()].filter(walk=>walk.event),signature=entries.map(w=>w.event._deliveryKey).sort().join('|');if(signature===routeSignature)return;routeSignature=signature;
    for(const mesh of currentRouteMeshes){routes.remove(mesh);mesh.dispose?.();}currentRouteMeshes=[];
    const matrices=[],segment=new THREE.Object3D(),from=new THREE.Vector3(),to=new THREE.Vector3(),direction=new THREE.Vector3();
    for(const walk of entries)for(let i=1;i<walk.route.length;i++){
      const a=walk.route[i-1],b=walk.route[i],length=Math.hypot(b.x-a.x,b.y-a.y);
      for(let at=0;at<length;at+=13){
        const begin=at/length,end=Math.min(length,at+6)/length;from.set(a.x+(b.x-a.x)*begin,3.2,a.y+(b.y-a.y)*begin);to.set(a.x+(b.x-a.x)*end,3.2,a.y+(b.y-a.y)*end);direction.subVectors(to,from);const size=direction.length();if(size<.01)continue;
        segment.position.copy(from).add(to).multiplyScalar(.5);segment.quaternion.setFromUnitVectors(Y_AXIS,direction.normalize());segment.scale.set(.55,size,.55);segment.updateMatrix();matrices.push(segment.matrix.clone());
      }
    }
    if(matrices.length){const mesh=new THREE.InstancedMesh(assets.geometries.cylinder,routeMaterial,matrices.length);matrices.forEach((matrix,index)=>mesh.setMatrixAt(index,matrix));mesh.computeBoundingSphere();routes.add(mesh);mesh.updateMatrixWorld(true);currentRouteMeshes.push(mesh);}
  }
  const exchangeFiles=new Map(),sourceHand=new THREE.Vector3(),targetHand=new THREE.Vector3(),sourceRotation=new THREE.Quaternion(),targetRotation=new THREE.Quaternion();
  function updateExchangeFiles(){
    for(const [key,file]of exchangeFiles)if(!controller.exchanges.has(key)){scene.remove(file);exchangeFiles.delete(key);}
    for(const [key,exchange]of controller.exchanges){
      const mover=agents.get(exchange.pair.mover),recipient=exchange.pair.recipientHuman?humans.get(exchange.pair.recipient):agents.get(exchange.pair.recipient);
      if(!mover||!recipient)continue;
      let file=exchangeFiles.get(key);
      if(!file){file=new THREE.Group();file.name='evidence-in-transfer';const cover=new THREE.Mesh(assets.geometries.round,assets.material(OFFICE3D_COLORS.copper));cover.scale.set(8.2,10.4,.8);file.add(cover);const sheets=new THREE.Mesh(assets.geometries.round,assets.material('#efe6d5'));sheets.scale.set(7.4,9.6,.15);sheets.position.z=.5;file.add(sheets);exchangeFiles.set(key,file);scene.add(file);}
      const progress=exchange.progress??0;file.visible=!reducedMotion&&progress>0&&progress<1&&mover.root.visible&&recipient.root.visible;
      if(!file.visible)continue;
      const sender=exchange.pair.collecting?recipient:mover,receiver=exchange.pair.collecting?mover:recipient;
      sender.document.getWorldPosition(sourceHand);receiver.document.getWorldPosition(targetHand);sender.document.getWorldQuaternion(sourceRotation);receiver.document.getWorldQuaternion(targetRotation);
      file.position.lerpVectors(sourceHand,targetHand,progress);file.position.y+=Math.sin(progress*Math.PI)*2.5;file.quaternion.slerpQuaternions(sourceRotation,targetRotation,progress);file.updateMatrixWorld(true);
      sender.document.visible=false;receiver.document.visible=false;
    }
  }
  function setCamera(){
    const reserved=Math.min(100,Math.max(72,height*.095)),usable=Math.max(1,height-reserved);
    cameraFrame=office3DFrustum(width/usable,{azimuth,elevation});const {up,right,direction}=cameraFrame;
    const fullHeight=cameraFrame.height*height/usable;
    const shifted=target.clone().addScaledVector(right,panX+cameraFrame.centerX).addScaledVector(up,panY+cameraFrame.centerY-fullHeight*reserved/height/2/scale);
    camera.position.copy(shifted).addScaledVector(direction,Math.max(2200,Math.hypot(OFFICE_WORLD.width,OFFICE_WORLD.height)*1.1));camera.up.copy(Y_AXIS);camera.lookAt(shifted);
    camera.left=-cameraFrame.width/2/scale;camera.right=cameraFrame.width/2/scale;camera.top=fullHeight/2/scale;camera.bottom=-fullHeight/2/scale;
    camera.updateProjectionMatrix();camera.updateMatrixWorld();syncDetailLevel();
  }
  function syncDetailLevel(){
    if(layout.localTeamId)return;
    const screenCenter={x:width/2,y:height*.45},candidates=[],current=layout.detailGroupIds[0];
    for(const info of layout.seatGroups.values()){
      if(teamsById.has(info.id)||info.seatIds.length<=info.overviewSeatIds.length)continue;const region=info.region,center=project({x:region.x+region.w/2,y:region.y+region.h/2},20);
      if(!center?.visible||center.x<0||center.y<0||center.x>width||center.y>height-75)continue;
      const explicit=detailFocus===info.id;if(!explicit&&!manualDetail)continue;const threshold=(explicit?1.65:OFFICE_DETAIL_ZOOM)-(current===info.id?.22:0);if(scale<threshold)continue;
      const a=project({x:region.x,y:region.y+region.h/2},15),b=project({x:region.x+region.w,y:region.y+region.h/2},15);
      if(!explicit&&Math.hypot(a.x-b.x,a.y-b.y)<240)continue;
      candidates.push({id:info.id,priority:explicit?-1e9:Math.hypot(center.x-screenCenter.x,center.y-screenCenter.y)*(current===info.id?.7:1)});
    }
    candidates.sort((a,b)=>a.priority-b.priority);const wanted=candidates.length?[candidates[0].id]:[];
    if(!layout.setDetailGroups(wanted))return;
    updatePostPicks();updateDeskPicks();
    if(hoveredPost&&!layout.isSeatVisible(hoveredPost.id))clearPost();for(const entry of presenceMotion.entries.values())if(!entry.motion&&entry.person.posture==='seated')positionEmployee(entry);labelsDirty=true;renderDirty=true;
  }
  function project(point,altitude=0){V.set(point.x,point.height??altitude,point.y??point.z).project(camera);if(!Number.isFinite(V.x)||!Number.isFinite(V.y))return null;return {x:(V.x+1)*width/2,y:(1-V.y)*heightPixels(),visible:V.z>=-1&&V.z<=1};}
  const heightPixels=()=>height/2;
  function place(el,point,altitude=0){const at=project(point,altitude);if(!at)return;el.style.left=`${at.x.toFixed(1)}px`;el.style.top=`${at.y.toFixed(1)}px`;el.style.transform='translate(-50%, -50%)';el.dataset.inView=String(at.x>-80&&at.y>-80&&at.x<width+80&&at.y<height+80);}
  function updateLabels(){
    const local=layout.localTeamId,compactLabels=width<=640&&scale<1.65&&!local;
    for(const room of OFFICE3D_ROOMS){
      const el=roomButtons.get(room.id);el.hidden=!!local;const left=project({x:room.x+8,y:room.label[1]},30),right=project({x:room.x+room.w-8,y:room.label[1]},30),span=left&&right?Math.hypot(right.x-left.x,right.y-left.y):210,limit=clamp(span*.92,76,210),fontSize=compactLabels?11:14;
      let text=compactLabels?(shortDepartmentNames[room.id]||room.title):room.title;
      if(!compactLabels&&text.length*(fontSize+.2)>limit&&departmentTitleBreaks[room.id])text=departmentTitleBreaks[room.id];
      if(el.firstChild.textContent!==text)el.firstChild.textContent=text;el.firstChild.style.fontSize=`${fontSize}px`;el.style.maxWidth=`${Math.round(limit)}px`;place(el,{x:room.label[0],y:room.label[1]},30);el.dataset.awaiting=String(!!latestState.humanApproval&&HUMAN_EMPLOYEES.find(h=>h.id===(latestState.approvalHumanId||'owner'))?.nodeId===room.id);
    }
    for(const [id,el]of nodeButtons){if(id==='bulletin'){place(el,{x:OFFICE_BULLETIN_AREA.board.x,y:OFFICE_BULLETIN_AREA.board.y},89);el.firstChild.style.fontSize=compactLabels?'11px':'14px';el.hidden=!!local;continue;}const anchor=layout.nodeAnchors.get(id)||{x:NODE_META[id].x,y:8,z:NODE_META[id].y};place(el,{x:anchor.x,y:anchor.z,height:anchor.y+5});const node=nodeStatus(latestState.nodes,id),visible=fixedLabels.has(id)||selectedNode===id||node!=='online';el.dataset.showLabel=String(visible);el.dataset.status=node;el.hidden=!!local||!topologyVisible&&selectedNode!==id&&node==='online';}
    for(const [id,el]of bulletinButtons){const tile=bulletinTile(OFFICE_BULLETIN_AREA,id).world,a=project({x:tile.x-tile.w/2,y:tile.y},tile.height),b=project({x:tile.x+tile.w/2,y:tile.y},tile.height),top=project({x:tile.x,y:tile.y},tile.height+tile.h/2),bottom=project({x:tile.x,y:tile.y},tile.height-tile.h/2),span=a&&b?Math.hypot(b.x-a.x,b.y-a.y):80,tileHeight=top&&bottom?Math.abs(bottom.y-top.y):18;place(el,{x:tile.x,y:tile.y},tile.height);el.style.width=`${clamp(span*.94,60,150)}px`;el.style.height=`${clamp(tileHeight*.82,12,26)}px`;el.style.fontSize=`${clamp(Math.min(span/9,tileHeight*.64),9,12)}px`;el.hidden=!!local;}
    for(const [id,el]of agentButtons){const actor=agents.get(id),data=(latestState.agents||[]).find?.(a=>a.id===id)||{};place(el,actor.point,actor.height*.56);el.hidden=!actor.root.visible;const active=data.selected!==false&&(data.status==='working'||controller.queue.locked(id));el.dataset.active=String(active||selectedAgent===id);el.dataset.working=String(data.status==='working');el.setAttribute('aria-label',`${data.name||AGENT3D_HOMES[id].name}，${data.role||AGENT3D_HOMES[id].role}`);}
    for(const [id,el]of humanButtons){const actor=humans.get(id),approval=!!latestState.humanApproval&&id===(latestState.approvalHumanId||'owner');place(el,actor.point,actor.height*.56);el.dataset.active=String(approval||selectedHuman===id);el.dataset.awaiting=String(approval);el.hidden=presenceState.enabled||!actor.root.visible;}
    for(const [id,el]of employeeButtons){const actor=actualPeople.get(id),entry=presenceMotion.entries.get(id);place(el,actor.point,actor.height*.56);el.hidden=!actor.root.visible;el.dataset.active=String(selectedHuman===id||!!entry?.person.current);el.dataset.working='false';}
    const owner=humans.get(latestState.approvalHumanId||'owner');approvalMarker.hidden=presenceState.enabled||!latestState.humanApproval||!owner?.root.visible;if(owner)place(approvalMarker,owner.point,owner.height+10);
    // Only names from the authenticated directory reach this overlay. The same
    // screen-space selector keeps both views sparse at overview and complete
    // when the desks spread out at close range.
    const nameCandidates=[],nameTargets=new Map(),nameSize=width>=2560?11:9,away=layout.awaySeatIds;
    const candidate=(id,name,point,altitude,priority,el,identity=id,options={})=>{const at=project(point,altitude);if(!at?.visible)return;nameTargets.set(id,el);nameCandidates.push({id,name,x:at.x,y:at.y,priority,identity,...options});};
    for(const [id,el]of roleLabels){
      const seat=layout.seatGeometry(id),occupant=organizationOccupant(id);el.textContent=occupant?.name||'';el.setAttribute('aria-label',occupant?.name||'工位');el.hidden=true;
      if(occupant&&seat&&seat.primarySeat&&seat.occupantVisible&&layout.isSeatVisible(id)&&!away.has(id))candidate(`post:${id}`,occupant.name,seat,46*seat.scale,seat.departmentId!=='ai_data'?.3:seat.role==='manager'||seat.role==='chairman'?2:3,el,occupant.personId||seat.personId,{required:seat.departmentId!=='ai_data',fontSize:seat.departmentId!=='ai_data'&&scale<1.65?(width>=2560?10:8):nameSize});
    }
    for(const [kind,collection,buttons]of[['agent',agents,agentButtons],['human',humans,humanButtons],['employee',actualPeople,employeeButtons]])for(const [id,el]of buttons){
      const actor=collection.get(id),name=el.firstChild;name.dataset.showName='false';if(!actor?.root.visible||el.hidden)continue;
      const person=kind==='employee'?presenceMotion.entries.get(id)?.person:null,identity=kind==='employee'?organizationOccupant(person?.appearanceKey)?.personId||`employee:${id}`:`${kind}:${id}`;
      candidate(`${kind}:${id}`,name.textContent,actor.point,actor.height+6,person?.current?0:kind==='agent'?1:2,name,identity);
    }
    const identities=new Set(),unique=nameCandidates.sort((a,b)=>a.priority-b.priority||a.id.localeCompare(b.id)).filter(item=>{if(identities.has(item.identity))return false;identities.add(item.identity);return true;});
    const selectedNames=selectOfficeNameLabels(unique,{width,height:height-78,fontSize:nameSize,gap:scale<1.65?4:3});
    for(const name of selectedNames){const el=nameTargets.get(name.id);el.style.fontSize=`${name.fontSize}px`;if(name.id.startsWith('post:')){el.style.left=`${name.x.toFixed(1)}px`;el.style.top=`${name.y.toFixed(1)}px`;el.style.transform='translate(-50%, -100%)';el.hidden=false;}else{const parent=el.parentNode,px=Number.parseFloat(parent.style.left),py=Number.parseFloat(parent.style.top);el.style.bottom='auto';el.style.top=`${name.y-py+23}px`;el.style.left=`${name.x-px+14}px`;el.dataset.showName='true';}}
    wrapper.dataset.nameLabels=String(selectedNames.length);
    for(const [id,el]of teamLabels){const team=teamsById.get(id),text=compactLabels?team.title:`${team.title} · ${team.staffCount} 人`;el.hidden=!!local&&id!==local;if(el.firstChild.textContent!==text)el.firstChild.textContent=text;el.firstChild.style.fontSize=compactLabels?'11px':'14px';const area=local===id?team.detailBounds:team;place(el,{x:area.x+area.w*.28,y:area.y+(local===id?14:-4)},local===id?35:30);}
    shopLabel.hidden=!!local;place(shopLabel,OFFICE_CONVENIENCE_AREA.anchor,12);shopTitle.style.fontSize=compactLabels?'11px':'14px';
    for(const area of[OFFICE_RECREATION_AREA,OFFICE_DATA_CENTER]){const el=sceneryLabels.get(area.id);el.hidden=!!local;place(el,{x:area.x+area.w/2,y:area.id==='data_center'?area.y+18:area.y+7},area.id==='data_center'?35:8);el.firstChild.style.fontSize=compactLabels?'11px':'14px';}
    positionGreeting();positionPost();
    wrapper.dataset.deliveryPending=String(controller.pendingCount);wrapper.dataset.deliveryActive=String(controller.activeCount);
  }
  function draw(time,{busy=false,delta=16,labelsChanged=false}={}){
    const started=performance.now(),changed=new Set();
    for(const actor of actorList())if(actor.needsUpdate||actor.isAnimating){
      actor.animate(time,{reducedMotion,delta,idleMotion:false});actor.root.updateMatrixWorld(true);changed.add(actor);stats.actorUpdates++;
    }
    if(reducedMotion)layout.clearIdlePoses();stats.staticPoseUploads+=layout.tickIdlePoses(time);updateExchangeFiles();updateActorInstances(changed);
    // Changing canvas width/height clears WebGL's drawing buffer. Keep that
    // mutation next to the replacement draw, never inside ResizeObserver.
    if(pendingResize){const next=pendingResize;pendingResize=null;renderer.setDrawingBufferSize(next.width,next.height,next.pixelRatio);Object.assign(stats,{...next,bufferWidth:canvas.width,bufferHeight:canvas.height,resizes:stats.resizes+1});}
    renderer.render(scene,camera);
    stats.renders++;stats.drawCalls=renderer.info.render.calls;stats.triangles=renderer.info.render.triangles;stats.lastRenderMs=performance.now()-started;
    stats.frameMs=stats.frameMs?stats.frameMs*.9+stats.lastRenderMs*.1:stats.lastRenderMs;
    wrapper.dataset.renderCount=String(stats.renders);wrapper.dataset.drawCalls=String(stats.drawCalls);wrapper.dataset.triangles=String(stats.triangles);wrapper.dataset.frameMs=stats.frameMs.toFixed(2);wrapper.dataset.animatingActors=String(actorList().filter(actor=>actor.isAnimating).length);wrapper.dataset.cameraMoving=String(viewTween.active);wrapper.dataset.ambient=ambient?.active?.type||'';wrapper.dataset.awayWorkplaces=String(layout.awaySeatIds.size);wrapper.dataset.activeStaticPoses=String(layout.idlePoseSeatIds.length);wrapper.dataset.activeStaticSeats=layout.idlePoseSeatIds.join(',');wrapper.dataset.staticPoseUploads=String(stats.staticPoseUploads);
    if(labelsDirty||busy||labelsChanged){updateLabels();labelsDirty=false;onViewChange();}renderDirty=false;urgentRenderDirty=false;forceFrame=false;
  }
  function resize(){if(destroyed||contextLost)return;const rect=container.getBoundingClientRect(),nextWidth=Number(container.clientWidth??rect.width),nextHeight=Number(container.clientHeight??rect.height);
    if(!Number.isFinite(nextWidth)||!Number.isFinite(nextHeight)||nextWidth<=0||nextHeight<=0)return;
    const nextRatio=scene3DPixelRatio(nextWidth,nextHeight,globalThis.devicePixelRatio||1,{maxDimension:maxBufferDimension});
    if((stats.resizes||pendingResize)&&width===nextWidth&&height===nextHeight&&Math.abs(pixelRatio-nextRatio)<1e-8)return;
    const layoutChanged=width!==nextWidth||height!==nextHeight;
    if(layoutChanged&&cameraMotionKind!=='automatic'){viewTween.cancel();motionAnchor=null;}
    width=nextWidth;height=nextHeight;pixelRatio=nextRatio;
    pendingResize=stats.resizes&&stats.width===width&&stats.height===height&&Math.abs(stats.pixelRatio-pixelRatio)<1e-8?null:{pixelRatio,width,height};
    if(layoutChanged&&focusedRegion&&cameraMotionKind==='automatic')viewTween.start(office3DRegionView(focusedRegion,{width,height,azimuth}),{immediate:true});else setCamera();markDirty();}
  function renderFrame(time){
    frame=0;if(destroyed||!active||contextLost||document.hidden)return;
    const wasBusy=controller.walks.size>0||controller.exchanges.size>0||presenceMotion.busy;
    const actors=actorList(),interacting=!!drag||!!nativeGesture||touches.size>0||viewTween.active,urgent=wasBusy||actors.some(actor=>actor.hasUrgentMotion),ambientOnly=!interacting&&!urgent&&(layout.hasIdlePoses||actors.some(actor=>actor.ambientKind)||!!ambient?.active||renderDirty&&!urgentRenderDirty);
    const policy=scene3DFramePolicy(lastFrame,time,{reducedMotion,interacting,urgent,ambientOnly,force:forceFrame||!!pendingResize,dirty:urgentRenderDirty,busy:wasBusy||viewTween.active||layout.hasIdlePoses||actors.some(actor=>actor.isAnimating)||renderDirty});
    if(!policy.render){if(policy.continue)schedule();return;}lastFrame=time;
    viewTween.tick(time);if(teamZoomCandidate&&!layout.localTeamId&&scale>=OFFICE_DETAIL_ZOOM){const id=teamZoomCandidate;teamZoomCandidate=null;resetInput();enterTeamFromInput(id);}if(layout.localTeamId&&cameraMotionKind!=='automatic'&&scale<office3DRegionView(officeTeamDetail(layout.localTeamId).detailBounds,{width,height,azimuth}).scale*.65)resetView();controller.tick(time);presenceMotion.tick(time,{isPaused:id=>controller.queue.locked(id)});updateRoutes();ambient?.refresh();
    const busy=controller.walks.size>0||controller.exchanges.size>0||presenceMotion.busy;
    if(wasBusy&&!busy)for(const actor of actorList())actor.invalidate();
    draw(time,{busy,delta:policy.delta,labelsChanged:wasBusy});
    if(busy||drag||touches.size||viewTween.active||layout.hasIdlePoses||actorList().some(actor=>actor.isAnimating))schedule();
  }
  function update(state={}){if(destroyed)return;latestState={...state,agents:Array.isArray(state.agents)?state.agents:Object.values(state.agents||{})};
    for(const [id,light]of layout.statusLights){const status=nodeStatus(state.nodes,id);light.material=assets.material(({online:'#81a078',warning:'#ba944f',offline:'#be614d',recovering:'#8aa893'})[status]);}
    for(const group of links.children){const a=nodeStatus(state.nodes,group.userData.a),b=nodeStatus(state.nodes,group.userData.b),status=[a,b].find(s=>s==='offline')||[a,b].find(s=>s==='warning')||[a,b].find(s=>s==='recovering')||'online';for(const line of group.children)line.material=linkMaterial(status);}
    controller.update(latestState);if(state.selectedNode!==undefined)select('node',state.selectedNode,false);if(state.selectedAgent!==undefined)select('agent',state.selectedAgent,false);markDirty();}
  function applyView(){setCamera();markDirty();onViewChange();}
  function takeCameraControl(kind){
    onLeaveBulletin();teamZoomCandidate=null;focusedRegion=null;manualDetail=true;clearSelectionTimer();clearPost();
    if(cameraMotionKind!==kind){viewTween.cancel();motionAnchor=null;}cameraMotionKind=kind;
  }
  function zoomBase(direction){
    takeCameraControl('zoom');const destination=viewTween.target;
    // A reversing wheel must act on the visible frame, not first wait for an
    // earlier burst to reach its old limit or finish a room's automatic zoom.
    if(viewTween.active&&Math.sign(destination.scale-scale)&&Math.sign(destination.scale-scale)!==Math.sign(direction)){viewTween.cancel();motionAnchor=null;}
    return viewTween.target.scale;
  }
  function anchoredPan(anchor,nextScale,nextAzimuth=azimuth,nextElevation=elevation){
    const reserved=Math.min(100,Math.max(72,height*.095)),usable=Math.max(1,height-reserved),frame=office3DFrustum(width/usable,{azimuth:nextAzimuth,elevation:nextElevation}),relative=anchor.world.clone().sub(target);
    return {panX:relative.dot(frame.right)-frame.centerX-(anchor.screen.x-width/2)*frame.width/width/nextScale,panY:relative.dot(frame.up)-frame.centerY+(anchor.screen.y-usable/2)*frame.height/usable/nextScale};
  }
  function anchorAt(screen){
    pointer.set(screen.x/width*2-1,1-screen.y/height*2);raycaster.setFromCamera(pointer,camera);const world=new THREE.Vector3();
    return raycaster.ray.intersectPlane(floorPlane,world)?{world,screen:{...screen}}:null;
  }
  function stageTeamZoom(event,anchor,increasing){
    teamZoomCandidate=null;if(layout.localTeamId||!increasing||!anchor)return;
    const identity=identityFor(event?.target),postTeam=identity?.type==='post'?overviewTeamForPost(identity.id):null;
    teamZoomCandidate=postTeam||(identity?.type==='team'&&teamsById.has(identity.id)?identity.id:null)||[...teamsById.values()].find(team=>officePointInTeam({x:anchor.world.x,y:anchor.world.z},team.id,{margin:0}))?.id||null;
    if(teamZoomCandidate&&scale>=OFFICE_DETAIL_ZOOM)markDirty();
  }
  function zoomTo(nextScale,anchor){
    const next={...viewState(),scale:clampOfficeScale(nextScale),...(anchor?anchoredPan(anchor,clampOfficeScale(nextScale)):null)};
    if(!officeCameraChanged(viewState(),next))return next.scale;
    motionAnchor=anchor;viewTween.start(next,{immediate:reducedMotion,duration:160});return next.scale;
  }
  function zoom(delta=.15){
    teamZoomCandidate=null;const amount=Number(delta);if(!Number.isFinite(amount)||!amount)return scale;const base=zoomBase(amount),reserved=Math.min(100,Math.max(72,height*.095));
    return zoomTo(clampOfficeScale(base+amount),anchorAt({x:width/2,y:(height-reserved)/2}));
  }
  function rotate(delta=Math.PI/8,tilt=0){
    takeCameraControl('rotate');const reserved=Math.min(100,Math.max(72,height*.095)),anchor=motionAnchor||anchorAt({x:width/2,y:(height-reserved)/2});
    const turn=Number.isFinite(Number(delta))?Number(delta):0,pitch=Number.isFinite(Number(tilt))?Number(tilt):0,next={...viewTween.target,azimuth:viewTween.target.azimuth+turn,elevation:clamp(viewTween.target.elevation+pitch,.42,1.28)};
    if(anchor)Object.assign(next,anchoredPan(anchor,next.scale,next.azimuth,next.elevation));
    if(officeCameraChanged(viewState(),next)){motionAnchor=anchor;viewTween.start(next,{immediate:reducedMotion,duration:220});}return {azimuth:next.azimuth,elevation:next.elevation};
  }
  function focusPoint(point,minimumScale=1.4){
    if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))return false;
    onLeaveBulletin();teamZoomCandidate=null;clearSelectionTimer();clearPost();clearGreeting();detailFocus=null;manualDetail=false;focusedRegion=null;cameraMotionKind='automatic';motionAnchor=null;
    const frame=office3DFrustum(width/Math.max(1,height-Math.min(100,Math.max(72,height*.095)))),diff=new THREE.Vector3(point.x-target.x,(Number.isFinite(point.height)?point.height:28)-target.y,point.y-target.z);
    const bearing=azimuth+Math.atan2(Math.sin(defaultAzimuth-azimuth),Math.cos(defaultAzimuth-azimuth));
    viewTween.start({scale:clampOfficeScale(Number(minimumScale)||1.4,{automatic:true}),panX:diff.dot(frame.right)-frame.centerX,panY:diff.dot(frame.up)-frame.centerY,azimuth:bearing,elevation:defaultElevation},{immediate:reducedMotion||!active,duration:520,easing:'smooth'});return true;
  }
  function focusRegion(region){
    const destination=office3DRegionView(region,{width,height,azimuth});if(!destination)return false;
    onNavigationContext(region.id);onLeaveBulletin();teamZoomCandidate=null;clearSelectionTimer();clearPost();clearGreeting();focusedRegion=region;cameraMotionKind='automatic';motionAnchor=null;viewTween.start(destination,{immediate:reducedMotion||!active,duration:520,easing:'smooth'});return true;
  }
  function refreshSceneContext(){
    const local=layout.localTeamId;wrapper.dataset.team=local||'';links.visible=topologyVisible&&!local;routes.visible=!local;
    for(const pick of picks)if(['node','bulletin'].includes(pick.userData.type)&&pick.parent)pick.parent.visible=!local;
    for(const actor of actorList())if(!actualPeople.has(actor.root.userData.actorId))placeActor(actor,actor.canonicalPoint||actor.point);
    for(const entry of presenceMotion.entries.values())positionEmployee(entry);
    updatePostPicks();updateDeskPicks();clearPost();clearGreeting();labelsDirty=true;renderDirty=true;
  }
  function leaveTeam(){if(!layout.exitTeam())return false;refreshSceneContext();return true;}
  function focusTeam(id){const team=officeTeamDetail(id);if(!team)return false;teamZoomCandidate=null;layout.enterTeam(id);detailFocus=id;manualDetail=false;clearSelectionTimer();refreshSceneContext();return focusRegion(team.detailBounds);}
  function focusArea(id){
    if(teamsById.has(id))return focusTeam(id);
    const region=teamsById.get(id)||OFFICE3D_ROOMS.find(room=>room.id===id)||[OFFICE_BULLETIN_AREA,OFFICE_CONVENIENCE_AREA,OFFICE_RECREATION_AREA,OFFICE_DATA_CENTER,...OFFICE_SHARED_AREAS].find(area=>area.id===id);
    if(!region)return false;leaveTeam();detailFocus=OFFICE3D_ROOMS.some(room=>room.id===id)?id:null;manualDetail=false;return focusRegion(region);
  }
  function focusDepartment(id){if(focusArea(id))return true;if(!NODE_META[id])return false;leaveTeam();return focusPoint(NODE_META[id]);}
  // A viewport-compensating ancestor can scale the stage without changing its
  // layout. Camera/labels use layout pixels; pointer coordinates use its rect.
  function logicalPointer(event){const rect=canvas.getBoundingClientRect();return {x:(event.clientX-rect.left)*width/Math.max(1,rect.width),y:(event.clientY-rect.top)*height/Math.max(1,rect.height)};}
  function gesturePointer(event){const reserved=Math.min(100,Math.max(72,height*.095));return Number.isFinite(event.clientX)&&Number.isFinite(event.clientY)?logicalPointer(event):{x:width/2,y:(height-reserved)/2};}
  function pan(dx,dy){focusedRegion=null;panX-=dx*cameraFrame.width/scale/width;panY+=dy*(camera.top-camera.bottom)/height;}
  function sampleTouch(){const points=[...touches.values()],a=points[0],b=points[1];return a&&b?{x:(a.x+b.x)/2,y:(a.y+b.y)/2,distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),angle:Math.atan2(b.y-a.y,b.x-a.x)}:null;}
  const onDown=(e,origin=null)=>{
    if(![0,1,2].includes(e.button))return;e.preventDefault();if(selectionTimer&&!pendingSelection)clearSelectionTimer();forceFrame=true;onLeaveBulletin();clearPost();clearGreeting();hoveredKey='';teamZoomCandidate=null;const guarded=e.button===0&&localEntryGuard();if(!guarded){viewTween.cancel();motionAnchor=null;cameraMotionKind='pointer';}wrapper.focus?.({preventScroll:true});canvas.setPointerCapture?.(e.pointerId);
    const point=logicalPointer(e);
    if(e.pointerType==='touch'){touches.set(e.pointerId,point);if(touches.size>1){touchGesture=sampleTouch();if(drag)drag.moved=true;canvas.setPointerCapture?.(e.pointerId);return;}}
    const mode=scene3DGestureMode(e),reserved=Math.min(100,Math.max(72,height*.095));
    drag={id:e.pointerId,x:point.x,y:point.y,lastX:point.x,lastY:point.y,moved:false,guarded,mode,origin,orbitAnchor:mode==='orbit'?anchorAt({x:width/2,y:(height-reserved)/2}):null};ambient?.refresh();
  };
  const onMove=e=>{
    const point=logicalPointer(e);
    if(touches.has(e.pointerId)){touches.set(e.pointerId,point);if(touches.size>1){const next=sampleTouch();if(touchGesture&&next){focusedRegion=null;manualDetail=true;if(drag?.guarded){viewTween.cancel();motionAnchor=null;drag.guarded=false;}cameraMotionKind='pointer';const anchor=anchorAt({x:touchGesture.x,y:touchGesture.y}),ratio=next.distance/touchGesture.distance;scale=officePinchScale(scale,ratio);azimuth-=Math.atan2(Math.sin(next.angle-touchGesture.angle),Math.cos(next.angle-touchGesture.angle));if(anchor){anchor.screen={x:next.x,y:next.y};({panX,panY}=anchoredPan(anchor,scale));}else pan(next.x-touchGesture.x,next.y-touchGesture.y);applyView();stageTeamZoom(e,anchor,ratio>1);}touchGesture=next;suppressClickUntil=performance.now()+200;return;}}
    if(!drag){if(e.pointerType!=='touch'){const hit=pickAt(e),key=hit?`${hit.type}:${hit.id}`:'';if(key!==hoveredKey){onLeaveBulletin();hoveredKey=key;if(hit?.type==='bulletin')showBulletin(hit.id);else if(hit?.type==='post')showPost(postsById.get(hit.id));else if(hit?.type==='node'&&OFFICE3D_ROOMS.some(room=>room.id===hit.id))showRegion('department',hit.id);else if(hit&&['agent','human','employee'].includes(hit.type))showGreeting(hit.type,hit.id);else{clearPost();clearGreeting();if(hit)feedback(hit.type,hit.id);}}}return;}if(drag.id!==e.pointerId)return;if(!drag.moved&&Math.hypot(point.x-drag.x,point.y-drag.y)<5)return;
    if(drag.guarded){viewTween.cancel();motionAnchor=null;cameraMotionKind='pointer';drag.guarded=false;}teamZoomCandidate=null;focusedRegion=null;manualDetail=true;clearSelectionTimer();drag.moved=true;canvas.setPointerCapture?.(e.pointerId);wrapper.classList.add('is-panning');
    const dx=point.x-drag.lastX,dy=point.y-drag.lastY;
    if(drag.mode==='pan')pan(dx,dy);else{azimuth-=dx*.006;elevation=clamp(elevation+dy*.004,.42,1.28);if(drag.orbitAnchor)({panX,panY}=anchoredPan(drag.orbitAnchor,scale));}
    drag.lastX=point.x;drag.lastY=point.y;applyView();
  };
  const visiblePick=object=>{for(let p=object;p&&p!==scene;p=p.parent)if(!p.visible)return false;return true;};
  function pickAt(e){const rect=canvas.getBoundingClientRect();pointer.set((e.clientX-rect.left)/Math.max(1,rect.width)*2-1,-(e.clientY-rect.top)/Math.max(1,rect.height)*2+1);raycaster.setFromCamera(pointer,camera);const hit=raycaster.intersectObjects(picks.filter(visiblePick),false).find(candidate=>candidate.object!==postPicks&&candidate.object!==deskPicks||layout.isSeatVisible(OFFICE_SEATS[candidate.instanceId]?.id));if(!hit)return null;return hit.object===postPicks||hit.object===deskPicks?{type:'post',id:OFFICE_SEATS[hit.instanceId]?.id}:hit.object.userData;}
  const floorPlane=new THREE.Plane(new THREE.Vector3(0,1,0),-1.9),floorPoint=new THREE.Vector3();
  function movePointAt(event){const rect=canvas.getBoundingClientRect();pointer.set((event.clientX-rect.left)/Math.max(1,rect.width)*2-1,-(event.clientY-rect.top)/Math.max(1,rect.height)*2+1);raycaster.setFromCamera(pointer,camera);if(!raycaster.ray.intersectPlane(floorPlane,floorPoint))return null;
    if(layout.localTeamId){const team=officeTeamDetail(layout.localTeamId),bounds=team.detailBounds;if(floorPoint.x<bounds.x||floorPoint.x>bounds.x+bounds.w||floorPoint.z<bounds.y||floorPoint.z>bounds.y+bounds.h)return null;const canonical=officeCanonicalPoint({x:floorPoint.x,y:floorPoint.z},team.id);return{x:clamp(canonical.x,team.x+1,team.x+team.w-1),y:clamp(canonical.y,team.y+1,team.y+team.h-1),nodeId:'ai_data',teamId:team.id};}
    const dc=OFFICE_DATA_CENTER,inDataCenter=floorPoint.x>=dc.x&&floorPoint.x<=dc.x+dc.w&&floorPoint.z>=dc.y&&floorPoint.z<=dc.y+dc.h;if((floorPoint.x<0&&!inDataCenter)||floorPoint.z<0||floorPoint.x>OFFICE_WORLD.width||floorPoint.z>OFFICE_WORLD.height)return null;const room=OFFICE3D_ROOMS.find(room=>floorPoint.x>=room.x&&floorPoint.x<=room.x+room.w&&floorPoint.z>=room.z&&floorPoint.z<=room.z+room.d);return{x:floorPoint.x,y:floorPoint.z,nodeId:inDataCenter?'data_center':room?.id||'courtyard'};}
  const onUp=e=>{
    const active=drag,multitouch=!!touchGesture;touches.delete(e.pointerId);if(touches.size<2)touchGesture=null;
    if(canvas.hasPointerCapture?.(e.pointerId))canvas.releasePointerCapture(e.pointerId);
    if(!active||active.id!==e.pointerId){if(multitouch)suppressClickUntil=performance.now()+200;return;}
    const moved=active.moved||multitouch;drag=null;wrapper.classList.remove('is-panning');ambient?.refresh();
    if(moved||e.button!==0||active.guarded){suppressClickUntil=Math.max(suppressClickUntil,performance.now()+180);return;}
    const hit=active.origin||pickAt(e);lastClickTarget=hit?{...hit,time:performance.now()}:null;if(hit?.type==='bulletin')select(hit.type,hit.id);else if(hit)queueSelection(hit.type,hit.id);else{const point=movePointAt(e);clearSelectionTimer();if(point)selectionTimer=setTimeout(()=>{clearSelectionTimer();if(!destroyed)onMovePoint(point);},350);}if(active.origin)suppressClickUntil=Math.max(suppressClickUntil,performance.now()+80);
  };
  const onCancel=e=>{clearPost();clearGreeting();touches.delete(e.pointerId);touchGesture=null;if(drag?.id===e.pointerId)drag=null;wrapper.classList.remove('is-panning');ambient?.refresh();if(canvas.hasPointerCapture?.(e.pointerId))canvas.releasePointerCapture(e.pointerId);};
  function resetInput(){
    const captured=new Set([...touches.keys(),...(drag?[drag.id]:[])]);teamZoomCandidate=null;drag=null;touches.clear();touchGesture=null;nativeGesture=null;wrapper.classList.remove('is-panning');
    for(const id of captured)if(canvas.hasPointerCapture?.(id))canvas.releasePointerCapture(id);
    suppressClickUntil=performance.now()+180;
  }
  listen(canvas,'pointerdown',onDown);listen(canvas,'pointermove',onMove);listen(canvas,'pointerup',onUp);listen(canvas,'pointercancel',onCancel);listen(wrapper,'contextmenu',e=>e.preventDefault());
  listen(canvas,'pointerleave',()=>{onLeaveBulletin();hoveredKey='';clearPost();clearGreeting();});
  listen(canvas,'dblclick',e=>{e.preventDefault();clearSelectionTimer();const hit=lastClickTarget&&performance.now()-lastClickTarget.time<400?lastClickTarget:pickAt(e);if(hit)focusObject(hit.type,hit.id);else resetView();});
  listen(wrapper,'keydown',e=>{
    const target=e.target;
    if(e.ctrlKey||e.metaKey||e.altKey||target!==wrapper&&!wrapper.contains?.(target)||target?.isContentEditable||target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),dialog,[role="dialog"],.erp-layer'))return;
    if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();rotate((e.key==='ArrowLeft'?1:-1)*Math.PI/12);}else if(e.key==='Home'){e.preventDefault();resetView();}else if(e.key?.toLowerCase()==='f'){
      e.preventDefault();const focused=identityFor(target?.closest?.('[data-agent],[data-human],[data-employee],[data-post],[data-team],[data-bulletin],[data-node]')||target);
      if(focused)focusObject(focused.type,focused.id);else if(selectedAgent)focusObject('agent',selectedAgent);else if(selectedHuman)focusObject(actualPeople.has(selectedHuman)?'employee':'human',selectedHuman);else if(selectedNode)focusObject('node',selectedNode);
    }
  });
  // Labels are HTML siblings of the canvas. Handle their bubbling wheel/pinch
  // events here as well, so the browser never zooms the entire office page.
  // Wheel deltas are scroll units, not transformed pointer coordinates: keep
  // pixel values unchanged, resolve lines to 16px and pages to logical height.
  listen(wrapper,'wheel',e=>{
    e.preventDefault();if(nativeGesture)return;const amount=Number(e.deltaY);if(!Number.isFinite(amount)||!amount)return;
    const base=zoomBase(-amount),next=officeWheelScale(base,amount,e.deltaMode,height),anchor=anchorAt(gesturePointer(e));zoomTo(next,anchor);stageTeamZoom(e,anchor,amount<0);
  },{passive:false});
  listen(wrapper,'gesturestart',e=>{e.preventDefault();takeCameraControl('native');clearGreeting();forceFrame=true;viewTween.cancel();motionAnchor=null;nativeGesture=touches.size>1?null:{lastScale:1,lastRotation:0,anchor:anchorAt(gesturePointer(e))};ambient?.refresh();suppressClickUntil=performance.now()+200;},{passive:false});
  listen(wrapper,'gesturechange',e=>{
    e.preventDefault();if(touches.size>1){nativeGesture=null;return;}if(!nativeGesture)return;
    const nextScale=Number(e.scale),rotation=Number(e.rotation),before=viewState(),ratio=Number.isFinite(nextScale)&&nextScale>0?nextScale/nativeGesture.lastScale:1;
    if(Number.isFinite(nextScale)&&nextScale>0){scale=officePinchScale(scale,ratio);nativeGesture.lastScale=nextScale;}
    if(Number.isFinite(rotation)){azimuth-=(rotation-nativeGesture.lastRotation)*Math.PI/180;nativeGesture.lastRotation=rotation;}
    if(nativeGesture.anchor){if(Number.isFinite(e.clientX)&&Number.isFinite(e.clientY))nativeGesture.anchor.screen=logicalPointer(e);({panX,panY}=anchoredPan(nativeGesture.anchor,scale));}
    if(officeCameraChanged(before,viewState()))applyView();stageTeamZoom(e,nativeGesture.anchor,ratio>1);suppressClickUntil=performance.now()+200;
  },{passive:false});
  listen(wrapper,'gestureend',e=>{e.preventDefault();nativeGesture=null;ambient?.refresh();suppressClickUntil=performance.now()+180;},{passive:false});
  listen(canvas,'lostpointercapture',onCancel);listen(globalThis.window||wrapper,'blur',()=>{clearPost();clearGreeting();resetInput();ambient?.refresh();clearSelectionTimer();});
  listen(canvas,'webglcontextlost',e=>{e.preventDefault();if(destroyed)return;clearPost();clearGreeting({redraw:false});contextLost=true;cancelAnimationFrame(frame);frame=0;controller.reset();const error=new Scene3DUnavailableError('3D 图形连接已中断，请切回 2D 视图');onUnavailable(error);container.dispatchEvent?.(new CustomEvent('scene3d-unavailable',{detail:error,bubbles:true}));});
  listen(document,'visibilitychange',()=>{if(!active)return;if(document.hidden){ambient?.refresh();clearPost();clearGreeting({redraw:false});hoveredKey='';resetInput();hiddenAt=performance.now();cancelAnimationFrame(frame);frame=0;clearSelectionTimer();}else{if(hiddenAt!==null){const elapsed=performance.now()-hiddenAt;controller.shiftTime(elapsed);presenceMotion.shiftTime(elapsed);viewTween.shiftTime(elapsed);}hiddenAt=null;lastFrame=0;resize();schedule();}});
  const onPreference=event=>{reducedMotion=event.matches;if(reducedMotion)viewTween.finish();controller.setReducedMotion(reducedMotion);presenceMotion.setReducedMotion(reducedMotion);ambient?.refresh();markDirty();};motionPreference?.addEventListener?.('change',onPreference);
  scene.updateMatrixWorld(true);scene.matrixWorldAutoUpdate=false;
  disposables.push(subscribeOrganizationOccupants(()=>{
    // Hidden cached views do not render. Reconcile private DOM content now,
    // rather than leaving the previous account's names inside inert overlays.
    clearPost();postTitle.textContent='';postDepartment.textContent='';updateLabels();markDirty();
  }));
  layout.root.traverse(object=>{object.matrixAutoUpdate=false;object.matrixWorldAutoUpdate=false;});
  let densityQuery=null;
  const onDensityChange=()=>{watchDensity();resize();};
  function watchDensity(){densityQuery?.removeEventListener?.('change',onDensityChange);densityQuery=globalThis.matchMedia?.(`(resolution: ${globalThis.devicePixelRatio||1}dppx)`);densityQuery?.addEventListener?.('change',onDensityChange);}
  if(globalThis.window?.addEventListener)listen(window,'resize',resize);
  const resizeObserver=new ResizeObserver(resize);resizeObserver.observe(container);watchDensity();resize();update({animateEvents:false});
  function resetView(){onNavigationContext(null);onLeaveBulletin();teamZoomCandidate=null;overviewEnterGuardUntil=0;leaveTeam();detailFocus=null;manualDetail=false;focusedRegion=null;cameraMotionKind='automatic';motionAnchor=null;clearSelectionTimer();clearPost();const bearing=azimuth+Math.atan2(Math.sin(defaultAzimuth-azimuth),Math.cos(defaultAzimuth-azimuth));viewTween.start({scale:1,panX:0,panY:0,azimuth:bearing,elevation:defaultElevation},{immediate:reducedMotion||!active,duration:520,easing:'smooth'});}
  let prepared=false,preparing=null;
  function prepare(){
    if(destroyed||contextLost||document.hidden)return;
    const render=()=>{if(destroyed||contextLost||document.hidden)return;resize();cancelAnimationFrame(frame);frame=0;lastFrame=0;draw(performance.now(),{delta:0,labelsChanged:true});};
    if(!prepared&&renderer.compileAsync){
      preparing??=Promise.resolve(renderer.compileAsync(scene,camera)).then(()=>{prepared=true;});
      return preparing.then(render);
    }
    prepared=true;render();
  }
  function setActive(value){
    if(destroyed||active===!!value)return;
    active=!!value;
    if(!active){
      inactiveAt=hiddenAt??performance.now();hiddenAt=null;ambient?.pause();clearPost();clearGreeting({redraw:false});
      hoveredKey='';resetInput();clearSelectionTimer();
      if(cameraMotionKind==='automatic')viewTween.finish();else viewTween.cancel();motionAnchor=null;cancelAnimationFrame(frame);frame=0;
    }else{
      if(inactiveAt!==null){const elapsed=performance.now()-inactiveAt;controller.shiftTime(elapsed);presenceMotion.shiftTime(elapsed,{since:inactiveAt});}
      inactiveAt=null;hiddenAt=document.hidden?performance.now():null;lastFrame=0;ambient?.resume();resize();markDirty();
    }
  }
  return {
    update,prepare,setActive,setTopology(visible){topologyVisible=!!visible;links.visible=topologyVisible&&!layout.localTeamId;wrapper.dataset.topology=String(topologyVisible);markDirty();},
    setSelectedNode(id){select('node',id,false);},setSelectedAgent(id){select('agent',id,false);},setSelectedHuman(id){select('human',id,false);},
    setPresence,getPresenceState:()=>presenceMotion.snapshot(),getLocalTeamId:()=>layout.localTeamId,
    getHumanAnchor(id='owner'){const actor=humans.get(id);return actor?.root.visible?project(actor.point,actor.height*.55):null;},
    getNodeAnchor(id){if(layout.localTeamId)return null;const anchor=layout.nodeAnchors.get(id),meta=NODE_META[id];return anchor?project({x:anchor.x,y:anchor.z,height:anchor.y+4}):meta?project(meta,10):null;},
    getAgentAnchor(id){const actor=agents.get(id);return actor?.root.visible?project(actor.point,actor.height*.55):null;},
    focusHuman(id='owner',minimumScale=2.4){const actor=humans.get(id);if(actor&&!actor.root.visible&&layout.localTeamId)leaveTeam();return focusPoint(actor?.point,minimumScale);},focusPoint(point,minimumScale=2.4){if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))return false;if(layout.localTeamId&&!officePointInTeam(point,layout.localTeamId,{margin:0}))leaveTeam();return focusPoint(officeDisplayPoint(point,layout.localTeamId),minimumScale);},focusAgent(id){const actor=agents.get(id);if(actor&&!actor.root.visible&&layout.localTeamId)leaveTeam();return focusPoint(actor?.point);},focusNode(id){return focusDepartment(id);},focusArea,
    getPostAnchor(id){const seat=layout.seatGeometry(id);if(!seat)return null;const anchor=project(seat,seat.scale*25);return anchor?{...anchor,visible:anchor.visible&&layout.isSeatVisible(id)}:null;},
    zoom,rotate,resetView,fit:resetView,getPerformanceStats:()=>({...stats,azimuth,elevation,scale,panX,panY,localTeamId:layout.localTeamId,scheduled:!!frame,cameraMoving:viewTween.active,people:actorList().length,nameLabels:Number(wrapper.dataset.nameLabels)||0,batches:actorBatches.size,ambientActive:ambient?.active?.type||null,detailGroups:layout.detailGroupIds,visibleWorkplaces:layout.visibleSeatIds.size,awayWorkplaces:layout.awaySeatIds.size,activeStaticPoses:layout.idlePoseSeatIds.length,activeStaticSeatIds:layout.idlePoseSeatIds,eligibleStaticPoses:staticIdlePeople().length,eligibleStaticSeatIds:staticIdlePeople().map(person=>person.seatId)}),
    destroy(){if(destroyed)return;clearPost();clearGreeting({redraw:false});destroyed=true;ambient?.destroy();clearSelectionTimer();viewTween.cancel();cancelAnimationFrame(frame);frame=0;controller.destroy();presenceMotion.destroy();actualPeople.clear();employeeButtons.clear();resizeObserver.disconnect();densityQuery?.removeEventListener?.('change',onDensityChange);motionPreference?.removeEventListener?.('change',onPreference);disposables.splice(0).forEach(dispose=>dispose());scene.traverse(object=>{if(object.isInstancedMesh)object.dispose();});pickGeometry.dispose();pickMaterial.dispose();routeMaterial.dispose();linkMaterials.forEach(material=>material.dispose());assets.dispose();renderer.dispose();renderer.forceContextLoss?.();wrapper.remove();},
  };
}
