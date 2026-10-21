import test from 'node:test';
import assert from 'node:assert/strict';
import { mountScene, NODE_META } from '../src/scene.js';
import { HUMAN_EMPLOYEES } from '../src/people.js';
import {renderOrganizationPositionContents} from '../src/scene-floor2d.mjs';
import {greetingForPerson} from '../src/person-greeting.mjs';
import {OFFICE_WORLD,OFFICE_BULLETIN_AREA,OFFICE_CONVENIENCE_AREA,OFFICE_ROOMS,OFFICE_SEATS,OFFICE_FITTINGS,OFFICE_SHARED_AREAS,OFFICE_LANDSCAPE,OFFICE_OVERVIEW_SEATS,officeSeatsForView,OFFICE_AGENT_HOMES,OFFICE_WORK_POSITIONS,departmentWorkPoint} from '../src/organization.mjs';
const initialViewBox=`0 0 ${OFFICE_WORLD.width} ${OFFICE_WORLD.height}`;

// A minimal SVG DOM records public scene interactions without a browser, model,
// or production-only testing controls.
function sceneFixture(callbacks={},options={}) {
  const previous={document:globalThis.document,window:globalThis.window,DOMPoint:globalThis.DOMPoint,ResizeObserver:globalThis.ResizeObserver,requestAnimationFrame:globalThis.requestAnimationFrame,cancelAnimationFrame:globalThis.cancelAnimationFrame,matchMedia:globalThis.matchMedia,performance:globalThis.performance,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,visualViewport:globalThis.visualViewport};
  let markup='',clock=1000,sequence=0;const layers=new Map(),groups=new Map(),preferenceListeners=new Set(),pending=new Map(),visibility=new Map(),documentListeners=new Map(),timers=new Map();
  class Element {
    constructor(){this.attrs={};this.writes=[];this.dataset={};this.children=[];this.innerHTML='';this.classes=new Set();this.listeners=new Map();this.listenerOptions=new Map();this.captured=new Set();this.props={};this.animations=[];this.queries=new Map();this.style={setProperty:(k,v)=>this.props[k]=v};this.classList={add:(...xs)=>xs.forEach(x=>this.classes.add(x)),remove:(...xs)=>xs.forEach(x=>this.classes.delete(x)),toggle:(x,on)=>{if(on??!this.classes.has(x))this.classes.add(x);else this.classes.delete(x);},contains:x=>this.classes.has(x)};}
    animate(frames,settings){const animation={frames,settings,cancel(){this.cancelled=true;}};this.animations.push(animation);return animation;}setAttribute(k,v){this.writes.push(k);this.attrs[k]=v;}removeAttribute(k){delete this.attrs[k];}addEventListener(k,fn,options){this.listeners.set(k,fn);this.listenerOptions.set(k,options);}removeEventListener(k){this.listeners.delete(k);this.listenerOptions.delete(k);}setPointerCapture(id){this.captured.add(id);}hasPointerCapture(id){return this.captured.has(id);}releasePointerCapture(id){this.captured.delete(id);}append(el){el.parent=this;this.children.push(el);}remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}querySelector(selector){if(!this.queries.has(selector))this.queries.set(selector,new Element());return this.queries.get(selector);}
  }
  const svg=new Element();
  const rect={left:0,top:0,width:1060,height:650,...options.rect};
  svg.clientHeight=options.layoutHeight||rect.height;svg.getBoundingClientRect=()=>({...rect});
  svg.ctmReads=0;svg.getScreenCTM=()=>{svg.ctmReads++;const [x,y,width,height]=(svg.attrs.viewBox||initialViewBox).split(' ').map(Number),unit=Math.min(rect.width/width,rect.height/height),matrix={a:unit,b:0,c:0,d:unit,e:rect.left+(rect.width-width*unit)/2-x*unit,f:rect.top+(rect.height-height*unit)/2-y*unit};matrix.inverse=()=>({a:1/unit,b:0,c:0,d:1/unit,e:-matrix.e/unit,f:-matrix.f/unit});return matrix;};
  svg.querySelector=selector=>{if(selector.startsWith('#')){const id=selector.slice(1),match=markup.match(new RegExp(`<symbol id="${id}"[^>]*>([\\s\\S]*?)<\\/symbol>`));return {innerHTML:match?.[1]||''};}if(!layers.has(selector))layers.set(selector,new Element());return layers.get(selector);};
  svg.querySelectorAll=selector=>{
    if(groups.has(selector))return groups.get(selector);
    const pattern=selector==='[data-node]'?/<g class="cnl-node" data-node="([^"]+)"/g:selector==='[data-team]'?/<g class="cnl-team-zone" data-team="([^"]+)"/g:selector==='[data-position]'?/<g class="cnl-position" data-position="([^"]+)"/g:selector==='[data-device]'?/<g class="cnl-device" data-device="([^"]+)"/g:/<g class="cnl-link" data-a="([^"]+)" data-b="([^"]+)"/g;
    const result=[...markup.matchAll(pattern)].map(m=>{const el=new Element();el.dataset[selector==='[data-node]'?'node':selector==='[data-device]'?'device':selector==='[data-position]'?'position':selector==='[data-team]'?'team':'a']=m[1];if(m[2])el.dataset.b=m[2];return el;});groups.set(selector,result);return result;
  };
  const preference={matches:options.reducedMotion===true,addEventListener:(_type,fn)=>preferenceListeners.add(fn),removeEventListener:(_type,fn)=>preferenceListeners.delete(fn)};
  const doc={hidden:false,createElementNS:()=>new Element(),addEventListener:(type,fn)=>{if(!documentListeners.has(type))documentListeners.set(type,new Set());documentListeners.get(type).add(fn);visibility.set(type,event=>{for(const listener of documentListeners.get(type)||[])listener(event);});},removeEventListener:(type,fn)=>{documentListeners.get(type)?.delete(fn);if(!documentListeners.get(type)?.size){documentListeners.delete(type);visibility.delete(type);}}};
  const windowTarget=new Element();
  globalThis.document=doc;globalThis.window=windowTarget;globalThis.DOMPoint=class{constructor(x=0,y=0){this.x=x;this.y=y;}matrixTransform(matrix){return new globalThis.DOMPoint(this.x*matrix.a+this.y*matrix.c+matrix.e,this.x*matrix.b+this.y*matrix.d+matrix.f);}};globalThis.ResizeObserver=class{observe(){}disconnect(){}};globalThis.requestAnimationFrame=()=>0;globalThis.cancelAnimationFrame=()=>{};globalThis.matchMedia=()=>preference;if(options.frames||options.timers){globalThis.performance={now:()=>clock};globalThis.requestAnimationFrame=fn=>{const id=++sequence;pending.set(id,fn);return id;};globalThis.cancelAnimationFrame=id=>pending.delete(id);}
  if(options.timers){globalThis.setTimeout=(fn,delay)=>{const id=++sequence;timers.set(id,{fn,at:clock+delay});return id;};globalThis.clearTimeout=id=>timers.delete(id);}
  if(options.nativeScale)globalThis.visualViewport={scale:options.nativeScale};
  const container={set innerHTML(v){markup=v;const initial=v.match(/viewBox="([^"]+)"/);if(initial)svg.attrs.viewBox=initial[1];},querySelector:()=>svg,getBoundingClientRect:()=>({...rect})};
  const scene=mountScene(container,callbacks);
  return {scene,svg,layers,groups,preferenceListeners,pending,timers,doc,visibility,windowTarget,advanceTimers(ms){const until=clock+ms;for(let steps=0;steps<1000;steps++){const first=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!first||first[1].at>until)break;timers.delete(first[0]);clock=first[1].at;first[1].fn();}clock=until;},screen(point){return new DOMPoint(point.x,point.y).matrixTransform(svg.getScreenCTM());},input(type,values={}){const event={target:{closest:()=>null},button:0,pointerId:1,pointerType:'mouse',clientX:530,clientY:325,deltaMode:0,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;},...values};svg.listeners.get(type)?.(event);return event;},frame(){const callbacks=[...pending.values()];pending.clear();clock+=34;callbacks.forEach(fn=>fn(clock));},drain(){for(let i=0;i<1000&&pending.size;i++)this.frame();assert.equal(pending.size,0);},get markup(){return markup;},destroy(){scene.destroy();Object.assign(globalThis,previous);}};
}

