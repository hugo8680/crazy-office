import {OFFICE_ROOMS,OFFICE_SEATS} from '../src/organization.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOfficePresence,MAX_OFFICE_PEOPLE,PRESENCE_NODE_IDS,presencePosition,createOfficePresenceMotion,mountErpPresence} from '../src/erp-presence.js';
import {FLOOR_SEGMENTS,routeBetweenPoints} from '../src/scene-motion.js';
import {createSceneViewController} from '../src/scene-view.js';
import {mountScene} from '../src/scene.js';
import {HUMAN_EMPLOYEES} from '../src/people.js';

const person=(id,nodeId='workstations',extra={})=>({id,name:'员工'+id,title:'项目专员',nodeId,online:true,...extra});
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('在线人物保留完整有效名单，离线和重复项剔除，本人排序优先',()=>{
 const people=Array.from({length:30},(_,i)=>person('user-'+i));people.push(person('offline','meeting',{online:false}),person('user-1','finance'));
 const state=normalizeOfficePresence({enabled:true,people,currentUserId:'user-29'});assert.equal(state.people.length,30);assert.equal(state.people[0].id,'user-29');assert.equal(state.people[0].current,true);assert.equal(state.people.some(p=>p.id==='offline'),false);assert.equal(new Set(state.people.map(p=>p.id)).size,30);
 assert.notEqual(state.people[0].title,'老板');assert.equal(normalizeOfficePresence({people}).enabled,false);assert.equal(normalizeOfficePresence({enabled:true,people:[person('valid','bad-node')]}).people[0].nodeId,'hr_admin');
});

test('公司249个真实身份均保留，超出绘制保护范围时也不会挤掉当前员工',()=>{
 const primary=OFFICE_SEATS.filter(seat=>seat.primarySeat),people=primary.map(seat=>person(seat.personId,seat.departmentId,{x:seat.x,y:seat.y,appearanceKey:seat.id}));assert.equal(primary.length,249);
 const state=normalizeOfficePresence({enabled:true,currentUserId:people.at(-1).id,people:[null,{},person('offline','finance',{online:false}),...people,people[0]]});
 assert.equal(state.people.length,249);assert.equal(new Set(state.people.map(item=>item.id)).size,249);assert.equal(state.people[0].id,people.at(-1).id);
 assert.deepEqual(state.people.map(item=>item.id).sort(),people.map(item=>item.id).sort());assert.ok(state.people.every(item=>item.point&&Number.isFinite(item.point.x)&&Number.isFinite(item.point.y)));
 const overflow=Array.from({length:MAX_OFFICE_PEOPLE+17},(_,index)=>person('overflow-'+index)),last=overflow.at(-1).id;
 const bounded=normalizeOfficePresence({enabled:true,currentUserId:last,people:overflow});assert.equal(bounded.people.length,MAX_OFFICE_PEOPLE);assert.equal(bounded.people[0].id,last);assert.equal(bounded.people[0].current,true);assert.equal(new Set(bounded.people.map(item=>item.id)).size,MAX_OFFICE_PEOPLE);
});

test('249个在线身份的中途位置、心跳与隐私清理不受人数采样影响',()=>{
 let time=0;const changes=[],motion=createOfficePresenceMotion({now:()=>time,onChange:entry=>changes.push(entry.person.id)}),primary=OFFICE_SEATS.filter(seat=>seat.primarySeat);
 const people=primary.map((seat,index)=>person(seat.personId,'research',{x:500+index*.2,y:1058,revision:1})),currentUserId=people.at(-1).id;
 try{
  motion.set({enabled:true,currentUserId,people});assert.equal(motion.entries.size,249);assert.equal(Object.keys(motion.snapshot().positions).length,249);assert.equal(motion.busy,false);
  const destinations=people.map(item=>({...item,x:item.x+2,revision:2}));motion.set({enabled:true,currentUserId,people:destinations});assert.equal(motion.busy,true);
  time=400;motion.tick(time);assert.equal(new Set(changes).size,249);const moving=motion.snapshot().positions,last=motion.entries.get(currentUserId),started=last.motion.started;
  motion.set({enabled:true,currentUserId,people:destinations});assert.equal(last.motion.started,started);assert.deepEqual(motion.snapshot().positions,moving);
  time=20000;motion.tick(time);assert.equal(motion.busy,false);assert.equal(motion.entries.size,249);for(const target of destinations)assert.deepEqual(motion.entries.get(target.id).point,{x:target.x,y:target.y});
  motion.set({enabled:false,currentUserId:null,people:destinations});assert.equal(motion.entries.size,0);assert.deepEqual(motion.snapshot(),{positions:{}});
 }finally{motion.destroy();}assert.equal(motion.entries.size,0);
});

