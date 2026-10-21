import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../src/vendor/three.module.js';
import { NODE_META } from '../src/scene.js';
import { HUMAN_EMPLOYEES } from '../src/people.js';
import { OFFICE3D_ROOMS, AGENT3D_HOMES, OFFICE3D_COLORS, createOffice3DAssets, createOffice3DLayout } from '../src/scene3d-layout.js';
import { actorIdentity, createOffice3DActor, facingForHeading } from '../src/scene3d-actors.js';
import { office3DFrustum, Scene3DUnavailableError, OFFICE3D_LINKS, scene3DFramePolicy, OFFICE3D_CAMERA_OFFSET, scene3DPixelRatio, scene3DGestureMode, mountScene3D } from '../src/scene3d.js';
import { createScene3DMotion, desired3DPositions } from '../src/scene3d-motion.js';

test('3D adds eight furnished rooms and preserves every selectable 2D endpoint',()=>{
  const assets=createOffice3DAssets();try{const layout=createOffice3DLayout(assets);assert.equal(layout.statistics.rooms,8);assert.equal(OFFICE3D_ROOMS.find(r=>r.id==='investment').title,'投资者关系部');assert.ok(OFFICE3D_ROOMS.find(r=>r.id==='general_office').x>OFFICE3D_ROOMS.find(r=>r.id==='investment').x);assert.deepEqual([...layout.statusLights.keys()].sort(),Object.keys(NODE_META).sort());assert.ok(layout.statistics.desks>=14);assert.equal(layout.statistics.racks,2);assert.ok(layout.statistics.plants>=10);assert.ok(layout.statistics.staticInstances>1500);assert.ok(layout.root.children.filter(child=>child.isInstancedMesh).length<150,'static fittings share instance batches');for(const instance of layout.root.children.filter(child=>child.isInstancedMesh)){assert.equal(instance.instanceColor?.count,instance.count);const matrix=new THREE.Matrix4();for(let i=0;i<instance.count;i++){instance.getMatrixAt(i,matrix);assert.ok(matrix.elements.every(Number.isFinite));}}}finally{assets.dispose();}
});

test('room floors and identities use opaque materials without shadows or light effects',()=>{
  const assets=createOffice3DAssets();try{const layout=createOffice3DLayout(assets),virtual=createOffice3DActor(assets,{id:'zhang',hair:'#514333'},{virtual:true}),human=createOffice3DActor(assets,HUMAN_EMPLOYEES[0]);for(const root of[layout.root,virtual.root,human.root])root.traverse(mesh=>{assert.equal(mesh.castShadow,false);assert.equal(mesh.receiveShadow,false);if(mesh.material){assert.equal(mesh.material.transparent,false);assert.equal(mesh.material.opacity,1);assert.ok(!mesh.material.emissive||mesh.material.emissive.getHex()===0);}});assert.equal(virtual.identity.badge,'chip');assert.equal(human.identity.badge,'lanyard');assert.notEqual(virtual.identity.uniform,human.identity.uniform);assert.equal(actorIdentity({color:'#bb9988'},{virtual:false}).uniform,'#bb9988');assert.equal(OFFICE3D_COLORS.copper,'#b85a43');}finally{assets.dispose();}
});

test('seated staff bend at the knee, keep feet near the floor and reach the keyboard',()=>{
  const assets=createOffice3DAssets();try{const actor=createOffice3DActor(assets,{id:'seated-proof'},{virtual:true});actor.setPose({seated:true,working:true});actor.animate(0,{reducedMotion:true});assert.equal(actor.legs.left.thigh.rotation.x,-Math.PI/2);assert.equal(actor.legs.left.shin.rotation.x,Math.PI/2);assert.ok(actor.arms.left.upper.rotation.x<-.7);actor.root.updateMatrixWorld(true);const shoe=actor.legs.left.shin.children.find(child=>child.material.color.getHexString()==='34443c');const p=new THREE.Vector3();shoe.getWorldPosition(p);assert.ok(p.y>0&&p.y<7,`feet y ${p.y}`);actor.setPose({seated:false,walking:true,stride:14,heading:'right',carrying:true});actor.animate(100,{reducedMotion:true});assert.equal(actor.document.visible,true);assert.ok(actor.legs.left.thigh.rotation.x!==actor.legs.right.thigh.rotation.x);assert.equal(actor.root.rotation.y,Math.PI/2);assert.equal(facingForHeading('up'),Math.PI);}finally{assets.dispose();}
});