test('general office is a selectable topology endpoint and keeps existing department endpoints',()=>{
  const selected=[],f=sceneFixture({onSelectNode:id=>selected.push(id)});
  try {
    const nodes=f.groups.get('[data-node]');
    assert.equal(nodes.length,Object.keys(NODE_META).length);
    for(const id of ['investment','general_office','executive','workstations','server'])assert.ok(nodes.some(n=>n.dataset.node===id),id);
    const office=nodes.find(n=>n.dataset.node==='general_office');office.listeners.get('click')({stopPropagation(){}});
    assert.deepEqual(selected,['general_office']);assert.equal(office.attrs['aria-pressed'],'true');
    assert.ok(f.markup.includes('投资者关系部'));assert.ok(f.markup.includes('data-room="general_office"'));
  }finally{f.destroy();}
});

test('a visiting reviewer, the virtual assistant and the real owner occupy separate general-office positions',()=>{
  const f=sceneFixture();
  try {
    f.scene.update({runId:'position-proof',animateEvents:false,agents:[{id:'invest_risk',nodeId:'general_office',status:'working',configured:true},{id:'boss',nodeId:'general_office',status:'working',configured:true}]});
    const agents=f.layers.get('.cnl-agent-layer').children;
    const reviewer=agents.find(a=>a.dataset.agent==='invest_risk'),assistant=agents.find(a=>a.dataset.agent==='boss');
    assert.equal(reviewer.dataset.x,OFFICE_WORK_POSITIONS.general_office[0][0].toFixed(2));assert.equal(assistant.dataset.x,OFFICE_AGENT_HOMES.boss.x.toFixed(2));
    const owner=HUMAN_EMPLOYEES.find(h=>h.id==='owner');assert.equal(owner.nodeId,'general_office');assert.equal(owner.x,departmentWorkPoint('general_office',0).x);
    const renderedOwner=f.layers.get('.cnl-human-layer').children.find(h=>h.dataset.human==='owner');
    assert.equal(renderedOwner.attrs.transform,`translate(${owner.x} ${owner.y})`);
    assert.ok(!assistant.classes.has('is-seated'));assert.ok(!reviewer.classes.has('is-seated'));assert.ok(!renderedOwner.classes.has('is-seated'));
    assert.equal(new Set([Number(reviewer.dataset.x),Number(assistant.dataset.x),owner.x]).size,3);
  }finally{f.destroy();}
});

test('all human identities stay selectable and the live motion preference subscription is cleaned up',()=>{
  const selected=[],f=sceneFixture({onSelectHuman:id=>selected.push(id)});
  try {
    const humans=f.layers.get('.cnl-human-layer').children;assert.equal(humans.length,7);
    for(const h of humans)h.listeners.get('click')({stopPropagation(){}});
    assert.deepEqual(selected,HUMAN_EMPLOYEES.map(h=>h.id));
    assert.equal(f.preferenceListeners.size,1);[...f.preferenceListeners][0]({matches:true});
  }finally{f.destroy();}
  assert.equal(f.preferenceListeners.size,0);
});

test('2D camera controls ease to an endpoint and object feedback respects reduced motion',()=>{
 const f=sceneFixture({}, {frames:true});try{f.drain();assert.equal(f.scene.zoom(.3),1.3);f.frame();f.frame();const middle=Number(f.svg.attrs.viewBox.split(' ')[2]);assert.ok(middle<OFFICE_WORLD.width&&middle>OFFICE_WORLD.width/1.3);f.drain();assert.ok(Math.abs(Number(f.svg.attrs.viewBox.split(' ')[2])-OFFICE_WORLD.width/1.3)<.001);
  const node=f.groups.get('[data-node]').find(node=>node.dataset.node==='server'),target={closest:()=>node};f.svg.listeners.get('pointerover')({target});assert.equal(node.animations.length,1);f.svg.listeners.get('pointerover')({target});assert.equal(node.animations.length,1);f.svg.listeners.get('pointerdown')({button:0,target});assert.equal(node.animations.length,2);
  [...f.preferenceListeners][0]({matches:true});f.scene.resetView();assert.equal(Number(f.svg.attrs.viewBox.split(' ')[2]),OFFICE_WORLD.width);f.svg.listeners.get('pointerdown')({button:0,target});assert.equal(node.animations.length,2);f.drain();
 }finally{f.destroy();}
});

test('ERP presence removes legacy representatives from accessibility and keyboard interaction across refreshes',()=>{
 const selected=[],f=sceneFixture({onSelectHuman:id=>selected.push(id)});try{
  f.scene.setPresence({enabled:true,people:[]});const layer=f.layers.get('.cnl-human-layer'),representatives=layer.children;assert.equal(layer.style.display,'none');assert.equal(layer.attrs['aria-hidden'],'true');
  f.scene.update({runId:'erp',animateEvents:false,humanApproval:true,humans:[{id:'owner',status:'awaiting_approval'}]});
  for(const el of representatives){assert.equal(el.style.display,'none');assert.equal(el.attrs['aria-hidden'],'true');assert.equal(el.attrs.tabindex,'-1');el.listeners.get('click')({stopPropagation(){}});el.listeners.get('keydown')({key:'Enter',preventDefault(){},stopPropagation(){}});}
  const approval=f.layers.get('.cnl-human-approval');assert.equal(approval.attrs['aria-hidden'],'true');assert.equal(approval.attrs.tabindex,'-1');approval.listeners.get('click')({stopPropagation(){}});assert.deepEqual(selected,[]);
  f.scene.setPresence({enabled:false,people:[]});assert.equal(layer.attrs['aria-hidden'],'false');assert.equal(layer.style.display,'');assert.ok(representatives.every(el=>el.attrs.tabindex==='0'&&el.attrs['aria-hidden']==='false'));
 }finally{f.destroy();}
});

const onlinePerson=(nodeId='workstations')=>({id:'signed-in-employee',name:'林青',title:'项目经理',online:true,nodeId});
const eventTarget=element=>({closest:()=>element});

