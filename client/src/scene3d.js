import * as THREE from './vendor/three.module.js';
import { NODE_META } from './scene.js';
import { HUMAN_EMPLOYEES } from './people.js';
import { OFFICE3D_ROOMS, AGENT3D_HOMES, OFFICE3D_COLORS, createOffice3DAssets, createOffice3DLayout } from './scene3d-layout.js';
import { createOffice3DActor } from './scene3d-actors.js';
import { createScene3DMotion } from './scene3d-motion.js';
import { createOfficePresenceMotion } from './erp-presence.js';
import { createViewTween } from './scene-motion.js';
import { greetingForPerson } from './person-greeting.mjs';

let greetingSequence=0;
const greetingFaces={
  human:'<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><circle cx="16" cy="16" r="13" fill="#f5d8b7" stroke="#a57c5c" stroke-width="1.2"/><path d="M8.7 13.5q2-2.4 4 0m6.6 0q2-2.4 4 0" stroke="#674f3f" stroke-width="1.7" stroke-linecap="round"/><path d="M10.3 18.2q5.7 7 11.4 0" fill="#fff9ed" stroke="#926452" stroke-width="1.4" stroke-linecap="round"/><circle cx="8.2" cy="17" r="1.8" fill="#db9d8a" opacity=".55"/><circle cx="23.8" cy="17" r="1.8" fill="#db9d8a" opacity=".55"/></svg>',
  robot:'<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 6V3m-13 12v6m26-6v6" stroke="#6c8b7d" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="3" r="2" fill="#bd7257"/><rect x="5" y="7" width="22" height="21" rx="7" fill="#dce9dc" stroke="#65816e" stroke-width="1.2"/><path d="M9 15q2-3.2 4 0m6 0q2-3.2 4 0" stroke="#416957" stroke-width="1.8" stroke-linecap="round"/><path d="M11 20q5 5.5 10 0" fill="#fffdf3" stroke="#416957" stroke-width="1.4" stroke-linecap="round"/><path d="M9 18h2m10 0h2" stroke="#b98c6d" stroke-width="1.4" stroke-linecap="round"/></svg>',
};

export class Scene3DUnavailableError extends Error {
  constructor(message='当前设备无法创建 3D 画面',cause){super(message,{cause});this.name='Scene3DUnavailableError';this.code='WEBGL_UNAVAILABLE';}
}
export const OFFICE3D_CAMERA_OFFSET=Object.freeze([-330,1180,1200]);
export const OFFICE3D_LINKS=Object.freeze([
  ['internet','firewall'],['firewall','core'],['core','server'],['core','storage'],['core','access'],['access','workstations'],['core','executive'],['access','meeting'],['access','reception'],['access','finance'],['access','investment'],['investment','general_office'],
]);
const bounds={min:new THREE.Vector3(20,-12,-7),max:new THREE.Vector3(1035,100,625)};
const V=new THREE.Vector3(),Y_AXIS=new THREE.Vector3(0,1,0);
const fixedLabels=new Set(['server','firewall','core']);
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
  for(const x of[bounds.min.x,bounds.max.x])for(const y of[bounds.min.y,bounds.max.y])for(const z of[bounds.min.z,bounds.max.z]){const p=new THREE.Vector3(x-527.5,y-35,z-309),px=p.dot(right),py=p.dot(up);xMin=Math.min(xMin,px);xMax=Math.max(xMax,px);yMin=Math.min(yMin,py);yMax=Math.max(yMax,py);}
  const height=Math.max(yMax-yMin,(xMax-xMin)/aspect)*Math.max(1.01,padding);return {width:height*aspect,height,direction,right,up,centerX:(xMin+xMax)/2,centerY:(yMin+yMax)/2};
}

export function scene3DFramePolicy(previous=0,current=0,{reducedMotion=false,interacting=false,dirty=false,busy=true}={}) {
  const delta=previous?Math.min(100,Math.max(0,current-previous)):16;
  return {render:!previous||dirty&&!interacting||reducedMotion||delta>=(interacting?14:30),delta,continue:interacting||busy||dirty};
}
export function scene3DPixelRatio(width,height,deviceRatio=1){return clamp(Math.min(Number(deviceRatio)||1,1.5,Math.sqrt(3000000/Math.max(1,width*height))),.7,1.5);}
export function scene3DGestureMode(event,touches=1){return touches>1?'touch':event.button===1||event.button===2||event.shiftKey?'pan':'orbit';}