test('所有在线员工目的地都在现有办公室通道中，拥挤时仍不穿越墙体',()=>{
 const onFloor=p=>FLOOR_SEGMENTS.some(([a,b])=>Math.abs((b[0]-a[0])*(p.y-a[1])-(b[1]-a[1])*(p.x-a[0]))<.001&&p.x>=Math.min(a[0],b[0])&&p.x<=Math.max(a[0],b[0])&&p.y>=Math.min(a[1],b[1])&&p.y<=Math.max(a[1],b[1]));
 for(const nodeId of PRESENCE_NODE_IDS)for(let i=0;i<20;i++){const p=presencePosition(nodeId,i,20);assert(onFloor(p),nodeId+JSON.stringify(p));const route=routeBetweenPoints(p,presencePosition('workstations'));assert(route.length>=1);assert(route.every(q=>Number.isFinite(q.x)&&Number.isFinite(q.y)));}
});

test('人物首次出现不重放走路，部门变化沿真实通道走动，心跳不重置当前行程',()=>{
 let time=0;const changes=[],motion=createOfficePresenceMotion({now:()=>time,onChange:entry=>changes.push({...entry.point})});
 const base={enabled:true,currentUserId:'user',people:[person('user')]};motion.set(base);assert.equal(motion.busy,false);const start={...motion.entries.get('user').point};
 motion.set({...base,people:[person('user','finance')]});assert.equal(motion.busy,true);const route=motion.entries.get('user').motion.route;assert(route.some(p=>p.x===285),'跨部门先通过西侧回廊');time=500;motion.tick(time);const halfway={...motion.entries.get('user').point};assert.notDeepEqual(halfway,start);
 const started=motion.entries.get('user').motion.started;motion.set({...base,people:[person('user','finance')]});assert.equal(motion.entries.get('user').motion.started,started);
 time=20000;motion.tick(time);assert.deepEqual(motion.entries.get('user').point,presencePosition('finance'));assert.equal(motion.busy,false);assert(changes.length>=2);motion.destroy();assert.equal(motion.entries.size,0);
});

test('减少动态效果直接到位，隐藏页暂停计时，交接锁定时员工不会继续走开',()=>{
 let time=0;const motion=createOfficePresenceMotion({now:()=>time});const state={enabled:true,currentUserId:'a',people:[person('a')]};motion.set(state);motion.set({...state,people:[person('a','meeting')]});time=200;motion.tick(time);const before={...motion.entries.get('a').point};time=1200;motion.tick(time,{isPaused:()=>true});assert.deepEqual(motion.entries.get('a').point,before);motion.shiftTime(10000);time=11200;motion.tick(time,{isPaused:()=>true});assert.deepEqual(motion.entries.get('a').point,before);
 motion.setReducedMotion(true);assert.deepEqual(motion.entries.get('a').point,presencePosition('meeting'));assert.equal(motion.busy,false);motion.set({enabled:false,people:state.people});assert.equal(motion.entries.size,0);motion.destroy();
});

