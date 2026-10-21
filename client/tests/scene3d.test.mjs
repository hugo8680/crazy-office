import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../src/vendor/three.module.js';
import { NODE_META } from '../src/scene.js';
import { HUMAN_EMPLOYEES } from '../src/people.js';
import { OFFICE3D_ROOMS, OFFICE3D_BOUNDS, OFFICE3D_CENTER, AGENT3D_HOMES, OFFICE3D_COLORS, createOffice3DAssets, createOffice3DLayout } from '../src/scene3d-layout.js';
import { actorIdentity, createOffice3DActor, facingForHeading } from '../src/scene3d-actors.js';
import { office3DFrustum, Scene3DUnavailableError, OFFICE3D_LINKS, scene3DFramePolicy, OFFICE3D_CAMERA_OFFSET, scene3DPixelRatio, scene3DGestureMode, mountScene3D } from '../src/scene3d.js';
import { OFFICE_ROOMS, OFFICE_BULLETIN_AREA, OFFICE_CONVENIENCE_AREA, OFFICE_SEATS, OFFICE_OVERVIEW_SEATS, OFFICE_FITTINGS, OFFICE_LANDSCAPE, OFFICE_WORK_POSITIONS } from '../src/organization.mjs';
import { createScene3DMotion, desired3DPositions } from '../src/scene3d-motion.js';

test('3D furnishes all twelve departments with 251 workplaces and 250 unique occupants in bounded GPU batches',()=>{
  const assets=createOffice3DAssets();try{
    const layout=createOffice3DLayout(assets);assert.equal(layout.statistics.rooms,12);assert.deepEqual(OFFICE3D_ROOMS.map(room=>room.id),OFFICE_ROOMS.map(room=>room.id));
    assert.equal(OFFICE3D_ROOMS.find(room=>room.id==='investment').title,'投资者关系部');
    assert.deepEqual([...layout.statusLights.keys()].sort(),Object.keys(NODE_META).filter(id=>id!=='bulletin').sort());
    assert.equal(layout.statistics.desks,251);assert.equal(layout.statistics.workplaces,251);assert.equal(layout.statistics.people,250);assert.equal(layout.statistics.racks,2);assert.equal(layout.statistics.plants,OFFICE_FITTINGS.filter(item=>item.kind==='plant').length+OFFICE_BULLETIN_AREA.plants.length);assert.equal(layout.statistics.bulletinBoards,1);assert.ok(layout.nodeAnchors.has('bulletin'));assert.equal(layout.statusLights.has('bulletin'),false);assert.equal(layout.statistics.fittings,OFFICE_FITTINGS.length);assert.equal(layout.statistics.landscape,OFFICE_LANDSCAPE.length);
    assert.ok(layout.statistics.staticInstances>10000&&layout.statistics.staticInstances<18000);assert.ok(layout.root.children.filter(child=>child.isInstancedMesh).length<=7,'additional staff only add instances to shared static geometry');
    for(const instance of layout.root.children.filter(child=>child.isInstancedMesh)){assert.equal(instance.instanceColor?.count,instance.count);const matrix=new THREE.Matrix4();for(let i=0;i<instance.count;i++){instance.getMatrixAt(i,matrix);assert.ok(matrix.elements.every(Number.isFinite));}}
  }finally{assets.dispose();}
});

test('room floors and identities use opaque materials without shadows or light effects',()=>{
  const assets=createOffice3DAssets();try{const layout=createOffice3DLayout(assets),virtual=createOffice3DActor(assets,{id:'zhang',hair:'#514333'},{virtual:true}),human=createOffice3DActor(assets,HUMAN_EMPLOYEES[0]);for(const root of[layout.root,virtual.root,human.root])root.traverse(mesh=>{assert.equal(mesh.castShadow,false);assert.equal(mesh.receiveShadow,false);if(mesh.material){assert.equal(mesh.material.transparent,false);assert.equal(mesh.material.opacity,1);assert.ok(!mesh.material.emissive||mesh.material.emissive.getHex()===0);}});assert.equal(virtual.identity.badge,'chip');assert.equal(human.identity.badge,'lanyard');assert.notEqual(virtual.identity.uniform,human.identity.uniform);assert.equal(actorIdentity({color:'#bb9988'},{virtual:false}).uniform,'#c68b60');assert.equal(actorIdentity({color:'#c68b60'},{virtual:true}).uniform,'#347f9c');assert.equal(OFFICE3D_COLORS.copper,'#b85a43');}finally{assets.dispose();}
});

test('seated staff bend at the knee, keep feet near the floor and reach the keyboard',()=>{
  const assets=createOffice3DAssets();try{const actor=createOffice3DActor(assets,{id:'seated-proof'},{virtual:true});actor.setPose({seated:true,working:true});actor.animate(0,{reducedMotion:true});assert.equal(actor.legs.left.thigh.rotation.x,-Math.PI/2);assert.equal(actor.legs.left.shin.rotation.x,Math.PI/2);assert.ok(actor.arms.left.upper.rotation.x<-.7);actor.root.updateMatrixWorld(true);const shoe=actor.legs.left.shin.children.find(child=>child.material.color.getHexString()==='34443c');const p=new THREE.Vector3();shoe.getWorldPosition(p);assert.ok(p.y>0&&p.y<7,`feet y ${p.y}`);actor.setPose({seated:false,walking:true,stride:14,heading:'right',carrying:true});actor.animate(100,{reducedMotion:true});assert.equal(actor.document.visible,true);assert.ok(actor.legs.left.thigh.rotation.x!==actor.legs.right.thigh.rotation.x);assert.equal(actor.root.rotation.y,Math.PI/2);assert.equal(facingForHeading('up'),Math.PI);}finally{assets.dispose();}
});

test('orthographic fitting covers desktop, tablet and narrow viewports without invalid frusta',()=>{
  for(const aspect of[.35,.65,1,1.6,2.5,4]){const f=office3DFrustum(aspect);assert.ok(f.width>0&&f.height>0);assert.ok(Math.abs(f.width/f.height-aspect)<.0001);assert.ok(Math.abs(f.direction.length()-1)<.0001);assert.ok(Math.abs(f.up.dot(f.right))<.0001);}
  const error=new Scene3DUnavailableError('unavailable');assert.equal(error.code,'WEBGL_UNAVAILABLE');assert.ok(error instanceof Error);
  for(const [a,b]of OFFICE3D_LINKS){assert.ok(NODE_META[a]);assert.ok(NODE_META[b]);}
});

test('management reviewer visits a shared-plan arrival slot without occupying the assistant or chairman post',()=>{
  const positions=desired3DPositions([{id:'invest_risk',status:'working',nodeId:'general_office'},{id:'boss',status:'working',nodeId:'general_office'}]);
  const [x,y]=OFFICE_WORK_POSITIONS.general_office[0];assert.deepEqual(positions.get('invest_risk'),{x,y});assert.deepEqual(positions.get('boss'),{x:AGENT3D_HOMES.boss.x,y:AGENT3D_HOMES.boss.y});
  assert.equal(new Set([positions.get('invest_risk').x,positions.get('boss').x,HUMAN_EMPLOYEES[0].x]).size,3);
  for(const seat of OFFICE_SEATS.filter(seat=>seat.departmentId==='general_office'))assert.notDeepEqual(positions.get('invest_risk'),{x:seat.x,y:seat.y});
  assert.deepEqual(desired3DPositions([{id:'zhang',status:'working',nodeId:'server'}],{halted:true}).get('zhang'),{x:AGENT3D_HOMES.zhang.x,y:AGENT3D_HOMES.zhang.y});
});

function motionFixture(){let time=0;const delivered=[];const makeActor=meta=>({point:{x:meta.x,y:meta.y},root:{rotation:{y:0}},pose:{},setPose(patch){Object.assign(this.pose,patch);},setPosition(point){this.point={x:point.x,y:point.y};},facePoint(){}});const agents=new Map(Object.entries(AGENT3D_HOMES).map(([id,meta])=>[id,makeActor(meta)])),humans=new Map(HUMAN_EMPLOYEES.map(h=>[h.id,makeActor(h)]));const motion=createScene3DMotion({agents,humans,now:()=>time,onDelivery:event=>delivered.push(event.id)});return{motion,agents,humans,delivered,tick(ms){time+=ms;motion.tick(time);},drain(){for(let i=0;i<800&&(motion.activeCount||motion.pendingCount||motion.walks.size);i++){time+=100;motion.tick(time);}assert.equal(motion.activeCount,0);assert.equal(motion.pendingCount,0);}};}

test('opening a historical snapshot does not reenact handoffs; fresh receipts happen exactly once',()=>{
  const f=motionFixture(),old={id:'old',type:'handoff',agentId:'zhang',targetAgentId:'liu'},fresh={id:'new',type:'handoff',agentId:'liu',targetAgentId:'lead'};
  f.motion.update({runId:'history',animateEvents:false,logs:[old]});assert.equal(f.motion.activeCount,0);f.motion.update({runId:'history',animateEvents:true,logs:[old,fresh]});assert.equal(f.motion.activeCount,1);f.drain();assert.deepEqual(f.delivered,['new']);f.motion.update({runId:'history',animateEvents:true,logs:[old,fresh]});f.drain();assert.deepEqual(f.delivered,['new']);f.motion.destroy();
});