test('orthographic fitting covers desktop, tablet and narrow viewports without invalid frusta',()=>{
  for(const aspect of[.35,.65,1,1.6,2.5,4]){const f=office3DFrustum(aspect);assert.ok(f.width>0&&f.height>0);assert.ok(Math.abs(f.width/f.height-aspect)<.0001);assert.ok(Math.abs(f.direction.length()-1)<.0001);assert.ok(Math.abs(f.up.dot(f.right))<.0001);}
  const error=new Scene3DUnavailableError('unavailable');assert.equal(error.code,'WEBGL_UNAVAILABLE');assert.ok(error instanceof Error);
  for(const [a,b]of OFFICE3D_LINKS){assert.ok(NODE_META[a]);assert.ok(NODE_META[b]);}
});

test('management reviewer visits a free position without occupying the assistant or owner seat',()=>{
  const positions=desired3DPositions([{id:'invest_risk',status:'working',nodeId:'general_office'},{id:'boss',status:'working',nodeId:'general_office'}]);assert.deepEqual(positions.get('invest_risk'),{x:670,y:87});assert.deepEqual(positions.get('boss'),{x:584,y:87});assert.equal(new Set([positions.get('invest_risk').x,positions.get('boss').x,HUMAN_EMPLOYEES[0].x]).size,3);assert.deepEqual(desired3DPositions([{id:'zhang',status:'working',nodeId:'server'}],{halted:true}).get('zhang'),{x:464,y:350});
});
function motionFixture(){let time=0;const delivered=[];const makeActor=meta=>({point:{x:meta.x,y:meta.y},root:{rotation:{y:0}},pose:{},setPose(patch){Object.assign(this.pose,patch);},setPosition(point){this.point={x:point.x,y:point.y};},facePoint(){}});const agents=new Map(Object.entries(AGENT3D_HOMES).map(([id,meta])=>[id,makeActor(meta)])),humans=new Map(HUMAN_EMPLOYEES.map(h=>[h.id,makeActor(h)]));const motion=createScene3DMotion({agents,humans,now:()=>time,onDelivery:event=>delivered.push(event.id)});return{motion,agents,humans,delivered,tick(ms){time+=ms;motion.tick(time);},drain(){for(let i=0;i<800&&(motion.activeCount||motion.pendingCount||motion.walks.size);i++){time+=100;motion.tick(time);}assert.equal(motion.activeCount,0);assert.equal(motion.pendingCount,0);}};}

test('opening a historical snapshot does not reenact handoffs; fresh receipts happen exactly once',()=>{
  const f=motionFixture(),old={id:'old',type:'handoff',agentId:'zhang',targetAgentId:'liu'},fresh={id:'new',type:'handoff',agentId:'liu',targetAgentId:'lead'};
  f.motion.update({runId:'history',animateEvents:false,logs:[old]});assert.equal(f.motion.activeCount,0);f.motion.update({runId:'history',animateEvents:true,logs:[old,fresh]});assert.equal(f.motion.activeCount,1);f.drain();assert.deepEqual(f.delivered,['new']);f.motion.update({runId:'history',animateEvents:true,logs:[old,fresh]});f.drain();assert.deepEqual(f.delivered,['new']);f.motion.destroy();
});

test('cross-employee handoffs serialize their participants and never approve a human workflow',()=>{
  const f=motionFixture(),events=[{id:'a',type:'handoff',agentId:'zhang',targetAgentId:'liu'},{id:'b',type:'handoff',agentId:'liu',targetAgentId:'zhang'},{id:'approval',type:'handoff',agentId:'boss',targetHumanId:'owner',deliveryKind:'approval_request'}];f.motion.update({runId:'live',animateEvents:true,logs:events,humanApproval:true});assert.equal(f.motion.activeCount,2);assert.equal(f.motion.pendingCount,1);assert.ok(f.motion.queue.locked('owner'));f.drain();assert.equal(f.delivered.length,3);assert.equal(new Set(f.delivered).size,3);assert.ok(f.delivered.includes('approval'));assert.equal(f.humans.get('owner').pose.seated,true);assert.ok(!('approved'in f.humans.get('owner').pose));f.motion.destroy();
});

test('switching or cancelling a run clears obsolete movement and transfer callbacks',()=>{
  for(const terminal of['cancelled','failed']){const f=motionFixture(),event={id:'obsolete',type:'handoff',agentId:'zhang',targetAgentId:'liu'};f.motion.update({runId:'one',animateEvents:true,logs:[event]});assert.equal(f.motion.activeCount,1);f.motion.update({runId:'one',runStatus:terminal,animateEvents:true,logs:[event]});f.tick(30000);assert.deepEqual(f.delivered,[]);assert.equal(f.motion.activeCount,0);assert.equal(f.motion.walks.size,0);f.motion.update({runId:'two',animateEvents:false,logs:[event]});f.tick(30000);assert.deepEqual(f.delivered,[]);f.motion.destroy();}
});