function heartbeatFixture(request,options={}){
 const values=[],calls=[],timers=new Map(),listeners=new Map();let sequence=0;const doc={hidden:false,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
 const scene={setPresence:value=>values.push(value)};
 const presence=mountErpPresence({scene,session:{actor:{id:'me'}},request:async(...args)=>{calls.push(args);return request(...args);},document:doc,setTimer:(fn,ms)=>{const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimer:id=>timers.delete(id),...options});
 return{presence,values,calls,timers,listeners,doc};
}

test('在线心跳使用三秒协议、读取真实名单，部门移动提交明确坐标',async()=>{
 const f=heartbeatFixture(async(_path,_method,body)=>({online:[person('me',body.nodeId),person('other','finance')]}));await f.presence.refresh();assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].slice(0,3),['/api/erp/presence','PUT',{operation:'heartbeat',nodeId:'hr_admin'}]);assert.ok(f.calls[0][3].signal instanceof AbortSignal);assert.equal([...f.timers.values()][0].ms,3000);assert.equal(f.values.at(-1).people.length,2);assert.equal(f.values.at(-1).currentUserId,'me');
 await f.presence.moveTo('meeting');assert.equal(f.calls.at(-1)[2].nodeId,'research');assert.equal(f.calls.at(-1)[2].operation,'move');assert.deepEqual({x:f.calls.at(-1)[2].x,y:f.calls.at(-1)[2].y},presencePosition('research'));assert.equal(await f.presence.moveTo('unknown'),false);assert(f.calls.every(([url])=>url==='/api/erp/presence'));f.presence.destroy();assert.equal(f.timers.size,0);assert.equal(f.listeners.size,0);assert.equal(f.values.at(-1).enabled,false);
});

test('presence updates notify the current seat and person surfaces after publishing the authoritative response',async()=>{
 let update=0,revision=0;const observed=[];
 const f=heartbeatFixture(async()=>({online:[person('me','finance',{revision:++revision}),person('other','finance',{posture:'seated',seatId:'finance_staff_001'})]}),{onUpdate(me,people){update++;observed.push({revision:me.revision,seat:people[1].seatId});}});
 await f.presence.ready;assert.equal(update,1);assert.deepEqual(observed,[{revision:1,seat:'finance_staff_001'}]);assert.equal(f.values.at(-1).people[0].revision,1);
 await f.presence.refresh();assert.equal(update,2);assert.equal(observed.at(-1).revision,2);f.presence.destroy();await f.presence.refresh();assert.equal(update,2);
});

test('an aborted heartbeat deadline releases the serialized queue, and destroy aborts a current request without a stale publish',async()=>{
 const deadlines=new Map(),signals=[];let sequence=0,attempt=0;
 const f=heartbeatFixture(async(_path,_method,body,{signal})=>{
  signals.push(signal);if(++attempt===1)return new Promise((_yes,no)=>signal.addEventListener('abort',()=>no(Object.assign(new Error('aborted'),{name:'AbortError'})),{once:true}));
  return{online:[person('me','finance',{x:body.x||145,y:body.y||520,revision:attempt})]};
 },{setDeadline:(fn,ms)=>{assert.equal(ms,12000);deadlines.set(++sequence,fn);return sequence;},clearDeadline:id=>deadlines.delete(id)});
 await flush();const move=f.presence.movePoint({x:285,y:710});assert.equal(f.calls.length,1);assert.equal(deadlines.size,1);[...deadlines.values()][0]();assert.equal(await move,true);assert.equal(signals[0].aborted,true);assert.equal(f.calls.length,2);assert.deepEqual({x:f.presence.self.x,y:f.presence.self.y},{x:285,y:710});assert.equal(deadlines.size,0);f.presence.destroy();
 const quiet=[],g=heartbeatFixture((_path,_method,_body,{signal})=>new Promise((_yes,no)=>signal.addEventListener('abort',()=>no(new Error('aborted')),{once:true})),{onUpdate:()=>quiet.push('publish'),setDeadline:(fn)=>{deadlines.set(++sequence,fn);return sequence;},clearDeadline:id=>deadlines.delete(id)});
 await flush();const signal=g.calls[0][3].signal;assert.equal(signal.aborted,false);g.presence.destroy();await g.presence.ready;assert.equal(signal.aborted,true);assert.deepEqual(quiet,[]);assert.equal(deadlines.size,0);assert.equal(g.values.at(-1).enabled,false);
});