test('cross-employee handoffs serialize their participants and never approve a human workflow',()=>{
  const f=motionFixture(),events=[{id:'a',type:'handoff',agentId:'zhang',targetAgentId:'liu'},{id:'b',type:'handoff',agentId:'liu',targetAgentId:'zhang'},{id:'approval',type:'handoff',agentId:'boss',targetHumanId:'owner',deliveryKind:'approval_request'}];f.motion.update({runId:'live',animateEvents:true,logs:events,humanApproval:true});assert.equal(f.motion.activeCount,2);assert.equal(f.motion.pendingCount,1);assert.ok(f.motion.queue.locked('owner'));f.drain();assert.equal(f.delivered.length,3);assert.equal(new Set(f.delivered).size,3);assert.ok(f.delivered.includes('approval'));assert.equal(f.humans.get('owner').pose.seated,false);assert.ok(!('approved'in f.humans.get('owner').pose));f.motion.destroy();
});

test('switching or cancelling a run clears obsolete movement and transfer callbacks',()=>{
  for(const terminal of['cancelled','failed']){const f=motionFixture(),event={id:'obsolete',type:'handoff',agentId:'zhang',targetAgentId:'liu'};f.motion.update({runId:'one',animateEvents:true,logs:[event]});assert.equal(f.motion.activeCount,1);f.motion.update({runId:'one',runStatus:terminal,animateEvents:true,logs:[event]});f.tick(30000);assert.deepEqual(f.delivered,[]);assert.equal(f.motion.activeCount,0);assert.equal(f.motion.walks.size,0);f.motion.update({runId:'two',animateEvents:false,logs:[event]});f.tick(30000);assert.deepEqual(f.delivered,[]);f.motion.destroy();}
});

test('runtime reduced motion settles current walks while retaining actual receipt ordering',()=>{
  const f=motionFixture(),event={id:'actual',type:'handoff',sourceHumanId:'hr_owner',targetAgentId:'zhang',agentId:'zhang'};f.motion.update({runId:'motion',animateEvents:true,logs:[event]});f.tick(50);assert.ok(f.motion.walks.size);f.motion.setReducedMotion(true);assert.equal(f.motion.walks.size,0);assert.equal(f.motion.activeCount,1);f.tick(1);assert.deepEqual(f.delivered,['actual']);f.tick(1600);assert.equal(f.motion.activeCount,0);assert.deepEqual(f.delivered,['actual']);f.motion.destroy();
});


test('the first visible animation frame always renders before idle frame throttling starts',()=>{
  const first=scene3DFramePolicy(0,1050);assert.equal(first.render,true);assert.equal(first.delta,16);
  assert.equal(scene3DFramePolicy(1050,1066).render,false);
  assert.equal(scene3DFramePolicy(1050,1083).render,true);
  assert.equal(scene3DFramePolicy(1083,1090,{reducedMotion:true}).render,true);
  assert.equal(scene3DFramePolicy(0,120000).render,true,'restoring visibility starts immediately');
});

test('a recorded file travels once, then stays in the actual recipient hands until settling',()=>{
  const f=motionFixture(),event={id:'file',type:'handoff',agentId:'zhang',targetAgentId:'liu'};f.motion.update({runId:'file',animateEvents:true,logs:[event]});
  for(let i=0;i<200&&f.motion.walks.size;i++)f.tick(100);
  assert.equal(f.motion.exchanges.size,1);f.tick(210);const exchange=f.motion.exchanges.get('file');assert.ok(exchange.progress>0&&exchange.progress<1);assert.deepEqual(f.delivered,[]);
  f.tick(300);assert.deepEqual(f.delivered,['file']);assert.equal(f.agents.get('liu').pose.carrying,true);assert.equal(f.agents.get('zhang').pose.carrying,false);f.drain();assert.equal(f.agents.get('liu').pose.carrying,false);f.motion.destroy();
});


test('camera fitting and the reference-facing view use the same orthonormal direction',()=>{
  const direction=new THREE.Vector3(...OFFICE3D_CAMERA_OFFSET).normalize();
  for(const aspect of[.45,1,1.7,2.8]){
    const f=office3DFrustum(aspect);assert.ok(direction.distanceTo(f.direction)<1e-8);assert.ok(f.right.x>0&&f.up.x>0,'reference office rises gently towards the right');
    for(const x of[OFFICE3D_BOUNDS.min.x,OFFICE3D_BOUNDS.max.x])for(const y of[OFFICE3D_BOUNDS.min.y,OFFICE3D_BOUNDS.max.y])for(const z of[OFFICE3D_BOUNDS.min.z,OFFICE3D_BOUNDS.max.z]){
      const corner=new THREE.Vector3(x-OFFICE3D_CENTER.x,y-OFFICE3D_CENTER.y,z-OFFICE3D_CENTER.z);assert.ok(Math.abs(corner.dot(f.right))<=f.width/2);assert.ok(Math.abs(corner.dot(f.up))<=f.height/2);
    }
  }
});

test('keyboard hands stay on desktop height for both detailed figure scales',()=>{
  const assets=createOffice3DAssets();try{for(const scale of[.98,1.12]){
    const actor=createOffice3DActor(assets,{id:'desk-contact'},{scale});actor.setPosition({x:145,y:263});actor.root.rotation.y=Math.PI;actor.setPose({seated:true,working:true});actor.animate(0,{reducedMotion:true});actor.root.updateMatrixWorld(true);const hand=new THREE.Vector3();actor.arms.right.hand.getWorldPosition(hand);assert.ok(hand.y>=26&&hand.y<=30,`scale ${scale} wrist y ${hand.y}`);
  }}finally{assets.dispose();}
});

test('orbit fits the complete building at every bearing and tilt without excess framing',()=>{
  for(const aspect of[.45,1,1.6,2.3,3.2])for(const azimuth of[-Math.PI,-Math.PI/2,0,.7,Math.PI])for(const elevation of[.42,.76,1.28]){
    const f=office3DFrustum(aspect,{azimuth,elevation});let maxX=0,maxY=0;
    for(const x of[OFFICE3D_BOUNDS.min.x,OFFICE3D_BOUNDS.max.x])for(const y of[OFFICE3D_BOUNDS.min.y,OFFICE3D_BOUNDS.max.y])for(const z of[OFFICE3D_BOUNDS.min.z,OFFICE3D_BOUNDS.max.z]){const point=new THREE.Vector3(x-OFFICE3D_CENTER.x,y-OFFICE3D_CENTER.y,z-OFFICE3D_CENTER.z);maxX=Math.max(maxX,Math.abs(point.dot(f.right)-f.centerX));maxY=Math.max(maxY,Math.abs(point.dot(f.up)-f.centerY));}
    assert.ok(maxX<=f.width/2&&maxY<=f.height/2);assert.ok(Math.max(maxX*2/f.width,maxY*2/f.height)>.96,'one fitted axis uses over 96% of the frame');
  }
});

test('a settled colleague skips unchanged poses, while a real move invalidates the rig',()=>{
  const assets=createOffice3DAssets();try{const actor=createOffice3DActor(assets,{id:'idle-proof'});assert.equal(actor.needsUpdate,false);assert.equal(actor.animate(1000),false);actor.setPose({walking:false,seated:false});assert.equal(actor.needsUpdate,false);actor.setPosition({x:200,y:320});assert.equal(actor.needsUpdate,true);assert.equal(actor.animate(1000,{reducedMotion:true}),true);assert.equal(actor.needsUpdate,false);actor.setPosition({x:200,y:320});assert.equal(actor.needsUpdate,false);actor.setPose({walking:true,stride:12});assert.equal(actor.isAnimating,true);assert.equal(actor.animate(1020),true);assert.equal(actor.animate(1040),true);actor.setPose({walking:false,stride:0});assert.equal(actor.animate(1050,{reducedMotion:true}),true);assert.equal(actor.animate(3000),false);}finally{assets.dispose();}
});

test('canvas input has distinct orbit and pan gestures and a bounded pixel budget',()=>{
  assert.equal(scene3DGestureMode({button:0}), 'orbit');assert.equal(scene3DGestureMode({button:2}), 'pan');assert.equal(scene3DGestureMode({button:0,shiftKey:true}), 'pan');assert.equal(scene3DGestureMode({button:0},2),'touch');
  assert.equal(scene3DPixelRatio(1440,900,2),2);assert.equal(scene3DPixelRatio(1920,1080,2),2);assert.equal(scene3DPixelRatio(3840,2160,1),1,'a 4K monitor is not rendered below its CSS resolution');
  for(const [width,height,device]of[[1440,900,2],[1920,1080,2],[3840,2160,2],[400,800,3],[7680,4320,3]]){const ratio=scene3DPixelRatio(width,height,device);assert.ok(ratio<=2&&ratio>0);assert.ok(width*height*ratio*ratio<=9000001);assert.ok(Math.max(width,height)*ratio<=8192);}
  assert.equal(scene3DPixelRatio(1920,1080,2,{maxDimension:2048}),2048/1920);assert.equal(scene3DPixelRatio(1440,900,.8),.8);
  for(const invalid of[0,-1,NaN,Infinity])assert.equal(scene3DPixelRatio(1440,900,invalid),1);assert.ok(Number.isFinite(scene3DPixelRatio(NaN,Infinity,2)));
  assert.equal(scene3DFramePolicy(1000,1008,{dirty:true,interacting:true}).render,false,'a 120 Hz pointer stream does not force 120 redraws');assert.equal(scene3DFramePolicy(1000,1016,{interacting:true}).render,true);assert.equal(scene3DFramePolicy(1000,1016,{busy:false}).continue,false);
});

