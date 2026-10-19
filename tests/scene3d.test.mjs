import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../dist/vendor/three.module.js';
import { NODE_META } from '../dist/scene.js';
import { HUMAN_EMPLOYEES } from '../dist/people.js';
import { OFFICE3D_ROOMS, AGENT3D_HOMES, OFFICE3D_COLORS, createOffice3DAssets, createOffice3DLayout } from '../dist/scene3d-layout.js';
import { actorIdentity, createOffice3DActor, facingForHeading } from '../dist/scene3d-actors.js';
import { office3DFrustum, Scene3DUnavailableError, OFFICE3D_LINKS, scene3DFramePolicy, OFFICE3D_CAMERA_OFFSET } from '../dist/scene3d.js';
import { createScene3DMotion, desired3DPositions } from '../dist/scene3d-motion.js';

test('3D adds eight furnished rooms and preserves every selectable 2D endpoint',()=>{
  const assets=createOffice3DAssets();try{const layout=createOffice3DLayout(assets);assert.equal(layout.statistics.rooms,8);assert.equal(OFFICE3D_ROOMS.find(r=>r.id==='investment').title,'投资者关系部');assert.ok(OFFICE3D_ROOMS.find(r=>r.id==='general_office').x>OFFICE3D_ROOMS.find(r=>r.id==='investment').x);assert.deepEqual([...layout.statusLights.keys()].sort(),Object.keys(NODE_META).sort());assert.ok(layout.statistics.desks>=14);assert.equal(layout.statistics.racks,2);assert.ok(layout.statistics.plants>=10);assert.ok(layout.statistics.staticInstances>1500);assert.ok(layout.root.children.filter(child=>child.isInstancedMesh).length<150,'static fittings share instance batches');for(const instance of layout.root.children.filter(child=>child.isInstancedMesh)){const matrix=new THREE.Matrix4();for(let i=0;i<instance.count;i++){instance.getMatrixAt(i,matrix);assert.ok(matrix.elements.every(Number.isFinite));}}}finally{assets.dispose();}
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
