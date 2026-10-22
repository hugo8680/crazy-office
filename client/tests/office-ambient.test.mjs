import test from 'node:test';
import assert from 'node:assert/strict';
import {createOfficeAmbientSelector,mountOfficeAmbient,selectOfficeAmbient} from '../src/office-ambient.mjs';

function seeded(seed=1){return()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};}
function population(count=60){return Array.from({length:count},(_,index)=>({id:`person-${String(index).padStart(3,'0')}`,kind:index%11===0?'virtual':index%7===0?'human':'post',...(index%11&&index%7?{seatId:`seat-${index}`} :{}),x:(index%10)*75,y:Math.floor(index/10)*75,seated:true,canSip:index%11===0}));}
function fixture(people=population(60)){
  let clock=0,serial=0,blocked=false,maxTimers=0;
  const timers=new Map(),listeners=new Map(),mediaListeners=new Set(),starts=[],ends=[];
  const document={visibilityState:'visible',addEventListener:(name,callback)=>listeners.set(name,callback),removeEventListener:(name,callback)=>{if(listeners.get(name)===callback)listeners.delete(name);}};
  const mediaQuery={matches:false,addEventListener:(_,callback)=>mediaListeners.add(callback),removeEventListener:(_,callback)=>mediaListeners.delete(callback)};
  const options={getPeople:()=>people,isBlocked:()=>blocked,onStart:a=>starts.push(a),onEnd:a=>ends.push(a),document,mediaQuery,random:seeded(13),now:()=>clock,setTimer:(callback,delay)=>{const id=++serial;timers.set(id,{callback,at:clock+delay});maxTimers=Math.max(maxTimers,timers.size);return id;},clearTimer:id=>timers.delete(id)};
  const advance=ms=>{const target=clock+ms;let iterations=0;for(;;){const first=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!first||first[1].at>target)break;if(++iterations>10000)throw Error('timer did not settle');timers.delete(first[0]);clock=first[1].at;first[1].callback();}clock=target;};
  const runNext=()=>{const first=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(first)advance(first[1].at-clock);return !!first;};
  return{options,advance,runNext,timers,starts,ends,document,mediaQuery,listeners,mediaListeners,get clock(){return clock;},get maxTimers(){return maxTimers;},setBlocked:value=>{blocked=value;},visibility:value=>{document.visibilityState=value;listeners.get('visibilitychange')?.();},motion:value=>{mediaQuery.matches=value;for(const callback of mediaListeners)callback();}};
}
function assertBatch(activity){
  assert.ok(activity.duration>=2800&&activity.duration<=4500);
  assert.ok(activity.participants.length>=1&&activity.participants.length<=8);
  assert.equal(new Set(activity.participants.map(person=>person.id)).size,activity.participants.length);
  assert.ok(Object.isFrozen(activity));assert.ok(Object.isFrozen(activity.participants));
  for(const person of activity.participants){assert.ok(person.delay>=0);assert.ok(person.duration>0);assert.ok(person.delay+person.duration<=activity.duration);assert.ok(Object.isFrozen(person));if(person.kind==='post')assert.notEqual(person.pose,'sip');}
}

test('one-shot previews are repeatable, finite and preserve all original person coordinates',()=>{
  const people=population(60),before=JSON.stringify(people),first=selectOfficeAmbient(people,12,123);
  assert.deepEqual(first,selectOfficeAmbient([...people].reverse(),12,123));assert.equal(first.startedAt,123);assertBatch(first);
  assert.equal(JSON.stringify(people),before);
  const invalid=selectOfficeAmbient(people,NaN,Infinity);assert.equal(invalid.id,'ambient-0');assert.equal(invalid.startedAt,0);
  assert.equal(selectOfficeAmbient([]),null);
});

test('60 and 250 eligible people all receive a turn before anyone repeats, including seated posts',()=>{
  for(const count of [60,250]){
    const people=population(count),selector=createOfficeAmbientSelector({random:seeded(count)}),seen=new Set();let time=0,batches=0;
    while(seen.size<count&&batches<count){
      const activity=selector.next(people,batches++,time);assert.ok(activity);assertBatch(activity);
      for(const person of activity.participants){assert.equal(seen.has(person.id),false,`${person.id} repeated before the ${count}-person round finished`);seen.add(person.id);}
      time+=activity.duration+1500;
    }
    assert.equal(seen.size,count);assert.ok(batches<=Math.ceil(count/3));
  }
});

