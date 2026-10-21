/* A map owns its walk lanes. The compiled graph is shared by every walking actor. */
const same=(a,b)=>Math.abs(a.x-b.x)<.001&&Math.abs(a.y-b.y)<.001;
const key=p=>`${p.x.toFixed(3)},${p.y.toFixed(3)}`;
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const point=p=>Array.isArray(p)?{x:p[0],y:p[1]}:{x:p.x,y:p.y};
function project(p,[a,b]){const dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy)));return{x:a.x+dx*t,y:a.y+dy*t};}
const onSegment=(p,s)=>distance(p,project(p,s))<.001;
function push(heap,item){heap.push(item);let i=heap.length-1;while(i){const parent=(i-1)>>1;if(heap[parent].priority<=item.priority)break;heap[i]=heap[parent];i=parent;}heap[i]=item;}
function pop(heap){const first=heap[0],last=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let child=i*2+1;if(child+1<heap.length&&heap[child+1].priority<heap[child].priority)child++;if(heap[child].priority>=last.priority)break;heap[i]=heap[child];i=child;}heap[i]=last;}return first;}

export function createFloorRouter(source){
  const segments=source.map(segment=>segment.map(point)),points=new Map();
  for(const segment of segments)for(const p of segment)points.set(key(p),p);
  for(const a of segments)for(const b of segments)if(a[0].x===a[1].x&&b[0].y===b[1].y){const p={x:a[0].x,y:b[0].y};if(onSegment(p,a)&&onSegment(p,b))points.set(key(p),p);}
  const ordered=segments.map(segment=>[...points.values()].filter(p=>onSegment(p,segment)).sort((a,b)=>distance(a,segment[0])-distance(b,segment[0])));
  const edges=new Map([...points].map(([id])=>[id,[]]));
  for(const lane of ordered)for(let i=1;i<lane.length;i++){const a=lane[i-1],b=lane[i],cost=distance(a,b);edges.get(key(a)).push([key(b),cost]);edges.get(key(b)).push([key(a),cost]);}
  const closest=p=>{let best=null;for(const [index,segment]of segments.entries()){const q=project(p,segment),cost=distance(p,q);if(!best||cost<best.cost)best={point:q,index,cost};}return best;};
  return {route(start,end){
    start=point(start);end=point(end);if(same(start,end))return[start];
    const from=closest(start),to=closest(end);if(!from||!to)return[start];
    const nodes=new Map(points),extra=new Map();
    const connect=(a,b)=>{const left=key(a),right=key(b),cost=distance(a,b);if(left===right)return;for(const [id,target]of [[left,right],[right,left]]){if(!extra.has(id))extra.set(id,[]);extra.get(id).push([target,cost]);}};
    for(const projection of [from,to]){const p=projection.point,id=key(p);if(nodes.has(id))continue;nodes.set(id,p);const lane=ordered[projection.index],segment=segments[projection.index],offset=distance(p,segment[0]);let before=null,after=null;for(const q of lane){if(distance(q,segment[0])<offset)before=q;else{after=q;break;}}if(before)connect(p,before);if(after)connect(p,after);}
    if(segments.some(segment=>onSegment(from.point,segment)&&onSegment(to.point,segment)))connect(from.point,to.point);
    const sourceID=key(from.point),targetID=key(to.point),costs=new Map([[sourceID,0]]),previous=new Map(),queue=[];push(queue,{id:sourceID,cost:0,priority:distance(from.point,to.point)});
    while(queue.length){const current=pop(queue);if(current.cost!==costs.get(current.id))continue;if(current.id===targetID)break;for(const [next,weight]of [...(edges.get(current.id)||[]),...(extra.get(current.id)||[])]){const cost=current.cost+weight;if(cost<(costs.get(next)??Infinity)){costs.set(next,cost);previous.set(next,current.id);push(queue,{id:next,cost,priority:cost+distance(nodes.get(next),to.point)});}}}
    if(!costs.has(targetID))return[start];
    const result=[];for(let id=targetID;id;id=previous.get(id))result.unshift({...nodes.get(id)});
    if(!same(start,result[0]))result.unshift(start);if(!same(end,result.at(-1)))result.push(end);
    return result.filter((p,i)=>!i||!same(p,result[i-1]));
  }};
}
