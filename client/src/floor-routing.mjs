/* A map owns its walk lanes. The compiled graph is shared by every walking actor. */
const same=(a,b)=>Math.abs(a.x-b.x)<.001&&Math.abs(a.y-b.y)<.001;
const key=p=>`${p.x.toFixed(3)},${p.y.toFixed(3)}`;
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const point=p=>Array.isArray(p)?{x:p[0],y:p[1]}:{x:p.x,y:p.y};
function project(p,[a,b]){const dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy)));return{x:a.x+dx*t,y:a.y+dy*t};}
const onSegment=(p,s)=>distance(p,project(p,s))<.001;
function push(heap,item){heap.push(item);let i=heap.length-1;while(i){const parent=(i-1)>>1;if(heap[parent].priority<=item.priority)break;heap[i]=heap[parent];i=parent;}heap[i]=item;}
function pop(heap){const first=heap[0],last=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let child=i*2+1;if(child+1<heap.length&&heap[child+1].priority<heap[child].priority)child++;if(heap[child].priority>=last.priority)break;heap[i]=heap[child];i=child;}heap[i]=last;}return first;}

export function createFloorRouter(source,{canConnect=()=>true}={}){
  const segments=source.map(segment=>segment.map(point)).filter(segment=>segment.length===2&&segment.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))&&!same(...segment)),points=new Map();
  for(const segment of segments)for(const p of segment)points.set(key(p),p);
  for(const a of segments)for(const b of segments)if(a[0].x===a[1].x&&b[0].y===b[1].y){const p={x:a[0].x,y:b[0].y};if(onSegment(p,a)&&onSegment(p,b))points.set(key(p),p);}
  const ordered=segments.map(segment=>[...points.values()].filter(p=>onSegment(p,segment)).sort((a,b)=>distance(a,segment[0])-distance(b,segment[0])));
  const edges=new Map([...points].map(([id])=>[id,[]]));
  for(const lane of ordered)for(let i=1;i<lane.length;i++){const a=lane[i-1],b=lane[i],cost=distance(a,b);edges.get(key(a)).push([key(b),cost]);edges.get(key(b)).push([key(a),cost]);}
  const closest=p=>{let best=null;for(const [index,segment]of segments.entries()){const q=project(p,segment),cost=distance(p,q);if((!best||cost<best.cost)&&canConnect(p,q))best={point:q,index,cost};}return best;};
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

// Furniture is expressed as floor rectangles. A segment may touch its padded
// outline, but it can never cross the occupied interior.
export function floorSegmentClear(a,b,obstacles=[]){
 const epsilon=.00001,dx=b.x-a.x,dy=b.y-a.y,left=Math.min(a.x,b.x),right=Math.max(a.x,b.x),top=Math.min(a.y,b.y),bottom=Math.max(a.y,b.y);
 for(const box of obstacles){
  const x0=box.x+epsilon,x1=box.x+box.w-epsilon,y0=box.y+epsilon,y1=box.y+box.h-epsilon;
  if(right<x0||left>x1||bottom<y0||top>y1)continue;
  let lo=0,hi=1;
  if(Math.abs(dx)<epsilon){if(a.x<=x0||a.x>=x1)continue;}
  else{const first=(x0-a.x)/dx,last=(x1-a.x)/dx;lo=Math.max(lo,Math.min(first,last));hi=Math.min(hi,Math.max(first,last));if(lo>hi)continue;}
  if(Math.abs(dy)<epsilon){if(a.y<=y0||a.y>=y1)continue;}
  else{const first=(y0-a.y)/dy,last=(y1-a.y)/dy;lo=Math.max(lo,Math.min(first,last));hi=Math.min(hi,Math.max(first,last));}
  if(lo<=hi&&hi>=0&&lo<=1)return false;
 }
 return true;
}