test('hovering a real signed-in person gives one finite wave, happy eyes and the office-time greeting without selecting work',()=>{
 const selected=[],f=sceneFixture();try{
  f.scene.setPresence({enabled:true,people:[onlinePerson()],onSelectEmployee:p=>selected.push(p.id)});
  const human=f.layers.get('.cnl-presence-layer').children[0],arm=human.querySelector('.cnl-person-arm-right'),bubble=f.layers.get('.cnl-greeting-layer'),target=eventTarget(human);
  f.svg.listeners.get('pointerover')({target});
  assert.equal(human.dataset.greeting,'human');assert.match(human.innerHTML,/cnl-person-face-happy/);assert.match(bubble.innerHTML,/cnl-greeting-icon-human/);assert.ok(bubble.innerHTML.includes(greetingForPerson().text));assert.equal(bubble.attrs['aria-hidden'],'false');assert.match(human.attrs['aria-describedby'],/-greeting$/);
  assert.equal(arm.animations.length,1);assert.equal(arm.animations[0].settings.iterations,1);assert.equal(arm.animations[0].settings.duration,920);assert.equal(human.animations.length,0);assert.deepEqual(selected,[]);
  f.svg.listeners.get('pointerover')({target});f.svg.listeners.get('pointerout')({relatedTarget:target});
  f.scene.setPresence({enabled:true,people:[onlinePerson()],onSelectEmployee:p=>selected.push(p.id)});
  assert.equal(arm.animations.length,1);assert.equal(bubble.dataset.visible,'true');
  human.listeners.get('click')({stopPropagation(){}});assert.deepEqual(selected,['signed-in-employee']);
  assert.doesNotMatch(bubble.innerHTML,/shadow|filter=|cnl-human-identity|cnl-agent-card/);
 }finally{f.destroy();}
});

test('virtual colleagues greet with a robot smile and standby text on hover and keyboard focus',()=>{
 const selected=[],f=sceneFixture({onSelectAgent:id=>selected.push(id)});try{
  const agent=f.layers.get('.cnl-agent-layer').children.find(el=>el.dataset.agent==='zhang'),bubble=f.layers.get('.cnl-greeting-layer'),target=eventTarget(agent);
  f.svg.listeners.get('pointerover')({target});assert.equal(agent.dataset.greeting,'robot');assert.match(bubble.innerHTML,/cnl-greeting-icon-robot/);assert.ok(bubble.innerHTML.includes('随时待命！'));assert.equal(agent.querySelector('.cnl-person-arm-right').animations.length,0);assert.deepEqual(selected,[]);
  f.svg.listeners.get('pointerout')({relatedTarget:null});assert.equal(bubble.style.display,'none');assert.equal(agent.dataset.greeting,undefined);
  f.svg.listeners.get('focusin')({target});assert.equal(bubble.dataset.visible,'true');assert.equal(agent.dataset.greeting,'robot');
  agent.listeners.get('keydown')({key:'Enter',preventDefault(){},stopPropagation(){}});assert.deepEqual(selected,['zhang']);
  f.svg.listeners.get('focusout')({relatedTarget:null});assert.equal(bubble.style.display,'none');assert.equal(agent.attrs['aria-describedby'],undefined);
 }finally{f.destroy();}
});

test('leaving, blurring, dragging, hiding, removing a person and destroying clear greetings and arm animation',()=>{
 const f=sceneFixture();let wave,bubble;try{
  f.scene.setPresence({enabled:true,people:[onlinePerson()]});const human=f.layers.get('.cnl-presence-layer').children[0],target=eventTarget(human),arm=human.querySelector('.cnl-person-arm-right');bubble=f.layers.get('.cnl-greeting-layer');
  const greet=()=>{f.svg.listeners.get('pointerover')({target});wave=arm.animations.at(-1);assert.equal(bubble.dataset.visible,'true');};
  const cleared=()=>{assert.equal(bubble.style.display,'none');assert.equal(bubble.innerHTML,'');assert.equal(human.dataset.greeting,undefined);assert.equal(wave.cancelled,true);};
  greet();f.svg.listeners.get('pointerleave')();cleared();
  greet();f.svg.listeners.get('focusout')({relatedTarget:null});cleared();
  greet();f.svg.listeners.get('pointerdown')({target:eventTarget(null),button:0,pointerId:1,clientX:0,clientY:0});cleared();f.svg.listeners.get('pointerup')({pointerId:1});
  greet();f.doc.hidden=true;f.visibility.get('visibilitychange')();cleared();f.doc.hidden=false;f.visibility.get('visibilitychange')();assert.equal(bubble.style.display,'none');
  greet();f.scene.setPresence({enabled:true,people:[]});cleared();assert.equal(f.layers.get('.cnl-presence-layer').children.length,0);
  f.svg.listeners.get('pointerover')({target});assert.equal(bubble.style.display,'none');
  f.scene.setPresence({enabled:true,people:[onlinePerson()]});const replacement=f.layers.get('.cnl-presence-layer').children[0];f.svg.listeners.get('focusin')({target:eventTarget(replacement)});wave=replacement.querySelector('.cnl-person-arm-right').animations.at(-1);
 }finally{f.destroy();}
 assert.equal(wave.cancelled,true);assert.equal(bubble.style.display,'none');assert.equal(f.visibility.size,0);for(const event of ['pointerover','pointerout','pointerleave','focusin','focusout'])assert.equal(f.svg.listeners.has(event),false);
});

test('reduced motion keeps smiles and text without waving and cancels a wave when the preference changes',()=>{
 const f=sceneFixture({}, {reducedMotion:true});try{
  f.scene.setPresence({enabled:true,people:[onlinePerson()]});const human=f.layers.get('.cnl-presence-layer').children[0],arm=human.querySelector('.cnl-person-arm-right'),target=eventTarget(human);
  f.svg.listeners.get('focusin')({target});assert.equal(human.dataset.greeting,'human');assert.equal(arm.animations.length,0);assert.equal(f.layers.get('.cnl-greeting-layer').dataset.visible,'true');
  [...f.preferenceListeners][0]({matches:false});f.svg.listeners.get('focusout')({relatedTarget:null});f.svg.listeners.get('pointerover')({target});assert.equal(arm.animations.length,1);
  [...f.preferenceListeners][0]({matches:true});assert.equal(arm.animations[0].cancelled,true);assert.equal(human.dataset.greeting,'human');assert.equal(f.layers.get('.cnl-greeting-layer').dataset.visible,'true');
 }finally{f.destroy();}
});

test('greetings follow real walking positions without overriding gait or a handoff, and never revive hidden representatives',()=>{
 const f=sceneFixture({}, {frames:true});try{
  f.scene.setPresence({enabled:true,people:[onlinePerson()]});const human=f.layers.get('.cnl-presence-layer').children[0],target=eventTarget(human),arm=human.querySelector('.cnl-person-arm-right'),bubble=f.layers.get('.cnl-greeting-layer');
  f.svg.listeners.get('pointerover')({target});const wave=arm.animations[0];f.scene.setPresence({enabled:true,people:[onlinePerson('finance')]});assert.equal(wave.cancelled,true);assert.equal(human.dataset.walking,'true');
  f.frame();assert.ok(bubble.attrs.transform.startsWith(human.attrs.transform));
  f.svg.listeners.get('pointerout')({relatedTarget:null});f.svg.listeners.get('pointerover')({target});assert.equal(arm.animations.length,1);f.drain();
  f.svg.listeners.get('pointerleave')();f.svg.listeners.get('pointerover')({target});assert.equal(arm.animations.length,2);
  f.scene.update({runId:'greet-delivery',animateEvents:false,logs:[]});f.scene.update({runId:'greet-delivery',logs:[{id:'actual-handoff',type:'handoff',sourceAgentId:'zhang',targetHumanId:'signed-in-employee'}]});assert.equal(arm.animations[1].cancelled,true);assert.equal(f.svg.dataset.deliveryActive,'1');
  const legacy=f.layers.get('.cnl-human-layer').children[0];f.svg.listeners.get('pointerover')({target:eventTarget(legacy)});assert.equal(bubble.style.display,'none');assert.equal(legacy.attrs['aria-hidden'],'true');assert.equal(legacy.attrs.tabindex,'-1');
 }finally{f.destroy();}
});