export function mountScene3D(container,{
  onSelectNode=()=>{},onSelectAgent=()=>{},onSelectHuman=()=>{},onDelivery=()=>{},onViewChange=()=>{},onUnavailable=()=>{},
  rendererFactory=options=>new THREE.WebGLRenderer(options),
}={}) {
  if(!container||!globalThis.document)throw new Scene3DUnavailableError('缺少 3D 显示容器');
  let renderer;try{renderer=rendererFactory({antialias:true,alpha:false,powerPreference:'high-performance'});}catch(error){throw new Scene3DUnavailableError('当前设备未提供可用的 WebGL，已保留 2D 视图',error);}
  const assets=createOffice3DAssets(),layout=createOffice3DLayout(assets),scene=new THREE.Scene();scene.background=new THREE.Color(OFFICE3D_COLORS.background);
  scene.add(layout.root);scene.add(new THREE.HemisphereLight('#fffaf0','#aebaa6',1.55));const sun=new THREE.DirectionalLight('#fff6e8',1.95);sun.position.set(-300,1000,400);scene.add(sun);
  renderer.shadowMap.enabled=false;renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.94;
  renderer.setPixelRatio(1);
  const wrapper=document.createElement('div');wrapper.className='office-scene3d';wrapper.dataset.view='3d';wrapper.tabIndex=0;wrapper.setAttribute('aria-label','办公室');
  const canvas=renderer.domElement;canvas.className='office-scene3d-canvas';canvas.setAttribute('aria-hidden','true');canvas.style.touchAction='none';
  const labels=document.createElement('div');labels.className='office-scene3d-labels';
  wrapper.append(canvas,labels);container.append(wrapper);
  const greetingElement=document.createElement('div');greetingElement.className='office3d-greeting';greetingElement.id=`office3d-person-greeting-${++greetingSequence}`;greetingElement.hidden=true;greetingElement.setAttribute('role','tooltip');greetingElement.setAttribute('aria-hidden','true');
  const greetingFace=document.createElement('span');greetingFace.className='office3d-greeting-face';greetingFace.setAttribute('aria-hidden','true');const greetingText=document.createElement('span');greetingText.className='office3d-greeting-text';greetingElement.append(greetingFace,greetingText);labels.append(greetingElement);
  const camera=new THREE.OrthographicCamera(-600,600,450,-450,1,6000),target=new THREE.Vector3(527.5,35,309);
  let azimuth=defaultAzimuth,elevation=defaultElevation,cameraFrame=office3DFrustum(),pixelRatio=1;
  const stats={renders:0,actorUpdates:0,instanceUploads:0,drawCalls:0,triangles:0,lastRenderMs:0,frameMs:0,pixelRatio:1,staticInstances:layout.statistics.staticInstances};
  const nodeButtons=new Map(),agentButtons=new Map(),humanButtons=new Map(),roomButtons=new Map();
  const agents=new Map(),humans=new Map(),background=[];const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2(),picks=[];
  const actualPeople=new Map(),employeeButtons=new Map();let presenceState={enabled:false,people:[]};
  const links=new THREE.Group(),routes=new THREE.Group();scene.add(links,routes);
  const linkMaterials=new Map();
  const pickMaterial=new THREE.MeshBasicMaterial({visible:false});
  const pickGeometry=new THREE.BoxGeometry(24,52,24);
  const routeMaterial=new THREE.MeshBasicMaterial({color:'#b95b43'});
  const linkMaterial=(status='online')=>{if(!linkMaterials.has(status))linkMaterials.set(status,new THREE.MeshBasicMaterial({color:({online:'#7a9a8a',warning:'#b88b46',offline:'#bd5c48',recovering:'#89a399'})[status]||'#7a9a8a'}));return linkMaterials.get(status);};
  let destroyed=false,contextLost=false,frame=0,lastFrame=0,width=1,height=1,scale=1,panX=0,panY=0,drag=null,suppressClickUntil=0;
  const touches=new Map();let touchGesture=null;
  let selectedNode=null,selectedAgent=null,selectedHuman=null,topologyVisible=true,latestState={},hiddenAt=document.hidden?performance.now():null;
  const motionPreference=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');let reducedMotion=motionPreference?.matches||false;
  let routeSignature='',currentRouteMeshes=[],labelsDirty=true,renderDirty=true,hoveredKey='',selectionTimer=null,pendingSelection=null,lastClickTarget=null,greeting=null;
  const actorList=()=>[...agents.values(),...humans.values(),...background];
  const disposables=[];
  const schedule=()=>{if(!frame&&!destroyed&&!contextLost&&!document.hidden)frame=requestAnimationFrame(renderFrame);};
  const markDirty=()=>{labelsDirty=true;renderDirty=true;schedule();};
  const viewTween=createViewTween({read:()=>({scale,panX,panY,azimuth,elevation}),write:value=>{({scale,panX,panY,azimuth,elevation}=value);setCamera();labelsDirty=true;renderDirty=true;},onStart:markDirty});
  const controller=createScene3DMotion({agents,humans,reducedMotion,onDelivery:event=>{onDelivery(event);markDirty();},onChange:markDirty});
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
    if(destroyed||document.hidden||drag||touches.size||!['agent','human','employee'].includes(type))return;
    const actor=type==='agent'?agents.get(id):humans.get(id);if(!actor?.root.visible||type==='human'&&presenceState.enabled)return;
    const key=`${type}:${id}`;if(greeting?.key===key){positionGreeting();return;}clearGreeting();
    const message=greetingForPerson({virtual:type==='agent'});greeting={key,type,id,actor,anchor:anchor||(type==='agent'?agentButtons.get(id):type==='employee'?employeeButtons.get(id):humanButtons.get(id))};
    greetingFace.innerHTML=greetingFaces[message.kind]||greetingFaces.human;greetingText.textContent=message.text;greetingElement.dataset.kind=message.kind;greetingElement.dataset.person=id;greetingElement.hidden=false;greetingElement.setAttribute('aria-hidden','false');
    if(greeting.anchor){greeting.anchor.dataset.greeting='true';greeting.anchor.setAttribute('aria-describedby',greetingElement.id);}actor.setGreeting(true,{animated:!reducedMotion});positionGreeting();markDirty();
  }
  function leavePerson(type,id){if(greeting?.key===`${type}:${id}`)clearGreeting();hoveredKey='';}
  function feedback(type,id,kind='hover',element){
    if(reducedMotion||destroyed)return;
    const actor=type==='agent'?agents.get(id):humans.get(id);if(actor){actor.react(kind);markDirty();}
    if(element?.animate){buttonAnimations.get(element)?.cancel();buttonAnimations.set(element,element.animate([{translate:'0 0',scale:1},{translate:kind==='press'?'0 1px':'0 -2px',scale:kind==='press'?.97:1.035},{translate:'0 0',scale:1}],{duration:kind==='press'?250:320,easing:'cubic-bezier(.2,.7,.2,1)'}));}
  }
  function identityFor(el){for(const type of ['agent','human','employee','node'])if(el?.dataset?.[type])return {type,id:el.dataset[type]};return null;}
  function clearSelectionTimer(){clearTimeout(selectionTimer);selectionTimer=null;pendingSelection=null;}
  function focusObject(type,id){clearSelectionTimer();select(type,id,false);feedback(type,id,'press');const room=OFFICE3D_ROOMS.find(room=>room.id===id),point=type==='agent'?agents.get(id)?.point:type==='human'||type==='employee'?humans.get(id)?.point:NODE_META[id]||(room?{x:room.label[0],y:room.label[1]}:null);return focusPoint(point);}
  function queueSelection(type,id,detail=1){
    if(pendingSelection?.type===type&&pendingSelection.id===id||detail>1){focusObject(type,id);return;}
    clearSelectionTimer();pendingSelection={type,id};feedback(type,id,'press');selectionTimer=setTimeout(()=>{clearSelectionTimer();if(!destroyed)select(type,id);},350);
  }
  function button(className,label,choose){const el=document.createElement('button');el.type='button';el.className=className;el.setAttribute('aria-label',label);el.setAttribute('aria-pressed','false');el.style.position='absolute';el.style.pointerEvents='auto';
    listen(el,'pointerdown',e=>{e.stopPropagation();const p=identityFor(el);if(p)onDown(e,p);});listen(el,'contextmenu',e=>e.preventDefault());
    listen(el,'pointerenter',()=>{const p=identityFor(el);if(!p)return;if(['agent','human','employee'].includes(p.type))showGreeting(p.type,p.id,el);else{clearGreeting();feedback(p.type,p.id,'hover',el);}});
    listen(el,'pointerleave',()=>{const p=identityFor(el);if(p)leavePerson(p.type,p.id);});listen(el,'focus',()=>{const p=identityFor(el);if(p)showGreeting(p.type,p.id,el);});listen(el,'blur',()=>{const p=identityFor(el);if(p)leavePerson(p.type,p.id);});
    listen(el,'click',e=>{e.stopPropagation();if(performance.now()<suppressClickUntil)return;const p=identityFor(el);if(p){feedback(p.type,p.id,'press',el);if(e.detail===0){clearSelectionTimer();select(p.type,p.id);}else queueSelection(p.type,p.id,e.detail);}else choose();});listen(el,'dblclick',e=>{e.preventDefault();e.stopPropagation();const p=identityFor(el);if(p)focusObject(p.type,p.id);});labels.append(el);return el;}
  function select(type,id,notify=true){
    if(type==='node')selectedNode=id;else if(id)selectedNode=null;
    if(type==='agent')selectedAgent=id;else if(id)selectedAgent=null;
    if(type==='human'||type==='employee')selectedHuman=id;else if(id)selectedHuman=null;
    for(const [key,el]of nodeButtons)el.setAttribute('aria-pressed',String(key===selectedNode));for(const [key,el]of agentButtons)el.setAttribute('aria-pressed',String(key===selectedAgent));for(const [key,el]of humanButtons)el.setAttribute('aria-pressed',String(key===selectedHuman));
    for(const [key,el]of employeeButtons)el.setAttribute('aria-pressed',String(key===selectedHuman));
    if(notify&&id){if(type==='employee'){const person=presenceMotion.entries.get(id)?.person;if(presenceState.enabled&&person)presenceState.onSelectEmployee({...person});}else({node:onSelectNode,agent:onSelectAgent,human:onSelectHuman})[type]?.(id);}markDirty();}
  function addPick(root,type,id,x=0,y=25,z=0,w=1,h=1,d=1){const hit=new THREE.Mesh(pickGeometry,pickMaterial);hit.position.set(x,y,z);hit.scale.set(w,h,d);hit.userData={type,id};root.add(hit);picks.push(hit);}
  function setActorInitial(actor,meta){actor.point={x:meta.x,y:meta.y};actor.setPosition(actor.point);if(meta.seated||['owner','investment_owner'].includes(meta.id)){actor.setPose({seated:true});actor.root.rotation.y=Math.PI;actor.animate(0,{reducedMotion:true});}scene.add(actor.root);}
  for(const [id,home]of Object.entries(AGENT3D_HOMES)){
    const actor=createOffice3DActor(assets,{...home,id},{virtual:true,scale:1.12});setActorInitial(actor,home);agents.set(id,actor);addPick(actor.root,'agent',id);
    const el=button('office3d-hotspot office3d-person-hit',`${home.name}，${home.role}`,()=>select('agent',id));el.dataset.agent=id;
    const name=document.createElement('span');name.className='office3d-person-label';name.textContent=home.name;el.append(name);agentButtons.set(id,el);
  }
  for(const meta of HUMAN_EMPLOYEES){
    const actor=createOffice3DActor(assets,meta,{scale:1.12});setActorInitial(actor,meta);humans.set(meta.id,actor);addPick(actor.root,'human',meta.id);
    const el=button('office3d-hotspot office3d-person-hit',`${meta.name}，${meta.role}`,()=>select('human',meta.id));el.dataset.human=meta.id;
    const name=document.createElement('span');name.className='office3d-person-label';name.textContent=meta.name;el.append(name);humanButtons.set(meta.id,el);
  }
  // Background office life remains seated at the actual desk and is never
  // presented as a model-powered employee or as evidence of task completion.
  const backgroundStaff=[
    {x:145,y:263,color:'#ba8f79',hair:'#51443c'}, {x:269,y:263,color:'#7e91a0',hair:'#564638'}, {x:393,y:263,color:'#9d9b85',hair:'#474538'},
    {x:145,y:366,color:'#ac9a9a',hair:'#654c3f'}, {x:269,y:366,color:'#b7a17e',hair:'#48413c'}, {x:393,y:366,color:'#829796',hair:'#403d40'},
    {x:148,y:492,color:'#a29b9d',hair:'#5b4d42',yaw:0},{x:211,y:492,color:'#79928b',hair:'#514d45',yaw:0},{x:274,y:492,color:'#bcaa88',hair:'#574635',yaw:0},
    {x:155,y:570,color:'#8d9d89',hair:'#433d36',yaw:Math.PI},{x:264,y:570,color:'#ac8f83',hair:'#654635',yaw:Math.PI},
    {x:432,y:509,color:'#718f89',hair:'#514438',yaw:0,lounging:true},{x:600,y:509,color:'#b19a7d',hair:'#4a443b',yaw:0,lounging:true},
  ];
  for(const [i,meta]of backgroundStaff.entries()){const actor=createOffice3DActor(assets,{...meta,id:`background-${i}`},{background:true,scale:.98});actor.setPosition(meta);actor.setPose({seated:true,working:!meta.lounging,lounging:!!meta.lounging});actor.root.rotation.y=meta.yaw??Math.PI;actor.animate(0,{reducedMotion:true});scene.add(actor.root);background.push(actor);}
  // Real objects and room titles share one node action, with keyboard access.
  for(const [id,meta]of Object.entries(NODE_META)){
    const el=button('office3d-hotspot office3d-node-hit',`查看${meta.label}`,()=>select('node',id));el.dataset.node=id;
    const dot=document.createElement('span');dot.className='office3d-node-dot';dot.setAttribute('aria-hidden','true');const text=document.createElement('span');text.className='office3d-device-label';text.textContent=meta.label;el.append(dot,text);nodeButtons.set(id,el);
    const hit=new THREE.Group();hit.position.set(meta.x,0,meta.y);addPick(hit,'node',id,0,18,0,2.3,.75,1.6);scene.add(hit);
  }
  for(const room of OFFICE3D_ROOMS){const el=button('office3d-room-label',`查看${room.title}`,()=>select('node',room.id));el.dataset.node=room.id;const title=document.createElement('strong');title.textContent=room.title;const english=document.createElement('small');english.textContent=room.english;el.append(title,english);roomButtons.set(room.id,el);}
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
  const approvalMarker=button('office3d-approval-marker','需要你审批',()=>select('human',latestState.approvalHumanId||'owner'));approvalMarker.textContent='!';approvalMarker.hidden=true;
  function positionEmployee(entry){const actor=actualPeople.get(entry.person.id);if(!actor)return;actor.point={...entry.point};actor.setPosition(entry.point);actor.setPose({seated:false,walking:!!entry.motion,heading:entry.sample?.heading||'down',stride:entry.sample?.stride||0,bob:entry.sample?.bob||0});}
  function setPresence(value={}){if(destroyed)return;presenceState=presenceMotion.set(value);const wanted=new Set(presenceMotion.entries.keys());let rosterChanged=false;
    if(greeting?.type==='employee'&&!wanted.has(greeting.id)||greeting?.type==='human'&&presenceState.enabled)clearGreeting();
    for(const [id,actor]of actualPeople)if(!wanted.has(id)){rosterChanged=true;for(let i=picks.length-1;i>=0;i--)if(picks[i].userData.type==='employee'&&picks[i].userData.id===id)picks.splice(i,1);scene.remove(actor.root);humans.delete(id);actualPeople.delete(id);employeeButtons.get(id)?.remove();employeeButtons.delete(id);}
    for(const meta of HUMAN_EMPLOYEES){const actor=humans.get(meta.id);if(actor&&actor.root.visible===presenceState.enabled){actor.root.visible=!presenceState.enabled;actor.invalidate();}const el=humanButtons.get(meta.id);if(el)el.hidden=presenceState.enabled;}
    for(const [id,entry]of presenceMotion.entries){let actor=actualPeople.get(id);if(!actor){rosterChanged=true;actor=createOffice3DActor(assets,{...entry.person,id},{scale:1.12});scene.add(actor.root);actualPeople.set(id,actor);humans.set(id,actor);addPick(actor.root,'employee',id);
        const el=button('office3d-hotspot office3d-person-hit',entry.person.name,()=>select('employee',id));el.dataset.employee=id;const name=document.createElement('span');name.className='office3d-person-label';el.append(name);labels.append(el);employeeButtons.set(id,el);}
      const p=entry.person,el=employeeButtons.get(id);el.setAttribute('aria-label',`${p.name}，${p.title||'员工'}${p.current?'，你':''}`);el.dataset.current=String(p.current);el.firstChild.textContent=p.name+(p.current?' · 你':'');positionEmployee(entry);
    }
    if(rosterChanged){for(const actor of actualPeople.values())actor.root.updateMatrixWorld(true);rebuildActorInstances();}
    markDirty();
  }
  function addLine(group,a,b,material,radius=.65){const from=new THREE.Vector3(a.x,a.height??3.1,a.y),to=new THREE.Vector3(b.x,b.height??3.1,b.y),delta=to.clone().sub(from),length=delta.length();if(length<.01)return null;const mesh=new THREE.Mesh(assets.geometries.cylinder,material);mesh.position.copy(from).add(to).multiplyScalar(.5);mesh.quaternion.setFromUnitVectors(Y_AXIS,delta.normalize());mesh.scale.set(radius,length,radius);group.add(mesh);return mesh;}
  for(const [a,b]of OFFICE3D_LINKS){const na=NODE_META[a],nb=NODE_META[b];const route=a==='internet'?[{x:na.x,y:na.y},{x:na.x,y:119},{x:553,y:119},{x:553,y:nb.y}]:a==='investment'?[{x:75,y:52},{x:75,y:108},{x:650,y:108},{x:650,y:52}]:b==='investment'?[{x:na.x,y:na.y},{x:32,y:na.y},{x:32,y:107},{x:75,y:107},{x:75,y:52}]:[{x:na.x,y:na.y},{x:na.x,y:411},{x:nb.x,y:411},{x:nb.x,y:nb.y}];
    const group=new THREE.Group();group.userData={a,b};for(let i=1;i<route.length;i++)addLine(group,route[i-1],route[i],linkMaterial());links.add(group);}
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
      const progress=exchange.progress??0;file.visible=!reducedMotion&&progress>0&&progress<1;
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
    camera.position.copy(shifted).addScaledVector(direction,2200);camera.up.copy(Y_AXIS);camera.lookAt(shifted);
    camera.left=-cameraFrame.width/2/scale;camera.right=cameraFrame.width/2/scale;camera.top=fullHeight/2/scale;camera.bottom=-fullHeight/2/scale;
    camera.updateProjectionMatrix();camera.updateMatrixWorld();
  }
  function project(point,altitude=0){V.set(point.x,point.height??altitude,point.y??point.z).project(camera);if(!Number.isFinite(V.x)||!Number.isFinite(V.y))return null;return {x:(V.x+1)*width/2,y:(1-V.y)*heightPixels(),visible:V.z>=-1&&V.z<=1};}
  const heightPixels=()=>height/2;
  function place(el,point,altitude=0){const at=project(point,altitude);if(!at)return;el.style.left=`${at.x.toFixed(1)}px`;el.style.top=`${at.y.toFixed(1)}px`;el.style.transform='translate(-50%, -50%)';el.dataset.inView=String(at.x>-80&&at.y>-80&&at.x<width+80&&at.y<height+80);}
  function updateLabels(){
    for(const room of OFFICE3D_ROOMS){const el=roomButtons.get(room.id);place(el,{x:room.label[0],y:room.label[1]},30);el.dataset.awaiting=String(!!latestState.humanApproval&&HUMAN_EMPLOYEES.find(h=>h.id===(latestState.approvalHumanId||'owner'))?.nodeId===room.id);}
    for(const [id,el]of nodeButtons){const anchor=layout.nodeAnchors.get(id)||{x:NODE_META[id].x,y:8,z:NODE_META[id].y};place(el,{x:anchor.x,y:anchor.z,height:anchor.y+5});const node=nodeStatus(latestState.nodes,id),visible=fixedLabels.has(id)||selectedNode===id||node!=='online';el.dataset.showLabel=String(visible);el.dataset.status=node;el.hidden=!topologyVisible&&selectedNode!==id&&node==='online';}
    for(const [id,el]of agentButtons){const actor=agents.get(id),data=(latestState.agents||[]).find?.(a=>a.id===id)||{};place(el,actor.point,actor.height*.56);const active=data.selected!==false&&(data.status==='working'||controller.queue.locked(id));el.dataset.active=String(active||selectedAgent===id);el.dataset.working=String(data.status==='working');el.setAttribute('aria-label',`${data.name||AGENT3D_HOMES[id].name}，${data.role||AGENT3D_HOMES[id].role}`);}
    for(const [id,el]of humanButtons){const actor=humans.get(id),approval=!!latestState.humanApproval&&id===(latestState.approvalHumanId||'owner');place(el,actor.point,actor.height*.56);el.dataset.active=String(approval||selectedHuman===id);el.dataset.awaiting=String(approval);el.hidden=presenceState.enabled;}
    for(const [id,el]of employeeButtons){const actor=actualPeople.get(id),entry=presenceMotion.entries.get(id);place(el,actor.point,actor.height*.56);el.dataset.active=String(selectedHuman===id||!!entry?.person.current);el.dataset.working='false';}
    approvalMarker.hidden=presenceState.enabled||!latestState.humanApproval;const owner=humans.get(latestState.approvalHumanId||'owner');if(owner)place(approvalMarker,owner.point,owner.height+10);
    positionGreeting();
    wrapper.dataset.deliveryPending=String(controller.pendingCount);wrapper.dataset.deliveryActive=String(controller.activeCount);
  }
  function draw(time,{busy=false,delta=16,labelsChanged=false}={}){
    const started=performance.now(),changed=new Set();
    for(const actor of actorList())if(actor.needsUpdate||actor.isAnimating){
      actor.animate(time,{reducedMotion,delta,idleMotion:false});actor.root.updateMatrixWorld(true);changed.add(actor);stats.actorUpdates++;
    }
    updateExchangeFiles();updateActorInstances(changed);renderer.render(scene,camera);
    stats.renders++;stats.drawCalls=renderer.info.render.calls;stats.triangles=renderer.info.render.triangles;stats.lastRenderMs=performance.now()-started;
    stats.frameMs=stats.frameMs?stats.frameMs*.9+stats.lastRenderMs*.1:stats.lastRenderMs;
    wrapper.dataset.renderCount=String(stats.renders);wrapper.dataset.drawCalls=String(stats.drawCalls);wrapper.dataset.frameMs=stats.frameMs.toFixed(2);
    if(labelsDirty||busy||labelsChanged){updateLabels();labelsDirty=false;onViewChange();}renderDirty=false;
  }
  function resize(){if(destroyed)return;const rect=container.getBoundingClientRect();width=Math.max(1,rect.width);height=Math.max(1,rect.height);
    pixelRatio=scene3DPixelRatio(width,height,globalThis.devicePixelRatio||1);renderer.setPixelRatio(pixelRatio);stats.pixelRatio=pixelRatio;
    renderer.setSize(width,height,false);canvas.style.width='100%';canvas.style.height='100%';setCamera();markDirty();}
  function renderFrame(time){
    frame=0;if(destroyed||contextLost||document.hidden)return;
    const wasBusy=controller.walks.size>0||controller.exchanges.size>0||presenceMotion.busy;
    const policy=scene3DFramePolicy(lastFrame,time,{reducedMotion,interacting:!!drag||touches.size>0||viewTween.active,dirty:renderDirty,busy:wasBusy||viewTween.active||actorList().some(actor=>actor.isAnimating)});
    if(!policy.render){if(policy.continue)schedule();return;}lastFrame=time;
    viewTween.tick(time);controller.tick(time);presenceMotion.tick(time,{isPaused:id=>controller.queue.locked(id)});updateRoutes();
    const busy=controller.walks.size>0||controller.exchanges.size>0||presenceMotion.busy;
    if(wasBusy&&!busy)for(const actor of actorList())actor.invalidate();
    draw(time,{busy,delta:policy.delta,labelsChanged:wasBusy});
    if(busy||drag||touches.size||viewTween.active||actorList().some(actor=>actor.isAnimating))schedule();
  }
  function update(state={}){if(destroyed)return;latestState={...state,agents:Array.isArray(state.agents)?state.agents:Object.values(state.agents||{})};
    for(const [id,light]of layout.statusLights){const status=nodeStatus(state.nodes,id);light.material=assets.material(({online:'#81a078',warning:'#ba944f',offline:'#be614d',recovering:'#8aa893'})[status]);}
    for(const group of links.children){const a=nodeStatus(state.nodes,group.userData.a),b=nodeStatus(state.nodes,group.userData.b),status=[a,b].find(s=>s==='offline')||[a,b].find(s=>s==='warning')||[a,b].find(s=>s==='recovering')||'online';for(const line of group.children)line.material=linkMaterial(status);}
    controller.update(latestState);if(state.selectedNode!==undefined)select('node',state.selectedNode,false);if(state.selectedAgent!==undefined)select('agent',state.selectedAgent,false);markDirty();}
  function applyView(){setCamera();markDirty();onViewChange();}
  function zoom(delta=.15){clearSelectionTimer();const next=clamp(viewTween.target.scale+Number(delta||0),.72,3.2);viewTween.start({...viewTween.target,scale:next},{immediate:reducedMotion});return next;}
  function rotate(delta=Math.PI/8,tilt=0){clearSelectionTimer();const next={...viewTween.target,azimuth:viewTween.target.azimuth+(Number(delta)||0),elevation:clamp(viewTween.target.elevation+(Number(tilt)||0),.42,1.28)};viewTween.start(next,{immediate:reducedMotion});return {azimuth:next.azimuth,elevation:next.elevation};}
  function focusPoint(point){if(!point)return false;const diff=new THREE.Vector3(point.x-target.x,0,point.y-target.z);viewTween.start({scale:Math.max(scale,1.4),panX:diff.dot(cameraFrame.right)-cameraFrame.centerX,panY:diff.dot(cameraFrame.up)-cameraFrame.centerY},{immediate:reducedMotion});return true;}
  function pan(dx,dy){panX-=dx*cameraFrame.width/scale/width;panY+=dy*(camera.top-camera.bottom)/height;}
  function sampleTouch(){const points=[...touches.values()],a=points[0],b=points[1];return a&&b?{x:(a.x+b.x)/2,y:(a.y+b.y)/2,distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),angle:Math.atan2(b.y-a.y,b.x-a.x)}:null;}
  const onDown=(e,origin=null)=>{
    if(![0,1,2].includes(e.button))return;e.preventDefault();clearGreeting();hoveredKey='';viewTween.cancel();wrapper.focus?.({preventScroll:true});canvas.setPointerCapture?.(e.pointerId);
    if(e.pointerType==='touch'){touches.set(e.pointerId,{x:e.clientX,y:e.clientY});if(touches.size>1){touchGesture=sampleTouch();if(drag)drag.moved=true;canvas.setPointerCapture?.(e.pointerId);return;}}
    drag={id:e.pointerId,x:e.clientX,y:e.clientY,lastX:e.clientX,lastY:e.clientY,moved:false,mode:scene3DGestureMode(e),origin};
  };
  const onMove=e=>{
    if(touches.has(e.pointerId)){touches.set(e.pointerId,{x:e.clientX,y:e.clientY});if(touches.size>1){const next=sampleTouch();if(touchGesture&&next){pan(next.x-touchGesture.x,next.y-touchGesture.y);scale=clamp(scale*next.distance/touchGesture.distance,.72,3.2);azimuth-=Math.atan2(Math.sin(next.angle-touchGesture.angle),Math.cos(next.angle-touchGesture.angle));applyView();}touchGesture=next;suppressClickUntil=performance.now()+200;return;}}
    if(!drag){if(e.pointerType!=='touch'){const hit=pickAt(e),key=hit?`${hit.type}:${hit.id}`:'';if(key!==hoveredKey){hoveredKey=key;if(hit&&['agent','human','employee'].includes(hit.type))showGreeting(hit.type,hit.id);else{clearGreeting();if(hit)feedback(hit.type,hit.id);}}}return;}if(drag.id!==e.pointerId)return;if(!drag.moved&&Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<5)return;
    clearSelectionTimer();drag.moved=true;canvas.setPointerCapture?.(e.pointerId);wrapper.classList.add('is-panning');
    const dx=e.clientX-drag.lastX,dy=e.clientY-drag.lastY;
    if(drag.mode==='pan')pan(dx,dy);else{azimuth-=dx*.006;elevation=clamp(elevation+dy*.004,.42,1.28);}
    drag.lastX=e.clientX;drag.lastY=e.clientY;applyView();
  };
  const visiblePick=object=>{for(let p=object;p&&p!==scene;p=p.parent)if(!p.visible)return false;return true;};
  function pickAt(e){const rect=canvas.getBoundingClientRect();pointer.set((e.clientX-rect.left)/Math.max(1,rect.width)*2-1,-(e.clientY-rect.top)/Math.max(1,rect.height)*2+1);raycaster.setFromCamera(pointer,camera);return raycaster.intersectObjects(picks.filter(visiblePick),false)[0]?.object.userData||null;}
  const onUp=e=>{
    const active=drag,multitouch=!!touchGesture;touches.delete(e.pointerId);if(touches.size<2)touchGesture=null;
    if(canvas.hasPointerCapture?.(e.pointerId))canvas.releasePointerCapture(e.pointerId);
    if(!active||active.id!==e.pointerId){if(multitouch)suppressClickUntil=performance.now()+200;return;}
    const moved=active.moved||multitouch;drag=null;wrapper.classList.remove('is-panning');
    if(moved||e.button!==0){suppressClickUntil=performance.now()+180;return;}
    const hit=active.origin||pickAt(e);lastClickTarget=hit?{...hit,time:performance.now()}:null;if(hit)queueSelection(hit.type,hit.id);if(active.origin)suppressClickUntil=performance.now()+80;
  };
  const onCancel=e=>{clearGreeting();touches.delete(e.pointerId);touchGesture=null;if(drag?.id===e.pointerId)drag=null;wrapper.classList.remove('is-panning');if(canvas.hasPointerCapture?.(e.pointerId))canvas.releasePointerCapture(e.pointerId);};
  listen(canvas,'pointerdown',onDown);listen(canvas,'pointermove',onMove);listen(canvas,'pointerup',onUp);listen(canvas,'pointercancel',onCancel);listen(canvas,'contextmenu',e=>e.preventDefault());
  listen(canvas,'pointerleave',()=>{hoveredKey='';clearGreeting();});
  listen(canvas,'dblclick',e=>{e.preventDefault();clearSelectionTimer();const hit=lastClickTarget&&performance.now()-lastClickTarget.time<400?lastClickTarget:pickAt(e);if(hit)focusObject(hit.type,hit.id);else resetView();});
  listen(wrapper,'keydown',e=>{
    const target=e.target;
    if(e.ctrlKey||e.metaKey||e.altKey||target!==wrapper&&!wrapper.contains?.(target)||target?.isContentEditable||target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),dialog,[role="dialog"],.erp-layer'))return;
    if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();rotate((e.key==='ArrowLeft'?1:-1)*Math.PI/12);}else if(e.key==='Home'){e.preventDefault();resetView();}else if(e.key?.toLowerCase()==='f'){
      e.preventDefault();const focused=identityFor(target?.closest?.('[data-agent],[data-human],[data-employee],[data-node]')||target);
      if(focused)focusObject(focused.type,focused.id);else if(selectedAgent)focusObject('agent',selectedAgent);else if(selectedHuman)focusObject(actualPeople.has(selectedHuman)?'employee':'human',selectedHuman);else if(selectedNode)focusObject('node',selectedNode);
    }
  });
  listen(canvas,'wheel',e=>{e.preventDefault();clearSelectionTimer();const amount=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?height:1),next=clamp(viewTween.target.scale*Math.exp(-clamp(amount,-180,180)*.0016),.72,3.2);viewTween.start({...viewTween.target,scale:next},{immediate:reducedMotion});},{passive:false});
  listen(canvas,'lostpointercapture',onCancel);listen(globalThis.window||wrapper,'blur',()=>{clearGreeting();if(drag)onCancel({pointerId:drag.id});touches.clear();touchGesture=null;clearSelectionTimer();});
  listen(canvas,'webglcontextlost',e=>{e.preventDefault();if(destroyed)return;clearGreeting({redraw:false});contextLost=true;cancelAnimationFrame(frame);frame=0;controller.reset();const error=new Scene3DUnavailableError('3D 图形连接已中断，请切回 2D 视图');onUnavailable(error);container.dispatchEvent?.(new CustomEvent('scene3d-unavailable',{detail:error,bubbles:true}));});
  listen(document,'visibilitychange',()=>{if(document.hidden){clearGreeting({redraw:false});hoveredKey='';hiddenAt=performance.now();cancelAnimationFrame(frame);frame=0;clearSelectionTimer();}else{if(hiddenAt!==null){const elapsed=performance.now()-hiddenAt;controller.shiftTime(elapsed);presenceMotion.shiftTime(elapsed);viewTween.shiftTime(elapsed);}hiddenAt=null;lastFrame=0;schedule();}});
  const onPreference=event=>{reducedMotion=event.matches;if(reducedMotion)viewTween.finish();controller.setReducedMotion(reducedMotion);presenceMotion.setReducedMotion(reducedMotion);markDirty();};motionPreference?.addEventListener?.('change',onPreference);
  scene.updateMatrixWorld(true);scene.matrixWorldAutoUpdate=false;
  layout.root.traverse(object=>{object.matrixAutoUpdate=false;object.matrixWorldAutoUpdate=false;});
  const resizeObserver=new ResizeObserver(resize);resizeObserver.observe(container);resize();update({animateEvents:false});
  function resetView(){clearSelectionTimer();const bearing=azimuth+Math.atan2(Math.sin(defaultAzimuth-azimuth),Math.cos(defaultAzimuth-azimuth));viewTween.start({scale:1,panX:0,panY:0,azimuth:bearing,elevation:defaultElevation},{immediate:reducedMotion});}
  return {
    update,setTopology(visible){topologyVisible=!!visible;links.visible=topologyVisible;wrapper.dataset.topology=String(topologyVisible);markDirty();},
    setSelectedNode(id){select('node',id,false);},setSelectedAgent(id){select('agent',id,false);},setSelectedHuman(id){select('human',id,false);},
    setPresence,getPresenceState:()=>presenceMotion.snapshot(),
    getHumanAnchor(id='owner'){const actor=humans.get(id);return actor?project(actor.point,actor.height*.55):null;},
    getNodeAnchor(id){const anchor=layout.nodeAnchors.get(id),meta=NODE_META[id];return anchor?project({x:anchor.x,y:anchor.z,height:anchor.y+4}):meta?project(meta,10):null;},
    getAgentAnchor(id){const actor=agents.get(id);return actor?project(actor.point,actor.height*.55):null;},
    focusHuman(id='owner'){return focusPoint(humans.get(id)?.point);},focusAgent(id){return focusPoint(agents.get(id)?.point);},focusNode(id){return focusPoint(NODE_META[id]);},
    zoom,rotate,resetView,fit:resetView,getPerformanceStats:()=>({...stats,azimuth,elevation,scale,scheduled:!!frame,cameraMoving:viewTween.active,people:actorList().length,batches:actorBatches.size}),
    destroy(){if(destroyed)return;clearGreeting({redraw:false});destroyed=true;clearSelectionTimer();viewTween.cancel();cancelAnimationFrame(frame);frame=0;controller.destroy();presenceMotion.destroy();actualPeople.clear();employeeButtons.clear();resizeObserver.disconnect();motionPreference?.removeEventListener?.('change',onPreference);disposables.splice(0).forEach(dispose=>dispose());scene.traverse(object=>{if(object.isInstancedMesh)object.dispose();});pickGeometry.dispose();pickMaterial.dispose();routeMaterial.dispose();linkMaterials.forEach(material=>material.dispose());assets.dispose();renderer.dispose();renderer.forceContextLoss?.();wrapper.remove();},
  };
}
