import test from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_EMPLOYEES, humanForScenario } from '../src/people.js';
import { FLOOR_SEGMENTS, routeBetweenPoints, routeLength, pointAlongRoute, walkingDuration, walkingSample, handoffTiming, deliveryParticipants, createDeliveryQueue, motionUpdatePolicy, createViewTween } from '../src/scene-motion.js';

test('view interpolation eases from the displayed position, accumulates targets and terminates exactly',()=>{
 let value={scale:1,x:0},starts=0;const tween=createViewTween({read:()=>({...value}),write:next=>{value=next;},onStart:()=>starts++,duration:400});
 tween.start({scale:2,x:100});assert.deepEqual(value,{scale:1,x:0});tween.tick(1000);tween.tick(1100);assert.ok(value.x>25&&value.x<100);const visible={...value};tween.start({scale:tween.target.scale+.5});assert.equal(value.x,visible.x);tween.tick(1200);tween.tick(1600);assert.equal(value.scale,2.5);assert.equal(value.x,visible.x);assert.equal(tween.active,false);assert.equal(tween.tick(3000),false);
 tween.start({x:200});tween.tick(3000);tween.shiftTime(1000);tween.tick(4000);assert.equal(value.x,visible.x);tween.finish();assert.equal(value.x,200);assert.equal(tween.active,false);tween.start({x:300},{immediate:true});assert.equal(value.x,300);assert.equal(tween.active,false);tween.start({x:400});tween.cancel();tween.tick(9000);assert.equal(value.x,300);assert.ok(starts>=4);
});

test('a continuous wheel stream keeps moving rather than restarting at zero on every frame',()=>{
 let value={scale:1};const tween=createViewTween({read:()=>({...value}),write:next=>{value=next;}});tween.start({scale:1.2});tween.tick(1000);
 for(let i=1;i<=12;i++){const before=value.scale;tween.start({scale:tween.target.scale+.05});tween.tick(1000+i*16);assert.ok(value.scale>before,'retargeting continues from the last sampled clock');}
 tween.tick(1700);assert.equal(tween.active,false);assert.ok(Math.abs(value.scale-1.8)<1e-8);
});

test('seven explicit human representatives cover each scenario without virtual badges',()=>{
  assert.equal(HUMAN_EMPLOYEES.length,7);
  assert.equal(new Set(HUMAN_EMPLOYEES.map(h=>h.id)).size,7);
  const expected={onboarding:'hr_owner',finance:'finance_owner',procurement:'purchasing_owner',ddos:'it_owner',database:'it_owner',delivery:'business_owner',investment:'investment_owner'};
  for(const [scenario,id] of Object.entries(expected)) assert.equal(humanForScenario(scenario).id,id);
  assert.equal(humanForScenario('unknown').id,'owner');
  for(const human of HUMAN_EMPLOYEES) assert.ok(human.role&&human.responsibility&&human.nodeId);
});

test('investment annex walks through both visible doors and the outside corridor',()=>{
  const route=routeBetweenPoints({x:153,y:87},{x:909,y:315});
  assert.deepEqual(route[0],{x:153,y:87});
  assert.deepEqual(route.at(-1),{x:909,y:315});
  assert.ok(route.some(p=>p.x===82&&p.y===107),'annex bottom door');
  assert.ok(route.some(p=>p.x===32&&p.y===411),'outside corridor');
  assert.ok(route.some(p=>p.x===827&&p.y===411),'office entry from the hall');
  // No shortcut through the annex/main-building walls.
  assert.ok(routeLength(route)>1300);
  for(let i=1;i<route.length;i++) assert.ok(route[i].x===route[i-1].x||route[i].y===route[i-1].y);
});

test('every human is connected to the network-room aisle',()=>{
  for(const human of HUMAN_EMPLOYEES) {
    const route=routeBetweenPoints({x:650,y:286},human);
    assert.deepEqual(route.at(-1),{x:human.x,y:human.y},human.id);
    assert.ok(routeLength(route)>0);
  }
});

test('walking to core goes around the switch instead of through it',()=>{
  const route=routeBetweenPoints({x:650,y:286},{x:650,y:345});
  assert.ok(route.some(p=>p.x===590&&p.y===345));
  assert.ok(routeLength(route)>150);
  for(let progress=0;progress<=1;progress+=.02) {
    const p=pointAlongRoute(route,progress);
    assert.ok(!(p.x>609&&p.x<685&&p.y>300&&p.y<330),'switch remains an obstacle');
  }
});

