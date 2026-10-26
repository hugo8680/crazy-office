import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../src/vendor/three.module.js';
import {createOffice3DAssets,createOffice3DLayout} from '../src/scene3d-layout.js';
import {OFFICE_ROOMS,OFFICE_SEATS,officeSeatForView,ORGANIZATION_TOTALS} from '../src/organization.mjs';
import {setOrganizationOccupants} from '../src/organization-occupants.mjs';

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

// Mirror Three's buffer upload contract: a nonempty updateRanges list uploads
// only those floats. CPU-only matrix assertions miss stale furniture on GPU.
function replayMatrixUploads(layout){
 const buffers=new Map(),versions=new Map();
 const visibleMeshes=()=>{const meshes=[];layout.root.traverseVisible(object=>{if(object.isInstancedMesh)meshes.push(object);});return meshes;};
 function flush(){
  for(const mesh of visibleMeshes()){
   const attribute=mesh.instanceMatrix,previous=buffers.get(mesh);
   if(!previous||previous.length!==attribute.array.length){buffers.set(mesh,Float32Array.from(attribute.array));versions.set(mesh,attribute.version);attribute.clearUpdateRanges();continue;}
   if(versions.get(mesh)===attribute.version)continue;
   if(attribute.updateRanges.length)for(const range of attribute.updateRanges)previous.set(attribute.array.subarray(range.start,range.start+range.count),range.start);
   else previous.set(attribute.array);
   versions.set(mesh,attribute.version);attribute.clearUpdateRanges();
  }
 }
 function assertSynchronized(context){
  for(const mesh of visibleMeshes()){
   const actual=buffers.get(mesh),expected=mesh.instanceMatrix.array;assert.ok(actual,`${context}: visible batch has been uploaded`);let stale=0;
   for(let index=0;index<expected.length;index++)if(actual[index]!==expected[index])stale++;
   assert.equal(stale,0,`${context}: ${mesh.parent.name}/${mesh.geometry.type} retains stale GPU matrix values`);
  }
 }
 function visibleBodyParts(group,id){
  const matrix=new THREE.Matrix4();let count=0;
  for(const mesh of group.children){const array=buffers.get(mesh);if(!array)continue;for(let index=0;index<mesh.count;index++)if(mesh.userData.bodySeats[index]===id){matrix.fromArray(array,index*16);if(Math.abs(matrix.determinant())>1e-9)count++;}}
  return count;
 }
 flush();return {flush,assertSynchronized,visibleBodyParts};
}

test('department LOD uploads every changed GPU matrix even when idle poses queued partial updates in the same frame',()=>{
 const assets=createOffice3DAssets();try{
  const layout=createOffice3DLayout(assets),gpu=replayMatrixUploads(layout),overview=layout.root.getObjectByName('organization-overview'),representative=ai.teamZones[0].overviewSeatIds[1],ordinary=OFFICE_SEATS.find(seat=>seat.departmentId==='finance'&&seat.primarySeat);
  assert.equal(layout.setIdlePose(representative,'wave'),true);layout.tickIdlePoses(0);layout.tickIdlePoses(700);gpu.flush();gpu.assertSynchronized('overview wave');
  layout.setDepartmentDetail('ai_data');
  // A later pose may append a small range after the full LOD rewrite. It must
  // never turn the pending full upload back into a partial body-only upload.
  assert.equal(layout.setIdlePose(ordinary.id,'nod'),true);layout.tickIdlePoses(800);layout.tickIdlePoses(1000);gpu.flush();gpu.assertSynchronized('enter complete department after pending wave');
  for(const id of ai.overviewSeatIds)assert.equal(gpu.visibleBodyParts(overview,id),0,'no enlarged overview body remains over canonical desks');
  assert.equal(layout.setIdlePose(representative,'typing'),true);layout.tickIdlePoses(1100);layout.tickIdlePoses(1400);layout.setAwaySeats([representative]);gpu.flush();gpu.assertSynchronized('presence removes a moving full-roster body');
  layout.setAwaySeats([]);layout.clearIdlePoses();gpu.flush();gpu.assertSynchronized('restoring presence and ending poses');
  for(const id of ai.overviewSeatIds)assert.equal(gpu.visibleBodyParts(overview,id),0,'pose restoration preserves hidden overview bodies');
  layout.setDepartmentDetail(null);assert.equal(layout.setIdlePose(representative,'wave'),true);layout.tickIdlePoses(1500);layout.tickIdlePoses(1800);gpu.flush();gpu.assertSynchronized('leave department with same-frame overview pose');
  assert.ok(gpu.visibleBodyParts(overview,representative)>0);
  for(let round=0;round<4;round++){
   layout.setDepartmentDetail('ai_data');layout.setAwaySeats(round%2?[representative]:[]);layout.setDepartmentDetail(null);layout.setDepartmentDetail('ai_data');gpu.flush();gpu.assertSynchronized(`rapid enter/exit ${round}`);
   for(const id of ai.overviewSeatIds)assert.equal(gpu.visibleBodyParts(overview,id),0);
  }
 }finally{assets.dispose();}
});

