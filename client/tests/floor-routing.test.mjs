import test from 'node:test';
import assert from 'node:assert/strict';
import {createFloorRouter,createFreeFloorRouter,floorSegmentClear} from '../src/floor-routing.mjs';
import {OFFICE_ROOMS,departmentWorkPoint,OFFICE_WALKING_SEGMENTS,OFFICE_FITTINGS,OFFICE_LANDSCAPE,OFFICE_RECREATION_AREA,OFFICE_CONVENIENCE_AREA,OFFICE_DATA_CENTER} from '../src/organization.mjs';
import {routeBetweenPoints,routeLength,resolveFloorDestination,walkingDuration,walkingSample} from '../src/scene-motion.js';

test('compiled routing keeps intermediate projections and takes the shortest connected lane',()=>{
 const router=createFloorRouter([[[0,0],[100,0]],[[0,0],[0,100]],[[100,0],[100,100]],[[0,100],[100,100]]]);
 assert.deepEqual(router.route({x:25,y:0},{x:75,y:0}),[{x:25,y:0},{x:75,y:0}]);
 const path=router.route({x:0,y:20},{x:100,y:20});assert.equal(routeLength(path),140);assert.deepEqual(path[0],{x:0,y:20});assert.deepEqual(path.at(-1),{x:100,y:20});
 const first=router.route({x:10,y:0},{x:80,y:0});first[0].x=999;assert.equal(router.route({x:10,y:0},{x:80,y:0})[0].x,10,'caller cannot mutate the compiled floor');
});

test('unconnected rooms do not create a walk through the gap',()=>{
 const router=createFloorRouter([[[0,0],[50,0]],[[100,100],[150,100]]]);assert.deepEqual(router.route({x:0,y:0},{x:150,y:100}),[{x:0,y:0}]);
});

const boxesFor=room=>[...room.seats.map(seat=>seat.desk),...OFFICE_FITTINGS.filter(item=>item.roomId===room.id),...OFFICE_LANDSCAPE.filter(item=>item.roomId===room.id)].map(({x,y,w,h})=>({x:x-w/2-1.5,y:y-h/2-1.5,w:w+3,h:h+3}));
const passes=(route,p)=>route.slice(1).some((b,i)=>{const a=route[i];return Math.abs((b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x))<.001&&p.x>=Math.min(a.x,b.x)-.001&&p.x<=Math.max(a.x,b.x)+.001&&p.y>=Math.min(a.y,b.y)-.001&&p.y<=Math.max(a.y,b.y)+.001;});
test('all department pairs cross the real doors and their room legs avoid desks and furniture',()=>{
 for(const from of OFFICE_ROOMS)for(const to of OFFICE_ROOMS){
  const a=departmentWorkPoint(from.id),b=departmentWorkPoint(to.id),route=routeBetweenPoints(a,b);assert.deepEqual(route[0],a);assert.deepEqual(route.at(-1),b,from.id+' to '+to.id);
  if(from!==to){assert.ok(passes(route,from.door),from.id+' exit');assert.ok(passes(route,to.door),to.id+' entrance');}
  for(let i=1;i<route.length;i++)for(const room of OFFICE_ROOMS)assert.ok(floorSegmentClear(route[i-1],route[i],boxesFor(room)),from.id+' to '+to.id+' hits '+room.id+' furniture');
 }
});
test('nearest-lane projection refuses a shortcut through a solid wall and zero-length lanes are ignored',()=>{
 const router=createFloorRouter([[[0,0],[0,100]],[[10,0],[10,100]],[[5,5],[5,5]]],{canConnect:(a,b)=>b.x===0});
 assert.deepEqual(router.route({x:8,y:20},{x:8,y:80}),[{x:8,y:20},{x:0,y:20},{x:0,y:80},{x:8,y:80}]);
});
test('free floor walks take a direct short line when clear and route around occupied furniture',()=>{
 const box={x:40,y:30,w:20,h:40},router=createFreeFloorRouter({bounds:{x:0,y:0,w:100,h:100},obstacles:[box]});
 assert.deepEqual(router.route({x:10,y:10},{x:30,y:25}),[{x:10,y:10},{x:30,y:25}]);
 const path=router.route({x:10,y:50},{x:90,y:50});assert.deepEqual(path[0],{x:10,y:50});assert.deepEqual(path.at(-1),{x:90,y:50});assert.ok(routeLength(path)<110);for(let i=1;i<path.length;i++)assert.ok(floorSegmentClear(path[i-1],path[i],[box]));
 assert.deepEqual(router.route({x:10,y:50},{x:50,y:50}),[{x:10,y:50}],'an occupied destination cannot teleport a person through a table');
});
test('same-room free ground never exits through a nearby corridor or walks back through the door',()=>{
 for(const [id,a,b]of[['hr_admin',{x:235,y:320},{x:235,y:510}],['finance',{x:260,y:590},{x:260,y:795}],['general_office',{x:65,y:70},{x:65,y:220}]]){
  const room=OFFICE_ROOMS.find(item=>item.id===id),path=routeBetweenPoints(a,b);assert.deepEqual(path[0],a);assert.deepEqual(path.at(-1),b);assert.ok(routeLength(path)<=Math.hypot(a.x-b.x,a.y-b.y)+.001,id+' keeps its natural direct approach');
  for(const p of path)assert.ok(p.x>=room.x&&p.x<=room.x+room.w&&p.y>=room.y&&p.y<=room.y+room.h,id+' stays in its room');for(let i=1;i<path.length;i++)assert.ok(floorSegmentClear(path[i-1],path[i],boxesFor(room)),id);
 }
});
test('same-room walks across desk rows stay in the room and avoid every padded footprint',()=>{
 for(const room of OFFICE_ROOMS){const obstacles=boxesFor(room),inside=p=>p.x>room.x&&p.x<room.x+room.w&&p.y>room.y&&p.y<room.y+room.h;const samples=[{x:room.x+8,y:room.y+12},{x:room.x+room.w-8,y:room.y+12},{x:room.x+8,y:room.y+room.h-12},{x:room.x+room.w-8,y:room.y+room.h-12},departmentWorkPoint(room.id)].filter(p=>floorSegmentClear(p,p,obstacles));
  for(const start of samples)for(const end of samples){const path=routeBetweenPoints(start,end);assert.deepEqual(path.at(-1),end,room.id+' endpoint');assert.ok(path.every(inside),room.id+' local walk must not exit');for(let i=1;i<path.length;i++)assert.ok(floorSegmentClear(path[i-1],path[i],obstacles),room.id+' collision');}
 }
});