function mountedSceneFixture(callbacks={},options={}){
  const saved=new Map(['document','ResizeObserver','requestAnimationFrame','cancelAnimationFrame','setTimeout','clearTimeout','matchMedia','devicePixelRatio'].map(key=>[key,globalThis[key]]));let clock=1000,sequence=0,size={width:options.width||1440,height:options.height||900},surface={scale:options.visualScale??1,left:options.offsetLeft??0,top:options.offsetTop??0};
  const pending=new Map(),timers=new Map(),resizers=new Set(),media=new Map(),query=matches=>({matches,listeners:new Map(),addEventListener(type,fn){this.listeners.set(type,fn);},removeEventListener(type){this.listeners.delete(type);}}),preference=query(!!options.reducedMotion);class Element{
    constructor(tag='div'){this.tagName=tag;this.children=[];this.style={};this.dataset={};this.attributes={};this.handlers=new Map();this.listenerOptions=new Map();this.hidden=false;this.parentNode=null;this.captured=new Set();this.animations=[];this.classList={add(){},remove(){}};}
    append(...children){for(const child of children){child.parentNode=this;this.children.push(child);}}get firstChild(){return this.children[0];}
    setAttribute(key,value){this.attributes[key]=value;}removeAttribute(key){delete this.attributes[key];}addEventListener(key,fn,options){this.handlers.set(key,fn);this.listenerOptions.set(key,options);}removeEventListener(key){this.handlers.delete(key);this.listenerOptions.delete(key);}
    contains(element){return element===this||this.children.some(child=>child.contains?.(element));}
    closest(selector){for(let el=this;el;el=el.parentNode){const tag=el.tagName?.toLowerCase();if(selector.includes('input')&&['input','textarea','select'].includes(tag)||selector.includes('[contenteditable]')&&el.isContentEditable||selector.includes('dialog')&&(tag==='dialog'||el.attributes.role==='dialog')||selector.includes('.erp-layer')&&el.className==='erp-layer'||['agent','human','employee','node'].some(type=>selector.includes('[data-'+type+']')&&el.dataset[type]))return el;}return null;}
    get clientWidth(){return size.width;}get clientHeight(){return size.height;}
    getBoundingClientRect(){return {x:surface.left,y:surface.top,left:surface.left,top:surface.top,width:size.width/surface.scale,height:size.height/surface.scale};}remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(child=>child!==this);}
    setPointerCapture(id){this.captured.add(id);}hasPointerCapture(id){return this.captured.has(id);}releasePointerCapture(id){this.captured.delete(id);}
    animate(frames,settings){const animation={frames,settings,cancel(){this.cancelled=true;}};this.animations.push(animation);return animation;}focus(){}
    emit(type,value={}){const event={defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;},target:this,button:0,pointerId:1,pointerType:'mouse',...value};for(let element=this;element;element=element.parentNode){element.handlers.get(type)?.(event);if(event.stopped||!['wheel','gesturestart','gesturechange','gestureend','contextmenu'].includes(type))break;}return event;}
  }
  const doc=new Element();doc.hidden=false;doc.createElement=tag=>new Element(tag);globalThis.document=doc;globalThis.ResizeObserver=class{constructor(fn){this.fn=fn;}observe(){resizers.add(this.fn);}disconnect(){resizers.delete(this.fn);}};
  globalThis.requestAnimationFrame=fn=>{const id=++sequence;pending.set(id,fn);return id;};globalThis.cancelAnimationFrame=id=>pending.delete(id);globalThis.setTimeout=(fn,delay)=>{const id=++sequence;timers.set(id,{fn,due:clock+delay});return id;};globalThis.clearTimeout=id=>timers.delete(id);globalThis.devicePixelRatio=options.deviceRatio??1;globalThis.matchMedia=selector=>{if(selector.includes('prefers-reduced-motion'))return preference;if(!media.has(selector))media.set(selector,query(true));return media.get(selector);};
  const canvas=new Element('canvas'),allocations=[],operations=[],renderer={domElement:canvas,shadowMap:{},capabilities:{maxTextureSize:options.maxBufferDimension||16384},info:{render:{calls:0,triangles:0}},setDrawingBufferSize(width,height,ratio){allocations.push({width,height,ratio});operations.push('resize');canvas.painted=false;canvas.width=Math.floor(width*ratio);canvas.height=Math.floor(height*ratio);},render(scene){operations.push('render');canvas.painted=true;let calls=0;const visit=(item,visible=true)=>{visible=visible&&item.visible;if(!visible)return;if(item.isMesh&&item.material?.visible!==false)calls++;for(const child of item.children)visit(child,visible);};visit(scene);this.info.render.calls=calls;},dispose(){},forceContextLoss(){}};
  const container=new Element(),api=mountScene3D(container,{...callbacks,rendererFactory:()=>renderer,ambientEnabled:options.ambientEnabled??false});
  return{api,canvas,pending,timers,container,wrapper:container.children[0],preference,media,allocations,operations,document:doc,client(x,y){return {clientX:surface.left+x/surface.scale,clientY:surface.top+y/surface.scale};},viewport(scale,left=surface.left,top=surface.top){surface={scale,left,top};for(const fn of resizers)fn();},resize(width,height){size={width,height};for(const fn of resizers)fn();},density(ratio){const previous=media.get(`(resolution: ${globalThis.devicePixelRatio}dppx)`);globalThis.devicePixelRatio=ratio;previous?.listeners.get('change')?.({matches:false});},greeting(){const find=el=>el.className==='office3d-greeting'?el:el.children.map(find).find(Boolean);return find(container);},postTooltip(){const find=el=>el.className==='office3d-post-tooltip'?el:el.children.map(find).find(Boolean);return find(container);},room(id){const find=el=>el.className==='office3d-room-label'&&el.dataset.node===id?el:el.children.map(find).find(Boolean);return find(container);},area(id){const find=el=>el.dataset.area===id?el:el.children.map(find).find(Boolean);return find(container);},button(type,id){const visit=el=>el.tagName==='button'&&el.dataset[type]===id?el:el.children.map(visit).find(Boolean);return visit(container);},frame(){const callbacks=[...pending.values()];pending.clear();clock+=34;callbacks.forEach(fn=>fn(clock));for(const [id,timer]of [...timers])if(timer.due<=clock){timers.delete(id);timer.fn();}},drain(){for(let i=0;i<1000&&(pending.size||timers.size);i++)this.frame();assert.equal(pending.size,0,'presentation animations stop after reaching their endpoint');assert.equal(timers.size,0);},restore(){api.destroy();for(const [key,value]of saved)if(value===undefined)delete globalThis[key];else globalThis[key]=value;}};
}

test('resize observers preserve the painted frame and coalesce allocation into the replacement draw',()=>{
  const f=mountedSceneFixture({}, {deviceRatio:2});try{f.frame();assert.equal(f.canvas.painted,true);assert.deepEqual(f.operations,['resize','render']);const initialAllocations=f.allocations.length;
    for(let i=0;i<8;i++){f.resize(1441+i,901+i);assert.equal(f.canvas.painted,true,'ResizeObserver cannot clear a visible frame before the next paint');assert.equal(f.allocations.length,initialAllocations);}assert.equal(f.pending.size,1);f.frame();assert.deepEqual(f.operations.slice(-2),['resize','render']);assert.equal(f.allocations.length,initialAllocations+1);assert.equal(f.canvas.width,2896);assert.equal(f.api.getPerformanceStats().width,1448);assert.equal(f.pending.size,0);
    f.canvas.emit('wheel',{deltaY:-60,deltaMode:0});for(let i=0;i<6;i++){f.resize(1450+i,910+i);assert.equal(f.canvas.painted,true);f.frame();assert.equal(f.canvas.painted,true);assert.deepEqual(f.operations.slice(-2),['resize','render']);}f.drain();assert.equal(f.pending.size,0);assert.equal(f.api.getPerformanceStats().pixelRatio,2);
    const settledAllocations=f.allocations.length;f.resize(1600,1000);f.resize(1455,915);f.frame();assert.equal(f.allocations.length,settledAllocations,'a resize burst returning to the painted size does not reallocate');assert.equal(f.canvas.painted,true);
    f.document.hidden=true;f.document.emit('visibilitychange');f.resize(1800,1000);assert.equal(f.canvas.painted,true);assert.equal(f.pending.size,0);f.document.hidden=false;f.document.emit('visibilitychange');f.drain();assert.deepEqual(f.operations.slice(-2),['resize','render']);assert.equal(f.api.getPerformanceStats().width,1800);
  }finally{f.restore();}
});

test('prepare paints a complete first frame synchronously and consumes the pending initial animation frame',()=>{
  const f=mountedSceneFixture({}, {deviceRatio:2});try{assert.equal(f.pending.size,1);assert.equal(f.allocations.length,0);f.api.prepare();assert.equal(f.canvas.painted,true);assert.deepEqual(f.operations,['resize','render']);assert.equal(f.api.getPerformanceStats().renders,1);assert.equal(f.pending.size,0);f.frame();assert.equal(f.api.getPerformanceStats().renders,1);f.api.zoom(.2);f.drain();assert.equal(f.pending.size,0);assert.equal(f.allocations.length,1);}finally{f.restore();}
});

test('an inversely scaled viewport preserves the full logical camera, labels and native framebuffer on mount',()=>{
  let baseline;
  for(const visualScale of[1,2,3]){const f=mountedSceneFixture({}, {visualScale,offsetLeft:185,offsetTop:91,deviceRatio:2});try{f.frame();const stats=f.api.getPerformanceStats(),anchors=['server','finance','meeting','internet'].map(id=>f.api.getNodeAnchor(id));assert.equal(stats.width,1440);assert.equal(stats.height,900);assert.equal(stats.pixelRatio,2);assert.equal(f.canvas.width,2880);assert.equal(f.canvas.height,1800);assert.equal(f.pending.size,0);
    if(!baseline)baseline=anchors;else assert.deepEqual(anchors,baseline,'layout labels and camera fitting must not shrink to the CSS-transformed rect');
    const allocations=f.allocations.length;f.viewport(visualScale+1,295,147);assert.equal(f.allocations.length,allocations);assert.equal(f.pending.size,0,'a pure viewport offset/transform change does not start an idle render loop');assert.deepEqual(f.api.getNodeAnchor('server'),anchors[0]);
  }finally{f.restore();}}
});

