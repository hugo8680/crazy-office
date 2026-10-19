import * as THREE from './vendor/three.module.js';

/* World coordinates deliberately match the 2D floor. A task has the same desk,
 * door and colleague in both views; only its presentation changes. */
export const OFFICE3D_ROOMS = Object.freeze([
  { id:'investment', title:'投资者关系部', english:'INVESTOR RELATIONS', x:55, z:7, w:450, d:94, floor:'#cfdcd3', label:[266,21] },
  { id:'general_office', title:'总经办', english:'EXECUTIVE OFFICE', x:527, z:7, w:278, d:94, floor:'#ddcfb8', label:[666,21] },
  { id:'workstations', title:'开放办公区', english:'WORKSPACE', x:56, z:134, w:428, d:253, floor:'#d8dcc7', label:[257,153] },
  { id:'server', title:'网络机房', english:'NETWORK OPERATIONS', x:497, z:134, w:306, d:253, floor:'#bdd0c5', label:[646,153] },
  { id:'executive', title:'业务管理室', english:'BUSINESS OPERATIONS', x:816, z:134, w:189, d:253, floor:'#e0cfb3', label:[914,153] },
  { id:'meeting', title:'会议室', english:'MEETING ROOM', x:56, z:443, w:295, d:162, floor:'#d1d0d3', label:[206,457] },
  { id:'reception', title:'客户会见厅', english:'CUSTOMER LOUNGE', x:365, z:443, w:313, d:162, floor:'#dcc8aa', label:[528,457] },
  { id:'finance', title:'财务办公室', english:'FINANCE & OPERATIONS', x:692, z:443, w:313, d:162, floor:'#cdd7bf', label:[850,457] },
].map(room=>Object.freeze(room)));
export const AGENT3D_HOMES = Object.freeze({
  hr:{name:'小禾',role:'入职登记专员',x:464,y:235,hair:'#51453d'},
  invest_research:{name:'沈研',role:'投资研究员',x:122,y:87,hair:'#514333',seated:true},
  invest_finance:{name:'顾衡',role:'财务尽调师',x:234,y:87,hair:'#474b45',seated:true},
  invest_risk:{name:'何审',role:'独立风险审查',x:346,y:87,hair:'#493d50',seated:true},
  zhang:{name:'小张',role:'网络工程师',x:464,y:350,hair:'#514333'},
  liu:{name:'小刘',role:'安全工程师',x:650,y:286,hair:'#493d50'},
  lead:{name:'陈工',role:'技术组长',x:650,y:373,hair:'#474b45'},
  business:{name:'林悦',role:'业务组长',x:477,y:575,hair:'#6b483d'},
  finance:{name:'许姐',role:'财务',x:910,y:579,hair:'#5e443d'},
  boss:{name:'周助理',role:'管理审校',x:584,y:87,hair:'#4d4440',seated:true},
  ops:{name:'阿杰',role:'机房运维',x:590,y:335,hair:'#484b3d'},
});
export const WORK3D_POSITIONS = Object.freeze({
  investment:[[122,87],[234,87],[346,87]],general_office:[[670,87]],
  internet:[[787,286],[757,390]],firewall:[[590,260],[590,286]],core:[[650,345],[590,373]],
  server:[[700,286],[768,286]],storage:[[787,373],[787,390]],ups:[[579,373],[590,345]],
  access:[[421,411],[492,411]],workstations:[[313,300],[387,300],[464,300]],
  meeting:[[322,479],[207,479]],executive:[[951,315],[861,315]],reception:[[600,575],[477,575]],finance:[[909,579],[760,579]],
});
export const OFFICE3D_COLORS = Object.freeze({
  background:'#f3efe6',wall:'#dddcd0',wallCap:'#f1eee4',foundation:'#a6ada0',
  wood:'#b28d61',woodTop:'#cda574',woodDark:'#8c6c48',sage:'#6d8b7d',sageDark:'#405c52',
  ink:'#2c3937',metal:'#7c8d80',steel:'#4c675f',cream:'#e2e0d2',screen:'#acc4b9',
  paper:'#f8f6ee',copper:'#b85a43',leaf:'#749078',darkLeaf:'#52755d',pot:'#d2c2a7',
});

/* All static fittings are instanced by geometry and material. This keeps a
 * furnished office inexpensive to redraw while employees remain articulated. */