test('changing clothes during full-roster inspection keeps hidden representatives and GPU appearance batches consistent',()=>{
 setOrganizationOccupants([]);const assets=createOffice3DAssets();try{
  const layout=createOffice3DLayout(assets),gpu=replayMatrixUploads(layout),overview=layout.root.getObjectByName('organization-overview'),representative=ai.teamZones[0].overviewSeatIds[1];
  layout.setIdlePose(representative,'wave');layout.tickIdlePoses(0);layout.tickIdlePoses(800);gpu.flush();layout.setDepartmentDetail('ai_data');
  const fixture={personId:representative,name:'显示测试',seatIds:[representative],outfitId:'cloud'};
  setOrganizationOccupants([fixture]);layout.refreshAppearances();gpu.flush();gpu.assertSynchronized('clothing refresh while entering full department');
  for(const id of ai.overviewSeatIds)assert.equal(gpu.visibleBodyParts(overview,id),0,'refreshing clothes cannot revive larger overview occupants');
  assert.equal(layout.setIdlePose(representative,'stretch'),true);layout.tickIdlePoses(1000);layout.tickIdlePoses(1500);gpu.flush();
  setOrganizationOccupants([{...fixture,outfitId:'terracotta'}]);assert.equal(layout.refreshAppearances(),true);layout.setAwaySeats([representative]);gpu.flush();gpu.assertSynchronized('clothing refresh and presence update');
  layout.setAwaySeats([]);layout.setDepartmentDetail(null);gpu.flush();gpu.assertSynchronized('overview after refreshed clothes');assert.ok(gpu.visibleBodyParts(overview,representative)>0);
 }finally{setOrganizationOccupants([]);assets.dispose();}
});

test('department fade introduces only canonical workplaces and returns to ordinary opaque rendering when settled',()=>{
 const assets=createOffice3DAssets();let layout;try{
  layout=createOffice3DLayout(assets);const gpu=replayMatrixUploads(layout),overview=layout.root.getObjectByName('organization-overview'),group=layout.root.getObjectByName('organization-department-ai_data');
  const assertOpacity=value=>{for(const mesh of group.children)assert.ok(Math.abs(mesh.material.opacity-value)<1e-8);};
  assert.equal(layout.setDepartmentDetail('ai_data',{animate:true}),true);assert.equal(layout.detailTransitionActive,true);assert.equal(group.visible,true);assertOpacity(0);
  gpu.flush();gpu.assertSynchronized('first department fade frame');for(const id of ai.overviewSeatIds)assert.equal(gpu.visibleBodyParts(overview,id),0,'outgoing footprints disappear before incoming detail fades');
  for(const mesh of group.children){assert.equal(mesh.material.transparent,true);assert.equal(mesh.material.depthWrite,false,'invisible incoming furniture cannot write depth');}
  assert.equal(layout.tickDetailTransition(1000),true);assertOpacity(0);assert.equal(layout.tickDetailTransition(1090),true);assertOpacity(.5);
  assert.equal(layout.tickDetailTransition(1180),true);assertOpacity(1);assert.equal(layout.detailTransitionActive,false);assert.equal(layout.tickDetailTransition(1200),false);
  for(const mesh of group.children){assert.equal(mesh.material.transparent,false,'settled dense furniture uses the opaque render queue');assert.equal(mesh.material.depthWrite,true);}
  assert.equal(layout.setDepartmentDetail(null),true);assert.equal(group.visible,false);gpu.flush();gpu.assertSynchronized('overview after settled fade');
 }finally{layout?.dispose();assets.dispose();}
});

