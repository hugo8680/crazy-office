import * as THREE from './vendor/three.module.js';
import { NODE_META } from './scene.js';
import { HUMAN_EMPLOYEES } from './people.js';
import { OFFICE3D_ROOMS, AGENT3D_HOMES, OFFICE3D_COLORS, createOffice3DAssets, createOffice3DLayout } from './scene3d-layout.js';
import { createOffice3DActor } from './scene3d-actors.js';
import { createScene3DMotion } from './scene3d-motion.js';
import { createOfficePresenceMotion } from './erp-presence.js';

export class Scene3DUnavailableError extends Error {
  constructor(message='当前设备无法创建 3D 画面',cause){super(message,{cause});this.name='Scene3DUnavailableError';this.code='WEBGL_UNAVAILABLE';}
}
export const OFFICE3D_CAMERA_OFFSET=Object.freeze([-330,1750,1200]);
export const OFFICE3D_LINKS=Object.freeze([
  ['internet','firewall'],['firewall','core'],['core','server'],['core','storage'],['core','access'],['access','workstations'],['core','executive'],['access','meeting'],['access','reception'],['access','finance'],['access','investment'],['investment','general_office'],
]);
const bounds={min:new THREE.Vector3(20,0,-7),max:new THREE.Vector3(1035,100,625)};
const V=new THREE.Vector3(),Y_AXIS=new THREE.Vector3(0,1,0);
const fixedLabels=new Set(['server','firewall','core']);
const safeStatus=value=>['online','warning','offline','recovering'].includes(value)?value:'online';
function nodeStatus(nodes,id){return safeStatus(typeof nodes?.[id]==='string'?nodes[id]:nodes?.[id]?.status);}

/* Keep the full house in the orthographic frustum at every screen aspect ratio. */
export function office3DFrustum(aspect=1.6){
  const direction=new THREE.Vector3(...OFFICE3D_CAMERA_OFFSET).normalize(),right=new THREE.Vector3().crossVectors(Y_AXIS,direction).normalize(),up=new THREE.Vector3().crossVectors(direction,right).normalize();
  let xMin=Infinity,xMax=-Infinity,yMin=Infinity,yMax=-Infinity;
  for(const x of[bounds.min.x,bounds.max.x])for(const y of[bounds.min.y,bounds.max.y])for(const z of[bounds.min.z,bounds.max.z]){const p=new THREE.Vector3(x-527.5,y-35,z-309),px=p.dot(right),py=p.dot(up);xMin=Math.min(xMin,px);xMax=Math.max(xMax,px);yMin=Math.min(yMin,py);yMax=Math.max(yMax,py);}
  const height=Math.max((yMax-yMin)*1.14,(xMax-xMin)/Math.max(.15,aspect)*1.12);return {width:height*Math.max(.15,aspect),height,direction,right,up};
}

export function scene3DFramePolicy(previous=0,current=0,{reducedMotion=false}={}) {
  const delta=previous?Math.min(100,Math.max(0,current-previous)):16;
  return {render:!previous||reducedMotion||delta>=30,delta};
}

