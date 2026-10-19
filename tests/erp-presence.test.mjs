import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOfficePresence,MAX_OFFICE_PEOPLE,PRESENCE_NODE_IDS,presencePosition,createOfficePresenceMotion,mountErpPresence} from '../dist/erp-presence.js';
import {FLOOR_SEGMENTS,routeBetweenPoints} from '../dist/scene-motion.js';
import {createSceneViewController} from '../dist/scene-view.js';
import {mountScene} from '../dist/scene.js';
import {HUMAN_EMPLOYEES} from '../dist/people.js';

const person=(id,nodeId='workstations',extra={})=>({id,name:'员工'+id,title:'项目专员',nodeId,online:true,...extra});
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('在线人物只展示已登录身份，离线/重复项剔除，最多20人并保留本人',()=>{
 const people=Array.from({length:30},(_,i)=>person('user-'+i));people.push(person('offline','meeting',{online:false}),person('user-1','finance'));
 const state=normalizeOfficePresence({enabled:true,people,currentUserId:'user-29'});assert.equal(state.people.length,MAX_OFFICE_PEOPLE);assert.equal(state.people[0].id,'user-29');assert.equal(state.people[0].current,true);assert.equal(state.people.some(p=>p.id==='offline'),false);assert.equal(new Set(state.people.map(p=>p.id)).size,20);
 assert.notEqual(state.people[0].title,'老板');assert.equal(normalizeOfficePresence({people}).enabled,false);assert.equal(normalizeOfficePresence({enabled:true,people:[person('valid','bad-node')]}).people[0].nodeId,'workstations');
});

test('所有在线员工目的地都在现有办公室通道中，拥挤时仍不穿越墙体',()=>{
 const onFloor=p=>FLOOR_SEGMENTS.some(([a,b])=>Math.abs((b[0]-a[0])*(p.y-a[1])-(b[1]-a[1])*(p.x-a[0]))<.001&&p.x>=Math.min(a[0],b[0])&&p.x<=Math.max(a[0],b[0])&&p.y>=Math.min(a[1],b[1])&&p.y<=Math.max(a[1],b[1]));
 for(const nodeId of PRESENCE_NODE_IDS)for(let i=0;i<20;i++){const p=presencePosition(nodeId,i,20);assert(onFloor(p),nodeId+JSON.stringify(p));const route=routeBetweenPoints(p,presencePosition('workstations'));assert(route.length>=1);assert(route.every(q=>Number.isFinite(q.x)&&Number.isFinite(q.y)));}
});

test('人物首次出现不重放走路，部门变化沿真实通道走动，心跳不重置当前行程',()=>{
 let time=0;const changes=[],motion=createOfficePresenceMotion({now:()=>time,onChange:entry=>changes.push({...entry.point})});
 const base={enabled:true,currentUserId:'user',people:[person('user')]};motion.set(base);assert.equal(motion.busy,false);const start={...motion.entries.get('user').point};
 motion.set({...base,people:[person('user','finance')]});assert.equal(motion.busy,true);const route=motion.entries.get('user').motion.route;assert(route.some(p=>p.y===411),'跨部门先通过主走廊');time=500;motion.tick(time);const halfway={...motion.entries.get('user').point};assert.notDeepEqual(halfway,start);
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

test('在线心跳只调用presence接口，15秒更新自身位置，并复用响应的在线名单',async()=>{
 const f=heartbeatFixture(async(_path,_method,body)=>({online:[person('me',body.nodeId),person('other','finance')]}));await f.presence.refresh();assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0],['/api/erp/presence','PUT',{nodeId:'workstations'}]);assert.equal([...f.timers.values()][0].ms,15000);assert.equal(f.values.at(-1).people.length,2);assert.equal(f.values.at(-1).currentUserId,'me');
 await f.presence.moveTo('meeting');assert.equal(f.calls.at(-1)[2].nodeId,'meeting');assert.equal(await f.presence.moveTo('unknown'),false);assert(f.calls.every(([url])=>url==='/api/erp/presence'));f.presence.destroy();assert.equal(f.timers.size,0);assert.equal(f.listeners.size,0);assert.equal(f.values.at(-1).enabled,false);
});

test('后台暂停心跳，前台立即刷新，销毁后迟到响应不能恢复在线人物',async()=>{
 const f=heartbeatFixture(async()=>({online:[person('me')]}));await f.presence.refresh();f.doc.hidden=true;f.listeners.get('visibilitychange')();assert.equal(f.timers.size,0);await f.presence.refresh();assert.equal(f.calls.length,1);
 f.doc.hidden=false;f.listeners.get('visibilitychange')();await f.presence.refresh();assert.equal(f.calls.length,2);assert.equal(f.timers.size,1);f.presence.destroy();
 let resolve;const g=heartbeatFixture(()=>new Promise(yes=>{resolve=yes;}));await flush();g.presence.destroy();const count=g.values.length;resolve({online:[person('me')]});await flush();assert.equal(g.values.length,count);assert.equal(g.timers.size,0);
});

test('移动期间合并心跳并发送最新位置，网络断开不永久展示旧在线状态，401停用',async()=>{
 let release;const f=heartbeatFixture(()=>new Promise(yes=>{release=yes;}));await flush();const moving=f.presence.moveTo('finance');release({online:[person('me')]});await moving;await flush();assert.equal(f.calls.at(-1)[2].nodeId,'finance');release({online:[person('me','finance')]});await flush();f.presence.destroy();
 let time=0,ok=true;const g=heartbeatFixture(async()=>{if(ok)return{people:[person('me')]};throw new Error('offline');},{now:()=>time});await g.presence.refresh();ok=false;time=46000;await g.presence.refresh();assert.deepEqual(g.values.at(-1).people,[]);g.presence.destroy();
 const h=heartbeatFixture(async()=>{throw Object.assign(new Error('login expired'),{status:401});});await h.presence.refresh();assert.equal(h.values.at(-1).enabled,false);assert.equal(h.timers.size,0);await h.presence.refresh();assert.equal(h.calls.length,1);h.presence.destroy();
});

test('视角切换保留在线身份和中途位置，旧视角回调失效，不更改Agent或审批状态',async()=>{
 const scenes=[],layers=[],selected=[];const doc={createElement:()=>({style:{},remove(){},ownerDocument:doc})};const container={ownerDocument:doc,append:layer=>layers.push(layer)};
 const mount=()=>{const scene={states:[],update(state){this.states.push(state);},setTopology(){},setSelectedNode(){},setSelectedAgent(){},setSelectedHuman(){},setPresence(value){this.presence=value;},getPresenceState:()=>({positions:{me:{x:650,y:411}}}),destroy(){}};scenes.push(scene);return scene;};
 const controller=createSceneViewController(container,{}, {mount2D:mount,load3D:async()=>({mountScene3D:mount})});const state={runId:'real-run',humanApproval:true,agents:[{id:'zhang',status:'working'}]};controller.update(state);controller.setPresence({enabled:true,people:[person('me','finance')],currentUserId:'me',onSelectEmployee:p=>selected.push(p.id)});const old=scenes[0].presence.onSelectEmployee;
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