test('equivalent physical drag, wheel and two-finger gestures produce the same view under viewport scale and offset',()=>{
  function exercise(visualScale){const selected=[],f=mountedSceneFixture({onSelectNode:id=>selected.push(id),onSelectAgent:id=>selected.push(id)}, {visualScale,offsetLeft:203,offsetTop:109});try{f.frame();const samples=[],record=()=>{const stats=f.api.getPerformanceStats();samples.push({azimuth:stats.azimuth,elevation:stats.elevation,scale:stats.scale,anchor:f.api.getNodeAnchor('server')});};
    for(const button of[0,2]){f.canvas.emit('pointerdown',{button,...f.client(600,350)});f.canvas.emit('pointermove',{button,...f.client(735,386)});f.canvas.emit('pointerup',{button,...f.client(735,386)});f.drain();record();}
    for(const [deltaMode,deltaY]of[[0,-85],[1,2],[2,-.08]]){f.canvas.emit('wheel',{deltaMode,deltaY});f.drain();record();}
    f.canvas.emit('pointerdown',{pointerType:'touch',pointerId:1,...f.client(400,400)});f.canvas.emit('pointerdown',{pointerType:'touch',pointerId:2,...f.client(600,400)});f.canvas.emit('pointermove',{pointerType:'touch',pointerId:2,...f.client(700,450)});f.canvas.emit('pointerup',{pointerType:'touch',pointerId:2,...f.client(700,450)});f.canvas.emit('pointerup',{pointerType:'touch',pointerId:1,...f.client(400,400)});f.drain();record();assert.deepEqual(selected,[]);assert.equal(f.pending.size,0);assert.equal(f.allocations.length,1);return samples;
  }finally{f.restore();}}
  const baseline=exercise(1);for(const visualScale of[2,3]){const samples=exercise(visualScale);for(let i=0;i<samples.length;i++){for(const key of['azimuth','elevation','scale'])assert.ok(Math.abs(samples[i][key]-baseline[i][key])<1e-8,`${key} changed under viewport scale ${visualScale}`);for(const key of['x','y'])assert.ok(Math.abs(samples[i].anchor[key]-baseline[i].anchor[key])<1e-6);}}
});

test('canvas picking still targets the colleague at its transformed visible location',()=>{
  for(const visualScale of[1,2,3]){const selected=[],f=mountedSceneFixture({onSelectAgent:id=>selected.push(id)}, {visualScale,offsetLeft:227,offsetTop:133});try{f.frame();const at=f.api.getAgentAnchor('zhang'),point=f.client(at.x,at.y);f.canvas.emit('pointerdown',point);f.canvas.emit('pointerup',point);f.drain();assert.deepEqual(selected,['zhang']);assert.equal(f.pending.size,0);}finally{f.restore();}}
});

test('retina, fullscreen resize and monitor density changes keep the backing buffer aligned without repeated allocations',()=>{
  const f=mountedSceneFixture({}, {deviceRatio:2});try{f.frame();assert.equal(f.canvas.width,2880);assert.equal(f.canvas.height,1800);assert.equal(f.api.getPerformanceStats().pixelRatio,2);assert.equal(f.allocations.length,1);
    f.resize(1920,1080);f.drain();assert.equal(f.canvas.width,3840);assert.equal(f.canvas.height,2160);assert.equal(f.api.getPerformanceStats().width,1920);assert.equal(f.api.getPerformanceStats().bufferHeight,2160);assert.equal(f.allocations.length,2);
    f.resize(1920,1080);f.resize(0,0);assert.equal(f.allocations.length,2,'identical or temporarily hidden layout cannot clear or reallocate the framebuffer');assert.equal(f.pending.size,0);
    f.resize(1920,1080);f.density(1);f.drain();assert.equal(f.canvas.width,1920);assert.equal(f.allocations.length,3);f.density(2);f.drain();assert.equal(f.canvas.width,3840);assert.equal(f.allocations.length,4);assert.equal(f.canvas.style.width,'100%');assert.equal(f.canvas.style.height,'100%');
    f.api.rotate(.4);f.drain();assert.equal(f.allocations.length,4,'camera animation does not rebuild or resize the framebuffer');
    f.restore();for(const query of f.media.values())assert.equal(query.listeners.size,0);
  }finally{f.restore();}
  const limited=mountedSceneFixture({}, {width:1920,height:1080,deviceRatio:2,maxBufferDimension:2048});try{limited.frame();assert.equal(limited.canvas.width,2048);assert.ok(limited.canvas.height<=2048);}finally{limited.restore();}
});

test('wheel and native Safari pinch on scene labels control the camera instead of zooming the whole page',()=>{
  const selected=[],f=mountedSceneFixture({onSelectNode:id=>selected.push(id),onSelectAgent:id=>selected.push(id)});try{f.frame();assert.equal(f.canvas.handlers.has('wheel'),false);assert.equal(f.wrapper.listenerOptions.get('wheel').passive,false);
    const person=f.button('agent','zhang'),room=f.button('node','meeting'),initial=f.api.getPerformanceStats();
    for(const label of[person,room]){assert.equal(label.emit('contextmenu').defaultPrevented,true);const event=label.emit('wheel',{deltaY:-40,deltaMode:0,ctrlKey:true});assert.equal(event.defaultPrevented,true);}f.drain();assert.ok(f.api.getPerformanceStats().scale>initial.scale);assert.deepEqual(selected,[]);
    const before=f.api.getPerformanceStats();for(const name of['gesturestart','gesturechange','gestureend'])assert.equal(f.wrapper.listenerOptions.get(name).passive,false);
    assert.equal(person.emit('gesturestart',{scale:1,rotation:0}).defaultPrevented,true);assert.equal(person.emit('gesturechange',{scale:1.25,rotation:20}).defaultPrevented,true);f.drain();const changed=f.api.getPerformanceStats();assert.ok(Math.abs(changed.scale-before.scale*1.25)<1e-8);assert.ok(Math.abs(changed.azimuth-before.azimuth+20*Math.PI/180)<1e-8);assert.equal(person.emit('gestureend').defaultPrevented,true);f.drain();assert.equal(f.pending.size,0);assert.deepEqual(selected,[]);
    const outside=f.document.createElement('button');assert.equal(outside.emit('wheel',{deltaY:-40,ctrlKey:true}).defaultPrevented,false,'business UI and browser shortcuts outside the scene keep their native behavior');
  }finally{f.restore();}
});

test('Safari gesture events cannot double-apply a two-pointer pinch',()=>{
  const f=mountedSceneFixture();try{f.frame();f.canvas.emit('pointerdown',{pointerType:'touch',pointerId:1,clientX:400,clientY:400});f.canvas.emit('pointerdown',{pointerType:'touch',pointerId:2,clientX:600,clientY:400});f.wrapper.emit('gesturestart',{scale:1,rotation:0});f.canvas.emit('pointermove',{pointerType:'touch',pointerId:2,clientX:700,clientY:400});const before=f.api.getPerformanceStats();assert.equal(f.wrapper.emit('gesturechange',{scale:1.5,rotation:0}).defaultPrevented,true);assert.equal(f.api.getPerformanceStats().scale,before.scale);f.canvas.emit('pointerup',{pointerType:'touch',pointerId:2,clientX:700,clientY:400});f.canvas.emit('pointerup',{pointerType:'touch',pointerId:1,clientX:400,clientY:400});f.wrapper.emit('gestureend');f.drain();assert.equal(f.pending.size,0);}finally{f.restore();}
});

test('the mounted office stops rendering at rest and returns to idle after pointer rotation',()=>{
  const f=mountedSceneFixture();try{f.frame();assert.equal(f.pending.size,0);const initial=f.api.getPerformanceStats();assert.equal(initial.renders,1);assert.ok(initial.drawCalls<110,JSON.stringify(initial));
    const before=f.api.getNodeAnchor('server');f.canvas.emit('pointerdown',{clientX:900,clientY:400});f.canvas.emit('pointermove',{clientX:1010,clientY:440});f.frame();const after=f.api.getNodeAnchor('server');assert.ok(Math.abs(before.x-after.x)>20);assert.notEqual(f.api.getPerformanceStats().azimuth,initial.azimuth);f.canvas.emit('pointerup',{clientX:1010,clientY:440});f.frame();assert.equal(f.pending.size,0);
    const settled=f.api.getPerformanceStats();assert.equal(settled.actorUpdates,initial.actorUpdates,'rotating the camera does not animate or upload static colleagues');assert.equal(settled.instanceUploads,initial.instanceUploads);
    f.api.resetView();assert.equal(f.api.getPerformanceStats().cameraMoving,true);f.drain();assert.ok(Math.abs(f.api.getNodeAnchor('server').x-before.x)<.001);
  }finally{f.restore();}
});

