import test from 'node:test';
import assert from 'node:assert/strict';
import {createSceneViewController} from '../src/scene-view.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(configure=()=>({})){
  const layers=[],scenes=[],changes=[],errors=[],deliveries=[],hovered=[];
  const doc={createElement:()=>({style:{},dataset:{},attrs:{},setAttribute(name,value){this.attrs[name]=value;},remove(){this.removed=true;},ownerDocument:doc})};
  const container={ownerDocument:doc,append:layer=>layers.push(layer)};
  function mount(mode){return (layer,callbacks)=>{
    const scene={mode,layer,callbacks,states:[],presence:[],selected:{},activeChanges:[],destroyed:0,prepares:0,camera:{zoom:1},localTeam:null,scopeCalls:[],
      update(value){this.states.push(value);},setTopology(value){this.topology=value;},setSelectedNode(value){this.selected.node=value;},setSelectedAgent(value){this.selected.agent=value;},setSelectedHuman(value){this.selected.human=value;},
      setPresence(value){this.presence.push(value);},getPresenceState(){return {positions:this.positions||{}};},setActive(value){this.active=value;this.activeChanges.push(value);},
      prepare(){this.prepares++;assert.equal(layer.style.visibility,'hidden');assert.equal(this.active,false);},
      getNodeAnchor:()=>({x:1,y:2}),getAgentAnchor:()=>({x:3,y:4}),getHumanAnchor:()=>({x:5,y:6}),
      getLocalTeamId(){return this.localTeam;},focusArea(id){this.localTeam=id.startsWith('ai_data_team_')?id:null;this.scopeCalls.push(['focusArea',id]);this.camera.area=id;return true;},focusNode(id){this.camera.node=id;return true;},focusAgent(id){this.camera.agent=id;return true;},focusHuman(id,zoom){this.camera={human:id,zoom};return true;},focusPoint(point){this.camera.point=point;return true;},
      zoom(delta){this.camera.zoom+=delta;return this.camera.zoom;},resetView(){this.localTeam=null;this.scopeCalls.push(['resetView']);this.camera={zoom:1};},destroy(){this.destroyed++;this.active=false;}
    };scenes.push(scene);return scene;
  };}
  const options={initialMode:'2d',warmup:false,mount2D:mount('2d'),load3D:async()=>({mountScene3D:mount('3d')}),onChange:value=>changes.push(value),onError:error=>errors.push(error),...configure(mount)};
  const controller=createSceneViewController(container,{onDelivery:value=>deliveries.push(value),onHoverBulletin:(...args)=>hovered.push(args)},options);
  return {controller,layers,scenes,changes,errors,deliveries,hovered,mount};
}

test('default startup mounts only 3D, queues live state and focus, then exposes its first prepared frame',async()=>{
  const wait=deferred(),f=fixture(mount=>({initialMode:undefined,load3D:()=>wait.promise.then(()=>({mountScene3D:mount('3d')}))}));
  try{
    assert.equal(f.controller.mode,'3d');assert.equal(f.controller.pending,true);assert.equal(f.layers.length,0);
    f.controller.update({runId:'current',animateEvents:true});f.controller.setTopology(false);f.controller.focusHuman('owner',2.1);
    await Promise.resolve();assert.equal(f.scenes.length,0);wait.resolve();await f.controller.ready;
    assert.equal(f.scenes.length,1);assert.equal(f.scenes[0].mode,'3d');assert.equal(f.scenes[0].prepares,1);assert.equal(f.scenes[0].states[0].animateEvents,false);
    assert.equal(f.scenes[0].topology,false);assert.deepEqual(f.scenes[0].camera,{human:'owner',zoom:2.1});assert.equal(f.scenes[0].active,true);assert.equal(f.layers[0].style.visibility,'');assert.equal(f.controller.pending,false);
  }finally{f.controller.destroy();}
});

test('repeated switching reuses two renderers, preserves their camera positions and suspends the hidden view',async()=>{
  const f=fixture();try{
    const plan=f.scenes[0];f.controller.zoom(.5);await f.controller.setMode('3d');const model=f.scenes[1];f.controller.focusHuman('owner',2.4);
    for(let index=0;index<8;index++){await f.controller.setMode('2d');assert.equal(plan.active,true);assert.equal(model.active,false);assert.equal(model.layer.inert,true);assert.equal(plan.camera.zoom,1.5);await f.controller.setMode('3d');assert.equal(model.active,true);assert.equal(plan.active,false);assert.deepEqual(model.camera,{human:'owner',zoom:2.4});}
    assert.equal(f.scenes.length,2);assert.equal(plan.destroyed,0);assert.equal(model.destroyed,0);assert.equal(f.layers.filter(layer=>layer.style.visibility==='').length,1);
  }finally{f.controller.destroy();}
  assert.deepEqual(f.scenes.map(scene=>scene.destroyed),[1,1]);
});