export function createFreeFloorRouter({bounds,obstacles=[]}={}){
 const boxes=obstacles.filter(box=>box.w>0&&box.h>0),within=p=>p.x>=bounds.x-.001&&p.x<=bounds.x+bounds.w+.001&&p.y>=bounds.y-.001&&p.y<=bounds.y+bounds.h+.001;
 // A desk-dense room otherwise checks hundreds of distant footprints for
 // every tiny graph edge. Compile a small index once; long sight lines keep
 // the allocation-free broad phase rather than visiting many empty cells.
 const cells=new Map(),cellSize=32,seen=new Uint32Array(boxes.length),nearby=[];let stamp=0;
 if(boxes.length>24)for(const [index,box]of boxes.entries())for(let x=Math.floor(box.x/cellSize);x<=Math.floor((box.x+box.w)/cellSize);x++)for(let y=Math.floor(box.y/cellSize);y<=Math.floor((box.y+box.h)/cellSize);y++){const id=x+':'+y;if(!cells.has(id))cells.set(id,[]);cells.get(id).push(index);}
 function collisionBoxes(a,b){
  if(!cells.size)return boxes;
  const x0=Math.floor(Math.min(a.x,b.x)/cellSize),x1=Math.floor(Math.max(a.x,b.x)/cellSize),y0=Math.floor(Math.min(a.y,b.y)/cellSize),y1=Math.floor(Math.max(a.y,b.y)/cellSize);
  if((x1-x0+1)*(y1-y0+1)>9)return boxes;
  nearby.length=0;if(++stamp===4294967295){seen.fill(0);stamp=1;}
  for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++)for(const index of cells.get(x+':'+y)||[]){if(seen[index]===stamp)continue;seen[index]=stamp;nearby.push(boxes[index]);}
  return nearby;
 }
 const clear=(a,b)=>within(a)&&within(b)&&floorSegmentClear(a,b,collisionBoxes(a,b));
 const baseX=[bounds.x,bounds.x+bounds.w,...boxes.flatMap(box=>[box.x,box.x+box.w])],baseY=[bounds.y,bounds.y+bounds.h,...boxes.flatMap(box=>[box.y,box.y+box.h])];
 const coordinates=(base,a,b,min,max)=>[...new Set([...base,a,b].filter(value=>value>=min&&value<=max))].sort((x,y)=>x-y);
 return{clear,route(start,end){
  start=point(start);end=point(end);if(!within(start)||!within(end)||!clear(start,start)||!clear(end,end))return[start];
  if(same(start,end))return[start];if(clear(start,end))return[start,end];
  const xs=coordinates(baseX,start.x,end.x,bounds.x,bounds.x+bounds.w),ys=coordinates(baseY,start.y,end.y,bounds.y,bounds.y+bounds.h),width=xs.length;
  const id=(x,y)=>y*width+x,at=value=>({x:xs[value%width],y:ys[Math.floor(value/width)]}),source=id(xs.indexOf(start.x),ys.indexOf(start.y)),target=id(xs.indexOf(end.x),ys.indexOf(end.y));
  const costs=new Map([[source,0]]),previous=new Map(),queue=[],valid=new Map();push(queue,{id:source,cost:0,priority:distance(start,end)});
  while(queue.length){const current=pop(queue);if(current.cost!==costs.get(current.id))continue;if(current.id===target)break;const x=current.id%width,y=Math.floor(current.id/width),a=at(current.id);
   for(const [nx,ny]of[[x-1,y],[x+1,y],[x,y-1],[x,y+1]]){if(nx<0||ny<0||nx>=width||ny>=ys.length)continue;const next=id(nx,ny),b=at(next),edge=current.id<next?current.id+':'+next:next+':'+current.id;let allowed=valid.get(edge);if(allowed===undefined){allowed=clear(a,b);valid.set(edge,allowed);}if(!allowed)continue;const cost=current.cost+distance(a,b);if(cost<(costs.get(next)??Infinity)){costs.set(next,cost);previous.set(next,current.id);push(queue,{id:next,cost,priority:cost+distance(b,end)});}}
  }
  if(!costs.has(target))return[start];const route=[];for(let next=target;next!==undefined;next=previous.get(next))route.unshift(at(next));
  const result=[start];let from=0;while(from<route.length-1){let to=route.length-1;while(to>from+1&&!clear(route[from],route[to]))to--;result.push(route[to]);from=to;}return result;
 }};
}