const almost=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<1e-7,message||`${actual} differs from ${expected}`);
const sceneScale=f=>OFFICE_WORLD.width/Number((f.svg.attrs.viewBox||initialViewBox).split(' ')[2]);

test('2D anchored zoom writes only its final viewBox once per frame without a forced CTM read between writes',()=>{
  const f=sceneFixture({}, {frames:true,rect:{left:80,top:60,width:720,height:450},layoutHeight:900});try{f.drain();const world={x:700,y:250},anchor=f.screen(world);f.input('wheel',{deltaY:-80,clientX:anchor.x,clientY:anchor.y});
    for(let i=0;i<16;i++){const writes=f.svg.writes.filter(key=>key==='viewBox').length,reads=f.svg.ctmReads;f.frame();assert.ok(f.svg.writes.filter(key=>key==='viewBox').length-writes<=1);assert.equal(f.svg.ctmReads,reads,'camera animation uses its stored anchor instead of forcing layout');almost(f.screen(world).x,anchor.x);almost(f.screen(world).y,anchor.y);}f.drain();assert.equal(f.pending.size,0);
    f.input('gesturestart',{clientX:anchor.x,clientY:anchor.y});const writes=f.svg.writes.filter(key=>key==='viewBox').length,reads=f.svg.ctmReads;f.input('gesturechange',{scale:1.3,clientX:anchor.x,clientY:anchor.y});assert.equal(f.svg.writes.filter(key=>key==='viewBox').length-writes,1);assert.equal(f.svg.ctmReads-reads,1);almost(f.screen(world).x,anchor.x);almost(f.screen(world).y,anchor.y);f.input('gestureend');f.drain();
  }finally{f.destroy();}
});

test('2D drag and wheel stay attached to the pointer through a scaled stage and SVG letterboxing',()=>{
 const f=sceneFixture({}, {frames:true,rect:{left:80,top:60,width:720,height:450},layoutHeight:900});
 try{
  f.drain();assert.ok(f.markup.includes(`viewBox="${initialViewBox}"`));assert.match(f.markup,/preserveAspectRatio="xMidYMid meet"/);
  const world={...NODE_META.server},initial=f.screen(world);
  f.input('pointerdown',{pointerId:8,clientX:250,clientY:260});f.input('pointermove',{pointerId:8,clientX:280,clientY:275});f.input('pointerup',{pointerId:8});
  const dragged=f.screen(world);almost(dragged.x,initial.x+30);almost(dragged.y,initial.y+15);assert.equal(f.svg.captured.size,0);
  const wheel=f.input('wheel',{deltaY:-80,clientX:dragged.x,clientY:dragged.y});assert.equal(wheel.defaultPrevented,true);almost(sceneScale(f),1,'wheel begins a transition rather than jumping');
  f.frame();f.frame();assert.ok(sceneScale(f)>1&&sceneScale(f)<1.1);almost(f.screen(world).x,dragged.x);almost(f.screen(world).y,dragged.y);
  f.drain();almost(f.screen(world).x,dragged.x);almost(f.screen(world).y,dragged.y);
  f.scene.resetView();f.drain();assert.equal(f.svg.attrs.viewBox,initialViewBox);almost(f.screen(world).x,initial.x);almost(f.screen(world).y,initial.y);
  const anchor=f.scene.getNodeAnchor('server');almost(anchor.x+80,initial.x);almost(anchor.y+60,initial.y);assert.equal(f.pending.size,0);
 }finally{f.destroy();}
});

test('2D wheel units are normalized and a continuous stream retargets smoothly without changing drag habits',()=>{
 const endpoints=[];
 for(const input of[{deltaMode:0,deltaY:-16},{deltaMode:1,deltaY:-1},{deltaMode:2,deltaY:-16/900}]){
  const f=sceneFixture({}, {frames:true,layoutHeight:900});try{f.drain();f.input('wheel',input);f.drain();endpoints.push(sceneScale(f));}finally{f.destroy();}
 }
 almost(endpoints[0],endpoints[1]);almost(endpoints[0],endpoints[2]);
 const f=sceneFixture({}, {frames:true});try{
  f.drain();const world={x:300,y:220},anchor=f.screen(world);let previous=sceneScale(f);
  for(let i=0;i<12;i++){f.input('wheel',{deltaY:-12,clientX:anchor.x,clientY:anchor.y});f.frame();f.frame();const current=sceneScale(f);assert.ok(current>=previous);previous=current;almost(f.screen(world).x,anchor.x);almost(f.screen(world).y,anchor.y);}
  f.drain();almost(sceneScale(f),Math.exp(12*12*.0009));assert.equal(f.pending.size,0);
  f.input('wheel',{deltaY:100000,clientX:anchor.x,clientY:anchor.y});f.drain();assert.ok(sceneScale(f)>.72&&sceneScale(f)<2.25);
  f.scene.resetView();f.drain();f.input('wheel',{deltaY:-100000});f.drain();assert.ok(sceneScale(f)<1.12,'one mouse wheel event is capped to a mild relative step');
 }finally{f.destroy();}
});

test('Safari 2D pinch is synchronous, anchored and scene-scoped, without also applying wheel zoom',()=>{
 const selected=[],f=sceneFixture({onSelectNode:id=>selected.push(id)}, {frames:true,rect:{left:70,top:40,width:530,height:325},layoutHeight:650});
 try{
  f.drain();const world={x:700,y:250},anchor=f.screen(world);
  for(const name of['gesturestart','gesturechange','gestureend','wheel'])assert.equal(f.svg.listenerOptions.get(name).passive,false);
  assert.equal(f.input('gesturestart',{clientX:anchor.x,clientY:anchor.y}).defaultPrevented,true);
  f.input('wheel',{deltaY:-100,clientX:anchor.x,clientY:anchor.y});almost(sceneScale(f),1);
  const changed=f.input('gesturechange',{scale:1.5,clientX:anchor.x,clientY:anchor.y});assert.equal(changed.defaultPrevented,true);almost(sceneScale(f),1.5);almost(f.screen(world).x,anchor.x);almost(f.screen(world).y,anchor.y);
  f.input('gesturechange',{scale:0});almost(sceneScale(f),1.5);assert.equal(f.input('gestureend').defaultPrevented,true);
  const click=f.input('click');assert.equal(click.defaultPrevented,true);assert.equal(click.stopped,true);
  f.groups.get('[data-node]').find(n=>n.dataset.node==='server').listeners.get('click')({stopPropagation(){}});assert.deepEqual(selected,[]);
  assert.equal(f.windowTarget.listeners.has('wheel'),false);assert.equal(f.windowTarget.listeners.has('gesturestart'),false);assert.equal(f.visibility.has('gesturestart'),false);
  f.scene.resetView();f.drain();assert.equal(f.svg.attrs.viewBox,initialViewBox);
  f.input('gesturestart',{clientX:undefined,clientY:undefined});f.input('gesturechange',{scale:1.2,clientX:undefined,clientY:undefined});almost(sceneScale(f),1.2);f.input('gestureend');f.drain();assert.equal(f.pending.size,0);
 }finally{f.destroy();}
});