test('furniture clicks resolve to nearby reachable floor in the same department without moving a clear target',()=>{
 for(const room of OFFICE_ROOMS){
  const start=departmentWorkPoint(room.id),clearTarget={x:room.x+8,y:room.y+room.h-12};
  if(floorSegmentClear(clearTarget,clearTarget,boxesFor(room)))assert.deepEqual(resolveFloorDestination(start,clearTarget),clearTarget,room.id+' clear ground stays exact');
  for(const furniture of OFFICE_FITTINGS.filter(item=>item.roomId===room.id&&['sofa','cabinet'].includes(item.kind))){
   const target={x:furniture.x,y:furniture.y},resolved=resolveFloorDestination(start,target);assert.ok(resolved,room.id+' '+furniture.id);assert.notDeepEqual(resolved,target);
   assert.ok(Math.hypot(resolved.x-target.x,resolved.y-target.y)<=64);assert.ok(resolved.x>room.x&&resolved.x<room.x+room.w&&resolved.y>room.y&&resolved.y<room.y+room.h,'a furniture click cannot select a floor across the wall');
   const path=routeBetweenPoints(start,resolved);assert.deepEqual(path.at(-1),resolved);for(let i=1;i<path.length;i++)assert.ok(floorSegmentClear(path[i-1],path[i],boxesFor(room)));
  }
 }
});

test('shared amenity and data-center objects resolve outside their occupied footprint without entering another department',()=>{
 const start=departmentWorkPoint('research');
 for(const item of[OFFICE_RECREATION_AREA.poolTable,OFFICE_CONVENIENCE_AREA.counter,OFFICE_DATA_CENTER.racks[0]]){
  const target={x:item.x,y:item.y},resolved=resolveFloorDestination(start,target),box={x:item.x-item.w/2-1.5,y:item.y-item.h/2-1.5,w:item.w+3,h:item.h+3};
  assert.ok(resolved);assert.ok(floorSegmentClear(resolved,resolved,[box]));assert.deepEqual(routeBetweenPoints(start,resolved).at(-1),resolved);assert.ok(Math.hypot(resolved.x-target.x,resolved.y-target.y)<=64);
  assert.ok(!OFFICE_ROOMS.some(room=>resolved.x>room.x&&resolved.x<room.x+room.w&&resolved.y>room.y&&resolved.y<room.y+room.h));
 }
});

test('unreachable or distant replacement destinations fail instead of inventing an arrival',()=>{
 const sofa=OFFICE_FITTINGS.find(item=>item.id==='legal_sofa_1'),inside={x:sofa.x,y:sofa.y},start=departmentWorkPoint('legal');
 assert.equal(resolveFloorDestination(start,inside,{maxDistance:5}),null,'a click cannot jump beyond the requested local correction budget');
 assert.deepEqual(resolveFloorDestination(inside,start),start,'an old position inside a sofa can leave by the restricted recovery leg');
 assert.equal(resolveFloorDestination(start,{x:NaN,y:200}),null);
});

test('a legacy position inside a sofa walks out through one short clear edge before normal collision-aware travel',()=>{
 const sofa=OFFICE_FITTINGS.find(item=>item.id==='legal_sofa_1'),room=OFFICE_ROOMS.find(room=>room.id==='legal'),start={x:sofa.x,y:sofa.y},end={x:782.5,y:210},path=routeBetweenPoints(start,end),obstacles=boxesFor(room);
 assert.deepEqual(path[0],start);assert.deepEqual(path.at(-1),end);assert.ok(path.length>2);assert.ok(Math.hypot(path[1].x-start.x,path[1].y-start.y)<=64);assert.ok(floorSegmentClear(path[1],path[1],obstacles));
 const others=obstacles.filter(box=>floorSegmentClear(start,start,[box]));assert.ok(floorSegmentClear(path[0],path[1],others),'the recovery leg cannot cross a second object');
 for(let i=2;i<path.length;i++)assert.ok(floorSegmentClear(path[i-1],path[i],obstacles),'all segments after leaving the old footprint use normal obstacle rules');
 const duration=walkingDuration(path),first=walkingSample(path,duration*.05,duration);assert.equal(first.arrived,false);assert.ok(first.y<start.y&&first.y>path[1].y,'the first frames walk out gradually rather than jumping to the edge');
 const last=walkingSample(path,duration,duration);assert.equal(last.arrived,true);assert.deepEqual({x:last.x,y:last.y},end);
 assert.deepEqual(resolveFloorDestination(start,end),end,'navigation preflight and rendered walking share the repaired route');
});
