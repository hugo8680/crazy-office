import {OFFICE_WALKING_SEGMENTS,OFFICE_ROOMS,OFFICE_FITTINGS,OFFICE_LANDSCAPE,OFFICE_BULLETIN_AREA,OFFICE_CONVENIENCE_AREA,OFFICE_RECREATION_AREA,OFFICE_DATA_CENTER,OFFICE_DATA_CENTER_WALKING_SEGMENTS} from './organization.mjs';
import {createFloorRouter,createFreeFloorRouter,floorSegmentClear} from './floor-routing.mjs';

export const FLOOR_SEGMENTS=OFFICE_WALKING_SEGMENTS;
const same=(a,b)=>Math.abs(a.x-b.x)<.001&&Math.abs(a.y-b.y)<.001;
const point=p=>Array.isArray(p)?{x:p[0],y:p[1]}:{x:p.x,y:p.y};
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const roomAt=p=>OFFICE_ROOMS.find(room=>p.x>room.x+.001&&p.x<room.x+room.w-.001&&p.y>room.y+.001&&p.y<room.y+room.h-.001);
const rectangle=({x,y,w,h},padding=1.5)=>({x:x-w/2-padding,y:y-h/2-padding,w:w+padding*2,h:h+padding*2});
const roomObstacles=new Map(OFFICE_ROOMS.map(room=>[room.id,[...room.seats.map(seat=>rectangle(seat.desk)),...OFFICE_FITTINGS.filter(item=>item.roomId===room.id).map(item=>rectangle(item)),...OFFICE_LANDSCAPE.filter(item=>item.roomId===room.id).map(item=>rectangle(item))]]));
const roomRouters=new Map(OFFICE_ROOMS.map(room=>[room.id,createFreeFloorRouter({bounds:room,obstacles:roomObstacles.get(room.id)})]));
const outsideObstacles=[...OFFICE_FITTINGS.filter(item=>!OFFICE_ROOMS.some(room=>room.id===item.roomId)),...OFFICE_LANDSCAPE.filter(item=>!item.roomId&&!['stepping_stone','deck'].includes(item.kind)),...['shelf','fridge','counter'].map(key=>OFFICE_CONVENIENCE_AREA[key]),...['treadmill','weightRack','bench','poolTable','cueRack'].map(key=>OFFICE_RECREATION_AREA[key]),OFFICE_BULLETIN_AREA.board,...OFFICE_BULLETIN_AREA.benches].map(item=>rectangle(item));
const boundaryConnects=(a,b)=>{
 if(!floorSegmentClear(a,b,outsideObstacles))return false;
 for(const room of OFFICE_ROOMS){
  // Connectors outside a room cannot use its internal aisle through a wall.
  if(roomAt(a)?.id===room.id||roomAt(b)?.id===room.id)return false;
  if(!floorSegmentClear(a,b,[{x:room.x+.001,y:room.y+.001,w:room.w-.002,h:room.h-.002}]))return false;
 }
 return true;
};
const officeRouter=createFloorRouter(FLOOR_SEGMENTS,{canConnect:boundaryConnects});
const dataCenterRouter=createFloorRouter(OFFICE_DATA_CENTER_WALKING_SEGMENTS.slice(1));
const dataCenterEntry={x:OFFICE_DATA_CENTER.door.x,y:OFFICE_DATA_CENTER.door.y+10};
const inDataCenter=p=>p.x>=OFFICE_DATA_CENTER.x&&p.x<=OFFICE_DATA_CENTER.x+OFFICE_DATA_CENTER.w&&p.y>=OFFICE_DATA_CENTER.y&&p.y<=OFFICE_DATA_CENTER.y+OFFICE_DATA_CENTER.h;
const compact=route=>route.filter((p,index)=>!index||!same(p,route[index-1]));
export function routeBetweenPoints(start,end){
 start=point(start);end=point(end);if(same(start,end))return[start];
 const fromAnnex=inDataCenter(start),toAnnex=inDataCenter(end);if(fromAnnex&&toAnnex)return dataCenterRouter.route(start,end);
 const fromRoom=!fromAnnex&&roomAt(start),toRoom=!toAnnex&&roomAt(end);
 if(fromRoom&&fromRoom===toRoom)return roomRouters.get(fromRoom.id).route(start,end);
 const from=fromAnnex?dataCenterEntry:fromRoom?point(fromRoom.door):start,to=toAnnex?dataCenterEntry:toRoom?point(toRoom.door):end;
 const approach=fromAnnex?dataCenterRouter.route(start,from):fromRoom?roomRouters.get(fromRoom.id).route(start,from):[];
 const departure=toAnnex?dataCenterRouter.route(to,end):toRoom?roomRouters.get(toRoom.id).route(to,end):[];
 // Unreachable furniture or a disconnected floor is a failed walk, never a
 // straight-line teleport to the server's requested destination.
 if(approach.length&&!same(approach.at(-1),from)||departure.length&&!same(departure.at(-1),end))return[start];
 const middle=officeRouter.route(from,to);if(!same(middle.at(-1),to))return[start];
 return compact([...approach,...middle,...departure]);
}