test('in-flight points remain on the floor and resume without teleportation',()=>{
  const route=routeBetweenPoints({x:153,y:87},{x:909,y:315});
  const current=pointAlongRoute(route,.43);
  const resumed=routeBetweenPoints(current,{x:757,y:390});
  assert.ok(Math.hypot(resumed[0].x-current.x,resumed[0].y-current.y)<.000001);
  assert.equal(routeLength(routeBetweenPoints(current,current)),0);
  const backwards=pointAlongRoute([{x:50,y:20},{x:10,y:20}],.5);
  assert.deepEqual(backwards,{x:30,y:20,facing:-1});
  assert.deepEqual(pointAlongRoute([],.5),{x:0,y:0,facing:1});
});

test('first history snapshot is baselined; duplicate updates do not replay',()=>{
  const queue=createDeliveryQueue();
  const old={id:'old',type:'handoff',agentId:'zhang',targetAgentId:'liu'};
  const fresh={id:'fresh',type:'handoff',agentId:'liu',targetAgentId:'lead'};
  queue.ingest([old],{animate:false});
  queue.ingest([old,fresh],{animate:true});
  assert.deepEqual(queue.startReady().map(e=>e.id),['fresh']);
  queue.finish('fresh');queue.ingest([old,fresh]);
  assert.equal(queue.startReady().length,0);
});

test('a brand-new run can animate its first real human input event',()=>{
  const event={id:'intake',type:'handoff',agentId:'zhang',sourceHumanId:'it_owner',targetAgentId:'zhang'};
  assert.deepEqual(deliveryParticipants(event),{mover:'zhang',recipient:'it_owner',recipientHuman:true,collecting:true});
  const queue=createDeliveryQueue();queue.ingest([event],{animate:true});
  assert.equal(queue.startReady()[0].id,'intake');
  assert.ok(queue.locked('it_owner')&&queue.locked('zhang'));
});

test('cross handoffs and multiple sources serialize without deadlocks or losing locks',()=>{
  const queue=createDeliveryQueue();
  const events=[
    {id:'a',type:'handoff',agentId:'zhang',targetAgentId:'liu'},
    {id:'b',type:'handoff',agentId:'liu',targetAgentId:'zhang'},
    {id:'c',type:'handoff',agentId:'lead',targetAgentId:'liu'},
    {id:'d',type:'handoff',agentId:'finance',targetHumanId:'finance_owner'},
  ];
  queue.ingest(events);
  assert.deepEqual(queue.startReady().map(e=>e.id),['a','d']);
  queue.finish('a');
  assert.ok(queue.locked('finance_owner'),'finishing a different exchange retains its lock');
  assert.deepEqual(queue.startReady().map(e=>e.id),['b']);
  queue.finish('b');assert.deepEqual(queue.startReady().map(e=>e.id),['c']);
  queue.finish('c');queue.finish('d');assert.equal(queue.activeCount,0);assert.equal(queue.pendingCount,0);
});

test('approval delivery is prioritised, and switching runs cancels pending and active deliveries',()=>{
  const queue=createDeliveryQueue();
  queue.ingest([
    {id:'evidence',type:'handoff',agentId:'lead',targetAgentId:'liu'},
    {id:'approval',type:'handoff',agentId:'lead',targetHumanId:'owner',deliveryKind:'approval_request',approvalId:'real-approval'},
  ]);
  assert.equal(queue.startReady()[0].id,'approval');
  assert.equal(queue.pendingCount,1);
  queue.clear();assert.equal(queue.activeCount,0);assert.equal(queue.pendingCount,0);assert.equal(queue.locked('lead'),false);
  queue.finish('approval');assert.equal(queue.locked('owner'),false);
  queue.ingest([{id:'new',type:'handoff',sourceHumanId:'owner',targetAgentId:'lead',deliveryKind:'approval_decision'}]);
  assert.equal(queue.startReady()[0].id,'new');
});

