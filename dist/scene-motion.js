/* Walkable floor centre lines. Vertical room walls are crossed only at doors. */
export const FLOOR_SEGMENTS = Object.freeze([
  [[82,87],[481,87]], [[82,87],[82,107]], [[82,107],[32,107]], [[32,107],[32,411]], [[32,411],[980,411]],
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
