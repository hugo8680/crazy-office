import * as THREE from './vendor/three.module.js';
import { employeeAppearance, employeeAppearanceKey } from './employee-appearance.mjs';
import { OFFICE3D_COLORS } from './scene3d-layout.js';

const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const blend=(from,to,weight)=>from+(to-from)*weight;
export const STANDING_ACTOR_HEIGHT=48;
export const SEATED_ACTOR_HEIGHT=40;
export function facingForHeading(heading,fallback=0){return ({down:0,right:Math.PI/2,up:Math.PI,left:-Math.PI/2})[heading]??fallback;}
export function actorIdentity(meta,{virtual=false}={}) {
  const appearance=employeeAppearance({virtual,id:meta.appearanceKey||meta.appearanceId||employeeAppearanceKey(meta),outfitId:meta.outfitId});
  return {...appearance,virtual,hair:meta.hair||appearance.hair,skin:virtual?appearance.face:appearance.skin,badge:virtual?'chip':'lanyard'};
}

/* Six reusable silhouettes share the same articulated skeleton. Identity is a
 * physical character detail: porcelain face and sensor ears, or hair and skin.
 * Clothes are independent of the employee's kind and authorization. */
export function createOffice3DActor(assets,meta,{virtual=false,background=false,scale=1}={}) {
  const identity=actorIdentity(meta,{virtual}),root=new THREE.Group();root.name=`${virtual?'virtual':'human'}-${meta.id||'colleague'}`;root.scale.setScalar(scale);
  const rig=new THREE.Group();root.add(rig);const torso=new THREE.Group();rig.add(torso);
  function mesh(kind,color,parent,x,y,z,w,h,d,rx=0,ry=0,rz=0){const item=new THREE.Mesh(assets.geometries[kind],assets.material(color));item.position.set(x,y,z);item.scale.set(w,h,d);item.rotation.set(rx,ry,rz);parent.add(item);return item;}
  const part=(kind,color,parent,pos,size)=>mesh(kind,color,parent,...pos,...size);
  // Garment panels sit on the torso; joints and batch geometry stay shared.
  mesh('round',identity.uniform,torso,0,7,0,11.3,13.8,6.6);
  const garment=identity.garment||'shirt';
  if(['overshirt','jacket','cardigan'].includes(garment)){
    mesh('round',identity.shirt,torso,0,9.1,3.4,4.8,8.5,.5);
    for(const side of[-1,1])mesh('box',identity.trim,torso,side*2.65,10.2,3.8,1.2,5.8,.3,0,0,-side*.3);
  }else if(garment==='hoodie'){
    mesh('round',identity.trim,torso,0,12.4,0,8.8,4.2,7.5);
    mesh('round',identity.shirt,torso,0,5.1,3.5,6.9,3.5,.3);
  }else{
    mesh('round',identity.trim,torso,0,12.5,2.4,4.7,2.4,2.4);
    if(garment==='shirt'||garment==='overshirt')mesh('box',identity.trim,torso,0,6.8,3.5,.45,9,.3);
    else mesh('round',identity.trim,torso,0,1.5,0,11.5,1.4,6.8);
  }
  for(const side of[-1,1])mesh('box',identity.trim,torso,side*3,3.4,3.44,2.7,.45,.3);
  if(garment==='overshirt')for(const side of[-1,1])mesh('round',identity.trim,torso,side*3.4,9.8,3.47,2.8,2.6,.3);
  if(garment==='knit')for(const y of[2.1,2.6])mesh('box',identity.trim,torso,0,y,3.5,9.7,.18,.2);
  mesh('cylinder',identity.skin,torso,0,15.2,0,2.1,3,2.1);
  const head=new THREE.Group();head.position.set(0,20.6,0);torso.add(head);
  if(virtual)mesh('round',identity.skin,head,0,0,0,10.3,11.2,8.8);
  else mesh('sphere',identity.skin,head,0,0,0,5.1,6.1,4.5);
  if(virtual){
    mesh('round','#bdcfca',head,0,5.05,-.6,8.8,.8,6.8);
    const face=mesh('round','#254c55',head,0,-.65,4.62,8.15,5.5,.55);face.name='synthetic-face-panel';
    for(const side of[-1,1]){mesh('round',identity.face,head,side*5.25,-.15,0,1.5,3.7,3.9);mesh('round',identity.accent,head,side*6.05,-.1,.65,.28,1.6,1.7);}
  }else{
    mesh('hair',identity.hair,head,0,.3,0,5.4,6.3,4.8);
    mesh('round',identity.hair,head,0,1.1,-3.4,8.5,8,2.5);
    mesh('round',identity.hair,head,-3,3.8,2.2,5.2,1.6,3.6,0,0,-.15);
    for(const side of[-1,1])mesh('sphere',identity.skin,head,side*4.9,-.3,0,1.15,1.7,1.1);
  }
  const eyes=[];
  for(const side of[-1,1]){eyes.push(mesh('sphere',virtual?identity.accent:'#303c35',head,side*1.9,-.6,virtual?5.05:4.08,virtual?.6:.45,.6,.28));if(!virtual)mesh('box',identity.hair,head,side*1.9,.7,4.12,1.5,.22,.24,0,0,-side*.07);}
  if(!virtual)mesh('sphere','#c99477',head,0,-1.6,4.35,.58,.7,.65);
  const neutralMouth=new THREE.Group(),smilingMouth=new THREE.Group();neutralMouth.name='neutral-mouth';smilingMouth.name='smiling-mouth';head.add(neutralMouth,smilingMouth);smilingMouth.visible=false;
  const mouthColor=virtual?identity.accent:'#a96d5d',mouthZ=virtual?5.05:3.9;
  mesh('round',mouthColor,neutralMouth,0,-2.8,mouthZ,1.7,.24,.18);
  mesh('round',mouthColor,smilingMouth,0,-2.95,mouthZ,1.25,.25,.22);
  for(const side of[-1,1])mesh('round',mouthColor,smilingMouth,side*.78,-2.69,mouthZ,.8,.25,.22,0,0,side*.55);
  if(virtual){
    mesh('round',identity.earcap,torso,-3.3,8,3.65,2.2,2.8,.5);mesh('box',identity.accent,torso,-3.3,8,4,1.1,1.5,.2);
  }else{
    // The small textile lanyard belongs to the clothes, not a floating identity UI.
    for(const side of[-1,1])mesh('box','#d7ccba',torso,side*1.3,9.8,3.8,.35,5.9,.25,0,0,side*.16);
    mesh('round','#f3ede1',torso,0,6.7,3.85,3.3,4.3,.5);mesh('box','#9e8669',torso,0,7.4,4.14,1.8,.4,.16);mesh('box','#b4b1a3',torso,0,6.3,4.14,1.8,.7,.16);
  }
  function arm(side){const upper=new THREE.Group();upper.position.set(side*6.4,12,0);torso.add(upper);mesh('round',garment==='vest'?identity.shirt:identity.uniform,upper,0,-4,0,3.6,8,3.9);const lower=new THREE.Group();lower.position.y=-7.2;upper.add(lower);mesh('round',garment==='vest'?identity.shirt:identity.uniform,lower,0,-3.4,0,3,6.8,3.2);mesh('round',identity.trim,lower,0,-6.5,0,3.2,1.6,3.4);const hand=new THREE.Group();hand.position.y=-8;lower.add(hand);mesh('sphere',identity.skin,hand,0,0,.15,1.7,2,1.8);return {upper,lower,hand};}
  const arms={left:arm(-1),right:arm(1)};
  function leg(side){const thigh=new THREE.Group();thigh.position.set(side*3,0,0);rig.add(thigh);mesh('round',identity.trousers,thigh,0,-5,0,4.5,10,4.8);const shin=new THREE.Group();shin.position.y=-9.5;thigh.add(shin);mesh('round',identity.trousers,shin,0,-5.7,0,4,11.4,4.2);const shoe=mesh('round',identity.shoes,shin,0,-11.6,1.5,4.7,3,7);shoe.name='shoe';mesh('box','#c4c4ba',shin,0,-13,1.7,4.8,.7,7.1);return {thigh,shin};}
  const legs={left:leg(-1),right:leg(1)};
  const document=new THREE.Group();arms.right.hand.add(document);document.position.set(0,-.3,3.6);document.rotation.x=.5;
  mesh('round',OFFICE3D_COLORS.copper,document,0,0,0,8.2,10.4,.8);mesh('round','#efe6d5',document,0,-.1,.5,7.3,9.4,.12);mesh('box',OFFICE3D_COLORS.copper,document,0,3,.65,7.5,3.8,.2);mesh('box','#f6e4d4',document,0,2.7,.8,3.6,.6,.12);document.visible=false;
  const ambientCup=new THREE.Group();ambientCup.name='ambient-cup';arms.right.hand.add(ambientCup);ambientCup.position.set(0,1.4,2);ambientCup.visible=false;
  mesh('cylinder','#f7efe1',ambientCup,0,2,0,2.1,4.2,2.1);mesh('cylinder','#aa7854',ambientCup,0,4.15,0,1.65,.2,1.65);mesh('torus','#f7efe1',ambientCup,2.1,2,0,1.25,1.25,1.25);
  const ambientTablet=new THREE.Group();ambientTablet.name='ambient-tablet';arms.left.hand.add(ambientTablet);ambientTablet.position.set(1,0,2.5);ambientTablet.rotation.set(-.5,0,.12);ambientTablet.visible=false;
  mesh('round','#345c51',ambientTablet,0,0,0,9,12,.8);mesh('round','#b4d9c5',ambientTablet,0,.2,.48,7.4,9.2,.16);mesh('box','#e9f3df',ambientTablet,0,2.1,.6,4.5,.6,.1);mesh('box','#78a795',ambientTablet,-.7,0,.6,3.1,.5,.1);
  const target={seated:false,walking:false,phase:0,stride:0,bob:0,working:false,lounging:false,carrying:false,offering:false,receiving:false,heading:'down',nod:0};
  let dirty=true;
  const pose={seated:0,step:0,typing:0,offer:0};let idleOffset=(String(meta.id||'').split('').reduce((n,c)=>n+c.charCodeAt(0),0)%19)/3,settling=false,reaction=null,faceAngle=null,greeting=false,wave=null,ambient=null;
  function animate(now=0,{reducedMotion=false,delta=16,idleMotion=false}={}) {
    if(!dirty&&!settling&&!reaction&&!wave&&!ambient&&!target.walking&&!target.offering&&!target.receiving&&!(idleMotion&&target.working))return false;
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
    arms.left.lower.rotation.z=0;arms.left.hand.rotation.z=0;arms.right.lower.rotation.z=0;arms.right.hand.rotation.z=0;head.rotation.y=0;ambientCup.visible=false;ambientTablet.visible=false;
    if(wave&&(reducedMotion||target.walking||target.offering||target.receiving||target.carrying))wave=null;
    if(wave){
      wave.started??=now;const progress=Math.min(1,Math.max(0,(now-wave.started)/1000)),envelope=Math.sin(progress*Math.PI),wrist=Math.sin(progress*Math.PI*6)*envelope;
      arms.left.upper.rotation.z-=1.95*envelope;arms.left.upper.rotation.x-=.2*envelope;arms.left.lower.rotation.x-=.7*envelope;arms.left.lower.rotation.z=wrist*.2;arms.left.hand.rotation.z=wrist*.24;
      if(progress===1)wave=null;
    }
    head.rotation.x=(target.receiving&&!reducedMotion?Math.sin(now/160)*.09:0)+sit*.06+response*.09;
    if(ambient&&(reducedMotion||target.walking||target.offering||target.receiving||target.carrying||target.working||greeting))ambient=null;
    if(ambient){
      ambient.started??=now+ambient.delay;
      if(now>=ambient.started){const progress=clamp((now-ambient.started)/ambient.duration,0,1),envelope=Math.sin(progress*Math.PI),phase=progress*Math.PI*2;
      const look=ambient.partner?clamp(Math.atan2(ambient.partner.x-root.position.x,ambient.partner.y-root.position.z)-root.rotation.y,-.75,.75):Math.sin(phase)*.42;
      if(ambient.kind==='sip'){
        ambientCup.visible=true;arms.right.upper.rotation.x-=1.1*envelope;arms.right.upper.rotation.z-=.45*envelope;arms.right.lower.rotation.x-=1.75*envelope;head.rotation.x-=.09*envelope;
      }else if(ambient.kind==='typing'){
        if(!target.seated){ambientTablet.visible=true;arms.left.upper.rotation.x-=1.15*envelope;arms.left.lower.rotation.x-=.6*envelope;arms.right.upper.rotation.x-=1.08*envelope;arms.right.upper.rotation.z-=.5*envelope;arms.right.lower.rotation.x-=(.7+Math.sin(progress*Math.PI*14)*.07)*envelope;}else for(const [index,side]of['left','right'].entries())arms[side].lower.rotation.x+=Math.sin(progress*Math.PI*16+index*2)*.045*envelope;
        head.rotation.x+=.12*envelope;
      }else if(ambient.kind==='wave'){
        arms.left.upper.rotation.z-=1.8*envelope;arms.left.upper.rotation.x-=.2*envelope;arms.left.lower.rotation.x-=.55*envelope;arms.left.hand.rotation.z=Math.sin(progress*Math.PI*8)*.2*envelope;head.rotation.y=look*envelope;
      }else if(ambient.kind==='nod'){head.rotation.x+=Math.sin(progress*Math.PI*6)*.16*envelope;head.rotation.y=look*envelope;}
      else if(ambient.kind==='stretch'){for(const [index,side]of['left','right'].entries()){const sign=index?1:-1;arms[side].upper.rotation.z+=sign*.7*envelope;arms[side].upper.rotation.x-=.18*envelope;arms[side].lower.rotation.x+=.35*envelope;}head.rotation.x-=.08*envelope;torso.rotation.x-=.025*envelope;}
      else if(ambient.kind==='settle'){torso.rotation.z+=Math.sin(phase)*.025*envelope;head.rotation.y=Math.sin(phase)*.08*envelope;}
      else head.rotation.y=look*envelope;
      if(progress===1){ambient=null;ambientCup.visible=false;ambientTablet.visible=false;}
      }
    }
    const blink=idleMotion&&!reducedMotion&&((now/1000+idleOffset)%5.6)<.12;eyes.forEach(eye=>eye.scale.y=blink?.1:greeting?.32:.6);const happy=greeting||ambient?.kind==='wave'||ambient?.kind==='nod';neutralMouth.visible=!happy;smilingMouth.visible=!!happy;
    document.visible=target.carrying||target.offering;
    if(target.walking)faceAngle=null;
    const facing=target.walking?facingForHeading(target.heading,root.rotation.y):faceAngle;
    if(facing!=null){let diff=facing-root.rotation.y;diff=Math.atan2(Math.sin(diff),Math.cos(diff));if(reducedMotion||Math.abs(diff)<.001){root.rotation.y+=diff;if(!target.walking)faceAngle=null;}else{root.rotation.y+=diff*weight;settling=true;}}
    dirty=false;return true;
  }
  const api={root,identity,rig,head,arms,legs,document,ambientCup,ambientTablet,target,animate,
    setPosition(point){if(root.position.x!==point.x||root.position.z!==point.y){root.position.set(point.x,1.9,point.y);dirty=true;}},
    facePoint(point){const angle=Math.atan2(point.x-root.position.x,point.y-root.position.z);if(root.rotation.y!==angle){faceAngle=angle;dirty=true;}},
    react(kind='hover'){if(ambient){ambient=null;dirty=true;}reaction={press:kind==='press',started:null};dirty=true;},
    setGreeting(value,{animated=true}={}){const next=!!value;if(next===greeting)return;if(next)ambient=null;greeting=next;wave=next&&!virtual&&animated&&!target.walking&&!target.offering&&!target.receiving&&!target.carrying?{started:null}:null;dirty=true;},
    setAmbient(kind,partner,{duration=2400,delay=0,startedAt=null}={}){if(!['typing','sip','look','nod','wave','stretch','settle'].includes(kind)||greeting||target.walking||target.offering||target.receiving||target.carrying||target.working)return false;const wait=Math.max(0,Math.min(2500,Number(delay)||0));ambient={kind,partner:partner?{x:partner.x,y:partner.y}:null,started:Number.isFinite(startedAt)?startedAt+wait:null,delay:wait,duration:Math.max(600,Math.min(4500,Number(duration)||2400))};dirty=true;return true;},
    clearAmbient(){if(!ambient)return false;ambient=null;dirty=true;return true;},get ambientKind(){return ambient?.kind||null;},
    setPose(patch){if(ambient&&['walking','working','carrying','offering','receiving'].some(key=>patch[key])){ambient=null;dirty=true;}for(const [key,value]of Object.entries(patch))if(target[key]!==value){target[key]=value;dirty=true;}},
    invalidate(){dirty=true;},get needsUpdate(){return dirty;},get isAnimating(){return settling||!!reaction||!!wave||!!ambient||target.walking||target.offering||target.receiving;},get hasUrgentMotion(){return settling||!!reaction||!!wave||target.walking||target.offering||target.receiving;},get greetingActive(){return greeting;},get waving(){return !!wave;},
    get height(){return (target.seated?SEATED_ACTOR_HEIGHT:STANDING_ACTOR_HEIGHT)*scale;},
  };
  root.userData={identity,actorId:meta.id,virtual,background};
  animate(0,{reducedMotion:true});root.updateMatrixWorld(true);
  // Local furniture and clothing transforms stay fixed; joints carry the motion.
  root.traverse(item=>{if(item.isMesh&&!eyes.includes(item)){item.updateMatrix();item.matrixAutoUpdate=false;}});return api;
}