test('floor graph segments are finite axis-aligned paths',()=>{
  for(const [a,b] of FLOOR_SEGMENTS) {
    assert.ok(a.every(Number.isFinite)&&b.every(Number.isFinite));
    assert.ok(a[0]===b[0]||a[1]===b[1]);assert.notDeepEqual(a,b);
  }
});

test('general office connects through its own door and outside corridor without crossing office walls',()=>{
  const boss={x:604,y:87},owner={x:729,y:87};
  const local=routeBetweenPoints(boss,owner);
  assert.equal(routeLength(local),125);
  const route=routeBetweenPoints(owner,{x:909,y:579});
  assert.deepEqual(route[0],owner);
  assert.ok(route.some(p=>p.x===550&&p.y===87),'general office aisle');
  assert.ok(route.some(p=>p.x===550&&p.y===107),'general office door');
  assert.ok(route.some(p=>p.x===32&&p.y===107),'outside corridor');
  assert.ok(route.some(p=>p.x===32&&p.y===411),'main office entrance');
  assert.deepEqual(route.at(-1),{x:909,y:579});
  for(let i=1;i<route.length;i++)assert.ok(route[i].x===route[i-1].x||route[i].y===route[i-1].y);
});

test('walking sampler eases departure and arrival and stops feet exactly at the endpoint',()=>{
  const route=[{x:20,y:20},{x:220,y:20}],duration=walkingDuration(route);
  const start=walkingSample(route,0,duration),early=walkingSample(route,duration*.05,duration);
  const middle=walkingSample(route,duration*.5,duration),late=walkingSample(route,duration*.95,duration),end=walkingSample(route,duration,duration);
  assert.equal(start.x,20);assert.equal(start.stride,0);assert.equal(start.bob,0);
  assert.ok(early.x<30,'first steps cover less than linear travel');
  assert.equal(middle.x,120);assert.ok(late.x>210,'last steps decelerate');
  assert.equal(end.x,220);assert.equal(end.y,20);assert.equal(end.arrived,true);
  assert.equal(end.stride,0);assert.equal(end.bob,0);assert.equal(end.lean,0);
  assert.equal(start.arrived,false);assert.ok(duration>=900&&duration<=10000);
  assert.deepEqual(walkingSample(route,duration*2,duration),end,'overdue frame remains at the destination');
});

test('turns slow down on the corridor centre line and retain the preceding horizontal facing',()=>{
  const route=[{x:200,y:10},{x:100,y:10},{x:100,y:110}],duration=walkingDuration(route);
  const before=walkingSample(route,duration*.49,duration),corner=walkingSample(route,duration*.5,duration),after=walkingSample(route,duration*.51,duration);
  assert.equal(before.y,10);assert.ok(before.x>100);
  assert.equal(corner.x,100);assert.equal(corner.y,10);
  assert.equal(after.x,100);assert.ok(after.y>10);
  assert.equal(before.heading,'left');assert.equal(after.heading,'down');assert.equal(after.facing,-1);
  const fast=walkingSample(route,duration*.25,duration),fastNext=walkingSample(route,duration*.26,duration);
  assert.ok(Math.hypot(corner.x-before.x,corner.y-before.y)<Math.hypot(fastNext.x-fast.x,fastNext.y-fast.y),'doorway turn is slower than corridor cruising');
  for(let i=0;i<=200;i++){
    const p=walkingSample(route,duration*i/200,duration);
    assert.ok((p.y===10&&p.x>=100&&p.x<=200)||(p.x===100&&p.y>=10&&p.y<=110));
    assert.ok(Object.values(p).filter(v=>typeof v==='number').every(Number.isFinite));
    assert.ok(Math.abs(p.stride)<=14&&p.bob>=-.8&&p.bob<=0&&Math.abs(p.lean)<=1.5);
  }
});

test('stride phase is distance based and collinear graph junctions do not cause artificial stops',()=>{
  const simple=[{x:0,y:20},{x:200,y:20}],junctions=[{x:0,y:20},{x:50,y:20},{x:100,y:20},{x:200,y:20}];
  assert.equal(walkingDuration(simple),walkingDuration(junctions));
  for(let i=0;i<=50;i++)assert.deepEqual(walkingSample(simple,i*40,2000),walkingSample(junctions,i*40,2000));
  const slow=walkingSample(simple,500,2000),fast=walkingSample(simple,250,1000);
  assert.equal(slow.x,fast.x);assert.equal(slow.phase,fast.phase,'same floor position has the same step phase');
  assert.equal(walkingDuration([]),0);assert.equal(walkingSample([],400).arrived,true);
  assert.deepEqual(walkingSample([{x:8,y:9}],0),{x:8,y:9,facing:1,axis:'none',heading:'none',progress:1,phase:0,stride:0,bob:0,lean:0,pace:0,arrived:true});
});

