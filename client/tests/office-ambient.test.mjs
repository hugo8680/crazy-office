import test from 'node:test';
import assert from 'node:assert/strict';
import {mountOfficeAmbient,selectOfficeAmbient} from '../src/office-ambient.mjs';

const people=[{id:'a',kind:'virtual',x:10,y:10},{id:'b',kind:'human',x:40,y:40},{id:'c',kind:'human',x:900,y:800,seated:true}];
function fixture(){
  let clock=0,serial=0,blocked=false;
  const timers=new Map(),listeners=new Map(),mediaListeners=new Set(),starts=[],ends=[];
  const document={visibilityState:'visible',addEventListener:(name,callback)=>listeners.set(name,callback),removeEventListener:(name,callback)=>{if(listeners.get(name)===callback)listeners.delete(name);}};
  const mediaQuery={matches:false,addEventListener:(_,callback)=>mediaListeners.add(callback),removeEventListener:(_,callback)=>mediaListeners.delete(callback)};
  const options={getPeople:()=>people,isBlocked:()=>blocked,onStart:a=>starts.push(a),onEnd:a=>ends.push(a),document,mediaQuery,now:()=>clock,setTimer:(callback,delay)=>{const id=++serial;timers.set(id,{callback,at:clock+delay});return id;},clearTimer:id=>timers.delete(id)};
  const advance=ms=>{const target=clock+ms;for(;;){const first=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!first||first[1].at>target)break;timers.delete(first[0]);clock=first[1].at;first[1].callback();}clock=target;};
  return{options,advance,timers,starts,ends,document,mediaQuery,listeners,mediaListeners,setBlocked:value=>{blocked=value;},visibility:value=>{document.visibilityState=value;listeners.get('visibilitychange')?.();},motion:value=>{mediaQuery.matches=value;for(const callback of mediaListeners)callback();}};
}

test('idle selection is deterministic, bounded to two nearby people and never mutates positions',()=>{
  const before=JSON.stringify(people),activity=selectOfficeAmbient(people,0,123);
  assert.deepEqual(activity,selectOfficeAmbient([...people].reverse(),0,123));
  assert.equal(activity.type,'greet');assert.equal(activity.participants.length,2);
  assert.equal(activity.participants[0].pose,'wave');assert.equal(activity.participants[1].pose,'nod');
  assert.equal(activity.startedAt,123);assert.equal(activity.duration,2400);
  assert.equal(JSON.stringify(people),before);assert.ok(Object.isFrozen(activity.participants[0]));
  const seen=new Set(Array.from({length:6},(_,i)=>selectOfficeAmbient(people,i).participants[0].id));
  assert.equal(seen.size,3);
});

test('idle candidates exclude invalid, duplicate and busy people; standing humans do not type',()=>{
  assert.equal(selectOfficeAmbient([{id:'invalid',kind:'human',x:NaN,y:0}]),null);
  assert.equal(selectOfficeAmbient([{...people[0],busy:true}]),null);
  assert.equal(selectOfficeAmbient([people[0],people[0]]).participants.length,1);
  assert.equal(selectOfficeAmbient([{id:'human',kind:'human',x:0,y:0}],3).type,'look');
  assert.equal(selectOfficeAmbient([{id:'human',kind:'human',x:0,y:0,seated:true}],3).type,'typing');
  assert.equal(selectOfficeAmbient([people[0]],3).type,'typing','virtual employee can use a handheld terminal');
  assert.equal(selectOfficeAmbient(people,NaN,Infinity).id,'ambient-0');
  assert.equal(selectOfficeAmbient(people,NaN,Infinity).startedAt,0);
});

test('scheduler starts after 1.5 seconds and ends finite poses before spacing the next round',()=>{
  const f=fixture(),ambient=mountOfficeAmbient(f.options);
  f.advance(1499);assert.equal(f.starts.length,0);assert.equal(f.timers.size,1);
  f.advance(1);assert.equal(f.starts.length,1);assert.equal(ambient.active.id,'ambient-0');
  f.advance(2399);assert.equal(f.ends.length,0);
  f.advance(1);assert.equal(f.ends.length,1);assert.equal(ambient.active,null);
  f.advance(6999);assert.equal(f.starts.length,1);
  f.advance(1);assert.equal(f.starts.length,2);assert.equal(f.timers.size,1);
  ambient.destroy();assert.equal(f.timers.size,0);
});

test('business and hover blocking immediately cancel active poses and stop all polling',()=>{
  const f=fixture(),ambient=mountOfficeAmbient(f.options);f.advance(1500);
  f.setBlocked(true);ambient.refresh();
  assert.equal(ambient.active,null);assert.equal(f.ends.length,1);assert.equal(f.timers.size,0);
  f.advance(100000);assert.equal(f.starts.length,1);
  f.setBlocked(false);ambient.refresh();f.advance(1499);assert.equal(f.starts.length,1);
  f.advance(1);assert.equal(f.starts.length,2);
  ambient.destroy();
});

test('hidden and reduced-motion states cancel activity and never replay elapsed rounds',()=>{
  const f=fixture(),ambient=mountOfficeAmbient(f.options);f.advance(1500);f.visibility('hidden');
  assert.equal(f.ends.length,1);assert.equal(f.timers.size,0);
  f.advance(900000);f.visibility('visible');assert.equal(f.starts.length,1);
  f.advance(1500);assert.equal(f.starts.length,2);
  f.motion(true);assert.equal(ambient.active,null);assert.equal(f.timers.size,0);
  f.motion(false);f.advance(1500);assert.equal(f.starts.length,3);
  ambient.destroy();assert.equal(f.listeners.size,0);assert.equal(f.mediaListeners.size,0);
});

test('refresh respects active participants becoming busy and repeated refreshes do not reset the clock',()=>{
  const f=fixture();let current=[...people];f.options.getPeople=()=>current;
  const ambient=mountOfficeAmbient(f.options);
  for(let i=0;i<15;i++){f.advance(100);ambient.refresh();}
  assert.equal(f.starts.length,1);
  current=[people[2]];ambient.refresh();assert.equal(f.ends.length,1);
  f.advance(1500);assert.deepEqual(f.starts.at(-1).participants.map(p=>p.id),['c']);
  ambient.pause();assert.equal(f.timers.size,0);ambient.resume();f.advance(1500);assert.equal(f.starts.length,3);
  ambient.destroy();ambient.destroy();ambient.refresh();f.advance(100000);
  assert.equal(f.starts.length,3);assert.equal(f.timers.size,0);
});

test('scheduler tolerates absent DOM APIs and a renderer destroying itself during onStart',()=>{
  const f=fixture();let ambient;f.options.document={};f.options.mediaQuery={};f.options.onStart=()=>ambient.destroy();
  ambient=mountOfficeAmbient(f.options);f.advance(1500);
  assert.equal(ambient.active,null);assert.equal(f.timers.size,0);assert.equal(f.ends.length,1);
});
