import test from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_EMPLOYEES, humanForScenario } from '../dist/people.js';
import { FLOOR_SEGMENTS, routeBetweenPoints, routeLength, pointAlongRoute, deliveryParticipants, createDeliveryQueue, motionUpdatePolicy } from '../dist/scene-motion.js';

test('six explicit human representatives cover each scenario without virtual badges',()=>{
  assert.equal(HUMAN_EMPLOYEES.length,6);
  assert.equal(new Set(HUMAN_EMPLOYEES.map(h=>h.id)).size,6);
  const expected={finance:'finance_owner',procurement:'purchasing_owner',ddos:'it_owner',database:'it_owner',delivery:'business_owner',investment:'investment_owner'};
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