test('restoring cached views keeps the current run and approvals without replaying events or stale callbacks',async()=>{
  const f=fixture(),run={runId:'live',humanApproval:true,approvalHumanId:'owner',logs:[{id:'old'}],animateEvents:true};try{
    f.controller.update(run);f.controller.setSelectedNode('general_office');f.controller.setSelectedAgent('boss');f.controller.setSelectedHuman('owner');f.controller.setTopology(false);
    await f.controller.setMode('3d');const [plan,model]=f.scenes;
    assert.equal(model.states[0].runId,'live');assert.equal(model.states[0].humanApproval,true);assert.equal(model.states[0].logs,run.logs);assert.equal(model.states[0].animateEvents,false);assert.equal(run.animateEvents,true);assert.deepEqual(model.selected,{node:'general_office',agent:'boss',human:'owner'});
    plan.callbacks.onDelivery({id:'hidden'});model.callbacks.onDelivery({id:'visible'});assert.deepEqual(f.deliveries,[{id:'visible'}]);
    const next={...run,logs:[{id:'old'},{id:'new'}]};f.controller.update(next);assert.equal(model.states.at(-1),next);await f.controller.setMode('2d');assert.equal(plan.states.at(-1).logs,next.logs);assert.equal(plan.states.at(-1).animateEvents,false);
    model.callbacks.onHoverBulletin('video',{x:10,y:20});plan.callbacks.onHoverBulletin('messages',{x:20,y:30});assert.deepEqual(f.hovered,[['messages',{x:20,y:30}]]);
  }finally{f.controller.destroy();}
});

test('a candidate prepares while the previous view remains visible and active',async()=>{
  const gate=deferred();let preparing=false;
  const f=fixture(mount=>({load3D:async()=>({mountScene3D(layer,callbacks){const scene=mount('3d')(layer,callbacks);scene.prepare=()=>{preparing=true;scene.prepares++;assert.equal(layer.style.visibility,'hidden');assert.equal(scene.active,false);assert.equal(f.scenes[0].active,true);assert.equal(f.scenes[0].layer.style.visibility,'');callbacks.onDelivery({id:'prepare'});return gate.promise;};return scene;}})}));
  try{const pending=f.controller.setMode('3d');await settle();assert.equal(preparing,true);assert.equal(f.controller.mode,'2d');assert.deepEqual(f.deliveries,[]);gate.resolve();await pending;assert.equal(f.controller.mode,'3d');assert.equal(f.scenes[0].active,false);assert.equal(f.scenes[1].active,true);}finally{f.controller.destroy();}
});

test('updates arriving during asynchronous preparation are restored before reveal',async()=>{
  const gate=deferred();let calls=0;
  const f=fixture(mount=>({load3D:async()=>({mountScene3D(layer,callbacks){const scene=mount('3d')(layer,callbacks);scene.prepare=()=>{calls++;return calls===1?gate.promise:undefined;};return scene;}})}));
  try{f.controller.update({runId:'first'});const pending=f.controller.setMode('3d');await settle();f.controller.update({runId:'latest',humanApproval:true});gate.resolve();await pending;assert.equal(calls,2);assert.equal(f.scenes[1].states.at(-1).runId,'latest');assert.equal(f.scenes[1].states.at(-1).humanApproval,true);}finally{f.controller.destroy();}
});

test('a failed 3D import retains working 2D, clears pending and can be retried',async()=>{
  let attempts=0;const f=fixture(mount=>({load3D:async()=>{if(++attempts===1)throw new Error('Network unavailable');return {mountScene3D:mount('3d')};}}));
  try{assert.equal(await f.controller.setMode('3d'),'2d');assert.equal(f.scenes[0].active,true);assert.equal(f.scenes[0].destroyed,0);assert.equal(f.controller.pending,false);assert.equal(f.errors.length,1);assert.equal(await f.controller.setMode('3d'),'3d');assert.equal(attempts,2);}finally{f.controller.destroy();}
});

