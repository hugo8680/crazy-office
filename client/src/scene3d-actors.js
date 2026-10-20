import * as THREE from './vendor/three.module.js';
import { OFFICE3D_COLORS } from './scene3d-layout.js';

const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const blend=(from,to,weight)=>from+(to-from)*weight;
export const STANDING_ACTOR_HEIGHT=48;
export const SEATED_ACTOR_HEIGHT=40;
export function facingForHeading(heading,fallback=0){return ({down:0,right:Math.PI/2,up:Math.PI,left:-Math.PI/2})[heading]??fallback;}
export function actorIdentity(meta,{virtual=false}={}) {
  return {virtual,uniform:virtual?'#728c7c':meta.color||'#a9816c',trousers:virtual?'#42574e':'#465057',hair:meta.hair||'#51463c',skin:virtual?'#e2c4a8':'#e5bb9b',badge:virtual?'chip':'lanyard'};
}

/* A lightweight articulated colleague. Both identities are opaque people;
 * uniform, ceramic ear pieces and wrist fittings identify virtual employees. */
export function createOffice3DActor(assets,meta,{virtual=false,background=false,scale=1}={}) {
  const identity=actorIdentity(meta,{virtual}),root=new THREE.Group();root.name=`${virtual?'virtual':'human'}-${meta.id||'colleague'}`;root.scale.setScalar(scale);
  const rig=new THREE.Group();root.add(rig);const torso=new THREE.Group();rig.add(torso);
  function mesh(kind,color,parent,x,y,z,w,h,d,rx=0,ry=0,rz=0){const item=new THREE.Mesh(assets.geometries[kind],assets.material(color));item.position.set(x,y,z);item.scale.set(w,h,d);item.rotation.set(rx,ry,rz);parent.add(item);return item;}
  const part=(kind,color,parent,pos,size)=>mesh(kind,color,parent,...pos,...size);
  // Tailored jacket, shirt collar and seams. No platform, halo or enclosing badge.
  mesh('round',identity.uniform,torso,0,7,0,11.3,13.8,6.6);
  mesh('box',virtual?'#d3ddcf':'#f4eee3',torso,0,12.3,3.35,4.5,3.3,.5);
  mesh('box',identity.uniform,torso,0,9.4,3.7,1.2,4.8,.35,0,0,.09);
  mesh('box',virtual?'#536c5c':'#836a59',torso,0,5.3,3.47,.4,8,.22);
  for(const side of[-1,1])mesh('box',virtual?'#98ad99':'#c9ac8c',torso,side*3,2.8,3.44,2.6,.5,.3);
  mesh('cylinder',identity.skin,torso,0,15.2,0,2.1,3,2.1);
  const head=new THREE.Group();head.position.set(0,20.6,0);torso.add(head);
  mesh('sphere',identity.skin,head,0,0,0,5.1,6.1,4.5);
  mesh('hair',identity.hair,head,0,.3,0,5.4,6.3,4.8);
  mesh('round',identity.hair,head,0,1.1,-3.4,8.5,8,2.5);
  mesh('round',identity.hair,head,-3,3.8,2.2,5.2,1.6,3.6,0,0,-.15);
  for(const side of[-1,1])mesh('sphere',identity.skin,head,side*4.9,-.3,0,1.15,1.7,1.1);
  const eyes=[];
  for(const side of[-1,1]){eyes.push(mesh('sphere','#303c35',head,side*1.9,-.6,4.08,.45,.6,.38));mesh('box',identity.hair,head,side*1.9,.7,4.12,1.5,.22,.24,0,0,-side*.07);}
  mesh('sphere',virtual?'#d3ac8f':'#c99477',head,0,-1.6,4.35,.58,.7,.65);
  mesh('round','#ac7764',head,0,-3.15,3.78,1.7,.24,.18);
  if(virtual){
    for(const side of[-1,1]){mesh('round','#ecebe1',head,side*5.7,-.2,0,1.5,3.1,3.4);mesh('box','#7f9c87',head,side*6.5,-.1,.4,.2,1.2,1.3);}
    mesh('round','#dfe5d5',torso,-2.8,8,3.65,3.1,3.8,.5);mesh('box','#5c7c67',torso,-2.8,8,4,1.7,1.9,.2);
    for(const side of[-1,1])for(const offset of[-.7,.7])mesh('box','#5c7c67',torso,-2.8+side*1.4,8+offset,3.99,.35,.3,.2);
  }else{
    // The small textile lanyard belongs to the clothes, not a floating identity UI.
    for(const side of[-1,1])mesh('box','#d7ccba',torso,side*1.3,9.8,3.8,.35,5.9,.25,0,0,side*.16);
    mesh('round','#f3ede1',torso,0,6.7,3.85,3.3,4.3,.5);mesh('box','#9e8669',torso,0,7.4,4.14,1.8,.4,.16);mesh('box','#b4b1a3',torso,0,6.3,4.14,1.8,.7,.16);
  }
  function arm(side){const upper=new THREE.Group();upper.position.set(side*6.4,12,0);torso.add(upper);mesh('round',identity.uniform,upper,0,-4,0,3.6,8,3.9);const lower=new THREE.Group();lower.position.y=-7.2;upper.add(lower);mesh('round',identity.uniform,lower,0,-3.4,0,3,6.8,3.2);mesh('round',virtual?'#e4e7dc':'#f0e4d0',lower,0,-6.5,0,3.2,1.6,3.4);const hand=new THREE.Group();hand.position.y=-8;lower.add(hand);mesh('sphere',identity.skin,hand,0,0,.15,1.7,2,1.8);return {upper,lower,hand};}
  const arms={left:arm(-1),right:arm(1)};
  function leg(side){const thigh=new THREE.Group();thigh.position.set(side*3,0,0);rig.add(thigh);mesh('round',identity.trousers,thigh,0,-5,0,4.5,10,4.8);const shin=new THREE.Group();shin.position.y=-9.5;thigh.add(shin);mesh('round',identity.trousers,shin,0,-5.7,0,4,11.4,4.2);mesh('round','#34443c',shin,0,-11.6,1.5,4.7,3,7);mesh('box','#a2a394',shin,0,-13,1.7,4.8,.7,7.1);return {thigh,shin};}
  const legs={left:leg(-1),right:leg(1)};
  const document=new THREE.Group();arms.right.hand.add(document);document.position.set(0,-.3,3.6);document.rotation.x=.5;
  mesh('round',OFFICE3D_COLORS.copper,document,0,0,0,8.2,10.4,.8);mesh('round','#efe6d5',document,0,-.1,.5,7.3,9.4,.12);mesh('box',OFFICE3D_COLORS.copper,document,0,3,.65,7.5,3.8,.2);mesh('box','#f6e4d4',document,0,2.7,.8,3.6,.6,.12);document.visible=false;
  const target={seated:false,walking:false,phase:0,stride:0,bob:0,working:false,lounging:false,carrying:false,offering:false,receiving:false,heading:'down',nod:0};
  let dirty=true;
  const pose={seated:0,step:0,typing:0,offer:0};let idleOffset=(String(meta.id||'').split('').reduce((n,c)=>n+c.charCodeAt(0),0)%19)/3,settling=false,reaction=null,faceAngle=null;
  function animate(now=0,{reducedMotion=false,delta=16,idleMotion=false}={}) {
    if(!dirty&&!settling&&!reaction&&!target.walking&&!target.offering&&!target.receiving&&!(idleMotion&&target.working))return false;
    const weight=reducedMotion?1:1-Math.exp(-Math.min(delta,100)/95),goals={seated:target.seated?1:0,step:target.walking?target.stride*Math.PI/180*1.75:0,typing:target.working&&target.seated?1:0,offer:target.offering?1:target.carrying?.35:0};
    settling=false;for(const key of Object.keys(goals)){pose[key]=blend(pose[key],goals[key],weight);if(Math.abs(pose[key]-goals[key])<.001)pose[key]=goals[key];else settling=true;}
    let response=0;
    if(reaction&&!reducedMotion){reaction.started??=now;const progress=Math.min(1,Math.max(0,(now-reaction.started)/(reaction.press?420:320)));response=Math.sin(progress*Math.PI)*(reaction.press?1:.6);if(progress===1)reaction=null;}else reaction=null;
    rig.scale.setScalar(1+response*.025);torso.rotation.z=-response*.025;
    const sit=pose.seated,step=pose.step,breath=reducedMotion||!idleMotion?0:Math.sin(now/1600+idleOffset)*.09;
    rig.position.y=23-sit*7+(target.walking?Math.max(0,-target.bob):breath);torso.rotation.x=sit*.07;torso.position.z=sit*3.5;
    for(const [index,side]of['left','right'].entries()){
      const sign=index?1:-1,leg=legs[side],arm=arms[side];arm.upper.position.y=12+sit*1.5;leg.thigh.rotation.x=-sit*Math.PI/2+step*sign;leg.shin.rotation.x=sit*Math.PI/2+Math.max(0,-step*sign)*.55;
      const type=pose.typing*(reducedMotion?0:Math.sin(now/130+index*2.5)*.035);
      arm.upper.rotation.x=-sit*(target.lounging?.28:Math.min(1.14,1.07-(scale-1)*1.6))-step*sign*.5-(side==='right'?pose.offer*.9:0)+type;arm.upper.rotation.z=-sign*(.065+pose.offer*.045);
      arm.lower.rotation.x=-sit*(target.lounging?1.15:.63)-(side==='right'?pose.offer*.32:.03)+type;
    }
    head.rotation.x=(target.receiving&&!reducedMotion?Math.sin(now/160)*.09:0)+sit*.06+response*.09;
    const blink=idleMotion&&!reducedMotion&&((now/1000+idleOffset)%5.6)<.12;eyes.forEach(eye=>eye.scale.y=blink?.1:.6);
    document.visible=target.carrying||target.offering;
    if(target.walking)faceAngle=null;
    const facing=target.walking?facingForHeading(target.heading,root.rotation.y):faceAngle;
    if(facing!=null){let diff=facing-root.rotation.y;diff=Math.atan2(Math.sin(diff),Math.cos(diff));if(reducedMotion||Math.abs(diff)<.001){root.rotation.y+=diff;if(!target.walking)faceAngle=null;}else{root.rotation.y+=diff*weight;settling=true;}}
    dirty=false;return true;
  }
  const api={root,identity,rig,head,arms,legs,document,target,animate,
    setPosition(point){if(root.position.x!==point.x||root.position.z!==point.y){root.position.set(point.x,1.9,point.y);dirty=true;}},
    facePoint(point){const angle=Math.atan2(point.x-root.position.x,point.y-root.position.z);if(root.rotation.y!==angle){faceAngle=angle;dirty=true;}},
    react(kind='hover'){reaction={press:kind==='press',started:null};dirty=true;},
    setPose(patch){for(const [key,value]of Object.entries(patch))if(target[key]!==value){target[key]=value;dirty=true;}},
    invalidate(){dirty=true;},get needsUpdate(){return dirty;},get isAnimating(){return settling||!!reaction||target.walking||target.offering||target.receiving;},
    get height(){return (target.seated?SEATED_ACTOR_HEIGHT:STANDING_ACTOR_HEIGHT)*scale;},
  };
  root.userData={identity,actorId:meta.id,virtual,background};
  animate(0,{reducedMotion:true});root.updateMatrixWorld(true);
  // Local furniture and clothing transforms stay fixed; joints carry the motion.
  root.traverse(item=>{if(item.isMesh&&!eyes.includes(item)){item.updateMatrix();item.matrixAutoUpdate=false;}});return api;
}