test('handoff choreography has a distinct transfer and acknowledgement window, with a motion-free alternative',()=>{
  const normal=handoffTiming(),reduced=handoffTiming(true);
  assert.ok(normal.approach>0&&normal.transfer>normal.approach&&normal.settle>normal.transfer&&normal.total>normal.settle);
  assert.equal(reduced.approach,0);assert.equal(reduced.transfer,0);assert.ok(reduced.total>=1000,'readable receipt remains without movement');
  assert.deepEqual(handoffTiming(),normal,'timings have no clock or global animation state');
});

test('same-run cancellation and failure halt active and queued exchanges; completion preserves actual final delivery',()=>{
  for(const runStatus of ['cancelled','failed']) {
    const policy=motionUpdatePolicy({hasUpdated:true,previousRunId:'run-1',runId:'run-1',animateEvents:true,runStatus});
    assert.equal(policy.reset,true);assert.equal(policy.animate,false);assert.equal(policy.halted,true);
    const queue=createDeliveryQueue();
    const events=[{id:'before',type:'handoff',agentId:'zhang',targetAgentId:'liu'},{id:'queued',type:'handoff',agentId:'zhang',targetHumanId:'owner'}];
    queue.ingest(events);queue.startReady();assert.equal(queue.activeCount,1);assert.equal(queue.pendingCount,1);
    if(policy.reset)queue.clear();queue.ingest(events,{animate:policy.animate});
    assert.equal(queue.startReady().length,0);assert.equal(queue.activeCount,0);assert.equal(queue.pendingCount,0);
  }
  const completed=motionUpdatePolicy({hasUpdated:true,previousRunId:'run-1',runId:'run-1',animateEvents:true,runStatus:'completed'});
  assert.equal(completed.reset,false);assert.equal(completed.animate,true);
  const restored=motionUpdatePolicy({previousRunId:'old',runId:'restored',animateEvents:false,runStatus:'completed'});
  assert.equal(restored.reset,true);assert.equal(restored.animate,false);
  const newlyCreated=motionUpdatePolicy({runId:'new',animateEvents:true,runStatus:'running'});
  assert.equal(newlyCreated.reset,true);assert.equal(newlyCreated.animate,true);
});

test('onboarding intake, HR approval and final handoff keep human identity through the walking queue',()=>{
  const hr=HUMAN_EMPLOYEES.find(h=>h.id==='hr_owner');assert.equal(hr.nodeId,'workstations');
  const intake={id:'hr-intake',type:'handoff',sourceHumanId:'hr_owner',targetAgentId:'hr',deliveryKind:'task_input'};
  const approval={id:'hr-approval',type:'handoff',sourceAgentId:'hr',targetHumanId:'hr_owner',deliveryKind:'approval_request',approvalId:'hr-approval-id'};
  const final={id:'hr-final',type:'handoff',sourceAgentId:'lead',targetHumanId:'hr_owner',deliveryKind:'final_delivery'};
  assert.deepEqual(deliveryParticipants(intake),{mover:'hr',recipient:'hr_owner',recipientHuman:true,collecting:true});
  assert.deepEqual(deliveryParticipants(approval),{mover:'hr',recipient:'hr_owner',recipientHuman:true});
  const path=routeBetweenPoints({x:464,y:235},hr);assert.deepEqual(path.at(-1),{x:hr.x,y:hr.y});assert.ok(path.some(p=>p.y===300));
  const queue=createDeliveryQueue();queue.ingest([intake,approval,final]);assert.equal(queue.startReady()[0].id,'hr-approval');assert.ok(queue.locked('hr_owner'));queue.finish('hr-approval');assert.equal(queue.startReady()[0].id,'hr-intake');queue.finish('hr-intake');assert.equal(queue.startReady()[0].id,'hr-final');queue.finish('hr-final');assert.equal(queue.activeCount,0);
});