test('twenty signed-in employees share render batches and disappear cleanly on logout',()=>{
  const f=mountedSceneFixture();try{f.frame();const initial=f.api.getPerformanceStats(),people=Array.from({length:20},(_,i)=>({id:`real-${i}`,name:`同事${i}`,title:'销售',online:true,nodeId:'workstations'}));f.api.setPresence({enabled:true,currentUserId:'real-0',people});f.frame();const populated=f.api.getPerformanceStats();if(process.env.OFFICE_SCENE_BENCH==='1')console.log(JSON.stringify({idle:initial,twentyEmployees:populated}));assert.equal(populated.people,initial.people+20);assert.equal(populated.drawCalls,initial.drawCalls,'twenty colleagues reuse the same geometry batches');assert.ok(f.api.getHumanAnchor('real-0')?.visible);assert.equal(f.pending.size,0);f.api.setPresence({enabled:false,people:[]});f.frame();assert.equal(f.api.getPerformanceStats().people,initial.people);assert.equal(f.api.getHumanAnchor('real-0'),null);assert.equal(f.pending.size,0);
  }finally{f.restore();}
});

test('pan, pinch and twist stay independent of object selection and settle after release',()=>{
  const selected=[],f=mountedSceneFixture({onSelectNode:id=>selected.push(id),onSelectAgent:id=>selected.push(id),onSelectHuman:id=>selected.push(id)});try{f.frame();const initial=f.api.getPerformanceStats(),before=f.api.getNodeAnchor('server');
    f.canvas.emit('pointerdown',{button:2,clientX:800,clientY:300});f.canvas.emit('pointermove',{button:2,clientX:890,clientY:320});f.frame();assert.equal(f.api.getPerformanceStats().azimuth,initial.azimuth);assert.ok(Math.abs(f.api.getNodeAnchor('server').x-before.x)>60);f.canvas.emit('pointerup',{button:2,clientX:890,clientY:320});f.frame();assert.deepEqual(selected,[]);
    f.canvas.emit('pointerdown',{pointerType:'touch',pointerId:1,clientX:400,clientY:400});f.canvas.emit('pointerdown',{pointerType:'touch',pointerId:2,clientX:600,clientY:400});f.canvas.emit('pointermove',{pointerType:'touch',pointerId:2,clientX:700,clientY:450});f.frame();const gesture=f.api.getPerformanceStats();assert.ok(gesture.scale>1.4);assert.notEqual(gesture.azimuth,initial.azimuth);f.canvas.emit('pointerup',{pointerType:'touch',pointerId:2,clientX:700,clientY:450});f.canvas.emit('pointerup',{pointerType:'touch',pointerId:1,clientX:400,clientY:400});f.frame();assert.equal(f.pending.size,0);assert.deepEqual(selected,[]);f.api.rotate(Math.PI/4);f.drain();assert.ok(Math.abs(f.api.getPerformanceStats().azimuth-gesture.azimuth-Math.PI/4)<1e-8);
  }finally{f.restore();}
});

test('an employee walk keeps rendering until arrival, while hidden pages never draw',()=>{
  const f=mountedSceneFixture();try{f.frame();const people=[{id:'moving-person',name:'同事',online:true,nodeId:'workstations'}];f.api.setPresence({enabled:true,people});f.frame();const before=f.api.getHumanAnchor('moving-person');f.api.setPresence({enabled:true,people:people.map(p=>({...p,nodeId:'finance'}))});f.frame();assert.ok(f.pending.size>0,'the motion scheduler continues the walk');for(let i=0;i<800&&f.pending.size;i++)f.frame();assert.equal(f.pending.size,0);const after=f.api.getHumanAnchor('moving-person');assert.ok(Math.hypot(before.x-after.x,before.y-after.y)>100,'the figure arrives at the actual destination');
    f.document.hidden=true;f.document.emit('visibilitychange');const settled=f.api.getPerformanceStats().renders;f.api.update({nodes:{server:'warning'}});f.api.setPresence({enabled:true,people});assert.equal(f.api.getPerformanceStats().renders,settled);assert.equal(f.pending.size,0);f.document.hidden=false;f.document.emit('visibilitychange');f.frame();assert.ok(f.api.getPerformanceStats().renders>settled);for(let i=0;i<800&&f.pending.size;i++)f.frame();assert.equal(f.pending.size,0);
  }finally{f.restore();}
});

test('camera buttons and wheel ease through intermediate positions, retarget smoothly and return to idle',()=>{
 const f=mountedSceneFixture();try{f.frame();const baseline=f.api.getPerformanceStats();f.api.rotate(.6);assert.equal(f.api.getPerformanceStats().azimuth,baseline.azimuth);f.frame();f.frame();const middle=f.api.getPerformanceStats();assert.ok(middle.azimuth>baseline.azimuth&&middle.azimuth<baseline.azimuth+.6);f.api.rotate(.2);f.drain();assert.ok(Math.abs(f.api.getPerformanceStats().azimuth-baseline.azimuth-.8)<1e-8);assert.equal(f.api.getPerformanceStats().actorUpdates,baseline.actorUpdates);
  f.canvas.emit('wheel',{deltaY:120,deltaMode:0});f.frame();f.frame();assert.ok(f.api.getPerformanceStats().scale<1);f.canvas.emit('wheel',{deltaY:-120,deltaMode:0});f.drain();assert.ok(Math.abs(f.api.getPerformanceStats().scale-1)<1e-8);f.api.resetView();f.drain();assert.ok(Math.abs(f.api.getPerformanceStats().azimuth-baseline.azimuth)<1e-8);assert.equal(f.api.getPerformanceStats().cameraMoving,false);assert.equal(f.api.getPerformanceStats().drawCalls,baseline.drawCalls);
 }finally{f.restore();}
});

test('middle-button panning, capture loss and keyboard focus do not dispatch business actions',()=>{
 const selected=[],f=mountedSceneFixture({onSelectNode:id=>selected.push(id)});try{f.frame();const original=f.api.getNodeAnchor('server'),azimuth=f.api.getPerformanceStats().azimuth;f.canvas.emit('pointerdown',{button:1,clientX:600,clientY:400});f.canvas.emit('pointermove',{button:1,clientX:740,clientY:440});f.frame();assert.equal(f.api.getPerformanceStats().azimuth,azimuth);assert.ok(Math.abs(f.api.getNodeAnchor('server').x-original.x)>70);f.canvas.emit('lostpointercapture',{button:1});f.frame();assert.equal(f.canvas.captured.size,0);const anchor=f.api.getNodeAnchor('server');f.canvas.emit('pointermove',{clientX:1000,clientY:800});f.drain();assert.ok(Math.abs(f.api.getNodeAnchor('server').x-anchor.x)<.001);const room=f.button('node','meeting');room.emit('pointerdown',{button:1,clientX:600,clientY:400});f.canvas.emit('pointermove',{button:1,clientX:640,clientY:420});f.canvas.emit('pointerup',{button:1,clientX:640,clientY:420});f.drain();assert.deepEqual(selected,[]);
  f.wrapper.emit('keydown',{key:'Home',target:{tagName:'INPUT'}});assert.equal(f.api.getPerformanceStats().cameraMoving,false);f.wrapper.emit('keydown',{key:'Home'});f.drain();assert.ok(Math.abs(f.api.getNodeAnchor('server').x-original.x)<.001);f.api.setSelectedNode('server');f.wrapper.emit('keydown',{key:'f'});f.drain();assert.ok(f.api.getPerformanceStats().scale>=1.4);assert.deepEqual(selected,[]);
 }finally{f.restore();}
});

test('double-click focuses an object without opening its business and ordinary clicks still work once',()=>{
 const selected=[],f=mountedSceneFixture({onSelectNode:id=>selected.push(id)});try{f.frame();const node=f.button('node','server');node.emit('click',{detail:1});assert.deepEqual(selected,[]);node.emit('click',{detail:2});f.drain();assert.deepEqual(selected,[]);assert.ok(f.api.getPerformanceStats().scale>=1.4);assert.equal(node.attributes['aria-pressed'],'true');node.emit('click',{detail:1});f.drain();assert.deepEqual(selected,['server']);f.api.rotate(.5);f.drain();f.canvas.emit('dblclick',{clientX:-500,clientY:-500});f.drain();assert.equal(f.api.getPerformanceStats().scale,1);assert.deepEqual(selected,['server']);
 }finally{f.restore();}
});

test('colleague hover and press produce finite articulated feedback without adding draw calls',()=>{
 const f=mountedSceneFixture();try{f.frame();const initial=f.api.getPerformanceStats(),person=f.button('agent','zhang');person.emit('pointerenter');f.frame();assert.equal(f.greeting().hidden,false);assert.equal(f.pending.size,0,'a robot smile is static after its first paint');person.emit('click',{detail:0});f.frame();assert.ok(f.pending.size>0);f.drain();const settled=f.api.getPerformanceStats();assert.ok(settled.actorUpdates>initial.actorUpdates);assert.equal(settled.drawCalls,initial.drawCalls);assert.equal(settled.cameraMoving,false);assert.equal(person.animations.length,1);assert.ok(person.animations[0].settings.duration<=420);f.api.rotate(.4);f.frame();f.frame();assert.equal(f.api.getPerformanceStats().cameraMoving,true);f.preference.listeners.get('change')({matches:true});assert.equal(f.api.getPerformanceStats().cameraMoving,false);f.frame();assert.equal(f.pending.size,0);
 }finally{f.restore();}
 const reduced=mountedSceneFixture({}, {reducedMotion:true});try{reduced.frame();const initial=reduced.api.getPerformanceStats();reduced.button('agent','zhang').emit('pointerenter');reduced.frame();assert.equal(reduced.greeting().hidden,false);assert.equal(reduced.pending.size,0);const greeted=reduced.api.getPerformanceStats();reduced.api.rotate(.5);assert.ok(Math.abs(reduced.api.getPerformanceStats().azimuth-initial.azimuth-.5)<1e-8);reduced.frame();assert.equal(reduced.pending.size,0);assert.equal(reduced.api.getPerformanceStats().actorUpdates,greeted.actorUpdates);}finally{reduced.restore();}
});