test('two-pointer 2D pinch can start on an object and does not double-apply Safari gestures or select the object',()=>{
 const selected=[],f=sceneFixture({onSelectNode:id=>selected.push(id)}, {frames:true});
 try{
  f.drain();const server=f.groups.get('[data-node]').find(n=>n.dataset.node==='server'),target={closest:()=>server},world=new DOMPoint(500,300).matrixTransform(f.svg.getScreenCTM().inverse());
  f.input('pointerdown',{pointerType:'touch',pointerId:1,clientX:400,clientY:300,target});
  assert.equal(f.input('pointerdown',{pointerType:'touch',pointerId:2,clientX:600,clientY:300}).defaultPrevented,true);assert.deepEqual([...f.svg.captured],[1,2]);
  f.input('gesturestart');f.input('gesturechange',{scale:2});almost(sceneScale(f),1);
  assert.equal(f.input('pointermove',{pointerType:'touch',pointerId:2,clientX:700,clientY:350}).defaultPrevented,true);
  const actual=sceneScale(f);almost(actual,Math.hypot(300,50)/200);almost(f.screen(world).x,550);almost(f.screen(world).y,325);
  f.input('gesturechange',{scale:3});almost(sceneScale(f),actual);f.input('gestureend');
  f.input('pointerup',{pointerType:'touch',pointerId:2});f.input('pointerup',{pointerType:'touch',pointerId:1});assert.equal(f.svg.captured.size,0);assert.equal(f.svg.classes.has('is-panning'),false);
  server.listeners.get('click')({stopPropagation(){}});assert.deepEqual(selected,[]);f.drain();assert.equal(f.pending.size,0);
 }finally{f.destroy();}
});

test('2D cancelled captures, hidden pages, blur and destroy release input state and listeners',()=>{
 const f=sceneFixture({}, {frames:true});
 try{
  f.drain();const down=()=>{f.input('pointerdown',{pointerType:'touch',pointerId:1,clientX:400,clientY:300});f.input('pointerdown',{pointerType:'touch',pointerId:2,clientX:600,clientY:300});};
  down();f.input('pointercancel',{pointerType:'touch',pointerId:2});f.input('pointercancel',{pointerType:'touch',pointerId:1});assert.equal(f.svg.captured.size,0);
  down();f.windowTarget.listeners.get('blur')();assert.equal(f.svg.captured.size,0);assert.equal(f.svg.classes.has('is-panning'),false);
  down();f.doc.hidden=true;f.visibility.get('visibilitychange')();assert.equal(f.svg.captured.size,0);f.doc.hidden=false;
  f.input('wheel',{deltaY:-40});assert.ok(f.pending.size>0);const oldGesture=f.svg.listeners.get('gesturechange');f.scene.destroy();assert.equal(f.pending.size,0);
  for(const name of['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture','wheel','gesturestart','gesturechange','gestureend'])assert.equal(f.svg.listeners.has(name),false,name);
  assert.equal(f.windowTarget.listeners.has('blur'),false);oldGesture({preventDefault(){},scale:2,clientX:100,clientY:100});assert.equal(f.pending.size,0);
 }finally{f.destroy();}
});

test('the organization retains 251 workplaces and 250 people while the overview exposes representative posts only',()=>{
  const selected=[],f=sceneFixture({onSelectNode:id=>selected.push(id)});
  try {
    const positions=f.groups.get('[data-position]');
    assert.equal(positions.length,251);assert.equal(new Set(positions.map(position=>position.dataset.position)).size,251);
    assert.equal(positions.filter(position=>position.dataset.visible==='true').length,OFFICE_OVERVIEW_SEATS.length);assert.equal(OFFICE_OVERVIEW_SEATS.length,52);
    assert.equal([...f.markup.matchAll(/class="cnl-position-person"/g)].length,51);
    assert.equal([...f.markup.matchAll(/data-occupied="true"/g)].length,250);
    assert.equal([...f.markup.matchAll(/data-occupied="false"/g)].length,1);
    for(const room of OFFICE_ROOMS){
      assert.ok(f.markup.includes(`data-room="${room.id}"`));assert.ok(f.markup.includes(room.title));
      const node=f.groups.get('[data-node]').find(node=>node.dataset.node===room.id);assert.ok(node,room.title);
      node.listeners.get('keydown')({key:'Enter',preventDefault(){},stopPropagation(){}});
    }
    assert.deepEqual(selected,OFFICE_ROOMS.map(room=>room.id));
    assert.equal([...f.markup.matchAll(/class="cnl-team-zone"/g)].length,5);
    for(const team of OFFICE_ROOMS.find(room=>room.id==='ai_data').teamZones){assert.ok(f.markup.includes(`data-team="${team.id}"`));assert.equal(team.seats.filter(seat=>seat.role==='staff').length,40);}
    for(const item of OFFICE_LANDSCAPE){assert.ok(f.markup.includes(`data-landscape="${item.id}"`));assert.ok(!f.markup.includes(`data-landscape="${item.id}" data-kind="${item.kind}"></g>`));}
    for(const fitting of OFFICE_FITTINGS)assert.ok(f.markup.includes(`data-fitting="${fitting.id}"`));for(const area of OFFICE_SHARED_AREAS)assert.ok(f.markup.includes(`data-common-area="${area.id}"`));
    assert.ok(f.markup.includes('12 部门 · 250 人'));assert.ok(f.markup.includes('商务部经理兼任'));
    assert.doesNotMatch(f.markup,/TEAM WORKSPACE|CUSTOMER LOUNGE|NETWORK FLOOR|会议室|客户会见厅|业务管理室|财务办公室/);
  }finally{f.destroy();}
});

test('a static organization workplace greets without impersonating signed-in presence or opening ERP data',()=>{
  const selected=[],f=sceneFixture({onSelectNode:id=>selected.push(id),onSelectHuman:id=>selected.push(id),onSelectAgent:id=>selected.push(id)});
  try {
    const seat=OFFICE_SEATS.find(seat=>seat.role==='chairman'),element=f.groups.get('[data-position]').find(position=>position.dataset.position===seat.id),bubble=f.layers.get('.cnl-greeting-layer'),target=eventTarget(element);
    f.svg.listeners.get('pointerover')({target});
    assert.equal(element.dataset.greeting,'human');assert.ok(bubble.innerHTML.includes(greetingForPerson().text));assert.equal(element.dataset.human,undefined);
    assert.ok(bubble.attrs.transform.startsWith(`translate(${seat.x} ${seat.y})`));
    const arm=element.querySelector('.cnl-position-wave');assert.equal(arm.animations.length,1);assert.equal(arm.animations[0].settings.iterations,1);
    element.listeners.get('click')({stopPropagation(){}});assert.equal(element.attrs['aria-pressed'],'true');assert.equal(element.dataset.selected,'true');assert.deepEqual(selected,[]);
    f.svg.listeners.get('pointerleave')();assert.equal(bubble.style.display,'none');assert.equal(arm.animations[0].cancelled,true);
    const shared=OFFICE_SEATS.find(seat=>!seat.occupantVisible),sharedElement=f.groups.get('[data-position]').find(position=>position.dataset.position===shared.id);
    f.svg.listeners.get('pointerover')({target:eventTarget(sharedElement)});assert.equal(bubble.style.display,'none');assert.equal(sharedElement.dataset.human,undefined);assert.deepEqual(selected,[]);
  }finally{f.destroy();}
});