export function routeLength(route) { return route.slice(1).reduce((sum,p,i)=>sum+distance(route[i],p),0); }
export function pointAlongRoute(route,progress) {
  if(!route.length) return {x:0,y:0,facing:1};
  const total=routeLength(route);let remaining=total*Math.max(0,Math.min(1,progress));
  for(let i=1;i<route.length;i++) {
    const a=route[i-1],b=route[i],length=distance(a,b);
    if(remaining<=length) { const t=length?remaining/length:1;return {x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,facing:b.x<a.x?-1:1}; }
    remaining-=length;
  }
  return {...route.at(-1),facing:1};
}

/* Geometry belongs to a single walk and is reclaimed with its route. Removing
 * collinear graph junctions prevents a visible stop at every desk connection.
 * Corners stay on the floor centre line instead of cutting through a wall. */
const walkingPlans = new WeakMap();

// Presentation-only interpolation: starts on the next animation clock, supports
// retargeting from the visible position, and stops exactly at its destination.
export function createViewTween({read,write,onStart=()=>{},duration=380}={}) {
  let current=null;
  return {
    start(patch,{immediate=false,duration:transitionDuration=duration,easing='out'}={}){
      const from=read(),to={...from,...patch};
      if(Object.keys(to).some(key=>!Number.isFinite(to[key])))return from;
      if(immediate||Object.keys(to).every(key=>Math.abs(to[key]-from[key])<1e-7)){current=null;write(to);onStart();return to;}
      const sampledAt=current?.sampledAt??null;
      const milliseconds=Number.isFinite(transitionDuration)?Math.max(80,Math.min(1500,transitionDuration)):duration;
      current={from,to,started:sampledAt,sampledAt,duration:milliseconds,easing};onStart();return to;
    },
    tick(time){
      if(!current)return false;current.started??=time;current.sampledAt=time;
      const progress=Math.max(0,Math.min(1,(time-current.started)/current.duration)),weight=current.easing==='smooth'?progress*progress*progress*(10+progress*(-15+6*progress)):1-Math.pow(1-progress,3);
      write(Object.fromEntries(Object.entries(current.to).map(([key,to])=>[key,progress===1?to:current.from[key]+(to-current.from[key])*weight])));
      if(progress===1)current=null;return !!current;
    },
    finish(){if(current){const to=current.to;current=null;write(to);onStart();}},
    cancel(){current=null;},
    shiftTime(milliseconds){if(current?.started!=null){const delay=Math.max(0,milliseconds);current.started+=delay;if(current.sampledAt!=null)current.sampledAt+=delay;}},
    get active(){return !!current;},get target(){return current?.to||read();},
  };
}
function walkingPlan(route) {
  if(walkingPlans.has(route)) return walkingPlans.get(route);
  const points=[];
  for(const source of route) {
    const p=point(source);
    if(points.length&&same(points.at(-1),p))continue;
    if(points.length>1) {
      const a=points.at(-2),b=points.at(-1);
      const ab={x:b.x-a.x,y:b.y-a.y},bc={x:p.x-b.x,y:p.y-b.y};
      if(Math.abs(ab.x*bc.y-ab.y*bc.x)<.0001&&ab.x*bc.x+ab.y*bc.y>0)points.pop();
    }
    points.push(p);
  }
  const segments=[];let length=0,weight=0,facing=1;
  for(let i=1;i<points.length;i++) {
    const a=points[i-1],b=points[i],size=distance(a,b),dx=b.x-a.x,dy=b.y-a.y;
    if(!size)continue;
    const axis=Math.abs(dx)>=Math.abs(dy)?'x':'y';
    if(axis==='x')facing=dx<0?-1:1;
    const heading=axis==='x'?(dx<0?'left':'right'):(dy<0?'up':'down');
    // Short stretches receive time to turn; long corridors retain a steady pace.
    const durationWeight=size+Math.min(20,size*.35);
    segments.push({a,b,length:size,startDistance:length,startWeight:weight,weight:durationWeight,axis,heading,facing});
    length+=size;weight+=durationWeight;
  }
  const plan={points,segments,length,weight};walkingPlans.set(route,plan);return plan;
}

export function walkingDuration(route) {
  const plan=walkingPlan(route);
  if(!plan.length)return 0;
  return Math.max(900,Math.min(10000,plan.length/150*1000+Math.max(0,plan.segments.length-1)*95+260));
}

/* One sampler drives travel, feet and body. The stride phase follows distance,
 * so slowing down at a doorway also slows the feet instead of making them slide.
 * Hermite tangents ease the first/last step and reduce speed before each turn. */