test('cancel, reduced-motion finish, repeated entry and local-team focus never leave a half-transparent roster behind',()=>{
 const assets=createOffice3DAssets();let layout;try{
  layout=createOffice3DLayout(assets);const group=layout.root.getObjectByName('organization-department-ai_data');
  const assertSettled=()=>{assert.equal(layout.detailTransitionActive,false);for(const mesh of group.children){assert.equal(mesh.material.opacity,1);assert.equal(mesh.material.transparent,false);assert.equal(mesh.material.depthWrite,true);}};
  layout.setDepartmentDetail('ai_data',{animate:true});layout.tickDetailTransition(100);layout.tickDetailTransition(145);assert.equal(layout.detailTransitionActive,true);
  layout.setDepartmentDetail('finance');assert.equal(group.visible,false);assertSettled();assert.equal(layout.tickDetailTransition(1000),false);
  layout.setDepartmentDetail('ai_data',{animate:false});assert.equal(group.visible,true);assertSettled();
  for(let round=0;round<3;round++){
   layout.setDepartmentDetail(null);layout.setDepartmentDetail('ai_data',{animate:true});layout.tickDetailTransition(2000+round*300);layout.tickDetailTransition(2050+round*300);
   assert.equal(layout.finishDetailTransition(),true,'a reduced-motion preference or inactive renderer settles once');assertSettled();assert.equal(layout.finishDetailTransition(),false);
  }
  layout.setDepartmentDetail(null);layout.setDepartmentDetail('ai_data',{animate:true});layout.tickDetailTransition(4000);layout.tickDetailTransition(4020);layout.enterTeam(ai.teamZones[0].id);
  assert.equal(group.visible,false);assert.equal(layout.localTeamId,ai.teamZones[0].id);assertSettled();layout.exitTeam();assert.equal(group.visible,false);
 }finally{layout?.dispose();assets.dispose();}
});

test('all 206 canonical AI colleagues share one body and desk scale, including the department manager',()=>{
 const assets=createOffice3DAssets();let layout;try{
  layout=createOffice3DLayout(assets);layout.setDepartmentDetail('ai_data');const group=layout.root.getObjectByName('organization-department-ai_data'),heights=[];
  assert.equal(ai.seats.length,206);assert.equal(ai.seats.filter(seat=>layout.isSeatVisible(seat.id)).length,206);
  for(const seat of ai.seats){
   const shown=layout.seatGeometry(seat.id);assert.equal(shown.scale,.24);assert.equal(shown.desk.w,14);assert.equal(shown.desk.h,9);
   const height=headBounds(group,seat.id).getSize(new THREE.Vector3()).y;assert.ok(height>2,'each canonical colleague has a real visible body');heights.push(height);
  }
  assert.ok(Math.max(...heights)-Math.min(...heights)<1e-4,'leaders and staff cannot produce oversized bodies in the same canonical department');
 }finally{layout?.dispose();assets.dispose();}
});