export function createOffice3DAssets() {
  const geometries={box:new THREE.BoxGeometry(1,1,1),sphere:new THREE.SphereGeometry(1,12,8),cylinder:new THREE.CylinderGeometry(1,1,1,12),cone:new THREE.ConeGeometry(1,1,9),torus:new THREE.TorusGeometry(1,.16,5,12),hair:new THREE.SphereGeometry(1,12,8,0,Math.PI*2,0,Math.PI*.44)};
  const shape=new THREE.Shape();const r=.08;
  shape.moveTo(-.5+r,-.5);shape.lineTo(.5-r,-.5);shape.quadraticCurveTo(.5,-.5,.5,-.5+r);shape.lineTo(.5,.5-r);shape.quadraticCurveTo(.5,.5,.5-r,.5);shape.lineTo(-.5+r,.5);shape.quadraticCurveTo(-.5,.5,-.5,.5-r);shape.lineTo(-.5,-.5+r);shape.quadraticCurveTo(-.5,-.5,-.5+r,-.5);
  geometries.round=new THREE.ExtrudeGeometry(shape,{depth:.92,bevelEnabled:true,bevelSize:.035,bevelThickness:.04,bevelSegments:2,steps:1,curveSegments:3});geometries.round.translate(0,0,-.46);
  const materials=new Map();
  const material=(color,options={})=>{const key=JSON.stringify([color,options]);if(!materials.has(key))materials.set(key,new THREE.MeshStandardMaterial({color,roughness:.83,metalness:0,...options}));return materials.get(key);};
  return {geometries,materials,material,dispose(){Object.values(geometries).forEach(g=>g.dispose());materials.forEach(m=>m.dispose());materials.clear();}};
}

