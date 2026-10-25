import test from 'node:test';
import assert from 'node:assert/strict';
import {officeWalkingStep} from '../src/office-walking.mjs';
import {OFFICE_ROOMS,OFFICE_FITTINGS,OFFICE_DATA_CENTER} from '../src/organization.mjs';
import {routeBetweenPoints} from '../src/scene-motion.js';

test('direct movement has a fixed world speed, normalized diagonals and bounded elapsed time',()=>{
 const start={x:290,y:700},right=officeWalkingStep(start,{x:1,y:0},20),diagonal=officeWalkingStep(start,{x:1,y:1},20);
 assert.ok(Math.abs(right.x-start.x-2.1)<1e-9);assert.ok(Math.abs(Math.hypot(diagonal.x-start.x,diagonal.y-start.y)-2.1)<1e-9);
 assert.ok(Math.hypot(...Object.values(officeWalkingStep(start,{x:1,y:0},1000)).map((value,i)=>value-[start.x,start.y][i]))<=5.250001);
 for(const direction of [{x:NaN,y:0},{x:0,y:0}])assert.deepEqual(officeWalkingStep(start,direction,16),start);
 assert.equal(officeWalkingStep(null,{x:1,y:0},16),null);
});
test('all department doorways allow direct crossing, while solid walls prevent crossing',()=>{
 for(const room of OFFICE_ROOMS){
  const {door}=room,vector=door.side==='left'?{x:1,y:0}:door.side==='right'?{x:-1,y:0}:door.side==='top'?{x:0,y:1}:{x:0,y:-1};
  const start={x:door.x-vector.x*2,y:door.y-vector.y*2},next=officeWalkingStep(start,vector,40);
  assert.ok(Math.hypot(next.x-start.x,next.y-start.y)>4,room.id+' enters door');
  const blocked={x:room.x-2,y:room.y+8};assert.deepEqual(officeWalkingStep(blocked,{x:1,y:0},40),blocked,room.id+' wall');
 }
 const dc=OFFICE_DATA_CENTER,start={x:dc.door.x,y:dc.door.y+2};assert.ok(officeWalkingStep(start,{x:0,y:-1},40).y<dc.door.y);
});
test('desks and shared furniture stay solid and diagonal input slides along the obstruction',()=>{
 const room=OFFICE_ROOMS.find(room=>room.id==='finance'),desk=room.seats[0].desk,start={x:desk.x,y:desk.y+desk.h/2+2};
 const blocked=officeWalkingStep(start,{x:0,y:-1},40);assert.deepEqual(blocked,start);
 const sliding=officeWalkingStep(start,{x:1,y:-1},40);assert.ok(sliding.x>start.x);assert.equal(sliding.y,start.y);
 const sofa=OFFICE_FITTINGS.find(item=>item.id==='legal_sofa_1'),saved={x:sofa.x,y:sofa.y},escaped=officeWalkingStep(saved,{x:0,y:1},40);assert.ok(escaped.y>saved.y,'legacy furniture overlap can be walked out of');
});
test('keyboard paths stay reachable by the same persisted click walker across a doorway',()=>{
 const room=OFFICE_ROOMS.find(room=>room.id==='research'),origin={x:room.door.x,y:room.door.y-8};let current=origin;
 for(let i=0;i<12;i++)current=officeWalkingStep(current,{x:0,y:1},16);
 assert.ok(current.y>room.y);assert.deepEqual(routeBetweenPoints(origin,current).at(-1),current);
 const bounds={x:1370,y:1080};assert.deepEqual(officeWalkingStep(bounds,{x:1,y:1},50),bounds);
});