test('a person turns and settles into a new pose over finite frames instead of snapping at arrival',()=>{
 const assets=createOffice3DAssets();try{const actor=createOffice3DActor(assets,{id:'settle'});actor.facePoint({x:100,y:0});actor.animate(0,{delta:16});assert.ok(actor.root.rotation.y>0&&actor.root.rotation.y<Math.PI/2);actor.setPose({seated:true});actor.animate(16,{delta:16});assert.ok(actor.rig.position.y>16&&actor.rig.position.y<23);for(let i=0;i<120&&actor.isAnimating;i++)actor.animate(34*i,{delta:34});assert.equal(actor.isAnimating,false);assert.equal(actor.rig.position.y,16);assert.ok(Math.abs(actor.root.rotation.y-Math.PI/2)<.002);assert.equal(actor.animate(10000),false);}finally{assets.dispose();}
});

test('scene shortcuts work from focused hotspots but ignore editors, dialogs and Enter activation',()=>{
 const selected=[],f=mountedSceneFixture({onSelectNode:id=>selected.push(id)});try{
  f.frame();const room=f.button('node','server');f.wrapper.emit('keydown',{key:'f',target:room});f.drain();assert.ok(f.api.getPerformanceStats().scale>=1.4);assert.deepEqual(selected,[]);f.wrapper.emit('keydown',{key:'Home',target:room});f.drain();assert.equal(f.api.getPerformanceStats().scale,1);
  for(const tag of ['input','textarea','select','div','dialog']){const editor=f.document.createElement(tag);if(tag==='div')editor.isContentEditable=true;f.wrapper.append(editor);f.wrapper.emit('keydown',{key:'f',target:editor});assert.equal(f.api.getPerformanceStats().cameraMoving,false);f.wrapper.emit('keydown',{key:'Home',target:editor});assert.equal(f.api.getPerformanceStats().cameraMoving,false);}
  const dialog=f.document.createElement('section'),inside=f.document.createElement('button');dialog.setAttribute('role','dialog');dialog.append(inside);f.wrapper.append(dialog);f.wrapper.emit('keydown',{key:'Home',target:inside});f.wrapper.emit('keydown',{key:'f',target:inside});assert.equal(f.api.getPerformanceStats().cameraMoving,false);const erp=f.document.createElement('section'),erpButton=f.document.createElement('button');erp.className='erp-layer';erp.append(erpButton);f.wrapper.append(erp);f.wrapper.emit('keydown',{key:'f',target:erpButton});assert.equal(f.api.getPerformanceStats().cameraMoving,false);
  f.wrapper.emit('keydown',{key:'Enter',target:room});assert.deepEqual(selected,[]);room.emit('click',{detail:0});assert.deepEqual(selected,['server']);assert.equal(f.api.getPerformanceStats().cameraMoving,false);
 }finally{f.restore();}
});

test('virtual hover and focus show a robot greeting without selecting or opening business',()=>{
 const selected=[],f=mountedSceneFixture({onSelectAgent:id=>selected.push(id)});try{
  f.frame();const person=f.button('agent','zhang'),bubble=f.greeting();assert.equal(bubble.hidden,true);person.emit('pointerenter');assert.equal(bubble.hidden,false);assert.equal(bubble.dataset.kind,'robot');assert.equal(bubble.dataset.person,'zhang');assert.equal(bubble.children[1].textContent,'随时待命！');assert.match(bubble.children[0].innerHTML,/<svg[^>]*viewBox="0 0 32 32"/);assert.match(bubble.children[0].innerHTML,/<rect/);assert.equal(person.attributes['aria-describedby'],bubble.id);f.drain();assert.deepEqual(selected,[]);
  person.emit('pointerleave');assert.equal(bubble.hidden,true);assert.equal(bubble.children[1].textContent,'');assert.equal(person.attributes['aria-describedby'],undefined);assert.equal(person.dataset.greeting,undefined);f.drain();person.emit('focus');assert.equal(bubble.hidden,false);person.emit('blur');f.drain();assert.equal(bubble.hidden,true);assert.deepEqual(selected,[]);
 }finally{f.restore();}
});

test('real employee greets by current Shanghai time on each hover and finishes one wave at idle',()=>{
 const NativeDate=globalThis.Date;let current='2026-10-20T22:00:00Z';globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[current]));}};
 const selected=[],f=mountedSceneFixture();try{
  f.frame();f.api.setPresence({enabled:true,currentUserId:'real',people:[{id:'real',name:'真实同事',title:'项目经理',online:true,nodeId:'workstations'}],onSelectEmployee:p=>selected.push(p.id)});f.drain();const initial=f.api.getPerformanceStats(),person=f.button('employee','real'),bubble=f.greeting();person.emit('pointerenter');assert.equal(bubble.dataset.kind,'human');assert.equal(bubble.children[1].textContent,'早上好！');assert.match(bubble.children[0].innerHTML,/<circle/);f.frame();assert.ok(f.pending.size>0);f.drain();assert.equal(bubble.hidden,false,'the smile and words stay while hovered without a perpetual animation');assert.equal(f.api.getPerformanceStats().drawCalls,initial.drawCalls);assert.deepEqual(selected,[]);
  person.emit('pointerleave');f.drain();current='2026-10-21T03:00:00Z';person.emit('pointerenter');assert.equal(bubble.children[1].textContent,'中午好！');person.emit('pointerleave');f.drain();current='2026-10-21T11:30:00Z';person.emit('focus');assert.equal(bubble.children[1].textContent,'晚上好！');person.emit('blur');f.drain();assert.equal(bubble.hidden,true);assert.deepEqual(selected,[]);
 }finally{f.restore();globalThis.Date=NativeDate;}
});

test('greetings clear on drag, hidden page, employee removal and destruction without dispatching work',()=>{
 const selected=[],f=mountedSceneFixture({onSelectAgent:id=>selected.push(id),onSelectHuman:id=>selected.push(id)});try{
  f.frame();const agent=f.button('agent','zhang'),bubble=f.greeting();agent.emit('pointerenter');f.canvas.emit('pointerdown',{clientX:900,clientY:400});assert.equal(bubble.hidden,true);f.canvas.emit('pointercancel');f.drain();
  agent.emit('focus');f.document.hidden=true;f.document.emit('visibilitychange');assert.equal(bubble.hidden,true);assert.equal(bubble.children[1].textContent,'');assert.equal(f.pending.size,0);f.document.hidden=false;f.document.emit('visibilitychange');f.drain();assert.equal(bubble.hidden,true);
  f.api.setPresence({enabled:true,people:[{id:'real',name:'真实同事',online:true,nodeId:'workstations'}]});f.drain();f.button('employee','real').emit('pointerenter');assert.equal(bubble.hidden,false);f.api.setPresence({enabled:true,people:[]});assert.equal(bubble.hidden,true);f.drain();agent.emit('focus');assert.equal(bubble.hidden,false);f.api.destroy();assert.equal(bubble.hidden,true);assert.equal(bubble.children[1].textContent,'');assert.equal(f.pending.size,0);assert.equal(f.container.children.length,0);agent.emit('pointerenter');assert.equal(bubble.hidden,true);assert.deepEqual(selected,[]);
 }finally{f.restore();}
});

test('smiling and a finite wave never change a person task, walk or handoff state',()=>{
 const assets=createOffice3DAssets();try{
  const person=createOffice3DActor(assets,{id:'human-greeting'}),before={...person.target};person.setGreeting(true);assert.equal(person.waving,true);person.animate(0,{delta:34});person.animate(260,{delta:34});assert.ok(person.arms.left.upper.rotation.z<-.5);assert.equal(person.root.getObjectByName('smiling-mouth').visible,true);assert.equal(person.root.getObjectByName('neutral-mouth').visible,false);assert.deepEqual(person.target,before);person.animate(1100,{delta:34});assert.equal(person.waving,false);assert.equal(person.isAnimating,false);assert.equal(person.animate(3000),false);
  person.setGreeting(false);person.animate(3200,{reducedMotion:true});assert.equal(person.root.getObjectByName('smiling-mouth').visible,false);person.setPose({walking:true,heading:'right',stride:8});const walking={...person.target};person.setGreeting(true);assert.equal(person.waving,false);person.animate(3300,{delta:34});assert.deepEqual(person.target,walking);person.setGreeting(false);person.setPose({walking:false,carrying:true,offering:true});const handingOff={...person.target};person.setGreeting(true);assert.equal(person.waving,false);person.animate(3400,{delta:34});assert.deepEqual(person.target,handingOff);assert.equal(person.document.visible,true);
  const reduced=createOffice3DActor(assets,{id:'reduced-greeting'});reduced.setGreeting(true,{animated:false});reduced.animate(0,{reducedMotion:true});assert.equal(reduced.greetingActive,true);assert.equal(reduced.waving,false);assert.equal(reduced.isAnimating,false);
  const robot=createOffice3DActor(assets,{id:'robot-greeting'},{virtual:true});robot.setGreeting(true);robot.animate(0);assert.equal(robot.waving,false);assert.equal(robot.isAnimating,false);assert.equal(robot.root.getObjectByName('smiling-mouth').visible,true);
 }finally{assets.dispose();}
});