test('后台暂停心跳，前台立即刷新，销毁后迟到响应不能恢复在线人物',async()=>{
 const f=heartbeatFixture(async()=>({online:[person('me')]}));await f.presence.refresh();f.doc.hidden=true;f.listeners.get('visibilitychange')();assert.equal(f.timers.size,0);await f.presence.refresh();assert.equal(f.calls.length,1);
 f.doc.hidden=false;f.listeners.get('visibilitychange')();await f.presence.refresh();assert.equal(f.calls.length,2);assert.equal(f.timers.size,1);f.presence.destroy();
 let resolve;const g=heartbeatFixture(()=>new Promise(yes=>{resolve=yes;}));await flush();g.presence.destroy();const count=g.values.length;resolve({online:[person('me')]});await flush();assert.equal(g.values.length,count);assert.equal(g.timers.size,0);
});

test('移动期间合并心跳并发送最新位置，网络断开不永久展示旧在线状态，401停用',async()=>{
 let release;const f=heartbeatFixture(()=>new Promise(yes=>{release=yes;}));await flush();const moving=f.presence.moveTo('finance');release({online:[person('me')]});await flush();assert.equal(f.calls.at(-1)[2].nodeId,'finance');release({online:[person('me','finance')]});assert.equal(await moving,true);await flush();f.presence.destroy();
 let time=0,ok=true;const g=heartbeatFixture(async()=>{if(ok)return{people:[person('me')]};throw new Error('offline');},{now:()=>time});await g.presence.refresh();ok=false;time=46000;await g.presence.refresh();assert.deepEqual(g.values.at(-1).people,[]);g.presence.destroy();
 const h=heartbeatFixture(async()=>{throw Object.assign(new Error('login expired'),{status:401});});await h.presence.refresh();assert.equal(h.values.at(-1).enabled,false);assert.equal(h.timers.size,0);await h.presence.refresh();assert.equal(h.calls.length,1);h.presence.destroy();
});

test('视角切换保留在线身份和中途位置，旧视角回调失效，不更改Agent或审批状态',async()=>{
 const scenes=[],layers=[],selected=[];const doc={createElement:()=>({style:{},dataset:{},remove(){},ownerDocument:doc})};const container={ownerDocument:doc,append:layer=>layers.push(layer)};
 const mount=()=>{const scene={states:[],update(state){this.states.push(state);},setTopology(){},setSelectedNode(){},setSelectedAgent(){},setSelectedHuman(){},setPresence(value){this.presence=value;},getPresenceState:()=>({positions:{me:{x:650,y:411}}}),destroy(){}};scenes.push(scene);return scene;};
 const controller=createSceneViewController(container,{}, {initialMode:'2d',warmup:false,mount2D:mount,load3D:async()=>({mountScene3D:mount})});const state={runId:'real-run',humanApproval:true,agents:[{id:'zhang',status:'working'}]};controller.update(state);controller.setPresence({enabled:true,people:[person('me','finance')],currentUserId:'me',onSelectEmployee:p=>selected.push(p.id)});const old=scenes[0].presence.onSelectEmployee;
 await controller.setMode('3d');assert.equal(scenes[1].presence.currentUserId,'me');assert.deepEqual(scenes[1].presence.positions.me,{x:650,y:411});assert.equal(scenes[1].states[0].humanApproval,true);assert.equal(scenes[1].states[0].agents,state.agents);old(person('me'));assert.deepEqual(selected,[]);scenes[1].presence.onSelectEmployee(person('me'));assert.deepEqual(selected,['me']);controller.destroy();
});