test('department focus frames the actual room while large organization seats remain detailed at the zoom limit',()=>{
  const f=sceneFixture({}, {frames:true});
  try {
    f.drain();
    for(const room of OFFICE_ROOMS){
      assert.equal(f.scene.focusNode(room.id),true);f.drain();
      const [x,y,width,height]=f.svg.attrs.viewBox.split(' ').map(Number);
      assert.ok(x<room.x&&x+width>room.x+room.w,room.title);
      assert.ok(y<room.y&&y+height>room.y+room.h,room.title);
      assert.ok(OFFICE_WORLD.width/width<=4.5);
    }
    assert.equal(f.scene.focusNode('missing-department'),false);
    f.scene.zoom(100);f.drain();almost(sceneScale(f),6.5);
    f.scene.resetView();f.drain();assert.equal(f.svg.attrs.viewBox,initialViewBox);
  }finally{f.destroy();}
});

test('a large department uses title feedback instead of animating hundreds of static workplace objects',()=>{
  const f=sceneFixture();
  try {
    const room=f.groups.get('[data-node]').find(node=>node.dataset.node==='ai_data'),target=eventTarget(room);
    f.svg.listeners.get('pointerover')({target});f.svg.listeners.get('pointerdown')({button:0,target});assert.equal(room.animations.length,0);
    assert.doesNotMatch(f.markup.match(/class="cnl-department-seats">([\s\S]*?)<\/g>/)?.[1]||'',/animation:|is-working|在线/);
    assert.equal(f.layers.get('.cnl-agent-layer').children.length,11);
  }finally{f.destroy();}
});

test('AI subdivision focus reveals forty-seat teams without selecting ERP data and preserves department overview reset',()=>{
  const selected=[],f=sceneFixture({onSelectNode:id=>selected.push(id)}, {frames:true});
  try {
    f.drain();const room=OFFICE_ROOMS.find(room=>room.id==='ai_data'),elements=f.groups.get('[data-team]');assert.equal(elements.length,5);
    for(const team of room.teamZones){
      const element=elements.find(element=>element.dataset.team===team.id);element.listeners.get('click')({stopPropagation(){}});f.drain();
      const [x,y,w,h]=f.svg.attrs.viewBox.split(' ').map(Number);assert.ok(x<team.x&&x+w>team.x+team.w);assert.ok(y<team.y&&y+h>team.y+team.h);assert.ok(sceneScale(f)>3);
    }
    assert.deepEqual(selected,[]);f.scene.focusNode('ai_data');f.drain();assert.ok(sceneScale(f)<2);f.scene.resetView();f.drain();assert.equal(f.svg.attrs.viewBox,initialViewBox);
  }finally{f.destroy();}
});

test('compact courtyard scenes render landscape, shared meeting furniture and every directional door from the same floor model',()=>{
  const f=sceneFixture();
  try {
    assert.equal(OFFICE_WORLD.width,1390);assert.equal(OFFICE_WORLD.height,1100);
    assert.ok(f.markup.includes('cnl-office-circulation'));assert.ok(f.markup.includes('stroke="url(#cnl-office-'));
    for(const kind of ['tree_island','pond','deck','planter','stepping_stone'])assert.ok(f.markup.includes(`data-kind="${kind}"`),kind);
    assert.ok(f.markup.includes('data-kind="collaboration_table"'));
    assert.equal([...f.markup.matchAll(/href="#cnl-office-\d+-chair"/g)].length,6,'shared table has six empty seats without creating extra employees');
    const directions=new Set();
    for(const room of OFFICE_ROOMS){
      const {x,y,width,side}=room.door;directions.add(side);
      const opening=side==='left'||side==='right'?`M${x} ${y-width/2}V${y+width/2}`:`M${x-width/2} ${y}H${x+width/2}`;
      assert.ok(f.markup.includes(`class="cnl-office-door" d="${opening}"`),`${room.title} ${side} door`);
    }
    assert.deepEqual([...directions].sort(),['bottom','left','right','top']);
    assert.equal([...f.markup.matchAll(/class="cnl-position-person"/g)].length,51);
  }finally{f.destroy();}
});

test('compact workplace hit regions stay within their row so neighboring desks do not steal hover or clicks',()=>{
  const f=sceneFixture();
  try {
    for(const displayed of [OFFICE_SEATS,OFFICE_OVERVIEW_SEATS]){
      const boxes=new Map(displayed.map(seat=>{const art=renderOrganizationPositionContents(seat,{use:()=>'',seated:()=>''}),match=art.match(/<rect class="cnl-position-hit" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/);return [seat.id,{x:Number(match[1]),y:Number(match[2]),w:Number(match[3]),h:Number(match[4])}];}));
      assert.equal(boxes.size,displayed.length);
      for(const room of OFFICE_ROOMS){
        const columns=new Map();for(const seat of displayed.filter(post=>post.departmentId===room.id)){const key=`${seat.teamId}:${seat.x}`;if(!columns.has(key))columns.set(key,[]);columns.get(key).push(seat);}
        for(const seats of columns.values()){
          seats.sort((a,b)=>a.y-b.y);
          for(let index=1;index<seats.length;index++){const upper=boxes.get(seats[index-1].id),lower=boxes.get(seats[index].id);assert.ok(upper.y+upper.h<=lower.y,`${room.title}: ${seats[index-1].label} / ${seats[index].label}`);}
        }
      }
    }

  }finally{f.destroy();}
});

test('idle poses affect at most two dynamic colleagues, finish, and never move posts or issue business actions',()=>{
  const actions=[],f=sceneFixture({onDelivery:e=>actions.push(e),onSelectNode:e=>actions.push(e)}, {timers:true});
  try {
    const actors=()=>[...f.layers.get('.cnl-agent-layer').children,...f.layers.get('.cnl-human-layer').children,...f.layers.get('.cnl-presence-layer').children];
    const before=new Map(actors().map(el=>[el,el.style.transform||el.attrs.transform]));
    f.advanceTimers(1500);const active=actors().filter(el=>el.dataset.ambient);assert.ok(active.length>0&&active.length<=2);
    assert.ok(active.every(el=>['wave','look','nod','sip','typing'].includes(el.dataset.ambient)));
    for(const position of f.groups.get('[data-position]'))assert.equal(position.dataset.ambient,undefined);
    assert.deepEqual(actions,[]);for(const el of actors())assert.equal(el.style.transform||el.attrs.transform,before.get(el));
    f.advanceTimers(2400);assert.ok(actors().every(el=>!el.dataset.ambient));assert.equal(f.timers.size,1);
    assert.ok(f.markup.includes('animation:cnl-ambient-wave 2.4s'));assert.doesNotMatch(f.markup,/cnl-ambient-[^}]+infinite/);
    assert.ok(f.layers.get('.cnl-agent-layer').children.every(el=>el.innerHTML.includes('cnl-ambient-tablet')));
  }finally{f.destroy();}
  assert.equal(f.timers.size,0);assert.equal(f.visibility.size,0);
});