test('all organizational workplaces share one static hit batch and leave the idle renderer asleep',()=>{
  const f=mountedSceneFixture();try{f.frame();const before=f.api.getPerformanceStats();assert.equal(before.organizationPeople,250);assert.equal(before.workplaces,251);assert.equal(before.people,18,'only virtual staff and functional representatives use articulated rigs');assert.equal(f.pending.size,0);
    assert.ok(before.drawCalls<90,`organization draw calls ${before.drawCalls}`);f.api.rotate(.5);f.drain();const after=f.api.getPerformanceStats();assert.equal(after.actorUpdates,before.actorUpdates);assert.equal(after.instanceUploads,before.instanceUploads);assert.equal(after.drawCalls,before.drawCalls);assert.equal(f.pending.size,0);
  }finally{f.restore();}
});

test('chairman workplace hover and selection use the same instance coordinates under native zoom',()=>{
  const seat=OFFICE_SEATS.find(post=>post.role==='chairman');
  for(const visualScale of[1,2,3]){const selected=[],f=mountedSceneFixture({onSelectNode:id=>selected.push(id)},{visualScale,offsetLeft:73,offsetTop:43});try{
    f.frame();const at=f.api.getPostAnchor(seat.id),point=f.client(at.x,at.y),tooltip=f.postTooltip();assert.ok(at.visible);
    f.canvas.emit('pointermove',point);assert.equal(tooltip.hidden,false);assert.equal(tooltip.dataset.post,seat.id);assert.equal(tooltip.children[0].textContent,'董事长');assert.equal(tooltip.children[1].textContent,'总经办');assert.equal(f.pending.size,0,'post hover has no model calls or background animation');
    f.canvas.emit('pointerdown',point);assert.equal(tooltip.hidden,true);f.canvas.emit('pointerup',point);f.drain();assert.deepEqual(selected,['general_office']);f.canvas.emit('pointerleave');assert.equal(tooltip.hidden,true);
  }finally{f.restore();}}
});

test('shared business manager has one person and an explicitly labelled second workplace',()=>{
  const shared=OFFICE_SEATS.find(seat=>seat.departmentId==='channels'&&seat.role==='manager'),chairman=OFFICE_SEATS.find(seat=>seat.role==='chairman');assert.equal(shared.occupantVisible,false);
  const selected=[],f=mountedSceneFixture({onSelectNode:id=>selected.push(id)});try{f.frame();assert.equal(f.button('post',chairman.id).hidden,true,'full view keeps role labels clear of signed-in employee nameplates');f.api.focusNode('general_office');f.drain();assert.equal(f.button('post',chairman.id).hidden,false,'department magnification reveals the chairman role');f.api.focusNode('channels');f.drain();assert.ok(f.api.getPerformanceStats().scale>=1.65&&f.api.getPerformanceStats().scale<=6.5);const label=f.button('post',shared.id);assert.ok(label);assert.equal(label.hidden,false);label.emit('focus');assert.equal(f.postTooltip().children[0].textContent,'商务部经理兼任');label.emit('blur');assert.equal(f.postTooltip().hidden,true);label.emit('click',{detail:0});assert.deepEqual(selected,['channels']);
    const chairmanLabel=f.button('post',chairman.id);assert.ok(chairmanLabel);assert.equal(chairmanLabel.textContent,'董事长');const smallDepartmentScale=f.api.getPerformanceStats().scale;f.api.focusNode('ai_data');f.drain();assert.ok(f.api.getPerformanceStats().scale<smallDepartmentScale,'a larger department zooms back to fit instead of inheriting the small department magnification');f.api.resetView();f.drain();assert.equal(f.api.getPerformanceStats().scale,1);assert.equal(f.button('post',chairman.id).hidden,true,'returning to full view hides the chairman overlay again');assert.equal(f.pending.size,0);
  }finally{f.restore();}
});


test('AI departments expose five shared-plan team labels that focus locally and return to the same full view',()=>{
  const selected=[],f=mountedSceneFixture({onSelectNode:id=>selected.push(id)});try{f.frame();const initial=f.api.getPerformanceStats(),initialAnchor=f.api.getPostAnchor('ai_data_head_001');
    const teams=OFFICE_ROOMS.find(room=>room.id==='ai_data').teamZones;assert.equal(teams.length,5);
    for(const team of teams){const label=f.button('team',team.id);assert.ok(label);assert.equal(label.firstChild.textContent,`${team.title} · 40 人`);label.emit('click',{detail:0});f.drain();assert.ok(f.api.getPerformanceStats().scale>=1.65&&f.api.getPerformanceStats().scale<=6.5);assert.ok(f.api.getPostAnchor(team.headPersonId).visible);assert.deepEqual(selected,[],'team navigation never opens or mutates ERP records');}
    f.api.resetView();f.drain();assert.equal(f.api.getPerformanceStats().scale,1);assert.equal(f.api.getPerformanceStats().azimuth,initial.azimuth);const finalAnchor=f.api.getPostAnchor('ai_data_head_001');for(const key of['x','y'])assert.ok(Math.abs(finalAnchor[key]-initialAnchor[key])<1e-6);assert.equal(f.pending.size,0);
  }finally{f.restore();}
});


test('rounded architecture and furniture geometry honors its declared footprint including bevels',()=>{
  const assets=createOffice3DAssets();try{for(const kind of['round','slab']){const geometry=assets.geometries[kind];geometry.computeBoundingBox();const dimensions=new THREE.Vector3();geometry.boundingBox.getSize(dimensions);for(const value of dimensions.toArray())assert.ok(Math.abs(value-1)<1e-6,`${kind} expanded outside its footprint`);}
    const layout=createOffice3DLayout(assets);layout.root.updateMatrixWorld(true);const extents=new THREE.Box3().setFromObject(layout.root);assert.ok(extents.min.x>=OFFICE3D_BOUNDS.min.x&&extents.max.x<=OFFICE3D_BOUNDS.max.x);assert.ok(extents.min.z>=OFFICE3D_BOUNDS.min.z&&extents.max.z<=OFFICE3D_BOUNDS.max.z);assert.ok(extents.max.y<=OFFICE3D_BOUNDS.max.y,'tree canopy and server racks remain inside the fitted height');
  }finally{assets.dispose();}
});


test('a selected department can reveal its roles at full scale without displaying unrelated labels',()=>{
  const f=mountedSceneFixture();try{f.frame();const chairman=OFFICE_SEATS.find(seat=>seat.role==='chairman'),shared=OFFICE_SEATS.find(seat=>!seat.occupantVisible);assert.equal(f.button('post',chairman.id).hidden,true);f.api.setSelectedNode('general_office');f.frame();assert.equal(f.button('post',chairman.id).hidden,false);assert.equal(f.button('post',shared.id).hidden,true);f.api.setSelectedNode(null);f.frame();assert.equal(f.button('post',chairman.id).hidden,true);assert.equal(f.pending.size,0);
  }finally{f.restore();}
});


test('ambient poses finish within one burst and never change the employee task pose or world position',()=>{
  const assets=createOffice3DAssets();try{for(const kind of['typing','sip','look','nod','wave']){
    const actor=createOffice3DActor(assets,{id:`ambient-${kind}`},{virtual:kind==='typing'});actor.setPosition({x:120,y:180});actor.animate(0,{reducedMotion:true});const before={...actor.target},point=actor.root.position.clone();
    assert.equal(actor.setAmbient(kind,{x:150,y:180}),true);assert.equal(actor.isAnimating,true);actor.animate(0);actor.animate(900);assert.equal(actor.ambientKind,kind);assert.deepEqual(actor.target,before);assert.deepEqual(actor.root.position,point);
    if(kind==='sip')assert.equal(actor.ambientCup.visible,true);if(kind==='typing')assert.equal(actor.ambientTablet.visible,true);
    actor.animate(2400);assert.equal(actor.ambientKind,null);assert.equal(actor.isAnimating,false);assert.equal(actor.ambientCup.visible,false);assert.equal(actor.ambientTablet.visible,false);assert.equal(actor.animate(5000),false);assert.deepEqual(actor.target,before);
  }}finally{assets.dispose();}
});

test('business movement, deliveries, hover greetings and reduced motion take priority over idle gestures',()=>{
  const assets=createOffice3DAssets();try{const actor=createOffice3DActor(assets,{id:'priority'});actor.setAmbient('sip');actor.animate(0);actor.animate(700);assert.equal(actor.ambientCup.visible,true);actor.setPose({carrying:true,offering:true});assert.equal(actor.ambientKind,null);actor.animate(720,{reducedMotion:true});assert.equal(actor.ambientCup.visible,false);assert.equal(actor.document.visible,true);assert.equal(actor.setAmbient('wave'),false);
    actor.setPose({carrying:false,offering:false});actor.animate(800,{reducedMotion:true});actor.setAmbient('look');actor.setGreeting(true);assert.equal(actor.ambientKind,null);assert.equal(actor.setAmbient('nod'),false);actor.setGreeting(false);actor.animate(900,{reducedMotion:true});actor.setAmbient('look');actor.animate(1000,{reducedMotion:true});assert.equal(actor.ambientKind,null);assert.equal(actor.isAnimating,false);
  }finally{assets.dispose();}
});

