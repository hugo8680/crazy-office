import {employeeAppearance,employeeAppearanceKey} from './employee-appearance.mjs';
import {OFFICE_ROOMS,OFFICE_WORLD,OFFICE_BULLETIN_AREA,OFFICE_SEATS,OFFICE_RECREATION_AREA,OFFICE_CONVENIENCE_AREA,OFFICE_DATA_CENTER,canonicalDepartmentId} from './organization.mjs';
import {routeBetweenPoints,walkingDuration,walkingSample} from './scene-motion.js';

export const MAX_OFFICE_PEOPLE=20;
export const PRESENCE_NODE_IDS=Object.freeze([...OFFICE_ROOMS.map(room=>room.id),'bulletin']);
const nodes=new Set(PRESENCE_NODE_IDS);
const presenceArea=value=>['bulletin','courtyard','shared_lounge','recreation','convenience','data_center'].includes(value)?(value==='shared_lounge'?'courtyard':value):canonicalDepartmentId(value);
const clean=(value,max=100)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').trim().slice(0,max):'';
function identity(person){const appearanceKey=employeeAppearanceKey(person),appearance=employeeAppearance({id:appearanceKey,outfitId:person.outfitId});return{appearanceKey,outfitId:appearance.outfitId,color:appearance.uniform,hair:appearance.hair};}

export function normalizeOfficePresence(value={}){
  const currentUserId=clean(value.currentUserId),seen=new Set(),people=[];
  for(const source of Array.isArray(value.people)?value.people:[]){
    const id=clean(source?.id);if(!id||seen.has(id)||source?.online!==true)continue;seen.add(id);
    const x=Number(source.x),y=Number(source.y),point=Number.isFinite(x)&&Number.isFinite(y)&&x>=-155&&x<=1390&&y>=0&&y<=1100?{x,y}:null;
    people.push({id,point,posture:source.posture==='seated'?'seated':'standing',seatId:clean(source.seatId),revision:Number.isSafeInteger(source.revision)&&source.revision>=0?source.revision:0,name:clean(source.name,80)||'员工',title:clean(source.title,80),nodeId:presenceArea(source.nodeId)||canonicalDepartmentId(source.department)||'hr_admin',online:true,current:id===currentUserId,...identity({...source,id})});
  }
  people.sort((a,b)=>Number(b.current)-Number(a.current)||a.id.localeCompare(b.id));
  return{enabled:value.enabled===true,currentUserId,people:people.slice(0,MAX_OFFICE_PEOPLE),onSelectEmployee:typeof value.onSelectEmployee==='function'?value.onSelectEmployee:()=>{}};
}

// Each destination is on an existing walkable centre line, clear of desks,
// cabinets and walls. Crowds spread along the same office corridor.
export function presencePosition(nodeId,index=0,count=1){
  const id=presenceArea(nodeId)||'hr_admin';if(id==='recreation')return{x:OFFICE_RECREATION_AREA.x+OFFICE_RECREATION_AREA.w/2,y:OFFICE_RECREATION_AREA.y+OFFICE_RECREATION_AREA.h};if(id==='convenience')return{...OFFICE_CONVENIENCE_AREA.anchor};if(id==='data_center')return{x:OFFICE_DATA_CENTER.door.x,y:OFFICE_DATA_CENTER.door.y-12};const room=id==='bulletin'?OFFICE_BULLETIN_AREA:OFFICE_ROOMS.find(item=>item.id===id);if(!room)return{x:560,y:470};const [a,b]=room.arrivalLine;
  const total=Math.max(1,Math.min(MAX_OFFICE_PEOPLE,count)),rank=Math.max(0,Math.min(total-1,index)),spacing=Math.min(22,(b[0]-a[0])/Math.max(1,total-1));
  return {x:(a[0]+b[0])/2+(rank-(total-1)/2)*spacing,y:a[1]};
}
const same=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y)<.1;
const validPoint=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=-155&&p.x<=OFFICE_WORLD.width-20&&p.y>=0&&p.y<=OFFICE_WORLD.height-20;

export function createOfficePresenceMotion({onChange=()=>{},now=()=>performance.now(),reducedMotion=false}={}){
  const entries=new Map();let reduced=!!reducedMotion,destroyed=false;
  const notify=entry=>onChange(entry);
  function set(value={}){
    const state=normalizeOfficePresence(value);if(destroyed)return state;
    const visible=state.enabled?state.people:[],ids=new Set(visible.map(p=>p.id)),counts={},ranks={};for(const p of visible)counts[p.nodeId]=(counts[p.nodeId]||0)+1;
    for(const id of entries.keys())if(!ids.has(id))entries.delete(id);
    for(const person of visible){
      const rank=ranks[person.nodeId]||0;ranks[person.nodeId]=rank+1;const target=person.point||presencePosition(person.nodeId,rank,counts[person.nodeId]);let entry=entries.get(person.id);
      if(!entry){const seed=value.positions?.[person.id];entry={person,point:!reduced&&validPoint(seed)?{x:seed.x,y:seed.y}:{...target},target:{...target},motion:null,sample:null,lastTick:now()};entries.set(person.id,entry);if(!same(entry.point,target)&&!reduced){const route=routeBetweenPoints(entry.point,target);entry.motion={route,started:now(),duration:walkingDuration(route)};}}
      else{entry.person=person;if(!same(entry.target,target)){entry.target={...target};entry.lastTick=now();if(reduced||same(entry.point,target)){entry.point={...target};entry.motion=null;entry.sample=null;}else{const route=routeBetweenPoints(entry.point,target);entry.motion={route,started:now(),duration:walkingDuration(route)};}}}
    }
    return state;
  }
  return{entries,set,
    get busy(){return [...entries.values()].some(e=>e.motion);},
    tick(time=now(),{isPaused=()=>false}={}){if(destroyed)return false;for(const [id,entry]of entries){const elapsed=Math.max(0,time-entry.lastTick);entry.lastTick=time;if(!entry.motion)continue;if(isPaused(id)){entry.motion.started+=elapsed;continue;}const m=entry.motion,sample=walkingSample(m.route,time-m.started,m.duration);entry.point={x:sample.x,y:sample.y};entry.sample=sample;if(sample.arrived)entry.motion=null;notify(entry);}return this.busy;},
    setReducedMotion(value){reduced=!!value;if(reduced)for(const entry of entries.values())if(entry.motion){entry.point={...entry.target};entry.motion=null;entry.sample=null;notify(entry);}},
    shiftTime(ms){for(const entry of entries.values()){entry.lastTick+=Math.max(0,ms);if(entry.motion)entry.motion.started+=Math.max(0,ms);}},
    snapshot(){return{positions:Object.fromEntries([...entries].map(([id,e])=>[id,{...e.point}]))};},
    destroy(){destroyed=true;entries.clear();},
  };
}