test('real tasks, greeting hover, hidden pages and reduced motion immediately stop ambient poses and pending timers',()=>{
  const f=sceneFixture({}, {timers:true});
  try {
    const actors=()=>[...f.layers.get('.cnl-agent-layer').children,...f.layers.get('.cnl-human-layer').children,...f.layers.get('.cnl-presence-layer').children],playing=()=>actors().filter(el=>el.dataset.ambient);
    f.advanceTimers(1500);assert.ok(playing().length);
    f.scene.update({runId:'actual-task',runStatus:'running',animateEvents:false,agents:[{id:'zhang',status:'working',nodeId:'server'}]});assert.equal(playing().length,0);assert.equal(f.timers.size,0);
    f.advanceTimers(30000);assert.equal(playing().length,0);
    f.scene.update({runId:'actual-task',runStatus:'completed',animateEvents:false,agents:[]});f.advanceTimers(1500);assert.ok(playing().length);
    const zhang=f.layers.get('.cnl-agent-layer').children.find(el=>el.dataset.agent==='zhang');f.svg.listeners.get('pointerover')({target:eventTarget(zhang)});assert.equal(playing().length,0);assert.equal(f.timers.size,0);
    f.svg.listeners.get('pointerleave')();f.advanceTimers(1500);assert.ok(playing().length);
    f.doc.hidden=true;f.visibility.get('visibilitychange')();assert.equal(playing().length,0);assert.equal(f.timers.size,0);
    f.doc.hidden=false;f.visibility.get('visibilitychange')();f.advanceTimers(1500);assert.ok(playing().length);
    [...f.preferenceListeners][0]({matches:true});assert.equal(playing().length,0);assert.equal(f.timers.size,0);
    [...f.preferenceListeners][0]({matches:false});f.advanceTimers(1500);assert.ok(playing().length);
  }finally{f.destroy();}
  assert.equal(f.timers.size,0);
});

test('overview and focused detail switch both artwork geometry and hit regions without exposing all AI employees',()=>{
  const f=sceneFixture({}, {frames:true});
  try {
    const posts=f.groups.get('[data-position]'),visible=()=>posts.filter(post=>post.dataset.visible==='true'),visibleIds=()=>visible().map(post=>post.dataset.position).sort();
    assert.deepEqual(visibleIds(),OFFICE_OVERVIEW_SEATS.map(post=>post.id).sort());
    const room=OFFICE_ROOMS.find(room=>room.id==='ai_data'),team=room.teamZones[0],overview=OFFICE_OVERVIEW_SEATS.find(post=>post.teamId===team.id&&post.role==='staff'),element=posts.find(post=>post.dataset.position===overview.id),full=OFFICE_SEATS.find(post=>post.id===overview.id);
    assert.ok(element.innerHTML.includes(`translate(${overview.desk.x-overview.desk.w/2} ${overview.desk.y-overview.desk.h/2})`));assert.equal(overview.desk.w,50);
    f.scene.focusNode('ai_data');f.drain();assert.equal(visible().length,52,'department overview does not unfold all 200 AI employees');
    f.groups.get('[data-team]').find(el=>el.dataset.team===team.id).listeners.get('click')({stopPropagation(){}});f.drain();
    assert.equal(visible().filter(el=>OFFICE_SEATS.find(post=>post.id===el.dataset.position).teamId===team.id).length,41);
    assert.equal(visible().filter(el=>OFFICE_SEATS.find(post=>post.id===el.dataset.position).teamId===room.teamZones[1].id).length,4);
    assert.ok(element.innerHTML.includes(`translate(${full.desk.x-full.desk.w/2} ${full.desk.y-full.desk.h/2})`));assert.equal(full.desk.w,14);
    f.scene.zoom(-10);f.drain();assert.equal(visible().length,52,'zooming back out collapses the previous team rather than keeping tiny desks on the overview');assert.equal(f.svg.dataset.focusTeam,'');
    f.scene.resetView();f.drain();assert.deepEqual(visibleIds(),OFFICE_OVERVIEW_SEATS.map(post=>post.id).sort());assert.ok(element.innerHTML.includes(`translate(${overview.desk.x-overview.desk.w/2} ${overview.desk.y-overview.desk.h/2})`));
    for(const el of posts){const shown=el.dataset.visible==='true';assert.equal(el.attrs['aria-hidden'],String(!shown));assert.equal(el.attrs.tabindex,shown?'0':'-1');assert.equal(el.style.display,shown?'':'none');}
    const hidden=posts.find(el=>el.dataset.visible==='false');f.svg.listeners.get('pointerover')({target:eventTarget(hidden)});assert.equal(f.layers.get('.cnl-greeting-layer').style.display,'none');
  }finally{f.destroy();}
});

test('Home and blank map double-click restore overview while object double-click never resets or submits work',()=>{
  const actions=[],f=sceneFixture({onSelectHuman:id=>actions.push(id),onSelectNode:id=>actions.push(id)}, {frames:true});
  try {
    f.scene.zoom(100);f.drain();almost(sceneScale(f),4.5);f.input('keydown',{key:'Home'});f.drain();almost(sceneScale(f),1);
    const team=f.groups.get('[data-team]')[0];team.listeners.get('click')({stopPropagation(){}});f.drain();assert.ok(sceneScale(f)>4.5);assert.ok(f.svg.dataset.focusTeam);
    const element=f.groups.get('[data-position]').find(el=>el.dataset.visible==='true'),before=f.svg.attrs.viewBox;
    f.input('dblclick',{target:eventTarget(element)});assert.equal(f.svg.attrs.viewBox,before);assert.deepEqual(actions,[]);
    assert.equal(f.input('dblclick').defaultPrevented,true);f.drain();assert.equal(f.svg.attrs.viewBox,initialViewBox);assert.equal(f.svg.dataset.visiblePosts,'52');assert.equal(f.svg.dataset.focusTeam,'');
    f.scene.zoom(100);f.drain();almost(sceneScale(f),4.5);assert.deepEqual(actions,[]);
  }finally{f.destroy();}
});

test('virtual uniforms and human workwear stay distinct even if task payloads supply conflicting colors',()=>{
  const f=sceneFixture();
  try {
    f.scene.update({runId:'identity',animateEvents:false,agents:[{id:'zhang',color:'#ff0000'}],humans:[{id:'finance_owner',color:'#347f9c'}]});
    for(const agent of f.layers.get('.cnl-agent-layer').children){assert.ok(agent.innerHTML.includes('--shirt:#347f9c'));assert.ok(!agent.innerHTML.includes('--shirt:#ff0000'));}
    for(const human of f.layers.get('.cnl-human-layer').children)assert.ok(human.innerHTML.includes('--shirt:#c68b60'));
    f.scene.setPresence({enabled:true,people:[{...onlinePerson(),color:'#347f9c'}]});assert.ok(f.layers.get('.cnl-presence-layer').children[0].innerHTML.includes('--shirt:#c68b60'));
    for(const post of f.groups.get('[data-position]').filter(el=>el.dataset.visible==='true'))if(OFFICE_SEATS.find(seat=>seat.id===post.dataset.position).occupantVisible)assert.ok(post.innerHTML.includes('--shirt:#c68b60'));
  }finally{f.destroy();}
});