function svgFixture(){
 const keys=['document','ResizeObserver','requestAnimationFrame','cancelAnimationFrame','matchMedia'];const previous=Object.fromEntries(keys.map(k=>[k,globalThis[k]]));let markup='';const layers=new Map(),groups=new Map(),visibility=new Map();
 class Element{constructor(){this.attrs={};this.dataset={};this.children=[];this.innerHTML='';this.classes=new Set();this.listeners=new Map();this.style={setProperty(){}};this.classList={add:(...xs)=>xs.forEach(x=>this.classes.add(x)),remove:(...xs)=>xs.forEach(x=>this.classes.delete(x)),toggle:(x,on)=>{if(on??!this.classes.has(x))this.classes.add(x);else this.classes.delete(x);},contains:x=>this.classes.has(x)};}setAttribute(k,v){this.attrs[k]=v;}addEventListener(k,fn){this.listeners.set(k,fn);}removeEventListener(k){this.listeners.delete(k);}append(el){el.parent=this;this.children.push(el);}remove(){if(this.parent)this.parent.children=this.parent.children.filter(el=>el!==this);}querySelector(){return new Element();}}
 const svg=new Element();svg.querySelector=selector=>{if(selector.startsWith('#')){const id=selector.slice(1),match=markup.match(new RegExp(`<symbol id="${id}"[^>]*>([\\s\\S]*?)<\\/symbol>`));return{innerHTML:match?.[1]||''};}if(!layers.has(selector))layers.set(selector,new Element());return layers.get(selector);};svg.querySelectorAll=selector=>{if(groups.has(selector))return groups.get(selector);const pattern=selector==='[data-node]'?/<g class="cnl-node" data-node="([^"]+)"/g:selector==='[data-device]'?/<g class="cnl-device" data-device="([^"]+)"/g:/<g class="cnl-link" data-a="([^"]+)" data-b="([^"]+)"/g;const result=[...markup.matchAll(pattern)].map(m=>{const el=new Element();el.dataset[selector==='[data-node]'?'node':selector==='[data-device]'?'device':'a']=m[1];if(m[2])el.dataset.b=m[2];return el;});groups.set(selector,result);return result;};
 globalThis.document={hidden:false,createElementNS:()=>new Element(),addEventListener:(k,fn)=>visibility.set(k,fn),removeEventListener:k=>visibility.delete(k)};globalThis.ResizeObserver=class{observe(){}disconnect(){}};globalThis.requestAnimationFrame=()=>0;globalThis.cancelAnimationFrame=()=>{};globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});const container={set innerHTML(value){markup=value;},querySelector:()=>svg};const scene=mountScene(container);
 return{scene,layers,visibility,destroy(){scene.destroy();for(const k of keys)if(previous[k]===undefined)delete globalThis[k];else globalThis[k]=previous[k];}};
}

test('2D在线员工替换固定职能人物，实体便服工牌与直接点击，关闭后原画保持一致',()=>{
 const f=svgFixture(),selected=[];try{const fixed=f.layers.get('.cnl-human-layer').children;const before=fixed.map(el=>el.innerHTML),agentCount=f.layers.get('.cnl-agent-layer').children.length;
 f.scene.setPresence({enabled:true,currentUserId:'me',people:[person('me'),person('other','finance')],onSelectEmployee:p=>selected.push(p.id)});assert(fixed.every(el=>el.style.display==='none'));const real=f.layers.get('.cnl-presence-layer').children;assert.equal(real.length,2);assert(real.every(el=>!el.innerHTML.includes('cnl-human-card')&&!el.innerHTML.includes('cnl-human-halo')));assert.equal(real[0].dataset.current,'true');assert.equal(f.layers.get('.cnl-agent-layer').children.length,agentCount);real[0].listeners.get('click')({stopPropagation(){}});assert.deepEqual(selected,['me']);
 f.scene.setPresence({enabled:false,people:[]});assert.equal(f.layers.get('.cnl-presence-layer').children.length,0);assert(fixed.every(el=>el.style.display===''));assert.deepEqual(fixed.map(el=>el.innerHTML),before);assert.equal(fixed.length,HUMAN_EMPLOYEES.length);
 }finally{f.destroy();}assert.equal(f.visibility.size,0);
});

