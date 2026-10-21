import test from 'node:test';
import assert from 'node:assert/strict';
import {createSceneViewController} from '../src/scene-view.js';

function fixture(options={}) {
  const layers=[],scenes=[],changes=[],errors=[],deliveries=[];
  const doc={createElement:()=>({style:{},animations:[],animate(frames,settings){this.animations.push({frames,settings});},remove(){this.removed=true;},ownerDocument:doc})};
  const container={ownerDocument:doc,append:layer=>layers.push(layer)};
  function mount(layer,callbacks){
    const scene={layer,callbacks,states:[],selected:{},destroyed:0,update(state){this.states.push(state);},setTopology(v){this.topology=v;},setSelectedNode(v){this.selected.node=v;},setSelectedAgent(v){this.selected.agent=v;},setSelectedHuman(v){this.selected.human=v;},getNodeAnchor:()=>({x:1,y:2}),getAgentAnchor:()=>({x:3,y:4}),getHumanAnchor:()=>({x:5,y:6}),focusNode:id=>id,focusAgent:id=>id,focusHuman:id=>id,zoom:delta=>delta,resetView(){},destroy(){this.destroyed++;}};
    scenes.push(scene);return scene;
  }
  const controller=createSceneViewController(container,{onDelivery:e=>deliveries.push(e)},{mount2D:mount,load3D:async()=>({mountScene3D:mount}),onChange:v=>changes.push(v),onError:e=>errors.push(e),...options(mount)});
  return {controller,layers,scenes,changes,errors,deliveries};
}
const defaults=()=>({});

test('switching views keeps the same run and approvals, restores selection, and does not replay history',async()=>{
  const f=fixture(defaults),run={runId:'live-run',runStatus:'awaiting_approval',humanApproval:true,approvalHumanId:'owner',logs:[{id:'real-handoff'}],animateEvents:true};
  f.controller.update(run);f.controller.setTopology(false);f.controller.setSelectedNode('general_office');f.controller.setSelectedHuman('owner');
  assert.equal(await f.controller.setMode('3d'),'3d');
  assert.equal(f.scenes[0].destroyed,1);assert.equal(f.layers[0].removed,true);
  const next=f.scenes[1],snapshot=next.states[0];assert.equal(snapshot.runId,run.runId);assert.equal(snapshot.humanApproval,true);assert.equal(snapshot.logs,run.logs);assert.equal(snapshot.animateEvents,false);assert.equal(run.animateEvents,true);
  assert.equal(next.topology,false);assert.deepEqual(next.selected,{node:'general_office',agent:null,human:'owner'});
  assert.equal(f.deliveries.length,0);
  const future={...run,logs:[...run.logs,{id:'next-real-handoff'}]};f.controller.update(future);assert.equal(next.states.at(-1),future);
  f.scenes[0].callbacks.onDelivery({id:'late-old-callback'});next.callbacks.onDelivery({id:'new-callback'});assert.deepEqual(f.deliveries,[{id:'new-callback'}]);
  await f.controller.setMode('2d');assert.equal(f.scenes[1].destroyed,1);assert.equal(f.scenes[2].states[0].animateEvents,false);f.controller.destroy();
});

test('an unavailable 3D renderer preserves the working 2D scene and reports the failure',async()=>{
  const f=fixture(()=>({load3D:async()=>({mountScene3D(){throw new Error('WebGL unavailable');}})}));
  f.controller.update({runId:'unchanged'});assert.equal(await f.controller.setMode('3d'),'2d');assert.equal(f.scenes[0].destroyed,0);assert.equal(f.controller.pending,false);assert.equal(f.errors[0].message,'WebGL unavailable');assert.equal(f.layers[1].removed,true);assert.deepEqual(f.controller.getHumanAnchor('owner'),{x:5,y:6});f.controller.destroy();
});

test('a candidate prepares the restored snapshot while hidden and before the previous view is removed',async()=>{
  let prepared=0;
  const f=fixture(mount=>({load3D:async()=>({mountScene3D(layer,callbacks){
    const scene=mount(layer,callbacks);
    scene.prepare=()=>{
      prepared++;
      assert.equal(layer.style.visibility,'hidden');
      assert.equal(f.controller.mode,'2d');
      assert.equal(f.scenes[0].destroyed,0);
      assert.notEqual(f.layers[0].removed,true);
      assert.equal(scene.states[0].runId,'active-run');
      assert.equal(scene.states[0].humanApproval,true);
      assert.equal(scene.states[0].animateEvents,false);
      assert.equal(scene.topology,false);
      assert.equal(scene.selected.human,'owner');
      callbacks.onDelivery({id:'prepare-callback'});
    };
    return scene;
  }})}));
  try {
    f.controller.update({runId:'active-run',humanApproval:true,animateEvents:true});
    f.controller.setTopology(false);f.controller.setSelectedHuman('owner');
    assert.equal(await f.controller.setMode('3d'),'3d');
    assert.equal(prepared,1);assert.equal(f.layers[1].style.visibility,'');
    assert.equal(f.scenes[0].destroyed,1);assert.equal(f.layers[0].removed,true);
    assert.deepEqual(f.deliveries,[]);
    const animations=f.layers[1].animations.length;
    f.controller.update({runId:'active-run',humanApproval:true,logs:[{id:'new-live-event'}]});
    assert.equal(prepared,1);assert.equal(f.layers[1].animations.length,animations);
  } finally { f.controller.destroy(); }
});