test('runtime reduced motion settles current walks while retaining actual receipt ordering',()=>{
  const f=motionFixture(),event={id:'actual',type:'handoff',sourceHumanId:'it_owner',targetAgentId:'zhang',agentId:'zhang'};f.motion.update({runId:'motion',animateEvents:true,logs:[event]});f.tick(500);assert.ok(f.motion.walks.size);f.motion.setReducedMotion(true);assert.equal(f.motion.walks.size,0);assert.equal(f.motion.activeCount,1);f.tick(1);assert.deepEqual(f.delivered,['actual']);f.tick(1600);assert.equal(f.motion.activeCount,0);assert.deepEqual(f.delivered,['actual']);f.motion.destroy();
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
    for(const x of[20,1035])for(const y of[0,100])for(const z of[-7,625]){
      const corner=new THREE.Vector3(x-527.5,y-35,z-309);assert.ok(Math.abs(corner.dot(f.right))<=f.width/2);assert.ok(Math.abs(corner.dot(f.up))<=f.height/2);
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
    for(const x of[20,1035])for(const y of[-12,100])for(const z of[-7,625]){const point=new THREE.Vector3(x-527.5,y-35,z-309);maxX=Math.max(maxX,Math.abs(point.dot(f.right)-f.centerX));maxY=Math.max(maxY,Math.abs(point.dot(f.up)-f.centerY));}
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
  const saved=new Map(['document','ResizeObserver','requestAnimationFrame','cancelAnimationFrame','setTimeout','clearTimeout','matchMedia','devicePixelRatio'].map(key=>[key,globalThis[key]]));let clock=1000,sequence=0,size={width:options.width||1440,height:options.height||900};
  const pending=new Map(),timers=new Map(),resizers=new Set(),media=new Map(),query=matches=>({matches,listeners:new Map(),addEventListener(type,fn){this.listeners.set(type,fn);},removeEventListener(type){this.listeners.delete(type);}}),preference=query(!!options.reducedMotion);class Element{
    constructor(tag='div'){this.tagName=tag;this.children=[];this.style={};this.dataset={};this.attributes={};this.handlers=new Map();this.listenerOptions=new Map();this.hidden=false;this.parentNode=null;this.captured=new Set();this.animations=[];this.classList={add(){},remove(){}};}
    append(...children){for(const child of children){child.parentNode=this;this.children.push(child);}}get firstChild(){return this.children[0];}
    setAttribute(key,value){this.attributes[key]=value;}removeAttribute(key){delete this.attributes[key];}addEventListener(key,fn,options){this.handlers.set(key,fn);this.listenerOptions.set(key,options);}removeEventListener(key){this.handlers.delete(key);this.listenerOptions.delete(key);}
    contains(element){return element===this||this.children.some(child=>child.contains?.(element));}
    closest(selector){for(let el=this;el;el=el.parentNode){const tag=el.tagName?.toLowerCase();if(selector.includes('input')&&['input','textarea','select'].includes(tag)||selector.includes('[contenteditable]')&&el.isContentEditable||selector.includes('dialog')&&(tag==='dialog'||el.attributes.role==='dialog')||selector.includes('.erp-layer')&&el.className==='erp-layer'||['agent','human','employee','node'].some(type=>selector.includes('[data-'+type+']')&&el.dataset[type]))return el;}return null;}
    getBoundingClientRect(){return {x:0,y:0,left:0,top:0,...size};}remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(child=>child!==this);}
    setPointerCapture(id){this.captured.add(id);}hasPointerCapture(id){return this.captured.has(id);}releasePointerCapture(id){this.captured.delete(id);}
    animate(frames,settings){const animation={frames,settings,cancel(){this.cancelled=true;}};this.animations.push(animation);return animation;}focus(){}
    emit(type,value={}){const event={defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;},target:this,button:0,pointerId:1,pointerType:'mouse',...value};for(let element=this;element;element=element.parentNode){element.handlers.get(type)?.(event);if(event.stopped||!['wheel','gesturestart','gesturechange','gestureend'].includes(type))break;}return event;}
  }
  const doc=new Element();doc.hidden=false;doc.createElement=tag=>new Element(tag);globalThis.document=doc;globalThis.ResizeObserver=class{constructor(fn){this.fn=fn;}observe(){resizers.add(this.fn);}disconnect(){resizers.delete(this.fn);}};
  globalThis.requestAnimationFrame=fn=>{const id=++sequence;pending.set(id,fn);return id;};globalThis.cancelAnimationFrame=id=>pending.delete(id);globalThis.setTimeout=(fn,delay)=>{const id=++sequence;timers.set(id,{fn,due:clock+delay});return id;};globalThis.clearTimeout=id=>timers.delete(id);globalThis.devicePixelRatio=options.deviceRatio??1;globalThis.matchMedia=selector=>{if(selector.includes('prefers-reduced-motion'))return preference;if(!media.has(selector))media.set(selector,query(true));return media.get(selector);};
  const canvas=new Element('canvas'),allocations=[],renderer={domElement:canvas,shadowMap:{},capabilities:{maxTextureSize:options.maxBufferDimension||16384},info:{render:{calls:0,triangles:0}},setDrawingBufferSize(width,height,ratio){allocations.push({width,height,ratio});canvas.width=Math.floor(width*ratio);canvas.height=Math.floor(height*ratio);},render(scene){let calls=0;const visit=(item,visible=true)=>{visible=visible&&item.visible;if(!visible)return;if(item.isMesh&&item.material?.visible!==false)calls++;for(const child of item.children)visit(child,visible);};visit(scene);this.info.render.calls=calls;},dispose(){},forceContextLoss(){}};
  const container=new Element(),api=mountScene3D(container,{...callbacks,rendererFactory:()=>renderer});
  return{api,canvas,pending,timers,container,wrapper:container.children[0],preference,media,allocations,document:doc,resize(width,height){size={width,height};for(const fn of resizers)fn();},density(ratio){const previous=media.get(`(resolution: ${globalThis.devicePixelRatio}dppx)`);globalThis.devicePixelRatio=ratio;previous?.listeners.get('change')?.({matches:false});},greeting(){const find=el=>el.className==='office3d-greeting'?el:el.children.map(find).find(Boolean);return find(container);},button(type,id){const visit=el=>el.tagName==='button'&&el.dataset[type]===id?el:el.children.map(visit).find(Boolean);return visit(container);},frame(){const callbacks=[...pending.values()];pending.clear();clock+=34;callbacks.forEach(fn=>fn(clock));for(const [id,timer]of [...timers])if(timer.due<=clock){timers.delete(id);timer.fn();}},drain(){for(let i=0;i<1000&&(pending.size||timers.size);i++)this.frame();assert.equal(pending.size,0,'presentation animations stop after reaching their endpoint');assert.equal(timers.size,0);},restore(){api.destroy();for(const [key,value]of saved)if(value===undefined)delete globalThis[key];else globalThis[key]=value;}};
}

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
    for(const label of[person,room]){const event=label.emit('wheel',{deltaY:-40,deltaMode:0,ctrlKey:true});assert.equal(event.defaultPrevented,true);}f.drain();assert.ok(f.api.getPerformanceStats().scale>initial.scale);assert.deepEqual(selected,[]);
    const before=f.api.getPerformanceStats();for(const name of['gesturestart','gesturechange','gestureend'])assert.equal(f.wrapper.listenerOptions.get(name).passive,false);
    assert.equal(person.emit('gesturestart',{scale:1,rotation:0}).defaultPrevented,true);assert.equal(person.emit('gesturechange',{scale:1.25,rotation:20}).defaultPrevented,true);f.drain();const changed=f.api.getPerformanceStats();assert.ok(Math.abs(changed.scale-before.scale*1.25)<1e-8);assert.ok(Math.abs(changed.azimuth-before.azimuth+20*Math.PI/180)<1e-8);assert.equal(person.emit('gestureend').defaultPrevented,true);f.drain();assert.equal(f.pending.size,0);assert.deepEqual(selected,[]);
    const outside=f.document.createElement('button');assert.equal(outside.emit('wheel',{deltaY:-40,ctrlKey:true}).defaultPrevented,false,'business UI and browser shortcuts outside the scene keep their native behavior');
  }finally{f.restore();}
});

