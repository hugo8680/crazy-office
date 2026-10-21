/* Idle poses are presentation only: no movement, ERP writes or online events.
 * Renderers call refresh after business/hover availability changes. There is
 * one finite timer, no frame loop and no background polling while blocked. */
const poses=['look','nod','sip','typing'];
const finite=number=>Number.isFinite(number);
function candidates(people) {
  const ids=new Set();
  return (Array.isArray(people)?people:[]).filter(person=>{
    if(!person||typeof person.id!=='string'||!person.id||ids.has(person.id)||!['virtual','human'].includes(person.kind)||!finite(person.x)||!finite(person.y)||person.busy)return false;
    ids.add(person.id);return true;
  }).map(({id,kind,x,y,seated})=>({id,kind,x,y,seated:!!seated})).sort((a,b)=>a.id.localeCompare(b.id));
}

export function selectOfficeAmbient(people,sequence=0,startedAt=0) {
  const available=candidates(people);if(!available.length)return null;
  const turn=finite(sequence)?Math.max(0,Math.floor(sequence)):0,person=available[turn%available.length];
  const neighbor=turn%3===0?available.filter(other=>other.id!==person.id&&Math.hypot(other.x-person.x,other.y-person.y)<=180).sort((a,b)=>Math.hypot(a.x-person.x,a.y-person.y)-Math.hypot(b.x-person.x,b.y-person.y)||a.id.localeCompare(b.id))[0]:null;
  let type=neighbor?'greet':poses[turn%poses.length];
  if(type==='typing'&&person.kind==='human'&&!person.seated)type='look';
  const participants=[{...person,pose:neighbor?'wave':type},...(neighbor?[{...neighbor,pose:'nod'}]:[])].map(Object.freeze);
  return Object.freeze({id:`ambient-${turn}`,type,participants:Object.freeze(participants),startedAt:finite(startedAt)?startedAt:0,duration:2400});
}

export function mountOfficeAmbient({
  getPeople=()=>[],isBlocked=()=>false,onStart=()=>{},onEnd=()=>{},
  document=globalThis.document,setTimer=globalThis.setTimeout,clearTimer=globalThis.clearTimeout,
  now=()=>globalThis.performance?.now?.()??Date.now(),
  mediaQuery=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)'),
}={}) {
  let timer=null,active=null,sequence=0,destroyed=false,paused=false,ending=false;
  const blocked=()=>destroyed||paused||document?.visibilityState==='hidden'||!!mediaQuery?.matches||!!isBlocked();
  function cancelTimer(){if(timer!==null){clearTimer(timer);timer=null;}}
  function end(){if(!active)return;const previous=active;active=null;ending=true;try{onEnd(previous);}finally{ending=false;}}
  function queue(delay){if(timer!==null||blocked()||ending)return;timer=setTimer(()=>{timer=null;begin();},delay);timer?.unref?.();}
  function begin(){
    if(blocked()){end();return;}
    const next=selectOfficeAmbient(getPeople(),sequence++,now());
    if(!next)return;
    active=next;onStart(next);
    if(destroyed||active!==next)return;
    if(blocked()){end();return;}
    timer=setTimer(()=>{
      timer=null;end();
      queue(6000+(sequence%5)*1000);
    },next.duration);timer?.unref?.();
  }
  function refresh(){
    if(destroyed)return;
    if(blocked()){cancelTimer();end();return;}
    if(active){
      const eligible=new Set(candidates(getPeople()).map(person=>person.id));
      if(active.participants.every(person=>eligible.has(person.id)))return;
      cancelTimer();end();
    }
    queue(1500);
  }
  const visibility=()=>refresh();
  document?.addEventListener?.('visibilitychange',visibility);
  if(mediaQuery?.addEventListener)mediaQuery.addEventListener('change',visibility);
  else mediaQuery?.addListener?.(visibility);
  refresh();
  return {
    refresh,
    pause(){paused=true;refresh();},
    resume(){paused=false;refresh();},
    get active(){return active;},
    destroy(){
      if(destroyed)return;destroyed=true;cancelTimer();end();
      document?.removeEventListener?.('visibilitychange',visibility);
      if(mediaQuery?.removeEventListener)mediaQuery.removeEventListener('change',visibility);
      else mediaQuery?.removeListener?.(visibility);
    },
  };
}