test('different injected random sources produce different casts and every supported static pose appears',()=>{
  const people=population(60),left=createOfficeAmbientSelector({random:seeded(2)}).next(people),right=createOfficeAmbientSelector({random:seeded(99)}).next(people);
  assert.notDeepEqual(left.participants.map(p=>p.id),right.participants.map(p=>p.id));
  const poses=new Set();
  for(let turn=0;turn<1500;turn++){
    const activity=selectOfficeAmbient([{id:'post',kind:'post',seatId:'desk',seated:true,x:0,y:0,canSip:true}],turn);
    const person=activity.participants[0];poses.add(person.pose);assert.notEqual(person.pose,'sip');
  }
  assert.deepEqual([...poses].sort(),['look','nod','settle','stretch','typing','wave']);
});

test('paired interactions only include reciprocal neighbours in the same area and remain two-person clusters',()=>{
  const people=population(60).map((person,index)=>({...person,areaId:index<30?'west':'east'})),selector=createOfficeAmbientSelector({random:seeded(38)});let paired=0;
  for(let turn=0;turn<70;turn++){
    const activity=selector.next(people,turn,turn*6000);assert.ok(activity);assertBatch(activity);
    for(const person of activity.participants){
      if(!person.partnerId)continue;paired++;
      const partner=activity.participants.find(other=>other.id===person.partnerId);assert.ok(partner);assert.equal(partner.partnerId,person.id);assert.equal(partner.areaId,person.areaId);
      const distance=Math.hypot(person.x-partner.x,person.y-partner.y);assert.ok(distance>12&&distance<=130);
      assert.ok(['greet','chatter'].includes(person.interaction));assert.equal(partner.interaction,person.interaction);
    }
  }
  assert.ok(paired>20);
  for(const people of [[{id:'a',kind:'post',x:0,y:0},{id:'b',kind:'post',x:5,y:5}],[{id:'a',kind:'post',x:0,y:0,areaId:'a'},{id:'b',kind:'post',x:30,y:0,areaId:'b'}]]){
    for(let turn=0;turn<30;turn++)assert.ok(selectOfficeAmbient(people,turn).participants.every(person=>person.partnerId===null));
  }
});

test('invalid, duplicate, busy and standing candidates cannot produce unsupported poses or duplicate identities',()=>{
  const duplicate={id:'same',kind:'post',seatId:'desk',x:0,y:0,seated:true};
  assert.equal(selectOfficeAmbient([{id:'invalid',kind:'human',x:NaN,y:0}]),null);
  assert.equal(selectOfficeAmbient([{...duplicate,busy:true}]),null);
  assert.equal(selectOfficeAmbient([{...duplicate,kind:'unknown'}]),null);
  assert.equal(selectOfficeAmbient([duplicate,duplicate]).participants.length,1);
  for(let turn=0;turn<200;turn++){
    assert.notEqual(selectOfficeAmbient([{id:'human',kind:'human',x:0,y:0}],turn).participants[0].pose,'typing');
    assert.notEqual(selectOfficeAmbient([{id:'human',kind:'human',x:0,y:0,canSip:false}],turn).participants[0].pose,'sip');
  }
});

test('per-person cooldown persists through visibility changes and only schedules the next exact availability',()=>{
  const selector=createOfficeAmbientSelector({random:seeded(91),cooldownMs:6500}),person={id:'one',kind:'post',seatId:'one',x:0,y:0,seated:true};
  const first=selector.next([person],0,0);assert.ok(first);
  assert.equal(selector.next([person],1,5000),null);
  const wait=selector.wait([person],5000);assert.ok(wait>=1500&&wait<=1580);
  assert.equal(selector.next([],2,5100),null);assert.equal(selector.wait([],5100),null);
  assert.equal(selector.next([person],3,5200),null,'leaving and re-entering the view bypassed the personal cooldown');
  const second=selector.next([person],4,6500+first.participants[0].delay);assert.ok(second);
});

test('scheduler runs staggered bounded batches with one timer and a short gap without repeated polling',()=>{
  const f=fixture(),ambient=mountOfficeAmbient(f.options),initial=[...f.timers.values()][0].at;
  assert.ok(initial>=300&&initial<=700);f.advance(initial-1);assert.equal(f.starts.length,0);f.advance(1);
  assert.equal(f.starts.length,1);assertBatch(ambient.active);assert.ok(new Set(ambient.active.participants.map(p=>p.delay)).size>1);
  const duration=ambient.active.duration;f.advance(duration-1);assert.equal(f.ends.length,0);f.advance(1);assert.equal(f.ends.length,1);assert.equal(ambient.active,null);
  const gap=[...f.timers.values()][0].at-f.clock;assert.ok(gap>=180&&gap<=500);f.advance(gap);assert.equal(f.starts.length,2);
  f.advance(180000);assert.equal(f.maxTimers,1);assert.equal(f.timers.size,1);assert.ok(f.starts.length>20);
  for(const activity of f.starts)assertBatch(activity);
  ambient.destroy();assert.equal(f.timers.size,0);
});