test('Safari gesture events cannot double-apply a two-pointer pinch',()=>{
  const f=mountedSceneFixture();try{f.frame();f.canvas.emit('pointerdown',{pointerType:'touch',pointerId:1,clientX:400,clientY:400});f.canvas.emit('pointerdown',{pointerType:'touch',pointerId:2,clientX:600,clientY:400});f.wrapper.emit('gesturestart',{scale:1,rotation:0});f.canvas.emit('pointermove',{pointerType:'touch',pointerId:2,clientX:700,clientY:400});const before=f.api.getPerformanceStats();assert.equal(f.wrapper.emit('gesturechange',{scale:1.5,rotation:0}).defaultPrevented,true);assert.equal(f.api.getPerformanceStats().scale,before.scale);f.canvas.emit('pointerup',{pointerType:'touch',pointerId:2,clientX:700,clientY:400});f.canvas.emit('pointerup',{pointerType:'touch',pointerId:1,clientX:400,clientY:400});f.wrapper.emit('gestureend');f.drain();assert.equal(f.pending.size,0);}finally{f.restore();}
});

test('the mounted office stops rendering at rest and returns to idle after pointer rotation',()=>{
  const f=mountedSceneFixture();try{f.frame();assert.equal(f.pending.size,0);const initial=f.api.getPerformanceStats();assert.equal(initial.renders,1);assert.ok(initial.drawCalls<100,JSON.stringify(initial));
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