/** Presence is presentation only. This module never submits a business task or
 * an approval, and receives no other employee's private work records. */
export function mountErpPresence({scene,request,session,onSelectEmployee=()=>{},onError=()=>{},onReady=()=>{},document:doc=globalThis.document,intervalMs=3000,setTimer=globalThis.setInterval,clearTimer=globalThis.clearInterval,now=()=>Date.now()}={}){
  if(!scene?.setPresence||typeof request!=='function')throw new TypeError('缺少办公室在线员工接口');
  const currentUserId=clean(session?.actor?.id||session?.user?.id||session?.id);let nodeId=canonicalDepartmentId(session?.actor?.department||session?.user?.department)||'hr_admin',destroyed=false,timer=null,inflight=null,unauthorized=false,lastSuccess=now(),first=true;
  let people=[],operations=Promise.resolve();
  const self=()=>people.find(p=>p.id===currentUserId)||null;
  const publish=()=>{if(!destroyed)scene.setPresence({enabled:!!currentUserId,people,currentUserId,onSelectEmployee});};
  function receive(result){if(destroyed)return;lastSuccess=now();people=Array.isArray(result?.online)?result.online:Array.isArray(result?.people)?result.people:[];nodeId=self()?.nodeId||nodeId;publish();if(first&&self()){first=false;onReady(self());}}
  function failed(error){if(destroyed)return;if(error?.status===401){unauthorized=true;if(timer!==null)clearTimer(timer);timer=null;people=[];scene.setPresence({enabled:false,people:[],currentUserId:null});}else if(now()-lastSuccess>=45000){people=[];publish();}}
  // All office requests share one queue. A slow heartbeat cannot overwrite a
  // later move or reservation, and commands use the revision just received.
  function enqueue(operation){const job=operations.then(()=>destroyed||unauthorized||!currentUserId?null:operation());operations=job.catch(()=>null);return job;}
  async function heartbeat(){
    if(destroyed||unauthorized||!currentUserId||doc?.hidden)return null;
    try{const result=await request('/api/erp/presence','PUT',{operation:'heartbeat',nodeId});receive(result);return result;}catch(error){failed(error);return null;}
  }
  function refresh(){
    if(destroyed||unauthorized||!currentUserId||doc?.hidden)return Promise.resolve(null);
    if(inflight)return inflight;
    const job=enqueue(heartbeat);inflight=job.finally(()=>{if(inflight===tracked)inflight=null;});const tracked=inflight;return tracked;
  }
  function command(payload){return enqueue(async()=>{
    try{const me=self(),result=await request('/api/erp/presence','PUT',{...payload,...(Number.isSafeInteger(me?.revision)?{expectedRevision:me.revision}:{})});receive(result);return !destroyed;}
    catch(error){failed(error);if(!destroyed&&error?.status!==401){onError(error.message);await heartbeat();}return false;}
  }).then(value=>value===true);}
  function schedule(){if(timer!==null){clearTimer(timer);timer=null;}if(!destroyed&&!unauthorized&&currentUserId&&!doc?.hidden)timer=setTimer(()=>void refresh(),Math.max(1000,intervalMs));}
  function visibility(){if(doc?.hidden){schedule();return;}schedule();void refresh();}
  doc?.addEventListener?.('visibilitychange',visibility);publish();schedule();const ready=refresh();
  return{refresh,ready,
    async moveTo(next){const id=presenceArea(next);if(!id||(!nodes.has(id)&&!['courtyard','recreation','convenience','data_center'].includes(id)))return false;const point=presencePosition(id);return command({operation:'move',nodeId:id,x:point.x,y:point.y});},
    movePoint(point){if(!validPoint(point))return Promise.resolve(false);return command({operation:'move',x:point.x,y:point.y});},
    sit(seatId){if(!OFFICE_SEATS.some(s=>s.id===seatId))return Promise.resolve(false);return command({operation:'sit',seatId});},
    sitAt(point){if(!validPoint(point)||point.x<20||point.y<20)return Promise.resolve(false);return command({operation:'sit',x:point.x,y:point.y});},
    stand(){return command({operation:'stand'});},
    get nodeId(){return nodeId;},get self(){return self();},get people(){return people;},
    destroy(){if(destroyed)return;destroyed=true;if(timer!==null)clearTimer(timer);timer=null;doc?.removeEventListener?.('visibilitychange',visibility);scene.setPresence({enabled:false,people:[],currentUserId:null});},
  };
}