test('dense department meshes preserve exact footprints and batch count while drawing fewer triangles',()=>{
 const assets=createOffice3DAssets();let layout;try{
  const triangles=geometry=>(geometry.index?.count??geometry.attributes.position.count)/3;
  for(const [kind,geometry]of Object.entries(assets.compactGeometries)){
   const full=assets.geometries[kind];geometry.computeBoundingBox();full.computeBoundingBox();
   for(const edge of['min','max'])for(const axis of['x','y','z'])assert.ok(Math.abs(geometry.boundingBox[edge][axis]-full.boundingBox[edge][axis])<1e-7,`${kind} preserves ${edge}.${axis} footprint`);
   assert.ok(triangles(geometry)<triangles(full),`${kind} genuinely reduces geometry`);
  }
  layout=createOffice3DLayout(assets);const group=layout.root.getObjectByName('organization-department-ai_data');let actual=0,unreduced=0;
  assert.ok(group.children.length<=6,'all 206 workplaces retain six shared draw batches');
  for(const mesh of group.children){
   const kind=Object.keys(assets.compactGeometries).find(key=>assets.compactGeometries[key]===mesh.geometry)||Object.keys(assets.geometries).find(key=>assets.geometries[key]===mesh.geometry);assert.ok(kind);
   actual+=triangles(mesh.geometry)*mesh.count;unreduced+=triangles(assets.geometries[kind])*mesh.count;
  }
  assert.ok(actual<unreduced*.6,`dense roster should use less than 60% of the previous triangles: ${actual}/${unreduced}`);
 }finally{layout?.dispose();assets.dispose();}
});

test('department detail shows every canonical AI workplace and restores the compact representative overview without rebuilding',()=>{
 const assets=createOffice3DAssets();try{
  const layout=createOffice3DLayout(assets),overview=[...layout.visibleSeatIds].sort(),instances=layout.statistics.staticInstances,roots=layout.root.children.length,group=layout.root.getObjectByName('organization-department-ai_data');
  assert.equal(ai.seats.filter(seat=>layout.isSeatVisible(seat.id)).length,21);assert.equal(group.visible,false);assert.equal(layout.setDepartmentDetail('ai_data'),true);
  assert.equal(layout.departmentDetailId,'ai_data');assert.equal(layout.localTeamId,null);assert.equal(group.visible,true);assert.equal(ai.seats.filter(seat=>layout.isSeatVisible(seat.id)).length,206);
  assert.equal(layout.visibleSeatIds.size,OFFICE_SEATS.length);assert.deepEqual([...owners(group)].sort(),ai.seats.map(seat=>seat.id).sort());
  for(const seat of ai.seats){assert.equal(layout.seatGeometry(seat.id),seat);assert.ok(seat.desk.x>=ai.x&&seat.desk.x<=ai.x+ai.w);assert.ok(seat.y>=ai.y&&seat.y<=ai.y+ai.h);}
  const hiddenBefore=ai.seats.find(seat=>!seat.overviewVisible);assert.ok(headBounds(group,hiddenBefore.id).getSize(new THREE.Vector3()).y>2);
  assert.equal(layout.setDepartmentDetail('ai_data'),false);assert.equal(layout.root.children.length,roots);assert.equal(layout.statistics.staticInstances,instances);
  assert.equal(layout.setDepartmentDetail('finance'),true);assert.equal(group.visible,false);assert.deepEqual([...layout.visibleSeatIds].sort(),overview);
  layout.setDepartmentDetail('ai_data');layout.enterTeam(ai.teamZones[0].id);assert.equal(layout.departmentDetailId,null);assert.equal(layout.visibleSeatIds.size,41);layout.exitTeam();assert.deepEqual([...layout.visibleSeatIds].sort(),overview);
 }finally{assets.dispose();}
});

test('full department poses and away seats affect the full roster once and never restore hidden representatives',()=>{
 const assets=createOffice3DAssets();try{
  const layout=createOffice3DLayout(assets),seat=ai.seats.find(seat=>!seat.overviewVisible&&seat.role==='staff'),group=layout.root.getObjectByName('organization-department-ai_data');
  layout.setDepartmentDetail('ai_data');assert.equal(layout.setIdlePose(seat.id,'wave'),true);layout.tickIdlePoses(1000);assert.ok(layout.tickIdlePoses(1500)>0);layout.setAwaySeats([seat.id]);assert.equal(layout.hasIdlePoses,false);assert.equal(headBounds(group,seat.id).isEmpty(),true);layout.setAwaySeats([]);assert.equal(headBounds(group,seat.id).isEmpty(),false);
  assert.equal(layout.setIdlePose(seat.id,'typing'),true);layout.setDepartmentDetail(null);assert.equal(layout.hasIdlePoses,false);assert.equal(layout.isSeatVisible(seat.id),false);
 }finally{assets.dispose();}
});