test('department hover and focus show authoritative roles in one compact hint without opening ERP or inventing online status',()=>{
  const actions=[],f=sceneFixture({onSelectNode:id=>actions.push(id)}, {timers:true});
  try {
    const room=f.groups.get('[data-node]').find(el=>el.dataset.node==='ai_data'),layer=f.layers.get('.cnl-greeting-layer');
    f.svg.listeners.get('pointerover')({target:eventTarget(room)});assert.equal(layer.attrs['aria-hidden'],'false');assert.ok(layer.innerHTML.includes('AI数据算法部'));assert.ok(layer.innerHTML.includes('206 人'));assert.ok(layer.innerHTML.includes('经理 1 · 部长 5 · 员工 200'));assert.doesNotMatch(layer.innerHTML,/在线|待命|运行正常|ERP|shadow|filter=/);assert.deepEqual(actions,[]);assert.equal(f.timers.size,0);
    const original=layer.innerHTML;f.svg.listeners.get('pointerout')({relatedTarget:eventTarget(room)});assert.equal(layer.innerHTML,original);
    f.svg.listeners.get('pointerleave')();assert.equal(layer.attrs['aria-hidden'],'true');
    const executive=f.groups.get('[data-node]').find(el=>el.dataset.node==='general_office');f.svg.listeners.get('focusin')({target:eventTarget(executive)});assert.ok(layer.innerHTML.includes('2 人'));assert.ok(layer.innerHTML.includes('董事长 1 · 经理 1'));assert.deepEqual(actions,[]);
    f.svg.listeners.get('focusout')({relatedTarget:null});assert.equal(layer.style.display,'none');assert.equal(executive.attrs['aria-describedby'],undefined);
  }finally{f.destroy();}
});

test('department hints keep readable physical UI dimensions on narrow screens, native pinch and map zoom without per-frame layout reads',()=>{
  for(const options of [{rect:{width:390,height:844},nativeScale:1},{rect:{width:720,height:450},nativeScale:2}]){
    const f=sceneFixture({}, {...options,frames:true});
    try {
      f.drain();const room=f.groups.get('[data-node]').find(el=>el.dataset.node==='finance'),layer=f.layers.get('.cnl-greeting-layer');f.svg.listeners.get('pointerover')({target:eventTarget(room)});
      const physicalWidth=()=>{const factor=Number(layer.attrs.transform.match(/scale\(([^)]+)\)/)[1]);return 232*factor*f.svg.getScreenCTM().a*options.nativeScale;};
      almost(physicalWidth(),232);f.scene.zoom(2);for(let index=0;index<16;index++){const reads=f.svg.ctmReads;f.frame();assert.equal(f.svg.ctmReads,reads,'hint placement reuses the cached fit ratio while zoom animates');}f.drain();almost(physicalWidth(),232);
      f.scene.resetView();f.drain();f.svg.listeners.get('pointerover')({target:eventTarget(room)});almost(physicalWidth(),232);
    }finally{f.destroy();}
  }
});

test('online signed-in colleagues receive ambient poses on their live presence element and hover or destroy clears them',()=>{
  const f=sceneFixture({}, {timers:true});let human;
  try {
    f.scene.setPresence({enabled:true,people:[{...onlinePerson('hr_admin'),id:'000-current-user'}],currentUserId:'000-current-user'});human=f.layers.get('.cnl-presence-layer').children[0];f.advanceTimers(1500);assert.ok(human.dataset.ambient,'the signed-in person is resolved through live presence rather than a legacy representative');
    const before=human.attrs.transform;f.svg.listeners.get('pointerover')({target:eventTarget(human)});assert.equal(human.dataset.ambient,undefined);assert.equal(human.attrs.transform,before);
    f.svg.listeners.get('pointerleave')();
  }finally{f.destroy();}
  assert.equal(human.dataset.ambient,undefined);assert.equal(f.timers.size,0);
});

test('the public bulletin is a real selectable shared facility, with an empty board and no extra department or employee',()=>{
  const selected=[],f=sceneFixture({onSelectNode:id=>selected.push(id)});
  try {
    const nodes=f.groups.get('[data-node]').filter(el=>el.dataset.node==='bulletin');assert.equal(nodes.length,1,'the physical bulletin must not also create a duplicate generic network hotspot');
    assert.ok(f.markup.includes('data-shared-space="bulletin"'));assert.ok(f.markup.includes('class="cnl-bulletin-frame"'));assert.equal([...f.markup.matchAll(/class="cnl-bulletin-bench"/g)].length,2);
    const area=f.markup.slice(f.markup.indexOf('class="cnl-bulletin-area"'),f.markup.indexOf('class="cnl-office-summary"'));
    assert.ok(area.includes('信息公开栏'));assert.doesNotMatch(area,/示例公告|欢迎加入|发布人|发布时间|暂无公告|查看进展|待命|在线人数/);
    assert.equal(OFFICE_ROOMS.length,12);assert.equal(OFFICE_SEATS.length,251);assert.equal(f.svg.dataset.visiblePosts,'52');assert.equal(f.layers.get('.cnl-agent-layer').children.length,11);
    nodes[0].listeners.get('click')({stopPropagation(){}});nodes[0].listeners.get('keydown')({key:'Enter',preventDefault(){},stopPropagation(){}});assert.deepEqual(selected,['bulletin','bulletin']);
    f.scene.update({runId:null,animateEvents:false});assert.equal(nodes[0].attrs['aria-label'],'信息公开栏');
    const point=f.scene.getNodeAnchor('bulletin'),screen=f.screen(OFFICE_BULLETIN_AREA.anchor);almost(point.x,screen.x);almost(point.y,screen.y);
  }finally{f.destroy();}
});

test('the unattended convenience shop is a furnished passive courtyard area without inventing retail functions or organization posts',()=>{
  const f=sceneFixture();
  try {
    const start=f.markup.indexOf('class="cnl-convenience-area"'),end=f.markup.indexOf('class="cnl-infrastructure"',start),area=f.markup.slice(start,end);
    assert.ok(start>0);assert.ok(area.includes('data-shared-space="convenience"'));assert.ok(area.includes('无人便利店'));
    for(const fixture of ['shelf','fridge','counter'])assert.ok(area.includes(`data-store-fixture="${fixture}"`));
    assert.ok(area.includes('cnl-store-glass'));assert.ok(area.includes('cnl-store-canopy'));
    assert.doesNotMatch(area,/data-node=|data-position=|tabindex=|role="button"|扫码|支付|销量|库存|订单|价格|¥|￥|元/);
    assert.ok(!f.groups.get('[data-node]').some(node=>node.dataset.node==='convenience'));assert.equal(OFFICE_ROOMS.length,12);assert.equal(OFFICE_SEATS.length,251);assert.equal(f.svg.dataset.visiblePosts,'52');
    assert.equal(OFFICE_CONVENIENCE_AREA.title,'无人便利店');assert.ok(OFFICE_CONVENIENCE_AREA.w<=150&&OFFICE_CONVENIENCE_AREA.h<=110);
  }finally{f.destroy();}
});