test('服务端坐标、姿态、占用座位和版本完整保留，越界与错误姿态不能进入画面',()=>{
 const seat=OFFICE_SEATS.find(seat=>seat.id==='research_staff_003'),source=person('me','research',{x:seat.x,y:seat.y,posture:'seated',seatId:seat.id,revision:4,appearanceKey:seat.id});const normalized=normalizeOfficePresence({enabled:true,currentUserId:'me',people:[source]}).people[0];assert.deepEqual(normalized.point,{x:seat.x,y:seat.y});assert.equal(normalized.posture,'seated');assert.equal(normalized.seatId,seat.id);assert.equal(normalized.revision,4);assert.equal(normalized.appearanceKey,seat.id);
 const invalid=normalizeOfficePresence({people:[person('bad','research',{x:1e6,y:20,posture:'unknown',revision:-3})]}).people[0];assert.equal(invalid.point,null);assert.equal(invalid.posture,'standing');assert.equal(invalid.revision,0);
});

test('移动、工位占座、空地坐下与起身按顺序提交，并在执行时读取最新版本',async()=>{
 const deferred=[],errors=[],ready=[];const f=heartbeatFixture((_path,_method,body)=>new Promise((resolve,reject)=>deferred.push({body,resolve,reject})),{onError:error=>errors.push(error),onReady:me=>ready.push(me.id)});try{
  await flush();assert.equal(deferred.length,1);deferred.shift().resolve({online:[person('me','research',{x:350,y:900,revision:3})]});await f.presence.ready;
  const seat=OFFICE_SEATS.find(seat=>seat.id==='research_staff_003'),move=f.presence.movePoint({x:450,y:1000}),sit=f.presence.sit(seat.id),stand=f.presence.stand(),floor=f.presence.sitAt({x:510,y:740});await flush();assert.equal(deferred.length,1,'commands never race each other');assert.deepEqual(deferred[0].body,{operation:'move',x:450,y:1000,expectedRevision:3});
  deferred.shift().resolve({online:[person('me','research',{x:450,y:1000,revision:4})]});assert.equal(await move,true);await flush();assert.deepEqual(deferred[0].body,{operation:'sit',seatId:seat.id,expectedRevision:4});
  deferred.shift().resolve({online:[person('me','research',{x:seat.x,y:seat.y,seatId:seat.id,posture:'seated',revision:5})]});assert.equal(await sit,true);await flush();assert.deepEqual(deferred[0].body,{operation:'stand',expectedRevision:5});
  deferred.shift().resolve({online:[person('me','research',{x:450,y:1000,revision:6})]});assert.equal(await stand,true);await flush();assert.deepEqual(deferred[0].body,{operation:'sit',x:510,y:740,expectedRevision:6});
  deferred.shift().resolve({online:[person('me','courtyard',{x:510,y:740,posture:'seated',revision:7})]});assert.equal(await floor,true);assert.equal(f.presence.self.posture,'seated');assert.equal(f.presence.self.seatId,undefined);assert.deepEqual(ready,['me']);assert.deepEqual(errors,[]);
  const before=f.calls.length;assert.equal(await f.presence.sit('invented-seat'),false);assert.equal(await f.presence.sitAt({x:0,y:0}),false);assert.equal(await f.presence.movePoint({x:NaN,y:400}),false);assert.equal(f.calls.length,before);
 }finally{f.presence.destroy();}
});