test('AI inspection removes only the foreground public board and restores its exact static matrices afterward',()=>{
 const assets=createOffice3DAssets();try{
  const layout=createOffice3DLayout(assets),entries=layout.root.children.filter(mesh=>mesh.isInstancedMesh).map(mesh=>({mesh,before:Float32Array.from(mesh.instanceMatrix.array)}));
  assert.equal(layout.isBulletinOccluded,false);layout.setDepartmentDetail('ai_data');assert.equal(layout.isBulletinOccluded,true);let changed=0;
  for(const {mesh,before}of entries)for(let index=0;index<mesh.count;index++){
   const actual=Array.from(mesh.instanceMatrix.array.slice(index*16,index*16+16)),original=Array.from(before.slice(index*16,index*16+16));
   if(mesh.userData.facilityOwners?.[index]==='bulletin'){assert.deepEqual(actual,new THREE.Matrix4().makeScale(0,0,0).toArray());changed++;}
   else assert.deepEqual(actual,original,'public benches, floor, landscape and other furniture retain their original transforms');
  }
  assert.equal(changed,11);layout.setDepartmentDetail('finance');assert.equal(layout.isBulletinOccluded,false);for(const {mesh,before}of entries)assert.deepEqual(mesh.instanceMatrix.array,before);
  layout.setDepartmentDetail('ai_data');layout.setDepartmentDetail(null);assert.equal(layout.isBulletinOccluded,false);for(const {mesh,before}of entries)assert.deepEqual(mesh.instanceMatrix.array,before);
 }finally{assets.dispose();}
});