test('inactive scene blocking immediately cancels all poses and leave no background polling',()=>{
  const f=fixture(),ambient=mountOfficeAmbient(f.options);f.runNext();assert.ok(ambient.active);
  f.setBlocked(true);ambient.refresh();assert.equal(ambient.active,null);assert.equal(f.ends.length,1);assert.equal(f.timers.size,0);
  f.advance(100000);assert.equal(f.starts.length,1);
  f.setBlocked(false);ambient.refresh();f.runNext();assert.equal(f.starts.length,2);assert.equal(f.maxTimers,1);ambient.destroy();
});

test('hidden and reduced-motion states stop all activity and never replay elapsed rounds',()=>{
  const f=fixture(),ambient=mountOfficeAmbient(f.options);f.runNext();f.visibility('hidden');assert.equal(f.ends.length,1);assert.equal(f.timers.size,0);
  f.advance(900000);f.visibility('visible');assert.equal(f.starts.length,1);f.runNext();assert.equal(f.starts.length,2);
  f.motion(true);assert.equal(ambient.active,null);assert.equal(f.timers.size,0);
  f.advance(900000);f.motion(false);f.runNext();assert.equal(f.starts.length,3);
  ambient.destroy();assert.equal(f.listeners.size,0);assert.equal(f.mediaListeners.size,0);
});

test('an individual becoming busy or moving stops only their gesture, without interrupting colleagues',()=>{
  const people=population(60),f=fixture(people);let current=people;f.options.getPeople=()=>current;
  const ambient=mountOfficeAmbient(f.options),initial=[...f.timers.values()][0].at;
  for(let i=0;i<3;i++){f.advance(50);ambient.refresh();}assert.equal([...f.timers.values()][0].at,initial);
  f.runNext();const batch=ambient.active,first=batch.participants[0],second=batch.participants[1],third=batch.participants[2],deadline=[...f.timers.values()][0].at;
  current=people.map(person=>person.id===first.id?{...person,busy:true}:person);ambient.refresh();
  assert.equal(ambient.active.id,batch.id);assert.equal(ambient.active.participants.length,batch.participants.length-1);assert.deepEqual(f.ends[0].participants.map(p=>p.id),[first.id]);assert.equal([...f.timers.values()][0].at,deadline);
  current=current.map(person=>person.id===second.id?{...person,x:person.x+20}:person);ambient.refresh();assert.deepEqual(f.ends[1].participants.map(p=>p.id),[second.id]);
  current=current.filter(person=>person.id!==third.id);ambient.refresh();assert.deepEqual(f.ends[2].participants.map(p=>p.id),[third.id]);assert.ok(ambient.active.participants.length>0);
  f.advance(deadline-f.clock);assert.equal(ambient.active,null);assert.equal(f.ends[3].participants.length,batch.participants.length-3);
  ambient.pause();assert.equal(f.timers.size,0);ambient.resume();f.runNext();assert.equal(f.starts.length,2);
  ambient.destroy();ambient.destroy();ambient.refresh();f.advance(100000);assert.equal(f.starts.length,2);assert.equal(f.timers.size,0);assert.equal(f.maxTimers,1);
});

test('every employee in a sixty-person viewport receives an idle gesture within fifty seconds',()=>{
  const f=fixture(population(60)),ambient=mountOfficeAmbient(f.options);f.advance(50000);
  assert.equal(new Set(f.starts.flatMap(batch=>batch.participants.map(person=>person.id))).size,60);
  assert.ok(f.starts.every(batch=>batch.participants.length<=8));assert.equal(f.maxTimers,1);ambient.destroy();
});

test('an empty scene sleeps until refreshed and tolerates missing DOM APIs or onStart destruction',()=>{
  const f=fixture([]);let current=[];f.options.getPeople=()=>current;f.options.document={};f.options.mediaQuery={};
  const ambient=mountOfficeAmbient(f.options);f.runNext();assert.equal(f.timers.size,0);assert.equal(f.starts.length,0);
  current=population(60);ambient.refresh();f.runNext();assert.equal(f.starts.length,1);ambient.destroy();
  const g=fixture();let self;g.options.onStart=()=>self.destroy();self=mountOfficeAmbient(g.options);g.runNext();assert.equal(self.active,null);assert.equal(g.timers.size,0);assert.equal(g.ends.length,1);
});