test('移动中的心跳排队合并，不能以旧快照覆盖新目的地或坐姿',async()=>{
 const deferred=[];const f=heartbeatFixture((_path,_method,body)=>new Promise(resolve=>deferred.push({body,resolve})));try{
  await flush();deferred.shift().resolve({online:[person('me','research',{x:350,y:900,revision:1})]});await f.presence.ready;
  const move=f.presence.movePoint({x:455,y:1030});await flush();assert.equal(deferred[0].body.operation,'move');const heartbeat1=f.presence.refresh(),heartbeat2=f.presence.refresh();assert.equal(heartbeat1,heartbeat2);await flush();assert.equal(deferred.length,1,'no heartbeat request exists until the pending move settles');
  deferred.shift().resolve({online:[person('me','research',{x:455,y:1030,revision:2})]});assert.equal(await move,true);await flush();assert.equal(f.values.at(-1).people[0].x,455);assert.deepEqual(deferred[0].body,{operation:'heartbeat',nodeId:'research'});deferred.shift().resolve({online:[person('me','research',{x:455,y:1030,revision:2})]});await heartbeat1;assert.equal(f.presence.self.x,455);assert.equal(f.presence.self.revision,2);
 }finally{f.presence.destroy();}
});

test('占座冲突保留错误并刷新权威状态，队列可继续，登录失效后排队动作不再提交',async()=>{
 let revision=1;const errors=[],f=heartbeatFixture(async(_path,_method,body)=>{if(body.operation==='sit')throw Object.assign(new Error('这个位置已有人'),{status:409});if(body.operation==='stand')revision++;return{online:[person('me','research',{x:350,y:900,revision})]};},{onError:error=>errors.push(error)});try{
  await f.presence.ready;assert.equal(await f.presence.sit('research_staff_003'),false);assert.deepEqual(errors,['这个位置已有人']);assert.deepEqual(f.calls.map(call=>call[2].operation),['heartbeat','sit','heartbeat']);assert.equal(await f.presence.stand(),true);assert.equal(f.presence.self.revision,2);
 }finally{f.presence.destroy();}
 let release;const g=heartbeatFixture((_path,_method,body)=>body.operation==='heartbeat'?Promise.resolve({online:[person('me','research',{revision:1})]}):new Promise((_resolve,reject)=>{release=reject;}));try{
  await g.presence.ready;const first=g.presence.movePoint({x:350,y:990}),second=g.presence.stand();await flush();release(Object.assign(new Error('expired'),{status:401}));assert.equal(await first,false);assert.equal(await second,false);assert.equal(g.calls.length,2);assert.equal(g.timers.size,0);assert.equal(g.values.at(-1).enabled,false);
 }finally{g.presence.destroy();}
});

test('在途坐姿目标、重复心跳与跨视角种子保持实际路程，不跳回部门默认入口',()=>{
 let time=0;const target={x:480,y:1020},motion=createOfficePresenceMotion({now:()=>time});const state={enabled:true,currentUserId:'me',people:[person('me','research',{x:350,y:1000,revision:1})]};motion.set(state);motion.set({...state,people:[person('me','research',{...target,seatId:'research_staff_003',posture:'seated',revision:2})]});const started=motion.entries.get('me').motion.started;time=400;motion.tick(time);const halfway={...motion.entries.get('me').point};motion.set({...state,people:[person('me','research',{...target,seatId:'research_staff_003',posture:'seated',revision:2})]});assert.equal(motion.entries.get('me').motion.started,started);
 const next=createOfficePresenceMotion({now:()=>time});next.set({...state,positions:motion.snapshot().positions,people:[person('me','research',{...target,seatId:'research_staff_003',posture:'seated',revision:2})]});assert.deepEqual(next.entries.get('me').point,halfway);assert.deepEqual(next.entries.get('me').target,target);assert.equal(next.entries.get('me').person.posture,'seated');time=30000;next.tick(time);assert.deepEqual(next.entries.get('me').point,target);assert.equal(next.busy,false);motion.destroy();next.destroy();
});

test('销毁后排队动作与慢响应都不能重建员工或触发就绪回调',async()=>{
 let release;const ready=[],f=heartbeatFixture(()=>new Promise(resolve=>{release=resolve;}),{onReady:person=>ready.push(person.id)});await flush();const move=f.presence.movePoint({x:350,y:1000});f.presence.destroy();const count=f.values.length;release({online:[person('me','research',{revision:1})]});await f.presence.ready;assert.equal(await move,false);assert.equal(f.calls.length,1);assert.equal(f.values.length,count);assert.deepEqual(ready,[]);assert.equal(f.timers.size,0);
});

