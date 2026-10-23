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

test('AI team details build all forty staff and their head at normal scale without changing logical employees or campus bounds',()=>{
 const assets=createOffice3DAssets();try{
  const layout=createOffice3DLayout(assets);
  assert.equal(ORGANIZATION_TOTALS.people,249);assert.equal(OFFICE_SEATS.length,251);assert.equal(ai.seats.length,206);
  assert.equal(layout.statistics.workplaces,251);assert.equal(layout.statistics.people,249);
  for(const team of ai.teamZones){
   const group=layout.seatGroups.get(team.id),bounds=team.detailBounds;
   assert.equal(team.seats.length,41);assert.equal(group.seatIds.length,41);assert.deepEqual(group.seatIds,team.detailSeatIds);assert.equal(group.overviewSeatIds.length,4);
   assert.deepEqual([...owners(group.root)].sort(),team.seats.map(seat=>seat.id).sort());
   assert.equal(group.seatIds.filter(id=>OFFICE_SEATS.find(seat=>seat.id===id).role==='head').length,1);
   assert.equal(group.seatIds.filter(id=>OFFICE_SEATS.find(seat=>seat.id===id).role==='staff').length,40);
   assert.ok(group.root.children.filter(mesh=>mesh.isInstancedMesh).length<=7);
   for(const seat of team.seats){const geometry=officeSeatForView(seat,{detail:true});assert.equal(geometry.scale,.72);assert.equal(geometry.desk.w,64);assert.equal(geometry.desk.h,28);assert.ok(geometry.desk.x-geometry.desk.w/2>=bounds.x);assert.ok(geometry.desk.x+geometry.desk.w/2<=bounds.x+bounds.w);assert.ok(geometry.desk.y-geometry.desk.h/2>=bounds.y);assert.ok(geometry.y<=bounds.y+bounds.h);}
  }
 }finally{assets.dispose();}
});

test('entering a team isolates its full room and exiting restores exactly the four representative campus overview',()=>{
 const assets=createOffice3DAssets();try{
  const layout=createOffice3DLayout(assets),overviewIds=[...layout.visibleSeatIds].sort(),normalRoots=layout.root.children.filter(root=>root.visible);
  assert.equal(layout.localTeamId,null);assert.equal(layout.exitTeam(),false);assert.equal(layout.enterTeam('missing'),null);
  for(const team of ai.teamZones){
   assert.equal(team.seats.filter(seat=>layout.isSeatVisible(seat.id)).length,4);
   assert.equal(layout.enterTeam(team.id),team);assert.equal(layout.localTeamId,team.id);assert.equal(layout.visibleSeatIds.size,41);
   assert.deepEqual([...layout.visibleSeatIds].sort(),team.seats.map(seat=>seat.id).sort());
   assert.deepEqual(layout.root.children.filter(root=>root.visible),[layout.seatGroups.get(team.id).root],'all campus furniture, surroundings and other teams stay out of the local room');
   for(const seat of team.seats)assert.deepEqual(layout.seatGeometry(seat.id),officeSeatForView(seat,{detail:true}));
   const outside=OFFICE_SEATS.find(seat=>seat.departmentId==='business');assert.equal(layout.isSeatVisible(outside.id),false);assert.equal(layout.seatGeometry(outside.id),outside,'hidden logical posts retain their canonical coordinates');
   assert.equal(layout.exitTeam(),true);assert.equal(layout.localTeamId,null);assert.deepEqual([...layout.visibleSeatIds].sort(),overviewIds);assert.deepEqual(layout.root.children.filter(root=>root.visible),normalRoots);
  }
  layout.setDetailGroups([ai.teamZones[0].id]);assert.equal(layout.localTeamId,ai.teamZones[0].id);layout.setDetailGroups([ai.teamZones[1].id]);assert.equal(layout.localTeamId,ai.teamZones[1].id);assert.equal(layout.visibleSeatIds.size,41);
  layout.setDetailGroups([]);assert.equal(layout.localTeamId,null);assert.deepEqual([...layout.visibleSeatIds].sort(),overviewIds);
  assert.equal(layout.isSeatVisible('missing'),false);assert.equal(layout.seatGeometry('missing'),null);
 }finally{assets.dispose();}
});

test('all forty-one actual team head meshes match ordinary full-sized employee geometry rather than six enlarged samples',()=>{
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

test('team display transforms round-trip all server seat coordinates and arbitrary walking points without mutation',()=>{
 const assets=createOffice3DAssets();try{
  const layout=createOffice3DLayout(assets),outside={x:400,y:500,nodeId:'courtyard'};assert.equal(layout.displayPoint(outside),outside);assert.equal(layout.canonicalPoint(outside),outside);
  for(const team of ai.teamZones){
   layout.enterTeam(team.id);
   for(const point of [...team.seats.map(seat=>({x:seat.x,y:seat.y,seatId:seat.id})),{x:team.x+37.5,y:team.y+88.25,nodeId:team.id}]){
    const before={...point},display=layout.displayPoint(point),canonical=layout.canonicalPoint(display);
    assert.deepEqual(point,before);assert.ok(Math.abs(canonical.x-point.x)<1e-8);assert.ok(Math.abs(canonical.y-point.y)<1e-8);assert.equal(canonical.seatId,point.seatId);assert.equal(canonical.nodeId,point.nodeId);
    if(point.seatId){const geometry=layout.seatGeometry(point.seatId);assert.ok(Math.abs(geometry.x-display.x)<1e-8);assert.ok(Math.abs(geometry.y-display.y)<1e-8);}
   }
   layout.exitTeam();
  }
 }finally{assets.dispose();}
});

test('local team idle poses and presence replacement never reveal another team or leave a hidden campus body behind',()=>{
 const assets=createOffice3DAssets();try{
  const layout=createOffice3DLayout(assets),team=ai.teamZones[0],outside=ai.teamZones[1].seats[0],seat=team.seats[0],group=layout.seatGroups.get(team.id).root;
  layout.enterTeam(team.id);assert.equal(layout.setIdlePose(outside.id,'wave'),false);assert.equal(layout.setIdlePose(seat.id,'wave'),true);layout.tickIdlePoses(0);assert.ok(layout.tickIdlePoses(1000)>0);
  assert.equal(layout.setAwaySeats([seat.id]),true);assert.equal(layout.idlePoseSeatIds.includes(seat.id),false);assert.equal(headBounds(group,seat.id).isEmpty(),true);
  layout.setAwaySeats([]);assert.equal(headBounds(group,seat.id).isEmpty(),false);layout.exitTeam();assert.equal(layout.hasIdlePoses,false);
  assert.deepEqual([...owners(group)].sort(),[...team.detailSeatIds].sort());
 }finally{assets.dispose();}
});
