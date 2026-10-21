/* Idle poses are presentation only. Every visible person joins a shuffled turn
 * queue; poses neither move people nor create ERP activity. A single finite timer
 * owns each batch and its gap. Hidden, reduced-motion and busy scenes stay quiet. */
const finite=number=>Number.isFinite(number);
const kinds=new Set(['virtual','human','post']);
const basePoses=['look','nod','typing','wave','stretch','settle'];
const MAX_PARTICIPANTS=6,NEIGHBOR_DISTANCE=130,MIN_NEIGHBOR_DISTANCE=12;
const unit=random=>{const value=Number(random());return finite(value)?Math.max(0,Math.min(1-Number.EPSILON,value)):.5;};
const between=(random,min,max)=>min+unit(random)*(max-min);
const integer=(random,min,max)=>Math.floor(between(random,min,max+1));
function eligible(person){return !!person&&typeof person.id==='string'&&!!person.id&&kinds.has(person.kind)&&finite(person.x)&&finite(person.y)&&!person.busy;}
function candidates(people){
  const seen=new Set(),out=[];
  for(const person of Array.isArray(people)?people:[]){
    if(!eligible(person)||seen.has(person.id))continue;seen.add(person.id);
    const {id,kind,x,y,seated,seatId,areaId,canSip}=person;
    out.push({id,kind,x,y,seated:!!seated,...(typeof seatId==='string'?{seatId}:{}),...(typeof areaId==='string'?{areaId}:{}),canSip:kind!=='post'&&canSip!==false});
  }
  return out.sort((a,b)=>a.id.localeCompare(b.id));
}
function shuffle(ids,random){
  const next=[...ids];for(let index=next.length-1;index>0;index--){const other=integer(random,0,index);[next[index],next[other]]=[next[other],next[index]];}return next;
}
function poseFor(person,random){
  const poses=basePoses.filter(pose=>pose!=='typing'||person.seated||person.kind==='virtual');
  if(person.canSip)poses.push('sip');return poses[integer(random,0,poses.length-1)];
}
function near(a,b){
  if(a.areaId&&b.areaId&&a.areaId!==b.areaId)return false;
  const distance=Math.hypot(a.x-b.x,a.y-b.y);return distance>MIN_NEIGHBOR_DISTANCE&&distance<=NEIGHBOR_DISTANCE;
}

// Stateful selection keeps every eligible person in a shuffled round. A nearby
// partner also spends their turn; popular neighbours cannot repeatedly jump the
// queue. New visible people join the current round and removed people drop out.
export function createOfficeAmbientSelector({random=Math.random,cooldownMs=6500}={}){
  random=typeof random==='function'?random:Math.random;
  const cooldown=finite(cooldownMs)?Math.max(0,cooldownMs):6500,lastStarted=new Map();
  let bag=[],round=new Set();
  function sync(people){
    const available=candidates(people),byId=new Map(available.map(person=>[person.id,person]));
    bag=bag.filter(id=>byId.has(id));
    for(const id of round)if(!byId.has(id))round.delete(id);
    const newcomers=available.filter(person=>!round.has(person.id));
    if(newcomers.length){bag.push(...shuffle(newcomers.map(person=>person.id),random));for(const person of newcomers)round.add(person.id);}
    if(!bag.length&&available.length){bag=shuffle(available.map(person=>person.id),random);round=new Set(bag);}
    // This is a local presentation cache, never a persistent employee directory.
    if(lastStarted.size>4096)for(const id of lastStarted.keys()){if(!byId.has(id))lastStarted.delete(id);if(lastStarted.size<=4096)break;}
    return {available,byId};
  }
  const ready=(id,time)=>!lastStarted.has(id)||time-lastStarted.get(id)>=cooldown;
  return {
    next(people,sequence=0,startedAt=0){
      const time=finite(startedAt)?startedAt:0,turn=finite(sequence)?Math.max(0,Math.floor(sequence)):0;
      const {available,byId}=sync(people);if(!available.length)return null;
      const duration=integer(random,2800,4500),target=integer(random,Math.min(3,available.length),Math.min(MAX_PARTICIPANTS,available.length)),selected=[];
      while(selected.length<target){
        const index=bag.findIndex(id=>ready(id,time));if(index<0)break;
        const [id]=bag.splice(index,1),person=byId.get(id);
        const item={...person,pose:poseFor(person,random),partnerId:null,interaction:null};selected.push(item);
        if(selected.length>=target||unit(random)>.38)continue;
        const neighbors=bag.filter(other=>ready(other,time)&&near(person,byId.get(other)));
        if(!neighbors.length)continue;
        const partnerId=neighbors[integer(random,0,neighbors.length-1)],partner=byId.get(partnerId),interaction=unit(random)<.55?'greet':'chatter';
        bag.splice(bag.indexOf(partnerId),1);item.pose=interaction==='greet'?'wave':'look';item.partnerId=partnerId;item.interaction=interaction;
        selected.push({...partner,pose:'nod',partnerId:id,interaction});
      }
      if(!selected.length)return null;
      const participants=selected.map((person,index)=>{
        const delay=index*100+integer(random,0,80),poseDuration=Math.max(1400,duration-delay-integer(random,0,180));
        lastStarted.set(person.id,time+delay);
        return Object.freeze({...person,delay,duration:poseDuration});
      });
      return Object.freeze({id:`ambient-${turn}`,type:participants.some(person=>person.partnerId)?'greet':participants.length===1?participants[0].pose:'idle',participants:Object.freeze(participants),startedAt:time,duration});
    },
    wait(people,startedAt=0){
      const time=finite(startedAt)?startedAt:0,{available}=sync(people);if(!available.length)return null;
      let delay=Infinity;
      for(const id of bag){if(ready(id,time))return 0;delay=Math.min(delay,lastStarted.get(id)+cooldown-time);}
      return finite(delay)?Math.max(0,delay):null;
    },
  };
}