test('preparation failure leaves the previous scene visible and usable',async()=>{
  const f=fixture(mount=>({load3D:async()=>({mountScene3D(layer,callbacks){
    const scene=mount(layer,callbacks);
    scene.prepare=()=>{throw new Error('Initial render failed');};
    return scene;
  }})}));
  try {
    const run={runId:'retained-run',humanApproval:true};f.controller.update(run);
    assert.equal(await f.controller.setMode('3d'),'2d');
    assert.equal(f.controller.pending,false);assert.equal(f.scenes[0].destroyed,0);
    assert.notEqual(f.layers[0].removed,true);assert.notEqual(f.layers[0].style.visibility,'hidden');
    assert.equal(f.scenes[1].destroyed,1);assert.equal(f.layers[1].removed,true);
    assert.equal(f.errors[0].message,'Initial render failed');assert.deepEqual(f.deliveries,[]);
    const next={...run,logs:[{id:'still-working'}]};f.controller.update(next);
    assert.equal(f.scenes[0].states.at(-1),next);
    assert.deepEqual(f.controller.getHumanAnchor('owner'),{x:5,y:6});
  } finally { f.controller.destroy(); }
});

test('a switch cancelled during preparation removes only the candidate',async()=>{
  const f=fixture(mount=>({load3D:async()=>({mountScene3D(layer,callbacks){
    const scene=mount(layer,callbacks);
    scene.prepare=()=>{void f.controller.setMode('2d');};
    return scene;
  }})}));
  try {
    assert.equal(await f.controller.setMode('3d'),'2d');
    assert.equal(f.scenes[0].destroyed,0);assert.notEqual(f.layers[0].removed,true);
    assert.equal(f.scenes[1].destroyed,1);assert.equal(f.layers[1].removed,true);
    assert.equal(f.controller.pending,false);assert.deepEqual(f.errors,[]);
  } finally { f.controller.destroy(); }
});

test('a delayed 3D load uses the latest live state, and switching back cancels stale imports',async()=>{
  let resolve;const delayed=new Promise(yes=>{resolve=yes;});
  const f=fixture(mount=>({load3D:()=>delayed.then(()=>({mountScene3D:mount}))}));
  f.controller.update({runId:'a'});const loading=f.controller.setMode('3d');assert.equal(f.controller.pending,true);
  f.controller.update({runId:'a',logs:[{id:'arrived-while-loading'}]});await f.controller.setMode('2d');resolve();await loading;assert.equal(f.scenes.length,1);assert.equal(f.controller.mode,'2d');assert.equal(f.controller.pending,false);
  await f.controller.setMode('3d');assert.equal(f.scenes[1].states[0].logs[0].id,'arrived-while-loading');f.controller.destroy();
});

test('context loss returns to 2D without changing or approving a task',async()=>{
  const f=fixture(defaults);f.controller.update({runId:'live',humanApproval:true,approvalHumanId:'owner'});await f.controller.setMode('3d');f.scenes[1].callbacks.onUnavailable(new Error('context lost'));await Promise.resolve();
  assert.equal(f.controller.mode,'2d');assert.equal(f.scenes.at(-1).states[0].humanApproval,true);assert.equal(f.deliveries.length,0);assert.equal(f.errors.length,1);f.controller.destroy();
});

test('destroying during a 3D import never mounts a detached renderer',async()=>{
  let resolve;const deferred=new Promise(yes=>{resolve=yes;});const f=fixture(mount=>({load3D:()=>deferred.then(()=>({mountScene3D:mount}))}));
  const loading=f.controller.setMode('3d');f.controller.destroy();resolve();await loading;assert.equal(f.scenes.length,1);assert.equal(f.scenes[0].destroyed,1);f.controller.destroy();assert.equal(f.scenes[0].destroyed,1);
});

test('view changes use a finite visual entrance and skip it for reduced motion',async()=>{
 const previous=globalThis.matchMedia,f=fixture(defaults);try{globalThis.matchMedia=()=>({matches:false});await f.controller.setMode('3d');assert.equal(f.layers[1].animations.length,1);assert.equal(f.layers[1].animations[0].settings.duration,240);assert.equal(f.layers[0].removed,true);assert.equal(f.deliveries.length,0);globalThis.matchMedia=()=>({matches:true});await f.controller.setMode('2d');assert.equal(f.layers[2].animations.length,0);assert.equal(f.layers[1].removed,true);}finally{f.controller.destroy();globalThis.matchMedia=previous;}
});
