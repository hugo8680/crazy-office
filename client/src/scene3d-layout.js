import * as THREE from './vendor/three.module.js';

import { OFFICE_WORLD, OFFICE_BULLETIN_AREA, OFFICE_CONVENIENCE_AREA, OFFICE_ROOMS, OFFICE_SEATS, officeSeatForView, OFFICE_FITTINGS, OFFICE_SHARED_AREAS, OFFICE_LANDSCAPE, OFFICE_WALKING_SEGMENTS, OFFICE_AGENT_HOMES, OFFICE_WORK_POSITIONS, OFFICE_NODE_ANCHORS } from './organization.mjs';
import { employeeAppearance } from './employee-appearance.mjs';
import { OFFICE_EXTERIOR } from './office-environment.mjs';

/* Architecture, seating and camera fitting share the organization's floor plan.
 * Workplaces are configured positions, separate from authenticated employees. */
export const OFFICE3D_ROOMS = Object.freeze(OFFICE_ROOMS.map(room=>Object.freeze({
  ...room,z:room.y,d:room.h,label:[room.x+room.w/2,room.y+22],
})));
export const OFFICE3D_BOUNDS = Object.freeze({
  min:Object.freeze({x:OFFICE_WORLD.x,y:-14,z:OFFICE_WORLD.y}),
  max:Object.freeze({x:OFFICE_WORLD.x+OFFICE_WORLD.width,y:100,z:OFFICE_WORLD.y+OFFICE_WORLD.height}),
});
export const OFFICE3D_CENTER = Object.freeze({
  x:(OFFICE3D_BOUNDS.min.x+OFFICE3D_BOUNDS.max.x)/2,y:35,
  z:(OFFICE3D_BOUNDS.min.z+OFFICE3D_BOUNDS.max.z)/2,
});
export const AGENT3D_HOMES = OFFICE_AGENT_HOMES;
export const WORK3D_POSITIONS = OFFICE_WORK_POSITIONS;
export const OFFICE3D_COLORS = Object.freeze({
  background:'#f5f4ed',wall:'#e8e4d8',wallCap:'#faf8ef',foundation:'#aebca5',
  wood:'#b69067',woodTop:'#e2bf8d',woodDark:'#81634d',sage:'#7d9b85',sageDark:'#365e50',
  ink:'#293c3a',metal:'#8fa69c',steel:'#365b57',cream:'#f0e9da',screen:'#a7d1c7',
  paper:'#faf9f1',copper:'#b85a43',leaf:'#7ca879',darkLeaf:'#477e60',pot:'#dec9ac',
});

/* All static fittings are instanced by geometry and material. This keeps a
 * furnished office inexpensive to redraw while employees remain articulated. */
export function createOffice3DAssets() {
  const geometries={box:new THREE.BoxGeometry(1,1,1),sphere:new THREE.SphereGeometry(1,12,8),cylinder:new THREE.CylinderGeometry(1,1,1,12),cone:new THREE.ConeGeometry(1,1,9),torus:new THREE.TorusGeometry(1,.16,5,12),hair:new THREE.SphereGeometry(1,12,8,0,Math.PI*2,0,Math.PI*.44)};
  const shape=new THREE.Shape();const r=.08;
  shape.moveTo(-.5+r,-.5);shape.lineTo(.5-r,-.5);shape.quadraticCurveTo(.5,-.5,.5,-.5+r);shape.lineTo(.5,.5-r);shape.quadraticCurveTo(.5,.5,.5-r,.5);shape.lineTo(-.5+r,.5);shape.quadraticCurveTo(-.5,.5,-.5,.5-r);shape.lineTo(-.5,-.5+r);shape.quadraticCurveTo(-.5,-.5,-.5+r,-.5);
  geometries.round=new THREE.ExtrudeGeometry(shape,{depth:.92,bevelEnabled:true,bevelSize:.035,bevelThickness:.04,bevelSegments:2,steps:1,curveSegments:3});geometries.round.translate(0,0,-.46);
  // Bevels must stay inside the declared footprint; both views and the path
  // planner treat w/h as exact dimensions. Extrusion otherwise adds 7%.
  geometries.round.computeBoundingBox();const roundedSize=new THREE.Vector3();geometries.round.boundingBox.getSize(roundedSize);geometries.round.scale(1/roundedSize.x,1/roundedSize.y,1/roundedSize.z);
  geometries.slab=geometries.round.clone();geometries.slab.rotateX(-Math.PI/2);
  const materials=new Map();
  const material=(color,options={})=>{const key=JSON.stringify([color,options]);if(!materials.has(key))materials.set(key,new THREE.MeshStandardMaterial({color,roughness:.83,metalness:0,...options}));return materials.get(key);};
  return {geometries,materials,material,dispose(){Object.values(geometries).forEach(g=>g.dispose());materials.forEach(m=>m.dispose());materials.clear();}};
}