export function mountScene3D(container,{
  onSelectNode=()=>{},onSelectAgent=()=>{},onSelectHuman=()=>{},onDelivery=()=>{},onViewChange=()=>{},onUnavailable=()=>{},
}={}) {
  if(!container||!globalThis.document)throw new Scene3DUnavailableError('缺少 3D 显示容器');
  let renderer;try{renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'high-performance'});}catch(error){throw new Scene3DUnavailableError('当前设备未提供可用的 WebGL，已保留 2D 视图',error);}
  const assets=createOffice3DAssets(),layout=createOffice3DLayout(assets),scene=new THREE.Scene();scene.background=new THREE.Color(OFFICE3D_COLORS.background);
  scene.add(layout.root);scene.add(new THREE.HemisphereLight('#fffaf0','#aebaa6',1.55));const sun=new THREE.DirectionalLight('#fff6e8',1.95);sun.position.set(-300,1000,400);scene.add(sun);
  renderer.shadowMap.enabled=false;renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.94;
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio||1,2));
  const wrapper=document.createElement('div');wrapper.className='office-scene3d';wrapper.dataset.view='3d';
  const canvas=renderer.domElement;canvas.className='office-scene3d-canvas';canvas.setAttribute('aria-hidden','true');canvas.style.touchAction='none';
  const labels=document.createElement('div');labels.className='office-scene3d-labels';
  wrapper.append(canvas,labels);container.append(wrapper);
  const camera=new THREE.OrthographicCamera(-600,600,450,-450,1,6000),target=new THREE.Vector3(527.5,35,309),offset=new THREE.Vector3(...OFFICE3D_CAMERA_OFFSET);
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
  let selectedNode=null,selectedAgent=null,selectedHuman=null,topologyVisible=true,latestState={},hiddenAt=document.hidden?performance.now():null;
  const motionPreference=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');let reducedMotion=motionPreference?.matches||false;
  let routeSignature='',currentRouteMeshes=[],labelsDirty=true;
  const disposables=[];
  const schedule=()=>{if(!frame&&!destroyed&&!contextLost&&!document.hidden)frame=requestAnimationFrame(renderFrame);};
  const markDirty=()=>{labelsDirty=true;schedule();};
  const controller=createScene3DMotion({agents,humans,reducedMotion,onDelivery:event=>{onDelivery(event);markDirty();},onChange:markDirty});
  const presenceMotion=createOfficePresenceMotion({reducedMotion,onChange:entry=>positionEmployee(entry)});
  function listen(element,type,handler,options){element.addEventListener(type,handler,options);disposables.push(()=>element.removeEventListener(type,handler,options));}
  function button(className,label,select){const el=document.createElement('button');el.type='button';el.className=className;el.setAttribute('aria-label',label);el.setAttribute('aria-pressed','false');el.style.position='absolute';el.style.pointerEvents='auto';
    listen(el,'pointerdown',e=>e.stopPropagation());listen(el,'click',e=>{e.stopPropagation();if(performance.now()<suppressClickUntil)return;select();});labels.append(el);return el;}
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
    const el=button('office3d-hotspot office3d-person-hit',`${home.name}，虚拟员工，${home.role}，查看任务与配置`,()=>select('agent',id));el.dataset.agent=id;
    const name=document.createElement('span');name.className='office3d-person-label';name.textContent=home.name;el.append(name);agentButtons.set(id,el);
  }
  for(const meta of HUMAN_EMPLOYEES){
    const actor=createOffice3DActor(assets,meta,{scale:1.12});setActorInitial(actor,meta);humans.set(meta.id,actor);addPick(actor.root,'human',meta.id);
    const el=button('office3d-hotspot office3d-person-hit',`${meta.name}，真实员工，${meta.role}，查看待办`,()=>select('human',meta.id));el.dataset.human=meta.id;
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
  for(const room of OFFICE3D_ROOMS){const el=button('office3d-room-label',`查看${room.title}`,()=>select('node',room.id));const title=document.createElement('strong');title.textContent=room.title;const english=document.createElement('small');english.textContent=room.english;el.append(title,english);roomButtons.set(room.id,el);}
  // The articulated source meshes retain their local joint transforms, while
  // shared opaque parts render through one instance batch per material. This
  // avoids thousands of draw calls when the whole office is visible.
  const actorBatches=new Map(),actorDrawLayer=new THREE.Group();actorDrawLayer.name='office-colleague-instances';scene.add(actorDrawLayer);
  for(const actor of [...agents.values(),...humans.values(),...background])actor.root.traverse(source=>{
    if(!source.isMesh||source.material===pickMaterial)return;
    const key=`${source.geometry.uuid}|${source.material.uuid}`;
    if(!actorBatches.has(key))actorBatches.set(key,{geometry:source.geometry,material:source.material,sources:[]});
    actorBatches.get(key).sources.push(source);source.visible=false;
  });
  for(const batch of actorBatches.values()){batch.mesh=new THREE.InstancedMesh(batch.geometry,batch.material,batch.sources.length);batch.mesh.frustumCulled=false;batch.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);actorDrawLayer.add(batch.mesh);}
  const zeroMatrix=new THREE.Matrix4().makeScale(0,0,0);
  function updateActorInstances(){for(const batch of actorBatches.values()){batch.sources.forEach((source,index)=>{let visible=true;for(let parent=source.parent;parent&&parent!==scene;parent=parent.parent)if(!parent.visible){visible=false;break;}batch.mesh.setMatrixAt(index,visible?source.matrixWorld:zeroMatrix);});batch.mesh.instanceMatrix.needsUpdate=true;}}
  const approvalMarker=button('office3d-approval-marker','需要你审批',()=>select('human',latestState.approvalHumanId||'owner'));approvalMarker.textContent='!';approvalMarker.hidden=true;
  function positionEmployee(entry){const actor=actualPeople.get(entry.person.id);if(!actor)return;actor.point={...entry.point};actor.setPosition(entry.point);actor.setPose({seated:false,walking:!!entry.motion,heading:entry.sample?.heading||'down',stride:entry.sample?.stride||0,bob:entry.sample?.bob||0});}
  function setPresence(value={}){if(destroyed)return;presenceState=presenceMotion.set(value);const wanted=new Set(presenceMotion.entries.keys());
    for(const [id,actor]of actualPeople)if(!wanted.has(id)){for(let i=picks.length-1;i>=0;i--)if(picks[i].userData.type==='employee'&&picks[i].userData.id===id)picks.splice(i,1);scene.remove(actor.root);humans.delete(id);actualPeople.delete(id);employeeButtons.get(id)?.remove();employeeButtons.delete(id);}
    for(const meta of HUMAN_EMPLOYEES){const actor=humans.get(meta.id);if(actor)actor.root.visible=!presenceState.enabled;const el=humanButtons.get(meta.id);if(el)el.hidden=presenceState.enabled;}
    for(const [id,entry]of presenceMotion.entries){let actor=actualPeople.get(id);if(!actor){actor=createOffice3DActor(assets,{...entry.person,id},{scale:1.12});scene.add(actor.root);actualPeople.set(id,actor);humans.set(id,actor);addPick(actor.root,'employee',id);
        const el=document.createElement('button');el.type='button';el.className='office3d-hotspot office3d-person-hit';el.style.position='absolute';el.style.pointerEvents='auto';el.dataset.employee=id;el.onpointerdown=e=>e.stopPropagation();el.onclick=e=>{e.stopPropagation();if(!destroyed&&performance.now()>=suppressClickUntil)select('employee',id);};const name=document.createElement('span');name.className='office3d-person-label';el.append(name);labels.append(el);employeeButtons.set(id,el);}
      const p=entry.person,el=employeeButtons.get(id);el.setAttribute('aria-label',`${p.name}，真实员工${p.title?'，'+p.title:''}，${p.current?'你，':''}在线，查看个人与待办`);el.dataset.current=String(p.current);el.firstChild.textContent=p.name+(p.current?' · 你':'');positionEmployee(entry);
    }
    markDirty();if(document.hidden)paintStatic();
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
    if(matrices.length){const mesh=new THREE.InstancedMesh(assets.geometries.cylinder,routeMaterial,matrices.length);matrices.forEach((matrix,index)=>mesh.setMatrixAt(index,matrix));mesh.computeBoundingSphere();routes.add(mesh);currentRouteMeshes.push(mesh);}
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
      file.position.lerpVectors(sourceHand,targetHand,progress);file.position.y+=Math.sin(progress*Math.PI)*2.5;file.quaternion.slerpQuaternions(sourceRotation,targetRotation,progress);
      sender.document.visible=false;receiver.document.visible=false;
    }
  }
  function setCamera(){const frameInfo=office3DFrustum(width/height),up=frameInfo.up,right=frameInfo.right;const shifted=target.clone().addScaledVector(right,panX).addScaledVector(up,panY);camera.position.copy(shifted).add(offset);camera.up.copy(Y_AXIS);camera.lookAt(shifted);camera.left=-frameInfo.width/2/scale;camera.right=frameInfo.width/2/scale;camera.top=frameInfo.height/2/scale;camera.bottom=-frameInfo.height/2/scale;camera.updateProjectionMatrix();camera.updateMatrixWorld();}
  function project(point,altitude=0){V.set(point.x,point.height??altitude,point.y??point.z).project(camera);if(!Number.isFinite(V.x)||!Number.isFinite(V.y))return null;return {x:(V.x+1)*width/2,y:(1-V.y)*heightPixels(),visible:V.z>=-1&&V.z<=1};}
  const heightPixels=()=>height/2;
  function place(el,point,altitude=0){const at=project(point,altitude);if(!at)return;el.style.left=`${at.x.toFixed(1)}px`;el.style.top=`${at.y.toFixed(1)}px`;el.style.transform='translate(-50%, -50%)';el.dataset.inView=String(at.x>-80&&at.y>-80&&at.x<width+80&&at.y<height+80);}
  function updateLabels(){
    for(const room of OFFICE3D_ROOMS){const el=roomButtons.get(room.id);place(el,{x:room.label[0],y:room.label[1]},30);el.dataset.awaiting=String(!!latestState.humanApproval&&HUMAN_EMPLOYEES.find(h=>h.id===(latestState.approvalHumanId||'owner'))?.nodeId===room.id);}
    for(const [id,el]of nodeButtons){const anchor=layout.nodeAnchors.get(id)||{x:NODE_META[id].x,y:8,z:NODE_META[id].y};place(el,{x:anchor.x,y:anchor.z,height:anchor.y+5});const node=nodeStatus(latestState.nodes,id),visible=fixedLabels.has(id)||selectedNode===id||node!=='online';el.dataset.showLabel=String(visible);el.dataset.status=node;el.hidden=!topologyVisible&&selectedNode!==id&&node==='online';}
    for(const [id,el]of agentButtons){const actor=agents.get(id),data=(latestState.agents||[]).find?.(a=>a.id===id)||{};place(el,actor.point,actor.height*.56);const active=data.selected!==false&&(data.status==='working'||controller.queue.locked(id));el.dataset.active=String(active||selectedAgent===id);el.dataset.working=String(data.status==='working');el.setAttribute('aria-label',`${data.name||AGENT3D_HOMES[id].name}，虚拟员工，${data.role||AGENT3D_HOMES[id].role}，${controller.queue.locked(id)?'证据交接中':data.status==='working'?'执行任务中':'查看任务与配置'}`);}
    for(const [id,el]of humanButtons){const actor=humans.get(id),approval=!!latestState.humanApproval&&id===(latestState.approvalHumanId||'owner');place(el,actor.point,actor.height*.56);el.dataset.active=String(approval||selectedHuman===id);el.dataset.awaiting=String(approval);el.hidden=presenceState.enabled;}
    for(const [id,el]of employeeButtons){const actor=actualPeople.get(id),entry=presenceMotion.entries.get(id);place(el,actor.point,actor.height*.56);el.dataset.active=String(selectedHuman===id||!!entry?.person.current);el.dataset.working='false';}
    approvalMarker.hidden=presenceState.enabled||!latestState.humanApproval;const owner=humans.get(latestState.approvalHumanId||'owner');if(owner)place(approvalMarker,owner.point,owner.height+10);
    wrapper.dataset.deliveryPending=String(controller.pendingCount);wrapper.dataset.deliveryActive=String(controller.activeCount);
  }
  function paintStatic(){
    if(destroyed||contextLost)return;
    for(const actor of [...agents.values(),...humans.values(),...background])actor.animate(performance.now(),{reducedMotion:true,delta:16});
    scene.updateMatrixWorld();updateExchangeFiles();updateActorInstances();renderer.render(scene,camera);updateLabels();labelsDirty=false;onViewChange();
  }
  function resize(){if(destroyed)return;const rect=container.getBoundingClientRect();width=Math.max(1,rect.width);height=Math.max(1,rect.height);renderer.setSize(width,height,false);canvas.style.width='100%';canvas.style.height='100%';setCamera();markDirty();if(document.hidden)paintStatic();}
  function renderFrame(time){frame=0;if(destroyed||contextLost||document.hidden)return;const {render,delta}=scene3DFramePolicy(lastFrame,time,{reducedMotion});if(!render){schedule();return;}lastFrame=time;
    const wasBusy=controller.walks.size>0||controller.exchanges.size>0||presenceMotion.busy;const busy=controller.tick(time)||presenceMotion.busy;presenceMotion.tick(time,{isPaused:id=>controller.queue.locked(id)});updateRoutes();for(const actor of [...agents.values(),...humans.values(),...background])actor.animate(time,{reducedMotion,delta});
    scene.updateMatrixWorld();updateExchangeFiles();updateActorInstances();renderer.render(scene,camera);if(labelsDirty||wasBusy||busy){updateLabels();labelsDirty=false;onViewChange();}if(!reducedMotion||busy)schedule();}
  function update(state={}){if(destroyed)return;latestState={...state,agents:Array.isArray(state.agents)?state.agents:Object.values(state.agents||{})};
    for(const [id,light]of layout.statusLights){const status=nodeStatus(state.nodes,id);light.material=assets.material(({online:'#81a078',warning:'#ba944f',offline:'#be614d',recovering:'#8aa893'})[status]);}
    for(const group of links.children){const a=nodeStatus(state.nodes,group.userData.a),b=nodeStatus(state.nodes,group.userData.b),status=[a,b].find(s=>s==='offline')||[a,b].find(s=>s==='warning')||[a,b].find(s=>s==='recovering')||'online';for(const line of group.children)line.material=linkMaterial(status);}
    controller.update(latestState);if(state.selectedNode!==undefined)select('node',state.selectedNode,false);if(state.selectedAgent!==undefined)select('agent',state.selectedAgent,false);markDirty();if(document.hidden)paintStatic();}
  function applyView(){setCamera();markDirty();onViewChange();}
  function zoom(delta=.15){scale=Math.max(.72,Math.min(2.25,scale+delta));applyView();return scale;}
  function focusPoint(point){if(!point)return false;const frameInfo=office3DFrustum(width/height),diff=new THREE.Vector3(point.x-target.x,0,point.y-target.z);panX=diff.dot(frameInfo.right);panY=diff.dot(frameInfo.up)-48/height*frameInfo.height/scale;applyView();return true;}
  const onDown=e=>{if(e.button!==0)return;drag={id:e.pointerId,x:e.clientX,y:e.clientY,lastX:e.clientX,lastY:e.clientY,moved:false};};
  const onMove=e=>{if(!drag||drag.id!==e.pointerId)return;if(!drag.moved&&Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<5)return;drag.moved=true;canvas.setPointerCapture?.(e.pointerId);wrapper.classList.add('is-panning');const frameInfo=office3DFrustum(width/height);panX-=(e.clientX-drag.lastX)*frameInfo.width/scale/width;panY+=(e.clientY-drag.lastY)*frameInfo.height/scale/height;drag.lastX=e.clientX;drag.lastY=e.clientY;applyView();};
  const visiblePick=object=>{for(let p=object;p&&p!==scene;p=p.parent)if(!p.visible)return false;return true;};
  const onUp=e=>{if(!drag||drag.id!==e.pointerId)return;const moved=drag.moved;drag=null;if(canvas.hasPointerCapture?.(e.pointerId))canvas.releasePointerCapture(e.pointerId);wrapper.classList.remove('is-panning');if(moved){suppressClickUntil=performance.now()+180;return;}const rect=canvas.getBoundingClientRect();pointer.set((e.clientX-rect.left)/Math.max(1,rect.width)*2-1,-(e.clientY-rect.top)/Math.max(1,rect.height)*2+1);scene.updateMatrixWorld();raycaster.setFromCamera(pointer,camera);const hit=raycaster.intersectObjects(picks.filter(visiblePick),false)[0];if(hit)select(hit.object.userData.type,hit.object.userData.id);};
  const onCancel=e=>{if(drag?.id!==e.pointerId)return;drag=null;wrapper.classList.remove('is-panning');if(canvas.hasPointerCapture?.(e.pointerId))canvas.releasePointerCapture(e.pointerId);};
  listen(canvas,'pointerdown',onDown);listen(canvas,'pointermove',onMove);listen(canvas,'pointerup',onUp);listen(canvas,'pointercancel',onCancel);listen(canvas,'wheel',e=>{e.preventDefault();zoom(-Math.max(-.15,Math.min(.15,e.deltaY*.0015)));},{passive:false});
  listen(canvas,'webglcontextlost',e=>{e.preventDefault();if(destroyed)return;contextLost=true;cancelAnimationFrame(frame);frame=0;controller.reset();const error=new Scene3DUnavailableError('3D 图形连接已中断，请切回 2D 视图');onUnavailable(error);container.dispatchEvent?.(new CustomEvent('scene3d-unavailable',{detail:error,bubbles:true}));});
  listen(document,'visibilitychange',()=>{if(document.hidden){hiddenAt=performance.now();cancelAnimationFrame(frame);frame=0;}else{if(hiddenAt!==null){const elapsed=performance.now()-hiddenAt;controller.shiftTime(elapsed);presenceMotion.shiftTime(elapsed);}hiddenAt=null;lastFrame=0;schedule();}});
  const onPreference=event=>{reducedMotion=event.matches;controller.setReducedMotion(reducedMotion);presenceMotion.setReducedMotion(reducedMotion);markDirty();};motionPreference?.addEventListener?.('change',onPreference);
  const resizeObserver=new ResizeObserver(resize);resizeObserver.observe(container);resize();update({animateEvents:false});
  return {
    update,setTopology(visible){topologyVisible=!!visible;links.visible=topologyVisible;wrapper.dataset.topology=String(topologyVisible);markDirty();},
    setSelectedNode(id){select('node',id,false);},setSelectedAgent(id){select('agent',id,false);},setSelectedHuman(id){select('human',id,false);},
    setPresence,getPresenceState:()=>presenceMotion.snapshot(),
    getHumanAnchor(id='owner'){const actor=humans.get(id);return actor?project(actor.point,actor.height*.55):null;},
    getNodeAnchor(id){const anchor=layout.nodeAnchors.get(id),meta=NODE_META[id];return anchor?project({x:anchor.x,y:anchor.z,height:anchor.y+4}):meta?project(meta,10):null;},
    getAgentAnchor(id){const actor=agents.get(id);return actor?project(actor.point,actor.height*.55):null;},
    focusHuman(id='owner'){return focusPoint(humans.get(id)?.point);},focusAgent(id){return focusPoint(agents.get(id)?.point);},focusNode(id){return focusPoint(NODE_META[id]);},
    zoom,resetView(){scale=1;panX=0;panY=0;applyView();},
    destroy(){if(destroyed)return;destroyed=true;cancelAnimationFrame(frame);frame=0;controller.destroy();presenceMotion.destroy();actualPeople.clear();employeeButtons.clear();resizeObserver.disconnect();motionPreference?.removeEventListener?.('change',onPreference);disposables.splice(0).forEach(dispose=>dispose());scene.traverse(object=>{if(object.isInstancedMesh)object.dispose();});pickGeometry.dispose();pickMaterial.dispose();routeMaterial.dispose();linkMaterials.forEach(material=>material.dispose());assets.dispose();renderer.dispose();renderer.forceContextLoss?.();wrapper.remove();},
  };
}