// A repeatable one-shot helper is useful for previews and tests. Mounted offices
// use the persistent selector above with Math.random or an injected random source.
export function selectOfficeAmbient(people,sequence=0,startedAt=0,options={}){
  const turn=finite(sequence)?Math.max(0,Math.floor(sequence)):0;let seed=(turn+1)>>>0;
  const seeded=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  return createOfficeAmbientSelector({...options,random:options.random||seeded}).next(people,turn,startedAt);
}
function stillAvailable(activity,people){
  const pending=new Map(activity.participants.map(person=>[person.id,person]));
  for(const person of Array.isArray(people)?people:[]){
    const previous=pending.get(person?.id);if(!previous||!eligible(person))continue;
    if(person.kind!==previous.kind||!!person.seated!==previous.seated||Math.abs(person.x-previous.x)>.01||Math.abs(person.y-previous.y)>.01)return false;
    pending.delete(person.id);if(!pending.size)return true;
  }
  return false;
}
export function mountOfficeAmbient({
  getPeople=()=>[],isBlocked=()=>false,onStart=()=>{},onEnd=()=>{},
  document=globalThis.document,setTimer=globalThis.setTimeout,clearTimer=globalThis.clearTimeout,
  now=()=>globalThis.performance?.now?.()??Date.now(),random=Math.random,cooldownMs=6500,
  mediaQuery=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)'),
}={}){
  random=typeof random==='function'?random:Math.random;
  const selector=createOfficeAmbientSelector({random,cooldownMs});
  let timer=null,active=null,sequence=0,destroyed=false,paused=false,ending=false;
  const blocked=()=>destroyed||paused||document?.visibilityState==='hidden'||!!mediaQuery?.matches||!!isBlocked();
  function cancelTimer(){if(timer!==null){clearTimer(timer);timer=null;}}
  function end(){if(!active)return;const previous=active;active=null;ending=true;try{onEnd(previous);}finally{ending=false;}}
  function queue(delay){if(timer!==null||blocked()||ending)return;timer=setTimer(()=>{timer=null;begin();},Math.max(0,delay));timer?.unref?.();}
  function begin(){
    if(blocked()){end();return;}
    const people=getPeople(),time=now(),next=selector.next(people,sequence,time);
    if(!next){const wait=selector.wait(people,time);if(wait!==null)queue(Math.max(1,wait));return;}
    sequence++;active=next;onStart(next);
    if(destroyed||active!==next)return;
    if(blocked()){end();return;}
    timer=setTimer(()=>{timer=null;end();queue(integer(random,600,1500));},next.duration);timer?.unref?.();
  }
  function refresh(){
    if(destroyed)return;
    if(blocked()){cancelTimer();end();return;}
    if(active){if(stillAvailable(active,getPeople()))return;cancelTimer();end();}
    queue(integer(random,600,1500));
  }
  const visibility=()=>refresh();
  document?.addEventListener?.('visibilitychange',visibility);
  if(mediaQuery?.addEventListener)mediaQuery.addEventListener('change',visibility);else mediaQuery?.addListener?.(visibility);
  refresh();
  return {
    refresh,pause(){paused=true;refresh();},resume(){paused=false;refresh();},get active(){return active;},
    destroy(){if(destroyed)return;destroyed=true;cancelTimer();end();document?.removeEventListener?.('visibilitychange',visibility);if(mediaQuery?.removeEventListener)mediaQuery.removeEventListener('change',visibility);else mediaQuery?.removeListener?.(visibility);},
  };
}
