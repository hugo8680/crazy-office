import test from 'node:test';
import assert from 'node:assert/strict';
import {createFloorRouter,createFreeFloorRouter,floorSegmentClear} from '../src/floor-routing.mjs';
import {OFFICE_ROOMS,departmentWorkPoint,OFFICE_WALKING_SEGMENTS,OFFICE_FITTINGS,OFFICE_LANDSCAPE} from '../src/organization.mjs';
import {routeBetweenPoints,routeLength} from '../src/scene-motion.js';

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
