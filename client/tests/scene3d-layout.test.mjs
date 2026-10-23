import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../src/vendor/three.module.js';
import {createOffice3DAssets,createOffice3DLayout} from '../src/scene3d-layout.js';
import {OFFICE_ROOMS,OFFICE_SEATS,officeSeatForView,ORGANIZATION_TOTALS} from '../src/organization.mjs';

const ai=OFFICE_ROOMS.find(room=>room.id==='ai_data');
const owners=group=>new Set(group.children.flatMap(mesh=>mesh.userData.bodySeats||[]).filter(Boolean));
function headBounds(group,seatId){
 const bounds=new THREE.Box3(),matrix=new THREE.Matrix4();
 for(const mesh of group.children){
  if(!mesh.isInstancedMesh)continue;
  mesh.geometry.computeBoundingBox();
  for(let index=0;index<mesh.count;index++){
   if(mesh.userData.bodySeats[index]!==seatId||mesh.userData.bodyParts[index]!=='head')continue;
   mesh.getMatrixAt(index,matrix);if(Math.abs(matrix.determinant())<1e-9)continue;
   bounds.union(mesh.geometry.boundingBox.clone().applyMatrix4(matrix));
  }
 }
 return bounds;
}

test('AI team details build six full-sized representatives while retaining every logical employee and workplace',()=>{
 const assets=createOffice3DAssets();try{
  const layout=createOffice3DLayout(assets);
  assert.equal(ORGANIZATION_TOTALS.people,249);assert.equal(OFFICE_SEATS.length,251);assert.equal(ai.seats.length,206);
  assert.equal(layout.statistics.workplaces,251);assert.equal(layout.statistics.people,249);
  for(const team of ai.teamZones){
   const group=layout.seatGroups.get(team.id);
   assert.equal(team.seats.length,41);assert.equal(group.seatIds.length,6);assert.deepEqual(group.seatIds,team.detailSeatIds);assert.deepEqual(group.overviewSeatIds,team.overviewSeatIds);
   assert.deepEqual([...owners(group.root)].sort(),[...team.detailSeatIds].sort());
   assert.equal(group.seatIds.filter(id=>OFFICE_SEATS.find(seat=>seat.id===id).role==='head').length,1);
   assert.equal(group.seatIds.filter(id=>OFFICE_SEATS.find(seat=>seat.id===id).role==='staff').length,5);
   assert.ok(group.root.children.filter(mesh=>mesh.isInstancedMesh).length<=7);
   for(const id of group.seatIds){const geometry=officeSeatForView(OFFICE_SEATS.find(seat=>seat.id===id),{detail:true});assert.equal(geometry.scale,.72);assert.equal(geometry.desk.w,64);assert.equal(geometry.desk.h,28);assert.ok(geometry.desk.x-geometry.desk.w/2>=team.x);assert.ok(geometry.desk.x+geometry.desk.w/2<=team.x+team.w);assert.ok(geometry.desk.y-geometry.desk.h/2>=team.y);assert.ok(geometry.y<=team.y+team.h);}
  }
 }finally{assets.dispose();}
});

test('only the four overview or six detailed representatives are visible, without discarding hidden presence coordinates',()=>{
 const assets=createOffice3DAssets();try{
  const layout=createOffice3DLayout(assets);
  for(const team of ai.teamZones){
   assert.deepEqual(team.seats.filter(seat=>layout.isSeatVisible(seat.id)).map(seat=>seat.id).sort(),[...team.overviewSeatIds].sort());
   layout.setDetailGroups([team.id]);
   assert.deepEqual(team.seats.filter(seat=>layout.isSeatVisible(seat.id)).map(seat=>seat.id).sort(),[...team.detailSeatIds].sort());
   for(const seat of team.seats){
    if(team.detailSeatIds.includes(seat.id))assert.deepEqual(layout.seatGeometry(seat.id),officeSeatForView(seat,{detail:true}));
    else{assert.equal(layout.isSeatVisible(seat.id),false);assert.equal(layout.seatGeometry(seat.id),seat,'hidden logical seats remain available to real presence without new furniture or picks');}
   }
   layout.setDetailGroups([]);assert.deepEqual(team.seats.filter(seat=>layout.isSeatVisible(seat.id)).map(seat=>seat.id).sort(),[...team.overviewSeatIds].sort());
  }
  for(const seat of OFFICE_SEATS.filter(seat=>seat.departmentId!=='ai_data'))assert.equal(layout.isSeatVisible(seat.id),true);
  assert.equal(layout.isSeatVisible('missing'),false);assert.equal(layout.seatGeometry('missing'),null);
 }finally{assets.dispose();}
});

test('actual team head meshes match ordinary full-sized employee geometry in both overview and detail buffers',()=>{
 const assets=createOffice3DAssets();try{
  const layout=createOffice3DLayout(assets),ordinary=OFFICE_SEATS.find(seat=>seat.departmentId!=='ai_data'&&seat.scale===.72&&seat.primarySeat),overview=layout.root.getObjectByName('organization-overview');
  const ordinaryHeight=headBounds(overview,ordinary.id).getSize(new THREE.Vector3()).y;
  assert.ok(ordinaryHeight>8&&ordinaryHeight<12,`ordinary head height ${ordinaryHeight}`);
  for(const team of ai.teamZones){
   const group=layout.seatGroups.get(team.id).root;
   for(const id of team.detailSeatIds){const actual=headBounds(group,id).getSize(new THREE.Vector3()).y;assert.ok(Math.abs(actual-ordinaryHeight)<1e-4,`${id} was rendered at a different body scale: ${actual} vs ${ordinaryHeight}`);}
   for(const id of team.overviewSeatIds){const actual=headBounds(overview,id).getSize(new THREE.Vector3()).y;assert.ok(Math.abs(actual-ordinaryHeight)<1e-4);}
  }
 }finally{assets.dispose();}
});

test('sampled team idle poses and presence replacement never reveal an unrepresented compact employee',()=>{
 const assets=createOffice3DAssets();try{
  const layout=createOffice3DLayout(assets),team=ai.teamZones[0],hidden=team.seats.find(seat=>!team.detailSeatIds.includes(seat.id)),seat=team.seats.find(seat=>seat.id===team.detailSeatIds[0]),group=layout.seatGroups.get(team.id).root;
  layout.setDetailGroups([team.id]);assert.equal(layout.setIdlePose(hidden.id,'wave'),false);assert.equal(layout.setIdlePose(seat.id,'wave'),true);layout.tickIdlePoses(0);assert.ok(layout.tickIdlePoses(1000)>0);
  assert.equal(layout.setAwaySeats([seat.id]),true);assert.equal(layout.idlePoseSeatIds.includes(seat.id),false);assert.equal(headBounds(group,seat.id).isEmpty(),true);
  layout.setAwaySeats([]);assert.equal(headBounds(group,seat.id).isEmpty(),false);layout.setDetailGroups([]);assert.equal(layout.hasIdlePoses,false);assert.equal(layout.setIdlePose(hidden.id,'nod'),false);
  assert.deepEqual([...owners(group)].sort(),[...team.detailSeatIds].sort());
 }finally{assets.dispose();}
});