export function createOffice3DLayout(assets) {
  const root=new THREE.Group();root.name='office-architecture';
  const batches=new Map(),object=new THREE.Object3D();const c=OFFICE3D_COLORS;
  const statusLights=new Map(),nodeAnchors=new Map(),statistics={staticInstances:0,desks:0,racks:0,plants:0,rooms:OFFICE3D_ROOMS.length};
  function part(kind,color,x,y,z,w,h,d,rx=0,ry=0,rz=0){const key=`${kind}|${color}`;if(!batches.has(key))batches.set(key,{geometry:assets.geometries[kind],material:assets.material(color),matrices:[]});object.position.set(x,y,z);object.rotation.set(rx,ry,rz);object.scale.set(w,h,d);object.updateMatrix();batches.get(key).matrices.push(object.matrix.clone());statistics.staticInstances++;}
  const box=(color,x,y,z,w,h,d,ry=0)=>part('box',color,x,y,z,w,h,d,0,ry);
  const round=(color,x,y,z,w,h,d,ry=0)=>part('round',color,x,y,z,w,h,d,0,ry);
  const cyl=(color,x,y,z,r,h)=>part('cylinder',color,x,y,z,r,h,r);
  const ball=(color,x,y,z,rx,ry=rx,rz=rx)=>part('sphere',color,x,y,z,rx,ry,rz);
  function stem(a,b,r,color){const from=new THREE.Vector3(...a),to=new THREE.Vector3(...b),mid=from.clone().add(to).multiplyScalar(.5);object.position.copy(mid);object.scale.set(r,from.distanceTo(to),r);object.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),to.sub(from).normalize());object.updateMatrix();const key=`cylinder|${color}`;if(!batches.has(key))batches.set(key,{geometry:assets.geometries.cylinder,material:assets.material(color),matrices:[]});batches.get(key).matrices.push(object.matrix.clone());statistics.staticInstances++;}
  function plant(x,z,s=1){statistics.plants++;cyl(c.pot,x,7*s,z,7*s,12*s);cyl('#b9aa91',x,13*s,z,6.3*s,1.3*s);cyl('#706c55',x,13.6*s,z,5.8*s,1*s);for(let i=0;i<6;i++){const a=i*2.399,high=(22+i*2.6)*s,dx=Math.cos(a)*(7+i%2*3)*s,dz=Math.sin(a)*(7+i%2*3)*s;stem([x,13*s,z],[x+dx,high,z+dz],.65*s,c.darkLeaf);part('sphere',i%2?c.leaf:c.darkLeaf,x+dx,high+3*s,z+dz,3.2*s,8*s,1.5*s,.3, -a,.35);}}
  function mug(x,z,y=27){cyl('#f8f6ed',x,y+3.4,z,2.8,6.4);cyl('#9a795d',x,y+6.7,z,2.2,.25);part('torus','#f8f6ed',x+2.8,y+3.5,z,2.1,2.1,2.1,0,0,0);}
  function paper(x,z,y=27,w=11,d=13,ry=0){round(c.paper,x,y,z,w,.6,d,ry);for(let i=0;i<3;i++)box('#b9bdb2',x,y+.35,z-3+i*2.2,w*.58,.14,.55,ry);}
  function fileStack(x,z,y=27){for(let i=0;i<3;i++)round(i===2?c.copper:'#e9e3d6',x,y+i*.8,z,13,.65,10);box('#f6ebe1',x-2,y+2.6,z+3,6,.16,1);}
  function monitor(x,z,y=26,scale=1){round(c.steel,x,y+14*scale,z,32*scale,21*scale,2.8*scale);round(c.screen,x,y+14*scale,z+1.45*scale,28*scale,17*scale,.22*scale);box('#e8efea',x-3*scale,y+17*scale,z+1.59*scale,17*scale,.9*scale,.12);box('#7faba0',x-4*scale,y+13.5*scale,z+1.59*scale,14*scale,.8*scale,.12);box('#90b8ac',x-6*scale,y+10.5*scale,z+1.59*scale,10*scale,.8*scale,.12);cyl(c.metal,x,y+2.2*scale,z,1.5*scale,5*scale);round(c.metal,x,y,z+1,18*scale,.9*scale,10*scale);}
  function keyboard(x,z,y=27,s=1){round('#d1d6cd',x,y,z,23*s,.9,7*s);for(let row=0;row<3;row++)for(let col=0;col<9;col++)box('#f7f8ee',x+(col-4)*2.25*s,y+.52,z+(row-1)*1.8*s,1.6*s,.2,1.1*s);ball('#e7e9df',x+18*s,y+.7,z,2.1*s,.9,3*s);}
  function chair(x,z,yaw=0,scale=1){const chairGroup=[];const local=(kind,color,dx,y,dz,w,h,d,rx=0)=>{const cos=Math.cos(yaw),sin=Math.sin(yaw);part(kind,color,x+(dx*cos+dz*sin)*scale,y*scale,z+(-dx*sin+dz*cos)*scale,w*scale,h*scale,d*scale,rx,yaw);};
    local('round','#667971',0,15,0,16,3,16);local('round','#647b71',0,23,6,15,18,3,-.1);local('box','#b1b9ad',-9,19,1,1.5,7,1.5);local('box','#b1b9ad',9,19,1,1.5,7,1.5);local('round','#76877a',-9,22,-1,3,1.7,10);local('round','#76877a',9,22,-1,3,1.7,10);cyl('#8f9c90',x,8*scale,z,1.6*scale,12*scale);for(let i=0;i<5;i++){const a=i*Math.PI*2/5;stem([x,3*scale,z],[x+Math.cos(a)*11*scale,2*scale,z+Math.sin(a)*11*scale],1.2*scale,'#78877b');ball('#526359',x+Math.cos(a)*11*scale,1.8*scale,z+Math.sin(a)*11*scale,2*scale,1.7*scale,1.7*scale);}}
  function desk(x,z,{w=110,d=43,scale=1,papers=true,cup=true,red=false,chairAt=true}={}){statistics.desks++;const width=w*scale,depth=d*scale,top=25*scale;round(c.woodTop,x,top,z,width,2.5*scale,depth);box(c.wood,x,top-4*scale,z-depth*.25,width*.86,5*scale,2*scale);for(const dx of [-width*.42,width*.42])for(const dz of [-depth*.34,depth*.34])box(c.metal,x+dx,12*scale,z+dz,3.3*scale,23*scale,3.3*scale);for(let i=0;i<4;i++)box('#ddc29d',x-width*.29+i*width*.19,top+1.3*scale,z, .35*scale,.13,depth*.88);monitor(x,z-10*scale,top+2*scale,.86*scale);keyboard(x,z+Math.min(15,d*.27)*scale,top+1.8*scale,.83*scale);if(cup)mug(x+width*.35,z+8*scale,top+1.4*scale);if(papers)paper(x-width*.35,z+8*scale,top+1.5*scale,10*scale,13*scale);if(red)fileStack(x-width*.31,z-7*scale,top+1.8*scale);if(chairAt)chair(x,z+32*scale,0,scale);}
  function cabinet(x,z,w=72,h=40,d=18){round(c.wood,x,h/2,z,w,h,d);box(c.woodTop,x,h+.8,z,w+1,1.6,d+1);for(let i=0;i<3;i++){const bx=x-w*.33+i*w*.33;box('#e8d8bc',bx,h*.51,z+d/2+.4,w*.29,h*.9,.9);box('#9f927b',bx,h*.56,z+d/2+1,w*.15,.8,.9);}for(let i=0;i<6;i++){const bx=x-w*.38+i*w*.14;box(['#73887e','#ae8f72','#d4c29b'][i%3],bx,h+8,z, w*.09,14,9);box('#eeeadf',bx,h+9,z+4.6,w*.05,3,.2);}}
  function sofa(x,z,w=85,yaw=0){const local=(color,dx,y,dz,ww,hh,dd)=>{const cs=Math.cos(yaw),sn=Math.sin(yaw);round(color,x+dx*cs+dz*sn,y,z-dx*sn+dz*cs,ww,hh,dd,yaw);};local('#879c8d',0,8,0,w,14,30);local('#a7b7a5',0,16,-10,w,21,7);local('#b6c3af',-w*.23,15,0,w*.42,6,23);local('#b6c3af',w*.23,15,0,w*.42,6,23);for(const dx of[-w*.48,w*.48])local('#9aaf9c',dx,15,0,7,15,30);for(const dx of[-w*.39,w*.39])local(c.woodDark,dx,2,1,4,4,4);}
  function wall(x,z,w,d,h=14){box(c.wall,x,h/2+1,z,w,h,d);box(c.wallCap,x,h+1.5,z,w+1,1.5,d+1);box('#deddd2',x,3,z,w,4,d+.1);}
  // One quiet foundation and physically separate annexes. No shadow receiving plane.
  round(c.foundation,530,-6,368,986,12,506);round('#dcd8c6',530,.1,368,977,1.4,492);
  for(const room of OFFICE3D_ROOMS){round(room.floor,room.x+room.w/2,.95,room.z+room.d/2,room.w,1.3,room.d);if(room.z<110)round(c.foundation,room.x+room.w/2,-4,room.z+room.d/2,room.w+9,8,room.d+8);for(let x=room.x+28;x<room.x+room.w;x+=42)box('#bec5b2',x,1.66,room.z+room.d/2,.24,.1,room.d-2);for(let z=room.z+26;z<room.z+room.d;z+=42)box('#bec5b2',room.x+room.w/2,1.66,z,room.w-2,.1,.24);}
  // Annex corridors preserve the actual route used by the motion planner.
  box('#eee8d9',291,0,107,518,2,20);box('#eee8d9',32,0,259,20,2,324);box('#eee8d9',664,0,107,246,2,20);
  // Back walls are cut to shoulder height; foreground walls remain low.
  wall(530,130,976,8,36);wall(48,263,8,266,27);wall(48,519,8,170,11);wall(1011,369,8,480,22);wall(490,258,9,248,27);wall(810,258,9,248,27);
  for(const [x,z,w,d]of[[112,437,112,8],[298,437,106,8],[429,437,123,8],[621,437,112,8],[752,437,114,8],[943,437,125,8],[358,524,9,162],[685,524,9,162]])wall(x,z,w,d,11);
  wall(530,611,976,8,8);
  for(const room of OFFICE3D_ROOMS.filter(r=>r.z<110)){wall(room.x+room.w/2,room.z,room.w,7,32);wall(room.x,room.z+room.d/2,6,room.d,20);wall(room.x+room.w,room.z+room.d/2,6,room.d,20);const door=room.id==='investment'?82:550;const left=door-14-room.x,right=room.x+room.w-door-14;wall(room.x+left/2,101,left,6,8);wall(door+14+right/2,101,right,6,8);}
  // Transom windows read as solid desaturated glass, avoiding transparent clutter.
  for(const [x,w]of[[163,144],[339,144],[909,132]]){box('#bcd1c9',x,20,129,w,10,2);box('#e8eeE4',x,20,130.3,1,10,.3);}
  // Flat woven textiles break up the plan without ornamental UI framing.
  round('#bac6ac',269,1.95,255,361,.35,77);round('#bac6ac',269,1.95,358,361,.35,77);
  round('#b8b8af',208,1.95,534,227,.35,108);round('#c2ad8d',529,1.95,536,243,.35,109);
  round('#c5b18d',912,1.95,279,153,.35,136);round('#bbc5a9',846,1.95,537,141,.35,101);
  // Complete workstations: the seated background staff are added by the renderer.
  for(const z of[231,334])for(const x of[145,269,393])desk(x,z,{red:x===145&&z===231});
  for(const x of[122,234,346])desk(x,58,{w:75,d:29,scale:1,papers:true,cup:false,chairAt:false});
  desk(458,58,{w:70,d:29,scale:1,cup:false,chairAt:false});
  desk(584,58,{w:84,d:31,scale:1,cup:false,red:true,chairAt:false});desk(755,58,{w:84,d:31,scale:1,cup:false,chairAt:false});
  for(const x of[122,234,346,458,584,755])chair(x,87,0,1);
  // Working file cart and a shared review table make the two annex workflows legible.
  round(c.woodTop,650,21,58,34,2.5,26);for(const dx of[-12,12])for(const dz of[-8,8])box(c.metal,650+dx,10.5,58+dz,2.5,20,2.5);fileStack(650,57,23);
  round('#83978a',76,15,58,20,27,25);round(c.woodTop,76,29,58,22,2,27);paper(76,58,30.4,13,17);for(const dx of[-7,7])ball('#596d5c',76+dx,2,58,2,2,2);
  cabinet(414,22,64,24,13);cabinet(687,23,49,25,13);plant(492,77,.65);plant(788,79,.55);
  cabinet(80,257,24,32,15);plant(72,365,.85);plant(458,181,.8);
  // Wall art with simple printed shapes. No gradients or fake data charts.
  box(c.woodDark,425,19,134,43,28,2);box(c.paper,425,19,135.2,39,24,.3);box('#b2b99f',419,18,135.5,12,15,.3);ball('#bda17d',433,23,135.6,4,4,.25);
  function rack(x,z){statistics.racks++;round('#465b59',x,44,z,43,85,35);box('#273e3d',x,45,z+18,36,76,1.3);box('#667b77',x,86,z,45,2,37);for(let i=0;i<7;i++){round('#4b6361',x,15+i*9.5,z+19,31,7.4,1.4);box('#9aaba3',x-4,16+i*9.5,z+20,16,.75,.3);box('#7c938c',x-6,14+i*9.5,z+20,12,.6,.3);ball('#b9d09e',x+11,15+i*9.5,z+20,1.1,1.1,.7);}for(const dx of[-17,17])box('#304946',x+dx,3,z+10,3,4,4);}
  rack(710,215);rack(762,215);
  function status(id,x,y,z){const mesh=new THREE.Mesh(assets.geometries.sphere,assets.material('#7d9e76'));mesh.scale.set(1.8,1.8,1.2);mesh.position.set(x,y,z);root.add(mesh);statusLights.set(id,mesh);nodeAnchors.set(id,{x,y,z});}
  // Security appliance, its wall monitor, UPS, core switch and the storage array.
  round('#ede7d6',553,20,213,54,32,33);box('#bda582',553,22,230,39,17,1);for(let i=0;i<4;i++)for(let j=0;j<2;j++)box('#e5cfaa',541+i*8,18+j*8,230.8,5.5,5.5,.4);status('firewall',575,25,231);for(const dx of[-23,23])cyl('#6b8072',553+dx,43,203,1.1,19);
  box('#d4ddd2',620,23,199,45,39,9);box('#415d55',620,27,204,34,21,1);for(let i=0;i<4;i++)box('#abc5ac',610+i*6,23+i%2*4,205,4,1,.25);
  round('#c3d1c6',645,17,314,70,27,30);box('#8ea799',645,18,329.5,63,20,1);for(let i=0;i<8;i++){box('#405c52',620+i*6.5,19,330.2,4.3,4.3,.4);box('#c1cfa8',620+i*6.5,24,330.3,1,.8,.3);}status('core',673,13,331);
  round('#d6d6bd',544,26,350,31,49,28);round('#596f60',544,36,364.5,21,10,1);box('#bfd29c',544,36,365.2,12,1,.3);for(let i=0;i<5;i++)box('#999e80',536+i*4,10,364.5,1,8,.4);box('#b99b55',545,23,365,4,9,.5);status('ups',553,30,365);
  round('#bacac2',745,19,351,55,34,32);for(let i=0;i<4;i++){round('#526e65',726+i*11,20,368,8.5,24,1.3);ball('#becba4',727+i*11,12,369,1,1,.5);}status('storage',766,25,369);status('server',780,68,235);
  round('#bfcfbe',459,10,407,52,16,20);for(let i=0;i<7;i++)box('#4c6857',441+i*5.5,11,418,3.5,3.5,.4);status('access',479,11,418);
  desk(912,249,{w:116,d:48,red:true,chairAt:true});
  box(c.woodDark,963,40,138,43,42,2);box('#e8e1cd',963,40,139.3,38,37,.35);box('#9aa68a',955,39,139.6,13,24,.3);ball('#b98c62',971,47,139.8,6,6,.25);
  cabinet(918,183,95,29,17);sofa(879,351,69);round(c.woodTop,963,11,350,37,5,29);mug(963,350,14);plant(984,187,.72);plant(985,374,.75);
  // Wall mounted meeting display, with a presentation layout rather than a blank slab.
  round('#435f55',210,44,448,91,43,3);box('#aec4b7',210,44,449.8,84,36,.4);box('#e9eee3',191,55,450.1,33,1.3,.2);
  for(let i=0;i<5;i++)box(['#6e8f7b','#93ad92','#b8bf98'][i%3],186+i*11,34+(i%3)*3,450.2,6,9+(i%3)*6,.25);
  box('#dce4d5',210,28,450.1,65,.8,.2);cyl('#71887b',210,16,446,2,16);
  // Meeting table with recessed seam, laptops and conference hub.
  round(c.woodTop,208,24,531,190,3,52);for(const x of[143,273])box(c.wood,x,12,531,8,23,28);box('#ccb491',208,25.7,531,.5,.2,47);
  for(const [x,z,yaw]of[[148,492,Math.PI],[211,492,Math.PI],[274,492,Math.PI],[155,570,0],[264,570,0]])chair(x,z,yaw,.85);
  for(const x of[148,270]){box(c.steel,x,33,528,27,16,1.6);box('#bdd0c4',x,33,529,23,12,.4);box(c.metal,x,26,536,29,1,16);keyboard(x,536,26.8,.7);}mug(185,522,26);mug(231,522,26);paper(148,511,26.1,12,9);paper(264,550,26.1,12,9);
  round('#d1dacf',208,28,520,18,4,12);ball('#638c73',208,30.4,520,1.8,.6,1.8);box('#6a7e74',78,39,507,4,48,37);box('#bfd0c4',80.2,41,507, .5,39,31);for(let i=0;i<4;i++)box('#7b9c8b',80.5,29+i*3,497+i*5,.3,6+i*5,3);plant(327,581,.68);
  sofa(432,506,82);sofa(600,506,82);round(c.woodTop,529,16,536,86,3,35);for(const x of[499,559])box(c.woodDark,x,8,536,4,15,4);mug(504,534,18);mug(554,534,18);paper(529,536,18,15,11,.1);fileStack(543,534,18);paper(516,538,18,11,13,-.08);round('#e5e7d8',529,21,521,19,4,10);status('reception',529,23.3,525);cabinet(528,473,85,26,13);plant(392,584,.75);plant(663,590,.7);
  desk(846,519,{w:110,d:43,red:true});cabinet(729,515,37,50,24);for(let i=0;i<3;i++){box('#e5e5d6',729,10+i*15,528,31,13,1);box('#9ca88f',729,11+i*15,529,11,1,1);}round('#cfd6c6',958,22,508,54,28,31);box('#a0b0a0',958,32,508,44,2,19);box(c.paper,958,36,508,36,4,23);box('#8d9e8c',958,22,524,36,3,1);cabinet(956,567,49,31,18);plant(988,588,.78);
  status('workstations',269,47,326);status('meeting',208,29,522);status('executive',912,44,239);status('finance',846,47,511);status('investment',76,7,72);status('general_office',650,7,65);
  // The external network remains a separate object connected to the building.
  round('#e9e9df',914,8,64,86,12,53);for(let i=0;i<3;i++){part('torus','#829e8f',914,17,64,12+i*5,12+i*5,12+i*5,Math.PI/2,0,0);}status('internet',914,19,65);
  // Physical copper/aluminium cabinet edges and books supply detail, without shadows.
  for(const batch of batches.values()){const instanced=new THREE.InstancedMesh(batch.geometry,batch.material,batch.matrices.length);batch.matrices.forEach((matrix,index)=>instanced.setMatrixAt(index,matrix));instanced.computeBoundingSphere();root.add(instanced);}
  root.userData.statistics=statistics;
  return {root,statusLights,nodeAnchors,statistics};
}