test('switching back to a cached renderer rebases an existing person at the drawn position with a fresh route clock',()=>{
 let clock=0;const motion=createOfficePresenceMotion({now:()=>clock}),base={enabled:true,currentUserId:'me',people:[person('me','research',{x:500,y:1058})]};
 try{
  motion.set(base);const entry=motion.entries.get('me');assert.deepEqual(entry.point,{x:500,y:1058});clock=10000;
  motion.set({...base,people:[person('me','research',{x:800,y:1058})],positions:{me:{x:650,y:1058}},rebase:true});
  assert.equal(motion.entries.get('me'),entry,'the same cached identity is retained');assert.deepEqual(entry.point,{x:650,y:1058});assert.equal(entry.motion.started,10000);assert.equal(entry.lastTick,10000);assert.equal(entry.sample,null);
  motion.shiftTime(10000,{since:0});assert.equal(entry.motion.started,10000,'freshly restored walks do not inherit the inactive interval');assert.equal(entry.lastTick,10000);
  clock=10050;motion.tick(clock);assert.notDeepEqual(entry.point,{x:650,y:1058});assert.ok(Math.hypot(entry.point.x-650,entry.point.y-1058)>.01,'the new walk advances immediately instead of freezing');
 }finally{motion.destroy();}
});

test('rebasing with an unchanged server destination replaces the stale cached point, while invalid positions snap safely',()=>{
 let clock=0;const motion=createOfficePresenceMotion({now:()=>clock}),base={enabled:true,people:[person('me','research',{x:800,y:1058})]};
 try{motion.set(base);clock=5000;motion.set({...base,positions:{me:{x:650,y:1058}},rebase:true});const entry=motion.entries.get('me');assert.deepEqual(entry.point,{x:650,y:1058});assert.equal(entry.motion.started,5000);motion.set({...base,positions:{me:{x:Infinity,y:0}},rebase:true});assert.deepEqual(entry.point,{x:800,y:1058});assert.equal(entry.motion,null);assert.equal(entry.sample,null);}
 finally{motion.destroy();}
});

test('pause adjustment shifts old routes fully and newly created routes only for time actually spent inactive',()=>{
 let clock=0;const motion=createOfficePresenceMotion({now:()=>clock});try{
  motion.set({enabled:true,people:[person('old','research',{x:500,y:1058})]});motion.set({enabled:true,people:[person('old','research',{x:800,y:1058})]});clock=5000;
  motion.set({enabled:true,people:[person('old','research',{x:800,y:1058}),person('new','research',{x:800,y:1058})],positions:{new:{x:650,y:1058}}});
  motion.shiftTime(10000,{since:0});assert.equal(motion.entries.get('old').motion.started,10000);assert.equal(motion.entries.get('new').motion.started,10000);assert.equal(motion.entries.get('new').lastTick,10000);
 }finally{motion.destroy();}
});

test('an obsolete navigation waiting behind a heartbeat is skipped before the HTTP move is sent',async()=>{
 let release;const f=heartbeatFixture(()=>new Promise(resolve=>release=resolve));try{await flush();let valid=true;const old=f.presence.movePoint(presencePosition('finance'),{shouldRun:()=>valid}),next=f.presence.movePoint(presencePosition('research'),{shouldRun:()=>true});valid=false;release({online:[person('me','hr_admin',{revision:1})]});await flush();assert.equal(f.calls.filter(([, ,body])=>body.operation==='move').length,1);assert.deepEqual({x:f.calls.at(-1)[2].x,y:f.calls.at(-1)[2].y},presencePosition('research'));release({online:[person('me','research',{revision:2})]});assert.equal(await old,false);assert.equal(await next,true);}finally{f.presence.destroy();}
});