test('default 3D startup falls back to a prepared 2D view when WebGL is unavailable',async()=>{
  const f=fixture(()=>({initialMode:'3d',load3D:async()=>({mountScene3D(){throw new Error('WebGL unavailable');}})}));
  try{await f.controller.ready;assert.equal(f.controller.mode,'2d');assert.equal(f.controller.pending,false);assert.equal(f.scenes.length,1);assert.equal(f.scenes[0].mode,'2d');assert.equal(f.scenes[0].active,true);assert.equal(f.layers[0].removed,true);assert.equal(f.errors[0].message,'WebGL unavailable');}finally{f.controller.destroy();}
});

test('a preparation failure disposes only the failed view and leaves the current view usable',async()=>{
  const f=fixture(mount=>({load3D:async()=>({mountScene3D(layer,callbacks){const scene=mount('3d')(layer,callbacks);scene.prepare=()=>{throw new Error('Preparation failed');};return scene;}})}));
  try{f.controller.update({runId:'unchanged'});await f.controller.setMode('3d');assert.equal(f.controller.mode,'2d');assert.equal(f.scenes[0].destroyed,0);assert.equal(f.scenes[0].active,true);assert.equal(f.scenes[1].destroyed,1);assert.equal(f.layers[1].removed,true);assert.deepEqual(f.controller.getHumanAnchor('owner'),{x:5,y:6});assert.equal(f.errors[0].message,'Preparation failed');}finally{f.controller.destroy();}
});

test('rapid contrary requests share an import and the last requested view wins without destroying useful cached scenes',async()=>{
  const gate=deferred();let imports=0;const f=fixture(mount=>({load3D:()=>{imports++;return gate.promise.then(()=>({mountScene3D:mount('3d')}));}}));
  try{const first=f.controller.setMode('3d');const second=f.controller.setMode('3d');await settle();assert.equal(imports,1);await f.controller.setMode('2d');gate.resolve();await Promise.all([first,second]);assert.equal(f.controller.mode,'2d');assert.equal(f.controller.pending,false);assert.equal(f.scenes.length,2);assert.equal(f.scenes[1].active,false);assert.equal(f.scenes[1].destroyed,0);await f.controller.setMode('3d');assert.equal(imports,1);assert.equal(f.scenes.length,2);}finally{f.controller.destroy();}
});

test('a later 2D request during 3D preparation keeps 2D visible and leaves the candidate suspended',async()=>{
  const gate=deferred();const f=fixture(mount=>({load3D:async()=>({mountScene3D(layer,callbacks){const scene=mount('3d')(layer,callbacks);scene.prepare=()=>gate.promise;return scene;}})}));
  try{const pending=f.controller.setMode('3d');await settle();await f.controller.setMode('2d');gate.resolve();await pending;assert.equal(f.controller.mode,'2d');assert.equal(f.scenes[0].active,true);assert.equal(f.scenes[1].active,false);assert.equal(f.scenes[1].destroyed,0);assert.equal(f.controller.pending,false);}finally{f.controller.destroy();}
});

test('context loss disposes the invalid renderer and reveals the cached fallback with the latest snapshot',async()=>{
  const f=fixture();try{await f.controller.setMode('3d');f.controller.update({runId:'live',humanApproval:true});const broken=f.scenes[1];broken.callbacks.onUnavailable(new Error('context lost'));await settle();assert.equal(f.controller.mode,'2d');assert.equal(f.scenes[0].active,true);assert.equal(f.scenes[0].states.at(-1).humanApproval,true);assert.equal(broken.destroyed,1);assert.equal(f.errors.length,1);assert.deepEqual(f.deliveries,[]);await f.controller.setMode('3d');assert.equal(f.scenes.length,3);assert.equal(f.scenes[2].active,true);}finally{f.controller.destroy();}
});

test('presence follows the current drawn position when changing views, and sign-out clears cached identities',async()=>{
  const selected=[],f=fixture();try{
    f.controller.setPresence({enabled:true,currentUserId:'one',people:[{id:'one',name:'Employee'}],onSelectEmployee:person=>selected.push(person.id)});f.scenes[0].positions={one:{x:23,y:45}};
    await f.controller.setMode('3d');const [plan,model]=f.scenes;assert.deepEqual(model.presence.at(-1).positions,{one:{x:23,y:45}});assert.equal(model.presence.at(-1).rebase,true);
    plan.presence.at(-1).onSelectEmployee({id:'one'});model.presence.at(-1).onSelectEmployee({id:'one'});assert.deepEqual(selected,['one']);
    f.controller.setPresence({enabled:true,currentUserId:null,people:[]});assert.deepEqual(plan.presence.at(-1).people,[]);assert.deepEqual(model.presence.at(-1).people,[]);
  }finally{f.controller.destroy();}
});