export function walkingSample(route,elapsedMs,duration=walkingDuration(route)) {
  const plan=walkingPlan(route),progress=duration>0?Math.max(0,Math.min(1,(Number.isFinite(elapsedMs)?elapsedMs:0)/duration)):1;
  const still=plan.points.at(-1)||{x:0,y:0};
  if(!plan.segments.length)return {...still,facing:1,axis:'none',heading:'none',progress:1,phase:0,stride:0,bob:0,lean:0,pace:0,arrived:true};
  const moment=plan.weight*progress;
  let index=plan.segments.findIndex(segment=>moment<=segment.startWeight+segment.weight);
  if(index<0)index=plan.segments.length-1;
  const segment=plan.segments[index],t=Math.max(0,Math.min(1,(moment-segment.startWeight)/segment.weight));
  const startTangent=index===0?0:.32,endTangent=index===plan.segments.length-1?0:.32;
  const t2=t*t,t3=t2*t;
  const eased=(-2*t3+3*t2)+(t3-2*t2+t)*startTangent+(t3-t2)*endTangent;
  const slope=(-6*t2+6*t)+(3*t2-4*t+1)*startTangent+(3*t2-2*t)*endTangent;
  const covered=segment.startDistance+segment.length*eased,phase=covered/42*Math.PI*2;
  const speed=duration>0?segment.length*slope/(duration*segment.weight/plan.weight)*1000:0;
  const envelope=progress===0||progress===1?0:Math.min(1,Math.max(0,speed/105));
  const step=Math.sin(phase),arrived=progress===1;
  return {
    x:arrived?still.x:segment.a.x+(segment.b.x-segment.a.x)*eased,
    y:arrived?still.y:segment.a.y+(segment.b.y-segment.a.y)*eased,
    facing:segment.facing,axis:segment.axis,heading:segment.heading,progress,phase,
    stride:!envelope?0:step*14*envelope,
    bob:!envelope?0:-Math.abs(step)*.8*envelope,
    lean:!envelope?0:((segment.axis==='x'?segment.facing*.8:0)+Math.sin(phase*2)*.65)*envelope,
    pace:speed>0?Math.max(150,Math.min(1200,42000/speed)):0,
    arrived,
  };
}

/* These are presentation timings only. They never dispatch or approve a task. */
export function handoffTiming(reducedMotion=false) {
  return reducedMotion?{approach:0,transfer:0,settle:1500,total:1500}:{approach:160,transfer:420,settle:720,total:1300};
}

export function deliveryKey(event) { return String(event.id || `${event.time}-${event.agentId||event.sourceHumanId}-${event.targetAgentId||event.targetHumanId}-${event.text}`); }
export function motionUpdatePolicy({ hasUpdated=false, previousRunId, runId=null, animateEvents, runStatus }={}) {
  const runChanged=!hasUpdated||runId!==previousRunId;
  const halted=['failed','cancelled','canceled'].includes(runStatus);
  return {
    runChanged,
    halted,
    reset:runChanged||animateEvents===false||halted,
    animate:!halted&&(animateEvents===true||(animateEvents!==false&&hasUpdated&&!runChanged)),
  };
}
export function deliveryParticipants(event) {
  // Human handoffs also retain agentId for the assigned task. Ownership is not the sender.
  if(event.sourceHumanId && event.targetAgentId) return {mover:event.targetAgentId,recipient:event.sourceHumanId,recipientHuman:true,collecting:true};
  const sourceAgent=event.sourceAgentId||event.agentId;
  if(sourceAgent) return {mover:sourceAgent,recipient:event.targetAgentId||event.targetHumanId,recipientHuman:!!event.targetHumanId};
  return null;
}

/* One active delivery per person; recipients are held until their colleague arrives. */
export function createDeliveryQueue() {
  const seen=new Set(),pending=[],active=new Map(),locks=new Set();
  return {
    ingest(events,{animate=true}={}) {
      for(const event of events||[]) {
        if(event.type!=='handoff') continue;
        const id=deliveryKey(event);if(seen.has(id)) continue;seen.add(id);
        if(animate && deliveryParticipants(event)?.recipient) pending.push({...event,_deliveryKey:id});
      }
      pending.sort((a,b)=>(b.deliveryKind==='approval_request')-(a.deliveryKind==='approval_request'));
    },
    startReady() {
      const started=[];
      for(let i=0;i<pending.length;) {
        const event=pending[i],pair=deliveryParticipants(event);
        if(locks.has(pair.mover)||locks.has(pair.recipient)) { i++;continue; }
        pending.splice(i,1);locks.add(pair.mover);locks.add(pair.recipient);active.set(event._deliveryKey,event);started.push(event);
      }
      return started;
    },
    finish(id) { const event=active.get(id);if(!event)return;const pair=deliveryParticipants(event);locks.delete(pair.mover);locks.delete(pair.recipient);active.delete(id); },
    locked(id) { return locks.has(id); },
    clear() { seen.clear();pending.length=0;active.clear();locks.clear(); },
    get pendingCount(){return pending.length;},
    get activeCount(){return active.size;},
  };
}