export function createOffice3DLayout(assets) {
  const root=new THREE.Group();root.name='office-architecture';
  const batches=new Map(),overviewBatches=new Map(),detailBatches=new Map(),object=new THREE.Object3D();let activeBatches=batches,activeSeatId=null,activeBodySeatId=null,activeBodyPart=null;const c=OFFICE3D_COLORS;
  const primarySeats=new Map(OFFICE_SEATS.filter(seat=>seat.primarySeat).map(seat=>[seat.personId,seat.id]));
  const primarySeatId=seat=>primarySeats.get(seat.personId)||seat.id;
  const newBatch=kind=>({geometry:assets.geometries[kind],material:assets.material('#ffffff'),matrices:[],colors:[],owners:[],bodyOwners:[],bodyParts:[]});
  const statusLights=new Map(),nodeAnchors=new Map(),statistics={staticInstances:0,desks:0,people:0,racks:0,plants:0,rooms:OFFICE3D_ROOMS.length};
  function part(kind,color,x,y,z,w,h,d,rx=0,ry=0,rz=0){const key=kind;if(!activeBatches.has(key))activeBatches.set(key,newBatch(kind));object.position.set(x,y,z);object.rotation.set(rx,ry,rz);object.scale.set(w,h,d);object.updateMatrix();activeBatches.get(key).matrices.push(object.matrix.clone());activeBatches.get(key).colors.push(color);activeBatches.get(key).owners.push(activeSeatId);activeBatches.get(key).bodyOwners.push(activeBodySeatId);activeBatches.get(key).bodyParts.push(activeBodyPart);statistics.staticInstances++;}
  const box=(color,x,y,z,w,h,d,ry=0)=>part('box',color,x,y,z,w,h,d,0,ry);
  const round=(color,x,y,z,w,h,d,ry=0)=>part('round',color,x,y,z,w,h,d,0,ry);
  const slab=(color,x,y,z,w,h,d,ry=0)=>part('slab',color,x,y,z,w,h,d,0,ry);
  const cyl=(color,x,y,z,r,h)=>part('cylinder',color,x,y,z,r,h,r);
  const ball=(color,x,y,z,rx,ry=rx,rz=rx)=>part('sphere',color,x,y,z,rx,ry,rz);
  function stem(a,b,r,color){const from=new THREE.Vector3(...a),to=new THREE.Vector3(...b),mid=from.clone().add(to).multiplyScalar(.5);object.position.copy(mid);object.scale.set(r,from.distanceTo(to),r);object.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),to.sub(from).normalize());object.updateMatrix();const key='cylinder';if(!activeBatches.has(key))activeBatches.set(key,newBatch(key));activeBatches.get(key).matrices.push(object.matrix.clone());activeBatches.get(key).colors.push(color);activeBatches.get(key).owners.push(activeSeatId);activeBatches.get(key).bodyOwners.push(activeBodySeatId);activeBatches.get(key).bodyParts.push(activeBodyPart);statistics.staticInstances++;}
  function plant(x,z,s=1){statistics.plants++;cyl(c.pot,x,7*s,z,7*s,12*s);cyl('#b9aa91',x,13*s,z,6.3*s,1.3*s);cyl('#706c55',x,13.6*s,z,5.8*s,1*s);for(let i=0;i<6;i++){const a=i*2.399,high=(22+i*2.6)*s,dx=Math.cos(a)*(7+i%2*3)*s,dz=Math.sin(a)*(7+i%2*3)*s;stem([x,13*s,z],[x+dx,high,z+dz],.65*s,c.darkLeaf);part('sphere',i%2?c.leaf:c.darkLeaf,x+dx,high+3*s,z+dz,3.2*s,8*s,1.5*s,.3, -a,.35);}}
  function mug(x,z,y=27,s=1){cyl('#f8f6ed',x,y+3.4*s,z,2.8*s,6.4*s);cyl('#9a795d',x,y+6.7*s,z,2.2*s,.25*s);part('torus','#f8f6ed',x+2.8*s,y+3.5*s,z,2.1*s,2.1*s,2.1*s,0,0,0);}
  function paper(x,z,y=27,w=11,d=13,ry=0){round(c.paper,x,y,z,w,.6,d,ry);for(let i=0;i<3;i++)box('#b9bdb2',x,y+.35,z-3+i*2.2,w*.58,.14,.55,ry);}
  function monitor(x,z,y=26,scale=1){round(c.steel,x,y+14*scale,z,32*scale,21*scale,2.8*scale);round(c.screen,x,y+14*scale,z+1.45*scale,28*scale,17*scale,.22*scale);box('#e8efea',x-3*scale,y+17*scale,z+1.59*scale,17*scale,.9*scale,.12);box('#7faba0',x-4*scale,y+13.5*scale,z+1.59*scale,14*scale,.8*scale,.12);box('#90b8ac',x-6*scale,y+10.5*scale,z+1.59*scale,10*scale,.8*scale,.12);cyl(c.metal,x,y+2.2*scale,z,1.5*scale,5*scale);round(c.metal,x,y,z+1,18*scale,.9*scale,10*scale);}
  function wall(x,z,w,d,h=14){box(c.wall,x,h/2+1,z,w,h,d);box(c.wallCap,x,h+1.5,z,w+1,1.5,d+1);box('#deddd2',x,3,z,w,4,d+.1);}
  // A composed perimeter gives the office a real setting. It shares the same
  // static instance buffers as the furniture and never expands the camera fit.
  const outside=OFFICE_EXTERIOR,lawn=outside.lawn;
  slab(lawn.color,lawn.x+lawn.w/2,-13,lawn.y+lawn.h/2,lawn.w,6,lawn.h);
  for(const path of outside.paths){
    slab('#d9d9ca',path.x+path.w/2,-9.25,path.y+path.h/2,path.w,1.5,path.h);
    const along=path.w>path.h;for(let p=24;p<(along?path.w:path.h);p+=34)box('#c1c9b6',path.x+(along?p:path.w/2),-8.45,path.y+(along?path.h/2:p),along?.4:path.w-.8,.12,along?path.h-.8:.4);
  }
  for(const garden of outside.gardens){
    slab('#c0cbae',garden.x+garden.w/2,-8,garden.y+garden.h/2,garden.w,5,garden.h);
    const horizontal=garden.w>garden.h,count=Math.floor((horizontal?garden.w:garden.h)/27);
    for(let i=0;i<count;i++){const x=garden.x+(horizontal?(i+.5)*garden.w/count:garden.w/2),z=garden.y+(horizontal?garden.h/2:(i+.5)*garden.h/count);ball(i%2?'#a7bf92':'#90af84',x,-.5,z,horizontal?16:19,9,horizontal?19:16);}
  }
  for(const tree of outside.trees){
    const height=tree.r*1.85;
    cyl('#cfceb8',tree.x,-7,tree.y,tree.r*.57,2);
    cyl('#a48c6c',tree.x,height*.29-8,tree.y,3,height*.6);
    stem([tree.x,height*.2,tree.y],[tree.x-8,height*.52,tree.y+5],1.7,'#a48c6c');
    ball('#5f9273',tree.x-8,height*.6,tree.y+3,tree.r*.77,tree.r*.8,tree.r*.75);
    ball('#8bb07f',tree.x+8,height*.75,tree.y-5,tree.r*.8,tree.r*.9,tree.r*.76);
    ball('#b1c79a',tree.x+3,height*.92,tree.y+6,tree.r*.57,tree.r*.62,tree.r*.58);
  }
  const parking=outside.parking;
  slab('#d0d5c7',parking.x+parking.w/2,-8.8,parking.y+parking.h/2,parking.w,1,parking.h);
  for(let i=0;i<=parking.spaces;i++)box('#f7f4e8',parking.x+i*parking.w/parking.spaces,-8.2,parking.y+parking.h*.5,1.2,.1,parking.h*.75);
  for(const index of[0,2]){
    const x=parking.x+(index+.5)*parking.w/parking.spaces,z=parking.y+parking.h*.5;
    round(index===0?'#7d9fa2':'#d4b398',x,3,z,35,18,61);round('#c1d5cc',x,15,z+2,31,14,32);
    round('#516d72',x,16,z+18.3,27,10,.6);round('#536d72',x,16,z-14.3,27,10,.6);
    for(const side of[-1,1])for(const offset of[-18,18])part('cylinder','#485a53',x+side*17,-2.7,z+offset,5.5,4,5.5,0,0,Math.PI/2);
    box('#ede4c8',x,5,z+31,26,3,.6);
  }
  const bikes=outside.bikes;
  for(let index=0;index<bikes.count;index++){
    const x=bikes.x+index*bikes.spacing,z=bikes.y;
    for(const dz of[-9,9]){part('torus','#51665d',x,-1.2,z+dz,7,7,7,0,Math.PI/2);part('torus','#c4cbb9',x,-1.2,z+dz,5.6,5.6,5.6,0,Math.PI/2);}
    const color=['#af7a5b','#7e9c91','#96a8a6','#b99f70'][index];
    for(const [a,b]of[[[x,-1.2,z-9],[x,6.8,z]],[[x,6.8,z],[x,-1.2,z+9]],[[x,-1.2,z+9],[x,-1.2,z-9]],[[x,6.8,z],[x,-1.2,z]]])stem(a,b,.6,color);
    box('#4c6258',x,12,z,5,1.2,4);stem([x,2,z+9],[x,15,z+8],.55,color);box('#4c6258',x,15,z+8,7,.9,1);
  }
  statistics.exteriorTrees=outside.trees.length;statistics.exteriorGardens=outside.gardens.length;statistics.bikes=bikes.count;
  // The architecture is one static GPU batch per shared geometry. A growing
  // organization adds instances, not additional draw calls or idle animation.
  // Low independent platforms and timber circulation preserve the campus
  // silhouette. WORLD defines framing; it is deliberately not a giant slab.
  for(const [[ax,az],[bx,bz]]of OFFICE_WALKING_SEGMENTS){
    const length=Math.hypot(bx-ax,bz-az);if(length<.1)continue;
    slab('#c4b593',(ax+bx)/2,-1,(az+bz)/2,length+20,4,24,Math.atan2(az-bz,bx-ax));
  }
  function boundary(room) {
    const {x,z,w,d,door}=room;
    const side=(which,fixed,start,end,h)=>{
      const vertical=which==='left'||which==='right';
      const put=(from,to)=>{if(to-from>.5)wall(vertical?fixed:(from+to)/2,vertical?(from+to)/2:fixed,vertical?5:to-from,vertical?to-from:5,h);};
      if(door?.side===which){const mid=vertical?door.y:door.x,half=door.width/2;put(start,mid-half);put(mid+half,end);}else put(start,end);
    };
    side('top',z,x,x+w,22);side('left',x,z,z+d,16);
    side('right',x+w,z,z+d,13);side('bottom',z+d,x,x+w,8);
  }
  for(const room of OFFICE3D_ROOMS){
    slab(c.foundation,room.x+room.w/2,-5,room.z+room.d/2,room.w+10,10,room.d+10);
    slab(room.floor,room.x+room.w/2,.95,room.z+room.d/2,room.w,1.3,room.d);
    boundary(room);
    for(let x=room.x+42;x<room.x+room.w;x+=70)box('#d4dccd',x,1.66,room.z+room.d/2,.16,.1,room.d-3);
    for(let z=room.z+42;z<room.z+room.d;z+=70)box('#d4dccd',room.x+room.w/2,1.66,z,room.w-3,.1,.16);
    for(const team of room.teamZones){
      slab('#adc2b5',team.x+team.w/2,2.05,team.y+team.h/2,team.w,1,team.h);
      slab('#e0e8de',team.x+team.w/2,2.65,team.y+team.h/2,team.w-5,.3,team.h-5);
      box('#9aafa4',team.x+team.w/2,2.2,team.y+9,team.w-18,.25,.8);
    }
  }
  for(const area of OFFICE_SHARED_AREAS){
    slab('#b7bda7',area.x+area.w/2,-5,area.y+area.h/2,area.w+10,10,area.h+10);
    slab('#e4dcca',area.x+area.w/2,.9,area.y+area.h/2,area.w,1.5,area.h);
    for(let x=area.x+12;x<area.x+area.w;x+=18)box('#d4c8b0',x,1.8,area.y+area.h/2,.5,.1,area.h-16);
  }
  function landscape(item) {
    const {x,y:z,w,h:d}=item,yaw=(item.rotation||0)*Math.PI/180;
    if(item.kind==='tree_island'){
      slab('#b6b69b',x,4.5,z,w,8,d,yaw);slab('#96b77d',x,9,z,w-7,1.2,d-7,yaw);
      for(const [dx,dz,height]of[[-w*.27,0,53],[w*.1,-d*.16,64],[w*.32,d*.17,45]]){
        const tx=x+dx,tz=z+dz;cyl('#978366',tx,height*.36,tz,3.3,height*.68);
        stem([tx,height*.45,tz],[tx-9,height*.73,tz+3],2,'#978366');
        ball('#64996b',tx-8,height*.83,tz+4,17,height*.25,15);ball('#87b17c',tx+7,height*.92,tz-3,18,height*.28,17);ball('#aec992',tx,height,tz+8,14,height*.19,15);
      }
      for(const side of[-1,1])slab('#b9a57c',x+side*w*.36,12,z+d*.41,w*.2,3,12);
    }else if(item.kind==='pond'){
      slab('#bfc8ba',x,4,z,w,6,d,yaw);slab('#609e9b',x,7.2,z,w-8,.6,d-8,yaw);slab('#91c8c0',x,7.6,z,w-14,.25,d-14,yaw);
      for(const [dx,dz,size]of[[-w*.25,d*.16,12],[w*.23,-d*.17,9]]){
        for(const r of[1,1.45])part('torus','#e2f0df',x+dx,8.1,z+dz,size*r,size*r,.6,Math.PI/2);
      }
      for(const [dx,dz]of[[-w*.35,-d*.18],[w*.35,d*.2]]){slab('#86a789',x+dx,8.3,z+dz,14,.5,10,.3);ball('#f4e8c9',x+dx,9,z+dz,2.2,1.8,2.2);}
    }else if(item.kind==='deck'){
      slab('#b79870',x,8.8,z,w,3,d,yaw);for(let at=-w/2+7;at<w/2;at+=12)box('#d0b78d',x+at,10.4,z,.65,.15,d-3,yaw);
      for(const side of[-1,1])box('#8b785c',x+side*w*.4,4,z,5,8,d*.55,yaw);
    }else if(item.kind==='planter'){
      slab('#b7b89f',x,6,z,w,10,d,yaw);slab('#6f876b',x,11.2,z,w-5,.5,d-5,yaw);
      for(let at=-w*.43;at<=w*.43;at+=18)ball(at%36?'#95ae86':'#809e77',x+at,16,z,9,9,d*.52);
    }else if(item.kind==='stepping_stone')slab('#d8d9c7',x,2.2,z,w,2,d,yaw);
  }
  OFFICE_LANDSCAPE.forEach(landscape);statistics.landscape=OFFICE_LANDSCAPE.length;
  function furnishing(item) {
    const yaw=item.rotation*Math.PI/180,cs=Math.cos(yaw),sn=Math.sin(yaw),{x,y:z,w,h:d}=item;
    const local=(kind,color,dx,yy,dz,ww,hh,dd)=>part(kind,color,x+dx*cs+dz*sn,yy,z-dx*sn+dz*cs,ww,hh,dd,0,yaw);
    if(item.kind==='plant'){plant(x,z,w/32);return;}
    if(item.kind==='collaboration_table'){
      local('slab',c.woodTop,0,22,0,w,3,d);for(const side of[-1,1])local('round',c.wood,side*w*.32,11,0,8,21,d*.52);
      for(const side of[-1,1])for(const column of[-1,0,1]){local('slab','#91a58f',column*w*.29,11,side*(d/2+10),27,4,20);local('box','#84947d',column*w*.29,5,side*(d/2+10),4,10,15);}
      local('slab','#f3efe4',-w*.22,24,0,25,.6,18);local('slab','#e1d5b8',w*.12,24,0,30,.6,20);local('round','#9fb3a2',0,26,0,16,5,13);
    }else if(item.kind==='sofa'){
      local('round','#8c9f90',0,9,0,w,15,d);
      local('round','#a6b6a3',0,21,-d*.38,w,24,d*.17);
      for(const side of[-1,1]){
        local('round','#b9c7b0',side*w*.235,17,0,w*.43,7,d*.73);
        local('round','#99ad98',side*(w/2-4),19,0,8,19,d);
        local('box',c.woodDark,side*w*.4,2,0,5,4,d*.6);
      }
    }else if(item.kind==='coffee_table'){
      local('round',c.woodTop,0,17,0,w,3,d);
      for(const side of[-1,1])local('box',c.woodDark,side*w*.34,8,0,5,15,d*.5);
      local('round',c.paper,-w*.18,19,0,w*.24,.6,d*.47);
      for(let row=0;row<3;row++)local('box','#b9bdb2',-w*.18,19.4,-d*.12+row*d*.11,w*.16,.14,.6);
      cyl('#f4f1e7',x+w*.26,21,z,3,7);cyl('#94735c',x+w*.26,24.7,z,2.4,.2);
    }else if(item.kind==='cabinet'){
      // Rotate narrow footprints so storage fronts remain wide enough for doors.
      const wide=w>=d?w:d,deep=Math.min(w,d),turn=w>=d?0:Math.PI/2;
      const cs2=Math.cos(yaw+turn),sn2=Math.sin(yaw+turn),unit=(color,dx,yy,dz,ww,hh,dd)=>part('box',color,x+dx*cs2+dz*sn2,yy,z-dx*sn2+dz*cs2,ww,hh,dd,0,yaw+turn);
      unit(c.wood,0,21,0,wide,42,deep);unit(c.woodTop,0,43,0,wide+1,2,deep+1);
      const doors=Math.max(2,Math.round(wide/40));
      for(let i=0;i<doors;i++){const dx=-wide/2+(i+.5)*wide/doors;unit('#e6d7ba',dx,22,deep/2+.4,wide/doors-3,38,.8);unit('#9e927b',dx,24,deep/2+1,Math.min(12,wide/doors*.35),1,.5);}
      const books=Math.max(3,Math.round(wide/18));for(let i=0;i<books;i++){const dx=-wide*.4+i*wide*.8/Math.max(1,books-1);unit(['#73887e','#ae8f72','#d4c29b'][i%3],dx,50,0,Math.min(7,wide*.07),13,9);unit('#eeeadf',dx,51,4.6,Math.min(4,wide*.04),3,.2);}
    }else if(item.kind==='whiteboard'){
      local('round','#73877a',0,33,0,w,38,3);
      local('round','#f1f0e5',0,33,1.7,w-5,33,.4);
      for(const side of[-1,1])local('box','#819283',side*w*.35,10,0,2.5,20,2.5);
      local('box','#94a793',0,15,2.5,w*.7,2,6);
      for(let row=0;row<3;row++)local('box','#a5bba6',-w*.1,40-row*7,2.1,w*.5-row*6,.75,.2);
      local('round','#d4bb8d',w*.29,28,2.2,9,10,.3);
    }
  }
  OFFICE_FITTINGS.forEach(furnishing);statistics.fittings=OFFICE_FITTINGS.length;
  // Seated figures share body-part instance ranges for finite idle poses.
  // Their geometry is separate from authenticated names and business state.
  function seatedPost(seat,index) {
    const primaryId=primarySeatId(seat);activeBodySeatId=primaryId;activeBodyPart='torso';
    const s=seat.scale,x=seat.x,z=seat.y,appearance=employeeAppearance({id:primaryId,outfitId:seat.outfitId}),uniform=appearance.uniform;
    const skin=appearance.skin,hair=appearance.hair,garment=appearance.garment;
    const body=(kind,color,dx,y,dz,w,h,d,rx=0)=>part(kind,color,x+dx*s,1.9+y*s,z+dz*s,w*s,h*s,d*s,rx);
    body('round',uniform,0,23,-2,11.5,14,6.5);
    if(['overshirt','jacket','cardigan'].includes(garment)){
      body('round',appearance.shirt,0,25,-5.4,4.5,8,.45);
      for(const side of[-1,1])part('box',appearance.trim,x+side*2.7*s,1.9+27*s,z-5.7*s,1.1*s,5.8*s,.3*s,0,0,side*.3);
    }else if(garment==='hoodie'){
      body('round',appearance.trim,0,29.2,-1.8,8.8,4.2,7.5);body('round',appearance.shirt,0,21,-5.4,6.9,3.2,.3);
    }else{body('round',appearance.trim,0,29,-4.4,4.5,2.4,2.5);body('box',appearance.trim,0,23,-5.5,.5,7,.3);}
    body('cylinder',skin,0,31,-2,2.1,3,2.1);activeBodyPart='head';body('sphere',skin,0,37,-2,5.1,6.1,4.5);
    body('hair',hair,0,37.3,-2,5.4,6.3,4.8);body('round',hair,0,38.1,1.4,8.5,8,2.5);
    body('round',hair,2.4,40.7,-4.2,5.2,1.6,3.6);
    for(const side of[-1,1]){
      activeBodyPart='head';
      body('sphere',skin,side*4.8,36.7,-2,1.15,1.7,1.1);
      body('sphere','#303b35',side*1.8,36.4,-6.08,.42,.55,.3);
      const ax=x+side*6.3*s,handZ=seat.desk.y+seat.desk.h*.3,handY=1.9+27*s;
      const sleeve=uniform;
      activeBodyPart=side===-1?'leftUpper':'rightUpper';stem([ax,1.9+29*s,z-2*s],[ax,1.9+24*s,z-11*s],1.8*s,sleeve);
      activeBodyPart=side===-1?'leftLower':'rightLower';stem([ax,1.9+24*s,z-11*s],[ax,handY,handZ],1.5*s,sleeve);
      ball(skin,ax,handY,handZ,1.7*s,1.5*s,1.8*s);
      activeBodyPart='legs';
      body('round',appearance.trousers,side*3,15,-7,4.5,4.5,13);
      body('round',appearance.trousers,side*3,8,-12,4,11.4,4.2);
      body('round',appearance.shoes,side*3,2,-13.5,4.7,3,7);
    }
    activeBodyPart='torso';body('box','#d6c8b5',0,24,-5.6,.5,6,.3);body('round','#f5eee2',0,21,-5.7,3,4,.45);
    statistics.people++;activeBodySeatId=null;activeBodyPart=null;
  }
  function workstation(seat,index) {
    statistics.desks++;
    const {desk:surface}=seat,s=seat.scale,x=surface.x,z=surface.y,top=25*s,w=surface.w,d=surface.h;
    round(c.woodTop,x,top,z,w,2.2*s,d);
    // A fine edge reveal, inset keyboard mat and chair arms read at close range;
    // each is another instance of the same shared furniture geometry.
    round(c.wood,x,top-1.3*s,z,w-.8*s,.7*s,d-.5*s);
    box(c.wood,x,top-3*s,z-d*.25,w*.86,4*s,2*s);
    for(const dx of[-w*.42,w*.42])for(const dz of[-d*.34,d*.34])box(c.metal,x+dx,12*s,z+dz,2.8*s,23*s,2.8*s);
    monitor(x,z-d*.19,top+1.4*s,.72*s);
    round('#b5c8bd',x,top+1.45*s,z+d*.3,29*s,.35*s,10*s);
    round('#e6e9df',x,top+1.7*s,z+d*.3,22*s,.8*s,6.2*s);
    for(let row=0;row<2;row++)box('#edf0e6',x,top+2.2*s,z+d*.3+(row-.5)*1.7*s,18*s,.14*s,.55*s);
    ball('#e6e9df',x+17*s,top+2.1*s,z+d*.3,2*s,.8*s,2.8*s);
    // The fabric chair remains a distinct object when a shared manager is away.
    round('#7c9a82',seat.x,15*s,seat.y,16*s,3*s,16*s);
    round('#73947c',seat.x,24*s,seat.y+6*s,15*s,18*s,3*s);
    for(const side of[-1,1])round('#466a5d',seat.x+side*9*s,20*s,seat.y-1*s,2.1*s,2*s,10*s);
    cyl('#8f9d8e',seat.x,8*s,seat.y,1.5*s,12*s);
    for(const dx of[-8,8])box('#7e8e80',seat.x+dx*s,2*s,seat.y,3*s,2*s,16*s);
    if(seat.role!=='staff'){
      paper(x-w*.33,z+d*.15,top+1.5*s,8*s,11*s);
      box(seat.role==='chairman'?'#b18b59':'#647d6b',x-w*.31,top+3*s,z-d*.3,15*s,3*s,5*s);
      mug(x+w*.34,z+d*.15,top+1.5*s,s);
    }else if(index%4===0){
      paper(x-w*.34,z+d*.15,top+1.5*s,8*s,9*s);
    }
    if(seat.occupantVisible)seatedPost(seat,index);
  }
  const seatGroups=new Map(),seatGroupById=new Map(),overviewSeatIds=new Set();
  for(const room of OFFICE3D_ROOMS){
    const sections=room.teamZones.length?[{...room,id:room.id,seats:room.seats.filter(seat=>!seat.teamId)},...room.teamZones]:[room];
    for(const section of sections){
      const sectionSeats=section.seats||[],sectionIds=new Set(sectionSeats.map(seat=>seat.id)),explicit=(section.overviewSeatIds||sectionSeats.filter(seat=>seat.overviewVisible).map(seat=>seat.id)).filter(id=>sectionIds.has(id));
      const representatives=explicit.length?explicit:sectionSeats.filter(seat=>seat.role!=='staff').concat(sectionSeats.filter(seat=>seat.role==='staff').slice(0,3)).map(seat=>seat.id);
      const info={id:section.id,region:section,seatIds:sectionSeats.map(seat=>seat.id),overviewSeatIds:representatives};seatGroups.set(section.id,info);representatives.forEach(id=>overviewSeatIds.add(id));
      sectionSeats.forEach(seat=>seatGroupById.set(seat.id,section.id));
    }
  }
  OFFICE_SEATS.forEach((seat,index)=>{
    const key=seatGroupById.get(seat.id);if(!detailBatches.has(key))detailBatches.set(key,new Map());activeSeatId=seat.id;activeBatches=detailBatches.get(key);workstation(seat,index);
    if(overviewSeatIds.has(seat.id)){activeBatches=overviewBatches;workstation(officeSeatForView(seat),index);}
  });
  activeSeatId=null;activeBatches=batches;
  statistics.people=OFFICE_SEATS.filter(seat=>seat.occupantVisible).length;statistics.desks=OFFICE_SEATS.length;statistics.workplaces=OFFICE_SEATS.length;statistics.overviewPeople=OFFICE_SEATS.filter(seat=>overviewSeatIds.has(seat.id)&&seat.occupantVisible).length;
  const shop=OFFICE_CONVENIENCE_AREA;
  slab('#adc3a4',shop.x+shop.w/2,2.6,shop.y+shop.h/2,shop.w,1.7,shop.h);
  slab('#f0e2bd',shop.x+shop.w/2,3.6,shop.y+shop.h/2,shop.w-5,.4,shop.h-5);
  const shelf=shop.shelf;
  const shelfPart=(kind,color,dx,yy,dz,ww,hh,dd)=>part(kind,color,shelf.x-dz,yy,shelf.y+dx,ww,hh,dd,0,-Math.PI/2);
  shelfPart('round',c.woodDark,0,27,0,shelf.h,50,shelf.w);
  shelfPart('box','#cfddbe',0,28,-shelf.w/2-.2,shelf.h-3,45,.8);
  for(const level of[11,26,41]){
    shelfPart('box',c.woodTop,0,level,1,shelf.h-3,2.2,shelf.w);
    for(let column=0;column<4;column++){
      const dx=(column-1.5)*8.5,color=['#d9b782','#8eb598','#c5967d','#b4c2a2'][column];
      shelfPart('cylinder',color,dx,level+5,5,2.6,7,2.6);
      shelfPart('cylinder','#e9e5ca',dx,level+8.8,5,1.5,1.1,1.5);
    }
  }
  const fridge=shop.fridge;
  round('#749d87',fridge.x,29,fridge.y,fridge.w,54,fridge.h);
  round('#e5eddc',fridge.x,30,fridge.y+fridge.h/2+.5,fridge.w-3,49,1.2);
  round('#b6d6c8',fridge.x,30,fridge.y+fridge.h/2+1.2,fridge.w-7,41,.4);
  for(const row of[0,1])for(const col of[-1,0,1]){
    const gx=fridge.x+col*6.5,gy=20+row*15,gz=fridge.y+fridge.h/2+1.9;
    round(['#cadbb3','#e6c990','#d3b29e'][col+1],gx,gy,gz,4.2,9,.7);
    box('#f0e8d4',gx,gy+5,gz,2.4,1,.8);
  }
  box('#5e8370',fridge.x+fridge.w*.33,30,fridge.y+fridge.h/2+2,1.3,13,1.1);
  box('#edf3df',fridge.x,53,fridge.y+fridge.h/2+1.2,fridge.w-8,2,.5);
  const checkout=shop.counter;
  slab('#709a7d',checkout.x,14,checkout.y,checkout.w-6,23,checkout.h-3);
  slab(c.woodTop,checkout.x,27,checkout.y,checkout.w,3,checkout.h);
  box('#d4c99e',checkout.x,15,checkout.y+checkout.h/2-.7,checkout.w-14,15,.6);
  round('#496b5d',checkout.x-9,35,checkout.y-2,15,13,1.8);
  round('#accdbd',checkout.x-9,35,checkout.y-.9,12,10,.3);
  cyl('#6e8775',checkout.x-9,29,checkout.y-2,1.4,5);
  slab('#4c6757',checkout.x+11,29.1,checkout.y+4,8,1.2,9);
  // A striped canopy supplies the shop silhouette. There are no prices,
  // payment controls, product names or invented sales data in this scenery.
  for(const side of[-1,1])box(c.woodDark,shop.x+shop.w/2+side*(shop.w/2-7),31,shop.y+11,3,56,3);
  slab('#f3e6c8',shop.x+shop.w/2,61,shop.y+11,shop.w,3,23);
  for(let stripe=0;stripe<10;stripe++)box(stripe%2?'#a4be98':'#f3e6c8',shop.x+(stripe+.5)*shop.w/10,59.5,shop.y+23,shop.w/10,7,2.1);
  statistics.convenienceAreas=1;
  const publicArea=OFFICE_BULLETIN_AREA,noticeBoard=publicArea.board;
  slab('#b8c7ac',publicArea.x+publicArea.w/2,-4,publicArea.y+publicArea.h/2,publicArea.w+8,8,publicArea.h+8);
  slab('#e1e8cf',publicArea.x+publicArea.w/2,.8,publicArea.y+publicArea.h/2,publicArea.w,1.2,publicArea.h);
  for(const side of[-1,1])round(c.woodDark,noticeBoard.x+side*noticeBoard.w*.43,19,noticeBoard.y,6,36,7);
  round(c.woodDark,noticeBoard.x,37,noticeBoard.y,noticeBoard.w+6,66,9);
  round(c.woodTop,noticeBoard.x,37,noticeBoard.y+4.8,noticeBoard.w,61,1);
  round('#d8c79f',noticeBoard.x,37,noticeBoard.y+5.5,noticeBoard.w-12,51,.5);
  // Blank pinned sheets are physical decoration. Actual notices are read from
  // the ERP; neither announcements nor publishers are fabricated on the board.
  for(let index=-2;index<=2;index++){
    const px=noticeBoard.x+index*noticeBoard.w*.175,py=35+(index%2?2:-1);
    round('#faf6e9',px,py,noticeBoard.y+6,noticeBoard.w*.137,33,.45);
    ball(index%2?'#9baf83':c.copper,px,py+13,noticeBoard.y+6.5,1.5,1.5,.8);
  }
  for(const bench of publicArea.benches){
    slab(c.woodTop,bench.x,13,bench.y,bench.w,4,bench.h);
    for(const side of[-1,1])round('#68866b',bench.x+side*bench.w*.36,6,bench.y,6,12,bench.h*.66);
    for(const offset of[-.23,.23])box('#ba986b',bench.x,15.2,bench.y+offset*bench.h,bench.w-7,.2,.55);
  }
  publicArea.plants.forEach(item=>plant(item.x,item.y,item.w/32));statistics.bulletinBoards=1;
  // Network appliances remain in the operations department. Their IDs retain
  // compatibility with existing tasks while all coordinates come from the plan.
  function rack(x,z){statistics.racks++;round('#465b59',x,44,z,36,85,30);box('#273e3d',x,45,z+15.5,30,76,1.3);box('#667b77',x,86,z,38,2,32);for(let i=0;i<7;i++){round('#4b6361',x,15+i*9.5,z+16.3,26,7.4,1.4);box('#9aaba3',x-3,16+i*9.5,z+17.1,13,.7,.3);ball('#b9d09e',x+9,15+i*9.5,z+17.2,1,1,.7);}}
  function status(id,x,y,z){const mesh=new THREE.Mesh(assets.geometries.sphere,assets.material('#7d9e76'));mesh.scale.set(1.8,1.8,1.2);mesh.position.set(x,y,z);root.add(mesh);statusLights.set(id,mesh);nodeAnchors.set(id,{x,y,z});}
  const networkIds=new Set(['internet','firewall','core','server','storage','ups','access']);
  const network=OFFICE_NODE_ANCHORS;
  rack(network.server.x-21,network.server.y);rack(network.server.x+21,network.server.y);
  for(const [id,anchor]of Object.entries(network)){
    if(id==='bulletin')continue;const {x,y:z}=anchor;
    if(networkIds.has(id)){
      if(id==='firewall'){round('#e5decc',x,19,z,42,32,28);box('#b7a27c',x,20,z+14.5,30,15,1);for(const dx of[-16,16])cyl('#738575',x+dx,40,z-6,1,17);}
      else if(id==='ups'){round('#d5d3bc',x,21,z,30,39,24);round('#597264',x,28,z+12.5,20,9,1);box('#bba15f',x,15,z+13,4,8,.5);}
      else if(id==='core'||id==='access'){round('#bacfc0',x,11,z,48,18,22);for(let i=0;i<7;i++)box('#486859',x-17+i*5.5,11,z+11.5,3.3,3.3,.4);}
      else if(id==='storage'){round('#b9cbc0',x,17,z,46,30,27);for(let i=0;i<4;i++)round('#526e65',x-15+i*10,18,z+14,7,22,1.3);}
      else if(id==='internet'){round('#e4e7dc',x,8,z,62,12,42);for(let i=0;i<3;i++)part('torus','#819c8b',x,17,z,9+i*4,9+i*4,9+i*4,Math.PI/2);}
    }
    status(id,x,id==='server'?69:networkIds.has(id)?25:6,z);
  }
  nodeAnchors.set('bulletin',{x:noticeBoard.x,y:35,z:noticeBoard.y});
  function emit(map,parent){
    for(const batch of map.values()){
      const instanced=new THREE.InstancedMesh(batch.geometry,batch.material,batch.matrices.length);
      batch.matrices.forEach((matrix,index)=>{instanced.setMatrixAt(index,matrix);instanced.setColorAt(index,new THREE.Color(batch.colors[index]));});
      instanced.computeBoundingSphere();instanced.userData.bodySeats=Object.freeze([...batch.bodyOwners]);instanced.userData.bodyParts=Object.freeze([...batch.bodyParts]);batch.mesh=instanced;parent.add(instanced);
    }
  }
  emit(batches,root);
  const overviewRoot=new THREE.Group();overviewRoot.name='organization-overview';root.add(overviewRoot);emit(overviewBatches,overviewRoot);
  for(const [id,map]of detailBatches){const group=new THREE.Group();group.name=`organization-detail-${id}`;group.visible=false;root.add(group);seatGroups.get(id).root=group;emit(map,group);}
  let detailed=new Set(),away=new Set();const zeroMatrix=new THREE.Matrix4().makeScale(0,0,0),idlePoses=new Map(),poseParts=new Map();
  for(const map of[overviewBatches,...detailBatches.values()])for(const batch of map.values())batch.bodyParts.forEach((part,index)=>{
    if(!part||part==='legs')return;const id=batch.owners[index];if(!poseParts.has(id))poseParts.set(id,[]);poseParts.get(id).push({batch,index,part,overview:map===overviewBatches,groupId:seatGroupById.get(id)});
  });
  const idlePartSets={look:new Set(['head']),nod:new Set(['head']),typing:new Set(['head','leftLower','rightLower']),wave:new Set(['head','leftUpper','leftLower']),stretch:new Set(['torso','head','leftUpper','leftLower','rightUpper','rightLower']),settle:new Set(['torso','head','leftUpper','leftLower','rightUpper','rightLower'])};
  const poseMatrix=new THREE.Matrix4(),bodyPose=new THREE.Matrix4(),headPose=new THREE.Matrix4(),leftUpperPose=new THREE.Matrix4(),leftLowerPose=new THREE.Matrix4(),rightUpperPose=new THREE.Matrix4(),rightLowerPose=new THREE.Matrix4(),pivotMatrix=new THREE.Matrix4(),poseEuler=new THREE.Euler();
  function pivot(matrix,x,y,z,rx=0,ry=0,rz=0){matrix.makeRotationFromEuler(poseEuler.set(rx,ry,rz));const e=matrix.elements;e[12]=x-e[0]*x-e[4]*y-e[8]*z;e[13]=y-e[1]*x-e[5]*y-e[9]*z;e[14]=z-e[2]*x-e[6]*y-e[10]*z;return matrix;}
  function restoreIdlePose(id){const activity=idlePoses.get(id);if(!activity)return 0;let changed=0;for(const entry of activity.entries){const {batch,index,overview,groupId}=entry,hidden=away.has(batch.bodyOwners[index])||overview&&detailed.has(groupId);batch.mesh.setMatrixAt(index,hidden?zeroMatrix:batch.matrices[index]);batch.mesh.instanceMatrix.addUpdateRange(index*16,16);batch.mesh.instanceMatrix.needsUpdate=true;changed++;}idlePoses.delete(id);return changed;}
  function clearIdlePoses(){let changed=0;for(const id of [...idlePoses.keys()])changed+=restoreIdlePose(id);return changed;}
  function setIdlePose(id,kind,{delay=0,duration=2400,partner=null,startedAt=null}={}){
    const seat=seatsById.get(id),parts=idlePartSets[kind];if(!seat||!seat.primarySeat||!seat.occupantVisible||!parts||away.has(primarySeatId(seat))||!isSeatVisible(id))return false;
    if(!idlePoses.has(id)&&idlePoses.size>=6)return false;
    restoreIdlePose(id);const entries=(poseParts.get(id)||[]).filter(entry=>parts.has(entry.part)&&(entry.overview?!detailed.has(entry.groupId):detailed.has(entry.groupId)));if(!entries.length)return false;
    const wait=Math.max(0,Math.min(2500,Number(delay)||0));idlePoses.set(id,{kind,delay:wait,duration:Math.max(600,Math.min(4500,Number(duration)||2400)),partner,entries,started:Number.isFinite(startedAt)?startedAt+wait:null,seat:seatGeometry(id)});return true;
  }
  function tickIdlePoses(now=0){
    let changed=0;
    for(const [id,activity]of [...idlePoses]){
      if(away.has(primarySeatId(activity.seat))||!isSeatVisible(id)){changed+=restoreIdlePose(id);continue;}
      activity.started??=now+activity.delay;if(now<activity.started)continue;const progress=Math.min(1,Math.max(0,(now-activity.started)/activity.duration));if(progress===1){changed+=restoreIdlePose(id);continue;}
      const envelope=Math.sin(progress*Math.PI),cycle=progress*Math.PI*2,{seat,kind,partner}=activity,s=seat.scale,x=seat.x,z=seat.y,y=1.9;
      let pitch=0,yaw=0,roll=0,bodyPitch=0,bodyRoll=0,shift=0,leftX=0,leftZ=0,leftElbow=0,leftWrist=0,rightX=0,rightZ=0,rightElbow=0;
      const look=partner?Math.max(-.55,Math.min(.55,Math.atan2(-(partner.x-x),-(partner.y-z)))):Math.sin(cycle)*.38;
      if(kind==='look')yaw=look*envelope;
      else if(kind==='nod'){yaw=look*.5*envelope;pitch=-Math.sin(progress*Math.PI*4)*.13*envelope;}
      else if(kind==='typing'){pitch=-.1*envelope;leftElbow=Math.sin(progress*Math.PI*16)*.035*envelope;rightElbow=Math.sin(progress*Math.PI*16+2)*.035*envelope;}
      else if(kind==='wave'){yaw=look*envelope;leftX=.65*envelope;leftZ=-.85*envelope;leftElbow=.65*envelope;leftWrist=Math.sin(progress*Math.PI*10)*.17*envelope;}
      else if(kind==='stretch'){bodyPitch=.035*envelope;pitch=.08*envelope;leftX=rightX=.28*envelope;leftZ=-.65*envelope;rightZ=.65*envelope;leftElbow=rightElbow=-.25*envelope;}
      else if(kind==='settle'){bodyRoll=Math.sin(cycle)*.027*envelope;shift=Math.sin(cycle)*.5*s*envelope;yaw=-Math.sin(cycle)*.08*envelope;}
      pivot(bodyPose,x,y+17*s,z-2*s,bodyPitch,0,bodyRoll);bodyPose.elements[12]+=shift;
      headPose.multiplyMatrices(bodyPose,pivot(pivotMatrix,x,y+32*s,z-2*s,pitch,yaw,roll));
      leftUpperPose.multiplyMatrices(bodyPose,pivot(pivotMatrix,x-6.3*s,y+29*s,z-2*s,leftX,0,leftZ));leftLowerPose.multiplyMatrices(leftUpperPose,pivot(pivotMatrix,x-6.3*s,y+24*s,z-11*s,leftElbow,0,leftWrist));
      rightUpperPose.multiplyMatrices(bodyPose,pivot(pivotMatrix,x+6.3*s,y+29*s,z-2*s,rightX,0,rightZ));rightLowerPose.multiplyMatrices(rightUpperPose,pivot(pivotMatrix,x+6.3*s,y+24*s,z-11*s,rightElbow,0,0));
      const transforms={torso:bodyPose,head:headPose,leftUpper:leftUpperPose,leftLower:leftLowerPose,rightUpper:rightUpperPose,rightLower:rightLowerPose};
      for(const entry of activity.entries){const {batch,index,part}=entry;poseMatrix.multiplyMatrices(transforms[part],batch.matrices[index]);batch.mesh.setMatrixAt(index,poseMatrix);batch.mesh.instanceMatrix.addUpdateRange(index*16,16);batch.mesh.instanceMatrix.needsUpdate=true;changed++;}
    }
    return changed;
  }
  function setAwaySeats(ids=[]){
    const requested=ids instanceof Set?[...ids]:Array.isArray(ids)?ids:[],next=new Set(requested.map(id=>{const seat=seatsById.get(id);return seat?primarySeatId(seat):null;}).filter(Boolean));
    const changed=new Set([...next,...away].filter(id=>next.has(id)!==away.has(id)));if(!changed.size)return false;
    for(const id of idlePoses.keys())if(next.has(primarySeatId(seatsById.get(id))))restoreIdlePose(id);
    for(const map of[overviewBatches,...detailBatches.values()])for(const batch of map.values()){
      let uploaded=false;batch.bodyOwners.forEach((key,index)=>{if(!key||!changed.has(key))return;const hidden=next.has(key)||map===overviewBatches&&detailed.has(seatGroupById.get(batch.owners[index]));batch.mesh.setMatrixAt(index,hidden?zeroMatrix:batch.matrices[index]);batch.mesh.instanceMatrix.addUpdateRange(index*16,16);uploaded=true;});
      if(uploaded)batch.mesh.instanceMatrix.needsUpdate=true;
    }
    away=next;return true;
  }
  function setDetailGroups(ids=[]){
    const next=new Set(ids.filter(id=>seatGroups.has(id)));if(next.size===detailed.size&&[...next].every(id=>detailed.has(id)))return false;
    clearIdlePoses();
    const changed=new Set([...next,...detailed].filter(id=>next.has(id)!==detailed.has(id)));
    for(const info of seatGroups.values())info.root.visible=next.has(info.id);
    for(const batch of overviewBatches.values()){
      let uploaded=false;batch.owners.forEach((id,index)=>{const owner=seatGroupById.get(id);if(!changed.has(owner))return;batch.mesh.setMatrixAt(index,next.has(owner)||away.has(batch.bodyOwners[index])?zeroMatrix:batch.matrices[index]);batch.mesh.instanceMatrix.addUpdateRange(index*16,16);uploaded=true;});
      if(uploaded)batch.mesh.instanceMatrix.needsUpdate=true;
    }
    detailed=next;return true;
  }
  const isSeatVisible=id=>detailed.has(seatGroupById.get(id))||overviewSeatIds.has(id)&&!detailed.has(seatGroupById.get(id));
  const seatsById=new Map(OFFICE_SEATS.map(seat=>[seat.id,seat]));
  const seatGeometry=id=>{const seat=seatsById.get(id);return seat?officeSeatForView(seat,{detail:detailed.has(seatGroupById.get(id))}):null;};
  root.userData.statistics=statistics;
  return {root,statusLights,nodeAnchors,statistics,seatGroups,setDetailGroups,setAwaySeats,setIdlePose,tickIdlePoses,clearIdlePoses,isSeatVisible,seatGeometry,
    get visibleSeatIds(){return new Set(OFFICE_SEATS.filter(seat=>isSeatVisible(seat.id)).map(seat=>seat.id));},
    get detailGroupIds(){return [...detailed];},
    get awaySeatIds(){return new Set(away);},
    get idlePoseSeatIds(){return [...idlePoses.keys()];},
    get hasIdlePoses(){return idlePoses.size>0;},
  };
}