test('destroying during an import never mounts a detached renderer; disposing cached scenes is idempotent',async()=>{
  const gate=deferred(),f=fixture(mount=>({load3D:()=>gate.promise.then(()=>({mountScene3D:mount('3d')}))}));
  const pending=f.controller.setMode('3d');f.controller.destroy();gate.resolve();await pending;assert.equal(f.scenes.length,1);assert.equal(f.scenes[0].destroyed,1);assert.equal(f.layers[0].removed,true);f.controller.destroy();assert.equal(f.scenes[0].destroyed,1);
});

test('invalid view names are rejected without changing the current renderer',async()=>{
  const f=fixture();try{await assert.rejects(f.controller.setMode('other'),TypeError);assert.equal(f.controller.mode,'2d');assert.equal(f.controller.pending,false);assert.equal(f.scenes.length,1);}finally{f.controller.destroy();}
});

test('context loss while a hidden candidate prepares clears pending and keeps the working view',async()=>{
  const gate=deferred();const f=fixture(mount=>({load3D:async()=>({mountScene3D(layer,callbacks){const scene=mount('3d')(layer,callbacks);scene.prepare=()=>gate.promise;return scene;}})}));
  try{const pending=f.controller.setMode('3d');await settle();f.scenes[1].callbacks.onUnavailable(new Error('Context lost during preparation'));gate.resolve();await pending;assert.equal(f.controller.pending,false);assert.equal(f.controller.mode,'2d');assert.equal(f.scenes[0].active,true);assert.equal(f.scenes[1].destroyed,1);assert.equal(f.errors.length,1);}finally{f.controller.destroy();}
});

test('idle prewarming constructs the secondary renderer once without exposing it or activating its input',async()=>{
  const previousIdle=globalThis.requestIdleCallback,previousCancel=globalThis.cancelIdleCallback;let next=0;const jobs=new Map();
  globalThis.requestIdleCallback=fn=>{jobs.set(++next,fn);return next;};globalThis.cancelIdleCallback=id=>jobs.delete(id);
  const f=fixture(()=>({warmup:true}));try{
    await f.controller.ready;assert.equal(jobs.size,1);const warm=[...jobs.values()][0];jobs.clear();warm();await settle();assert.equal(f.scenes.length,2);assert.equal(f.scenes[0].active,true);assert.equal(f.scenes[1].active,false);assert.equal(f.scenes[1].prepares,1);assert.equal(f.layers[1].style.visibility,'hidden');
    await f.controller.setMode('3d');assert.equal(f.scenes.length,2);assert.equal(f.scenes[1].active,true);assert.equal(f.scenes[0].active,false);assert.equal(jobs.size,0);
  }finally{f.controller.destroy();globalThis.requestIdleCallback=previousIdle;globalThis.cancelIdleCallback=previousCancel;}
});


test('area navigation during view preparation applies only to the new view, while returning to the current view flushes the latest focus',async()=>{
 const gate=deferred(),f=fixture(mount=>({load3D:()=>gate.promise.then(()=>({mountScene3D:mount('3d')}))}));try{const pending=f.controller.setMode('3d');f.controller.focusArea('finance');f.controller.focusArea('research');assert.equal(f.scenes[0].camera.area,undefined);gate.resolve();await pending;assert.equal(f.scenes[1].camera.area,'research');await f.controller.setMode('2d');const wait=deferred();f.scenes[1].prepare=()=>wait.promise;const switchAgain=f.controller.setMode('3d');await settle();f.controller.focusArea('business');await f.controller.setMode('2d');assert.equal(f.scenes[0].camera.area,'business');wait.resolve();await switchAgain;}finally{f.controller.destroy();}
});
test('sign-out replaces a deferred private office with overview, and failed switching still applies the latest overview',async()=>{
 const gate=deferred(),f=fixture(mount=>({load3D:()=>gate.promise.then(()=>({mountScene3D:mount('3d')}))}));try{const pending=f.controller.setMode('3d');f.controller.focusArea('finance');f.controller.resetView();gate.resolve();await pending;assert.deepEqual(f.scenes[1].camera,{zoom:1});}finally{f.controller.destroy();}
 const failure=deferred(),g=fixture(()=>({load3D:()=>failure.promise}));try{g.controller.focusNode('finance');const switching=g.controller.setMode('3d');g.controller.resetView();failure.reject(new Error('offline'));await switching;assert.deepEqual(g.scenes[0].camera,{zoom:1});}finally{g.controller.destroy();}
});