test('3D ambience wakes only for a finite idle burst and stops immediately for a business task or hidden page',()=>{
  const events=[],f=mountedSceneFixture({onDelivery:event=>events.push(event),onSelectNode:id=>events.push(id)},{ambientEnabled:true});try{f.frame();assert.equal(f.pending.size,0);assert.equal(f.timers.size,1,'one future timeout does not keep the render loop awake');const initial=f.api.getPerformanceStats();
    for(let i=0;i<50&&!f.api.getPerformanceStats().ambientActive;i++)f.frame();assert.ok(f.api.getPerformanceStats().ambientActive);f.frame();assert.ok(f.pending.size>0);assert.ok(f.api.getPerformanceStats().instanceUploads>initial.instanceUploads);
    f.api.update({runStatus:'running',agents:[{id:'zhang',status:'working'}]});assert.equal(f.api.getPerformanceStats().ambientActive,null);assert.equal(f.timers.size,0,'blocked business state has no idle polling timeout');f.drain();assert.equal(f.pending.size,0);assert.deepEqual(events,[]);
    f.api.update({runStatus:'completed',agents:[]});f.frame();assert.equal(f.timers.size,1);for(let i=0;i<50&&!f.api.getPerformanceStats().ambientActive;i++)f.frame();assert.ok(f.api.getPerformanceStats().ambientActive);
    f.document.hidden=true;f.document.emit('visibilitychange');assert.equal(f.api.getPerformanceStats().ambientActive,null);assert.equal(f.timers.size,0);assert.equal(f.pending.size,0);f.document.hidden=false;f.document.emit('visibilitychange');f.frame();assert.equal(f.timers.size,1);f.preference.listeners.get('change')({matches:true});f.frame();assert.equal(f.timers.size,0);assert.equal(f.api.getPerformanceStats().ambientActive,null);assert.equal(f.pending.size,0);assert.deepEqual(events,[]);
  }finally{f.restore();}
});


test('3D home shows only shared overview posts while one selected team can reveal all 41 workplaces',()=>{
  const assets=createOffice3DAssets();try{const layout=createOffice3DLayout(assets),team=OFFICE_ROOMS.find(room=>room.id==='ai_data').teamZones[0],hiddenStaff=team.seats.find(seat=>!seat.overviewVisible),head=team.seats[0];
    assert.deepEqual([...layout.visibleSeatIds].sort(),OFFICE_OVERVIEW_SEATS.map(seat=>seat.id).sort());assert.equal(layout.isSeatVisible(hiddenStaff.id),false);assert.equal(layout.seatGeometry(head.id).scale,.58);assert.equal(layout.statistics.people,250);assert.equal(layout.statistics.workplaces,251);
    assert.equal(layout.setDetailGroups([team.id]),true);assert.equal(layout.detailGroupIds.length,1);for(const seat of team.seats){assert.equal(layout.isSeatVisible(seat.id),true);assert.equal(layout.seatGeometry(seat.id).scale,.24);}assert.equal(layout.visibleSeatIds.size,OFFICE_OVERVIEW_SEATS.length-team.overviewSeatIds.length+41);assert.equal(layout.setDetailGroups([team.id]),false,'unchanged camera frames do not upload overview instances');
    assert.equal(layout.setDetailGroups([]),true);assert.equal(layout.isSeatVisible(hiddenStaff.id),false);assert.equal(layout.seatGeometry(head.id).scale,.58);
  }finally{assets.dispose();}
});

test('AI department navigation retains its representative view and team detail never expands the entire roster',()=>{
  const f=mountedSceneFixture();try{f.frame();assert.equal(f.api.getPerformanceStats().visibleWorkplaces,OFFICE_OVERVIEW_SEATS.length);assert.deepEqual(f.api.getPerformanceStats().detailGroups,[]);const team=OFFICE_ROOMS.find(room=>room.id==='ai_data').teamZones[0],hiddenStaff=team.seats.find(seat=>!seat.overviewVisible);assert.equal(f.api.getPostAnchor(hiddenStaff.id).visible,false);
    f.api.focusNode('ai_data');f.drain();assert.deepEqual(f.api.getPerformanceStats().detailGroups,[],'viewing the AI department does not show a dense roster');f.button('team',team.id).emit('click',{detail:0});f.drain();assert.deepEqual(f.api.getPerformanceStats().detailGroups,[team.id]);assert.equal(f.api.getPostAnchor(hiddenStaff.id).visible,true);assert.ok(f.api.getPerformanceStats().visibleWorkplaces<100);assert.ok(f.api.getPerformanceStats().scale>3.2,'the compact team can be inspected beyond ordinary overview magnification');
    f.api.resetView();f.drain();assert.equal(f.api.getPostAnchor(hiddenStaff.id).visible,false);assert.deepEqual(f.api.getPerformanceStats().detailGroups,[]);assert.equal(f.api.getPerformanceStats().visibleWorkplaces,OFFICE_OVERVIEW_SEATS.length);assert.equal(f.pending.size,0);
  }finally{f.restore();}
});


test('department and team hover show authoritative role counts without inferred business or online status',()=>{
  const f=mountedSceneFixture();try{f.frame();const tooltip=f.postTooltip();f.room('general_office').emit('pointerenter');assert.equal(tooltip.children[0].textContent,'总经办');assert.equal(tooltip.children[1].textContent,'1 董事长 · 1 经理');assert.equal(tooltip.dataset.department,'general_office');f.room('general_office').emit('pointerleave');assert.equal(tooltip.hidden,true);
    f.room('ai_data').emit('focus');assert.equal(tooltip.children[1].textContent,'1 经理 · 5 部长 · 200 员工');f.room('ai_data').emit('blur');assert.equal(tooltip.hidden,true);const team=OFFICE_ROOMS.find(room=>room.id==='ai_data').teamZones[0];f.button('team',team.id).emit('pointerenter');assert.equal(tooltip.children[0].textContent,'AI数据算法部 · 第1部');assert.equal(tooltip.children[1].textContent,'1 部长 · 40 员工');assert.doesNotMatch(tooltip.children.map(child=>child.textContent).join(' '),/待命|在线|处理中/);assert.equal(f.pending.size,0);
  }finally{f.restore();}
});

test('narrow 3D overview labels use short names while focus and wide displays retain full accessible titles',()=>{
  const f=mountedSceneFixture({}, {width:405,height:724});try{f.frame();const hr=f.room('hr_admin'),publicAffairs=f.room('public_affairs'),team=f.button('team','ai_data_team_1');assert.equal(hr.firstChild.textContent,'人事行政');assert.equal(publicAffairs.firstChild.textContent,'公共事务');assert.equal(hr.firstChild.style.fontSize,'11px');assert.equal(team.firstChild.textContent,'第1部');assert.match(hr.attributes['aria-label'],/人力资源与行政管理部/);assert.equal(hr.attributes.title,'人力资源与行政管理部');assert.match(team.attributes['aria-label'],/40/);const baseline=f.api.getPerformanceStats();
    f.api.focusNode('hr_admin');f.drain();assert.equal(hr.firstChild.textContent,'人力资源与行政管理部');assert.equal(hr.firstChild.style.fontSize,'14px');assert.equal(team.firstChild.textContent,'第1部 · 40 人');f.api.resetView();f.drain();assert.equal(hr.firstChild.textContent,'人事行政');assert.equal(f.api.getPerformanceStats().azimuth,baseline.azimuth);
    f.resize(1440,900);f.drain();assert.equal(hr.firstChild.textContent,'人力资源与行政管理部');assert.equal(publicAffairs.firstChild.textContent,'公共事务关系部');assert.equal(team.firstChild.textContent,'第1部 · 40 人');assert.equal(hr.firstChild.style.fontSize,'14px');assert.equal(f.pending.size,0);
  }finally{f.restore();}
});


test('the public information wall has one readable action and a physical pick target under native zoom',()=>{
  for(const visualScale of[1,2,3]){const selected=[],f=mountedSceneFixture({onSelectNode:id=>selected.push(id)},{visualScale,offsetLeft:81,offsetTop:37});try{f.frame();const button=f.button('node','bulletin');assert.ok(button);assert.equal(button.firstChild.textContent,'信息公开栏');assert.equal(button.hidden,false);assert.equal(button.attributes['aria-label'],'信息公开栏');const at=f.api.getNodeAnchor('bulletin');assert.ok(at.visible);const point=f.client(at.x,at.y);f.canvas.emit('pointerdown',point);f.canvas.emit('pointerup',point);f.drain();assert.deepEqual(selected,['bulletin']);assert.equal(f.api.getPerformanceStats().organizationPeople,250);assert.equal(f.api.getPerformanceStats().workplaces,251);
    f.api.setTopology(false);f.frame();assert.equal(button.hidden,false,'announcements remain accessible when network lines are off');button.emit('click',{detail:0});assert.deepEqual(selected,['bulletin','bulletin']);f.api.focusNode('bulletin');f.drain();assert.ok(f.api.getPerformanceStats().scale>1);f.api.resetView();f.drain();assert.equal(f.api.getPerformanceStats().scale,1);assert.equal(f.pending.size,0);
  }finally{f.restore();}}
});


test('the courtyard convenience store is scenery with a readable label and no retail business action',()=>{
  const selected=[],f=mountedSceneFixture({onSelectNode:id=>selected.push(id)},{width:405,height:724});try{f.frame();const label=f.area('convenience');assert.ok(label);assert.equal(label.firstChild.textContent,'无人便利店');assert.equal(label.attributes.role,'img');assert.equal(label.firstChild.style.fontSize,'11px');assert.equal(f.button('node','convenience'),undefined);assert.equal(NODE_META.convenience,undefined);label.emit('pointerenter');assert.equal(label.firstChild.style.color,'var(--office-ui-accent)');label.emit('pointerleave');assert.equal(label.firstChild.style.color,'');label.emit('click',{detail:0});assert.deepEqual(selected,[]);assert.equal(f.api.getPerformanceStats().organizationPeople,250);assert.equal(f.api.getPerformanceStats().workplaces,251);assert.equal(f.pending.size,0);
    f.resize(1440,900);f.drain();assert.equal(label.firstChild.style.fontSize,'14px');assert.equal(label.attributes['aria-label'],OFFICE_CONVENIENCE_AREA.title);
  }finally{f.restore();}
});