test('AI team details build all forty staff and their head at normal scale without changing logical employees or campus bounds',()=>{
 const assets=createOffice3DAssets();try{
  const layout=createOffice3DLayout(assets);
  assert.equal(ORGANIZATION_TOTALS.people,249);assert.equal(OFFICE_SEATS.length,250);assert.equal(ai.seats.length,206);
  assert.equal(layout.statistics.workplaces,250);assert.equal(layout.statistics.people,249);
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

test('shared quiet team finishes leave every desk and colleague footprint intact and stay under the existing instance budget',async()=>{
 const {officeTeamInterior,OFFICE_TEAM_MATERIALS}=await import('../src/office-team-interior.mjs'),{renderOfficeTeamFloor}=await import('../src/scene-floor2d.mjs');
 const assets=createOffice3DAssets();try{
  const layout=createOffice3DLayout(assets);assert.ok(layout.statistics.staticInstances<31000,`instance count ${layout.statistics.staticInstances}`);
  for(const team of ai.teamZones){
   const original=team.seats.map(seat=>({x:seat.x,y:seat.y,detail:JSON.stringify(seat.detailGeometry)})),interior=officeTeamInterior(team),bounds=team.detailBounds;
   assert.equal(interior.islands.length,4);assert.equal(interior.plants.length,2);
   const furniture=[interior.bench,interior.table,interior.cabinet,...interior.plants.map(p=>({...p,w:p.r*2,h:p.r*2}))];
   for(const item of furniture){
    assert.ok(item.x-item.w/2>=bounds.x&&item.x+item.w/2<=bounds.x+bounds.w);assert.ok(item.y-item.h/2>=bounds.y&&item.y+item.h/2<=bounds.y+120,'all new fittings stay in the unused rear band');
    for(const seat of team.seats){const shown=officeSeatForView(seat,{detail:true}),desk=shown.desk;assert.ok(item.x+item.w/2<=desk.x-desk.w/2||item.x-item.w/2>=desk.x+desk.w/2||item.y+item.h/2<=desk.y-desk.h/2||item.y-item.h/2>=desk.y+desk.h/2,`${team.id} decoration overlaps ${seat.id}`);assert.ok(Math.abs(item.x-shown.x)>item.w/2+6||Math.abs(item.y-shown.y)>item.h/2+6,'chairs keep clear of decorative furniture');}
   }
   const plantCalls=[],svg=renderOfficeTeamFloor(team,{uid:'proof',plant:(x,y,scale)=>{plantCalls.push({x,y,scale});return `<g data-proof-plant="${x},${y}"/>`;}});
   assert.match(svg,new RegExp(`fill="${OFFICE_TEAM_MATERIALS.floor}"`));assert.equal((svg.match(/data-team-decoration="work-islands"/g)||[]).length,1);assert.match(svg,/data-team-decoration="bench"/);assert.match(svg,/data-team-decoration="table"/);assert.match(svg,/data-team-decoration="cabinet"/);assert.equal(plantCalls.length,2);assert.match(svg,/aria-hidden="true" pointer-events="none"/);
   assert.doesNotMatch(svg,/filter=|shadow|glow|tabindex|data-erp-action|data-position/);assert.deepEqual(team.seats.map(seat=>({x:seat.x,y:seat.y,detail:JSON.stringify(seat.detailGeometry)})),original);
  }
 }finally{assets.dispose();}
});

test('department hover stays visible above every floor with unlit fill and a full inset geometric rim',()=>{
 const assets=createOffice3DAssets();try{
  const layout=createOffice3DLayout(assets),group=layout.root.getObjectByName('department-hover'),[plane,rim]=group.children,roots=layout.root.children.length,instances=layout.statistics.staticInstances;
  const staticFloors=[];
  for(const mesh of layout.root.children.filter(mesh=>mesh.isInstancedMesh&&mesh.geometry===assets.geometries.slab)){
   mesh.geometry.computeBoundingBox();const matrix=new THREE.Matrix4(),color=new THREE.Color(),floorColors=OFFICE_ROOMS.map(room=>new THREE.Color(room.floor)).concat(new THREE.Color('#e0e8de'));
   for(let index=0;index<mesh.count;index++){
    mesh.getColorAt(index,color);if(!floorColors.some(floor=>Math.abs(floor.r-color.r)+Math.abs(floor.g-color.g)+Math.abs(floor.b-color.b)<1e-5))continue;
    mesh.getMatrixAt(index,matrix);staticFloors.push(mesh.geometry.boundingBox.clone().applyMatrix4(matrix));
   }
  }
  assert.ok(staticFloors.length>=OFFICE_ROOMS.length+ai.teamZones.length,'inspect actual department and raised team floor geometry');
  // Production disables both forms of automatic matrix updates for static
  // architecture. Feedback must still move and resize in that exact state.
  layout.root.updateMatrixWorld(true);layout.root.traverse(object=>{object.matrixAutoUpdate=false;object.matrixWorldAutoUpdate=false;});
  assert.equal(layout.hoveredDepartmentId,null);assert.equal(group.visible,false);assert.equal(layout.setHoveredDepartment(null),false);
  assert.equal(plane.castShadow,false);assert.equal(plane.receiveShadow,false);assert.equal(plane.material.isMeshBasicMaterial,true);assert.equal(plane.material.toneMapped,false);assert.equal(plane.material.transparent,true);assert.ok(plane.material.opacity>=.18&&plane.material.opacity<=.25);assert.equal(plane.material.depthWrite,false);
  assert.equal(rim.isInstancedMesh,true);assert.equal(rim.count,4);assert.equal(rim.geometry,assets.geometries.box);assert.equal(rim.material.isMeshBasicMaterial,true);assert.equal(rim.material.toneMapped,false);assert.equal(rim.material.depthWrite,false);assert.equal(rim.castShadow,false);assert.equal(rim.receiveShadow,false);
  plane.geometry.computeBoundingBox();rim.geometry.computeBoundingBox();const rimMatrix=new THREE.Matrix4(),worldRimMatrix=new THREE.Matrix4();
  for(const room of OFFICE_ROOMS){
   assert.equal(layout.setHoveredDepartment(room.id),true);assert.equal(layout.hoveredDepartmentId,room.id);assert.equal(group.visible,true);
   assert.deepEqual(group.position.toArray(),[room.x+room.w/2,0,room.y+room.h/2]);assert.deepEqual(plane.scale.toArray(),[room.w-14,.08,room.h-14]);
   const fillBounds=plane.geometry.boundingBox.clone().applyMatrix4(plane.matrixWorld),floors=staticFloors.filter(bounds=>bounds.min.x>=room.x-.01&&bounds.max.x<=room.x+room.w+.01&&bounds.min.z>=room.y-.01&&bounds.max.z<=room.y+room.h+.01),floorTop=Math.max(...floors.map(bounds=>bounds.max.y));
   assert.ok(floors.length>0);assert.ok(fillBounds.min.y>floorTop+.1,`${room.id} raised floors cannot cover the hover fill`);assert.ok(fillBounds.max.y<5,'furniture and people stay in front of the floor feedback');
   assert.ok(Math.abs((fillBounds.min.x+fillBounds.max.x)/2-(room.x+room.w/2))<1e-8);assert.ok(Math.abs((fillBounds.min.z+fillBounds.max.z)/2-(room.y+room.h/2))<1e-8);assert.ok(fillBounds.max.x-fillBounds.min.x>room.w-15,'the real frozen world matrix covers the department rather than the origin');
   const base=new THREE.Color(room.floor),blended=base.clone().lerp(plane.material.color,plane.material.opacity);assert.ok(Math.abs(base.r-blended.r)+Math.abs(base.g-blended.g)+Math.abs(base.b-blended.b)>.08,'every department has measurable fill contrast');
   const sides=[];
   for(let index=0;index<rim.count;index++){
    rim.getMatrixAt(index,rimMatrix);worldRimMatrix.multiplyMatrices(rim.matrixWorld,rimMatrix);const bounds=rim.geometry.boundingBox.clone().applyMatrix4(worldRimMatrix),size=bounds.getSize(new THREE.Vector3());
    assert.ok(bounds.min.y>floorTop+.1);assert.ok(bounds.max.y<5);assert.ok(bounds.min.x>room.x+5&&bounds.max.x<room.x+room.w-5&&bounds.min.z>room.y+5&&bounds.max.z<room.y+room.h-5,'the rim sits inside the walls');assert.ok(Math.min(size.x,size.z)>2.7,'rim width is world geometry, independent of WebGL line width');sides.push(size.x>size.z?'horizontal':'vertical');
   }
   assert.deepEqual(sides,['horizontal','horizontal','vertical','vertical']);
   const matrix=group.matrixWorld.elements.slice();assert.equal(layout.setHoveredDepartment(room.id),false);assert.deepEqual(group.matrixWorld.elements,matrix,'repeated pointer samples do not dirty the hover transform');
   assert.equal(layout.root.children.length,roots);assert.equal(layout.statistics.staticInstances,instances);assert.equal(group.children[0],plane);assert.equal(group.children[1],rim);
  }
  assert.equal(layout.setHoveredDepartment('missing'),true);assert.equal(group.visible,false);assert.equal(layout.setHoveredDepartment('missing'),false);
  layout.setHoveredDepartment('ai_data');layout.enterTeam(ai.teamZones[0].id);assert.equal(layout.hoveredDepartmentId,null);assert.equal(group.visible,false);assert.equal(layout.setHoveredDepartment('finance'),false,'a hidden campus cannot leave a department plane over the legacy local floor');layout.exitTeam();assert.equal(group.visible,false);assert.equal(layout.setHoveredDepartment('finance'),true);
 }finally{assets.dispose();}
});