test('local office follows 2D and 3D switches without refitting matching manual cameras',async()=>{
 const f=fixture();try{
  const plan=f.scenes[0];f.controller.focusArea('ai_data_team_1');f.controller.zoom(2);
  await f.controller.setMode('3d');const model=f.scenes[1];assert.equal(model.localTeam,'ai_data_team_1');assert.deepEqual(model.scopeCalls,[['focusArea','ai_data_team_1']]);f.controller.zoom(4);
  for(let index=0;index<3;index++){await f.controller.setMode('2d');assert.equal(plan.localTeam,'ai_data_team_1');assert.equal(plan.camera.zoom,3);await f.controller.setMode('3d');assert.equal(model.localTeam,'ai_data_team_1');assert.equal(model.camera.zoom,5);}
  assert.deepEqual(plan.scopeCalls,[['focusArea','ai_data_team_1']]);assert.deepEqual(model.scopeCalls,[['focusArea','ai_data_team_1']]);
  f.controller.focusArea('ai_data_team_2');await f.controller.setMode('2d');assert.equal(plan.localTeam,'ai_data_team_2');assert.deepEqual(plan.scopeCalls.at(-1),['focusArea','ai_data_team_2']);
 }finally{f.controller.destroy();}
});

test('leaving a local office clears the cached secondary local office once and preserves overview cameras afterward',async()=>{
 const f=fixture();try{
  f.controller.focusArea('ai_data_team_1');await f.controller.setMode('3d');const [plan,model]=f.scenes;f.controller.resetView();f.controller.zoom(.7);
  await f.controller.setMode('2d');assert.equal(plan.localTeam,null);assert.deepEqual(plan.scopeCalls.at(-1),['resetView']);f.controller.zoom(.4);const calls=plan.scopeCalls.length;
  await f.controller.setMode('3d');assert.equal(model.localTeam,null);assert.equal(model.camera.zoom,1.7);await f.controller.setMode('2d');assert.equal(plan.camera.zoom,1.4);assert.equal(plan.scopeCalls.length,calls);
 }finally{f.controller.destroy();}
});

test('a source local office change during asynchronous preparation is synchronized before reveal',async()=>{
 const gate=deferred();let calls=0;const f=fixture(mount=>({load3D:async()=>({mountScene3D(layer,callbacks){const scene=mount('3d')(layer,callbacks);scene.prepare=()=>++calls===1?gate.promise:undefined;return scene;}})}));try{
  f.controller.focusArea('ai_data_team_1');const pending=f.controller.setMode('3d');await settle();assert.equal(f.scenes[1].localTeam,'ai_data_team_1');
  f.scenes[0].focusArea('ai_data_team_3');gate.resolve();await pending;assert.equal(calls,2);assert.equal(f.scenes[1].localTeam,'ai_data_team_3');assert.deepEqual(f.scenes[1].scopeCalls,[['focusArea','ai_data_team_1'],['focusArea','ai_data_team_3']]);
 }finally{f.controller.destroy();}
});

test('latest deferred office navigation and sign-out take precedence over copied local scope',async()=>{
 for(const reset of [false,true]){
  const gate=deferred();const f=fixture(mount=>({load3D:async()=>({mountScene3D(layer,callbacks){const scene=mount('3d')(layer,callbacks);scene.prepare=()=>gate.promise;return scene;}})}));try{
   f.controller.focusArea('ai_data_team_1');const pending=f.controller.setMode('3d');await settle();f.controller.focusArea('ai_data_team_2');if(reset)f.controller.resetView();gate.resolve();await pending;
   assert.equal(f.scenes[1].localTeam,reset?null:'ai_data_team_2');assert.deepEqual(f.scenes[1].scopeCalls.at(-1),reset?['resetView']:['focusArea','ai_data_team_2']);
  }finally{f.controller.destroy();}
 }
});
