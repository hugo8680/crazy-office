import {routeBetweenPoints,walkingDuration,walkingSample} from './scene-motion.js';

export const MAX_OFFICE_PEOPLE=20;
export const PRESENCE_NODE_IDS=Object.freeze(['workstations','executive','storage','reception','meeting','finance','general_office','investment','server']);
const nodes=new Set(PRESENCE_NODE_IDS);
const clean=(value,max=100)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').trim().slice(0,max):'';
const shirts=['#b98d75','#8b9caa','#b6a179','#a38f9b','#78968d','#a89177'];
const hairs=['#51453d','#5c4839','#424641','#62483c'];
function identity(id){const hash=[...id].reduce((n,c)=>(n*31+c.charCodeAt(0))>>>0,0);return{color:shirts[hash%shirts.length],hair:hairs[hash%hairs.length]};}

export function normalizeOfficePresence(value={}){
  const currentUserId=clean(value.currentUserId),seen=new Set(),people=[];
  for(const source of Array.isArray(value.people)?value.people:[]){
    const id=clean(source?.id);if(!id||seen.has(id)||source?.online!==true)continue;seen.add(id);
    people.push({id,name:clean(source.name,80)||'员工',title:clean(source.title,80),nodeId:nodes.has(source.nodeId)?source.nodeId:'workstations',online:true,current:id===currentUserId,...identity(id)});
  }
  people.sort((a,b)=>Number(b.current)-Number(a.current)||a.id.localeCompare(b.id));
  return{enabled:value.enabled===true,currentUserId,people:people.slice(0,MAX_OFFICE_PEOPLE),onSelectEmployee:typeof value.onSelectEmployee==='function'?value.onSelectEmployee:()=>{}};
}

// Each destination is on an existing walkable centre line, clear of desks,
// cabinets and walls. Crowds spread along the same office corridor.
const arrivalLines={workstations:[213,445,300],executive:[839,969,315],storage:[605,777,373],reception:[484,642,480],meeting:[213,316,479],finance:[770,910,579],general_office:[562,764,87],investment:[92,470,87],server:[607,775,286]};
export function presencePosition(nodeId,index=0,count=1){const [start,end,y]=arrivalLines[nodeId]||arrivalLines.workstations;const spacing=Math.min(22,(end-start)/Math.max(1,count-1));return{x:start+Math.max(0,index)*spacing,y};}
const same=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y)<.1;
const validPoint=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=20&&p.x<=1035&&p.y>=20&&p.y<=625;

export function createOfficePresenceMotion({onChange=()=>{},now=()=>performance.now(),reducedMotion=false}={}){
  const entries=new Map();let reduced=!!reducedMotion,destroyed=false;
  const notify=entry=>onChange(entry);
  function set(value={}){
    const state=normalizeOfficePresence(value);if(destroyed)return state;
    const visible=state.enabled?state.people:[],ids=new Set(visible.map(p=>p.id)),counts={},ranks={};for(const p of visible)counts[p.nodeId]=(counts[p.nodeId]||0)+1;
    for(const id of entries.keys())if(!ids.has(id))entries.delete(id);
    for(const person of visible){
      const rank=ranks[person.nodeId]||0;ranks[person.nodeId]=rank+1;const target=presencePosition(person.nodeId,rank,counts[person.nodeId]);let entry=entries.get(person.id);
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
export function mountErpPresence({scene,request,session,onSelectEmployee=()=>{},document:doc=globalThis.document,intervalMs=15000,setTimer=globalThis.setInterval,clearTimer=globalThis.clearInterval,now=()=>Date.now()}={}){
  if(!scene?.setPresence||typeof request!=='function')throw new TypeError('缺少办公室在线员工接口');
  const currentUserId=clean(session?.actor?.id||session?.user?.id||session?.id);let nodeId='workstations',destroyed=false,timer=null,inflight=null,revision=0,unauthorized=false,lastSuccess=now();
  let people=[];
  const publish=()=>{if(!destroyed)scene.setPresence({enabled:!!currentUserId,people,currentUserId,onSelectEmployee});};
  async function refresh(){
    if(destroyed||unauthorized||!currentUserId||doc?.hidden)return null;
    if(inflight)return inflight;
    const sentRevision=revision,sentNode=nodeId;
    inflight=(async()=>{try{const result=await Promise.resolve().then(()=>request('/api/erp/presence','PUT',{nodeId:sentNode}));if(destroyed)return null;lastSuccess=now();people=Array.isArray(result?.online)?result.online:Array.isArray(result?.people)?result.people:[];publish();return result;}catch(error){if(destroyed)return null;if(error?.status===401){unauthorized=true;if(timer!==null)clearTimer(timer);timer=null;people=[];scene.setPresence({enabled:false,people:[],currentUserId:null});}else if(now()-lastSuccess>=45000){people=[];publish();}return null;}finally{inflight=null;if(!destroyed&&!unauthorized&&sentRevision!==revision&&!doc?.hidden)queueMicrotask(()=>void refresh());}})();
    return inflight;
  }
  function schedule(){if(timer!==null){clearTimer(timer);timer=null;}if(!destroyed&&!unauthorized&&currentUserId&&!doc?.hidden)timer=setTimer(()=>void refresh(),Math.max(1000,intervalMs));}
  function visibility(){if(doc?.hidden){schedule();return;}schedule();void refresh();}
  doc?.addEventListener?.('visibilitychange',visibility);publish();schedule();void refresh();
  return{refresh,
    async moveTo(next){if(!nodes.has(next))return false;nodeId=next;revision++;await refresh();return true;},
    get nodeId(){return nodeId;},
    destroy(){if(destroyed)return;destroyed=true;if(timer!==null)clearTimer(timer);timer=null;doc?.removeEventListener?.('visibilitychange',visibility);scene.setPresence({enabled:false,people:[],currentUserId:null});},
  };
}
