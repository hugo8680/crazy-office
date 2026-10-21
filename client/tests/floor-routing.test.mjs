import test from 'node:test';
import assert from 'node:assert/strict';
import {createFloorRouter} from '../src/floor-routing.mjs';
import {OFFICE_ROOMS,departmentWorkPoint,OFFICE_WALKING_SEGMENTS} from '../src/organization.mjs';
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

test('every new department connects to all others through actual office lanes',()=>{
 const covered=(a,b)=>OFFICE_WALKING_SEGMENTS.some(([c,d])=>{
  const on=p=>Math.abs((d[0]-c[0])*(p.y-c[1])-(d[1]-c[1])*(p.x-c[0]))<.001&&p.x>=Math.min(c[0],d[0])-.001&&p.x<=Math.max(c[0],d[0])+.001&&p.y>=Math.min(c[1],d[1])-.001&&p.y<=Math.max(c[1],d[1])+.001;
  return on(a)&&on(b);
 });
 for(const from of OFFICE_ROOMS)for(const to of OFFICE_ROOMS){
  const a=departmentWorkPoint(from.id),b=departmentWorkPoint(to.id),route=routeBetweenPoints(a,b);assert.deepEqual(route[0],a);assert.deepEqual(route.at(-1),b,from.id+' to '+to.id);
  for(let i=1;i<route.length;i++)assert.ok(covered(route[i-1],route[i]),from.id+' to '+to.id+' leaves a corridor');
 }
});
