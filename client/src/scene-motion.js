/* Walkable floor centre lines. Vertical room walls are crossed only at doors. */
export const FLOOR_SEGMENTS = Object.freeze([
  [[82,87],[481,87]], [[82,87],[82,107]], [[32,107],[550,107]], [[550,87],[775,87]], [[550,87],[550,107]], [[32,107],[32,411]], [[32,411],[980,411]],
  [[464,185],[464,411]], [[205,300],[464,300]],
  [[590,260],[590,373]], [[590,286],[787,286]], [[590,373],[787,373]], [[787,286],[787,390]], [[650,373],[650,411]], [[590,345],[650,345]], [[579,373],[590,373]], [[757,390],[787,390]],
  [[827,315],[977,315]], [[827,315],[827,411]],
  [[207,411],[207,479]], [[207,479],[322,479]], [[322,479],[322,493]],
  [[528,411],[528,480]], [[477,480],[650,480]], [[477,480],[477,575]], [[650,480],[650,575]], [[600,575],[650,575]], [[620,560],[650,560]],
  [[845,411],[845,457]], [[760,457],[920,457]], [[760,457],[760,579]], [[920,457],[920,579]], [[760,579],[920,579]],
].map(segment => Object.freeze(segment.map(point => Object.freeze(point)))));

const same = (a,b) => Math.abs(a.x-b.x)<.001 && Math.abs(a.y-b.y)<.001;
const key = p => `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
const point = p => Array.isArray(p) ? {x:p[0],y:p[1]} : {x:p.x,y:p.y};
function project(p,segment) {
  const a=point(segment[0]), b=point(segment[1]);
  const dx=b.x-a.x,dy=b.y-a.y;
  const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy)));
  return {x:a.x+dx*t,y:a.y+dy*t};
}
function onSegment(p,segment) { return distance(p,project(p,segment))<.001; }

export function routeBetweenPoints(start,end) {
  start=point(start);end=point(end);
  if(same(start,end)) return [start];
  const closest = p => FLOOR_SEGMENTS.map(segment=>({segment,p:project(p,segment)})).sort((a,b)=>distance(p,a.p)-distance(p,b.p))[0];
  const from=closest(start),to=closest(end);
  const points=new Map();
  for(const segment of FLOOR_SEGMENTS) for(const p of segment) { const q=point(p);points.set(key(q),q); }
  // All segment intersections become junctions, including a room entry midway down the hall.
  for(const a of FLOOR_SEGMENTS) for(const b of FLOOR_SEGMENTS) {
    if(a[0][0]===a[1][0] && b[0][1]===b[1][1]) {
      const p={x:a[0][0],y:b[0][1]}; if(onSegment(p,a)&&onSegment(p,b)) points.set(key(p),p);
    }
  }
  points.set(key(from.p),from.p);points.set(key(to.p),to.p);
  const edges=new Map([...points].map(([k])=>[k,[]]));
  for(const segment of FLOOR_SEGMENTS) {
    const ordered=[...points.values()].filter(p=>onSegment(p,segment)).sort((a,b)=>distance(a,point(segment[0]))-distance(b,point(segment[0])));
    for(let i=1;i<ordered.length;i++) {
      const a=ordered[i-1],b=ordered[i],cost=distance(a,b);
      edges.get(key(a)).push([key(b),cost]);edges.get(key(b)).push([key(a),cost]);
    }
  }
  const source=key(from.p),target=key(to.p),costs=new Map([[source,0]]),previous=new Map(),pending=new Set(points.keys());
  while(pending.size) {
    const current=[...pending].sort((a,b)=>(costs.get(a)??Infinity)-(costs.get(b)??Infinity))[0];
    if(!Number.isFinite(costs.get(current))) break;
    pending.delete(current);if(current===target) break;
    for(const [next,weight] of edges.get(current)) if((costs.get(current)+weight)<(costs.get(next)??Infinity)) { costs.set(next,costs.get(current)+weight);previous.set(next,current); }
  }
  if(!costs.has(target)) return [start];
  const result=[];for(let current=target;current;current=previous.get(current)) result.unshift(points.get(current));
  if(!same(start,result[0])) result.unshift(start);
  if(!same(end,result.at(-1))) result.push(end);
  return result.filter((p,i)=>!i||!same(p,result[i-1]));
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
    start(patch,{immediate=false}={}){
      const from=read(),to={...from,...patch};
      if(Object.keys(to).some(key=>!Number.isFinite(to[key])))return from;
      if(immediate||Object.keys(to).every(key=>Math.abs(to[key]-from[key])<1e-7)){current=null;write(to);onStart();return to;}
      const sampledAt=current?.sampledAt??null;
      current={from,to,started:sampledAt,sampledAt};onStart();return to;
    },
    tick(time){
      if(!current)return false;current.started??=time;current.sampledAt=time;
      const progress=Math.max(0,Math.min(1,(time-current.started)/duration)),weight=1-Math.pow(1-progress,3);
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
    x:segment.a.x+(segment.b.x-segment.a.x)*eased,
    y:segment.a.y+(segment.b.y-segment.a.y)*eased,
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
