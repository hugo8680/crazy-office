import test from 'node:test';
import assert from 'node:assert/strict';
import { mountScene, NODE_META } from '../src/scene.js';
import { HUMAN_EMPLOYEES } from '../src/people.js';
import {greetingForPerson} from '../src/person-greeting.mjs';

// A minimal SVG DOM records public scene interactions without a browser, model,
// or production-only testing controls.
function sceneFixture(callbacks={},options={}) {
  const previous={document:globalThis.document,window:globalThis.window,DOMPoint:globalThis.DOMPoint,ResizeObserver:globalThis.ResizeObserver,requestAnimationFrame:globalThis.requestAnimationFrame,cancelAnimationFrame:globalThis.cancelAnimationFrame,matchMedia:globalThis.matchMedia,performance:globalThis.performance};
  let markup='',clock=1000,sequence=0;const layers=new Map(),groups=new Map(),preferenceListeners=new Set(),pending=new Map(),visibility=new Map();
  class Element {
    constructor(){this.attrs={};this.writes=[];this.dataset={};this.children=[];this.innerHTML='';this.classes=new Set();this.listeners=new Map();this.listenerOptions=new Map();this.captured=new Set();this.props={};this.animations=[];this.queries=new Map();this.style={setProperty:(k,v)=>this.props[k]=v};this.classList={add:(...xs)=>xs.forEach(x=>this.classes.add(x)),remove:(...xs)=>xs.forEach(x=>this.classes.delete(x)),toggle:(x,on)=>{if(on??!this.classes.has(x))this.classes.add(x);else this.classes.delete(x);},contains:x=>this.classes.has(x)};}
    animate(frames,settings){const animation={frames,settings,cancel(){this.cancelled=true;}};this.animations.push(animation);return animation;}setAttribute(k,v){this.writes.push(k);this.attrs[k]=v;}removeAttribute(k){delete this.attrs[k];}addEventListener(k,fn,options){this.listeners.set(k,fn);this.listenerOptions.set(k,options);}removeEventListener(k){this.listeners.delete(k);this.listenerOptions.delete(k);}setPointerCapture(id){this.captured.add(id);}hasPointerCapture(id){return this.captured.has(id);}releasePointerCapture(id){this.captured.delete(id);}append(el){el.parent=this;this.children.push(el);}remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}querySelector(selector){if(!this.queries.has(selector))this.queries.set(selector,new Element());return this.queries.get(selector);}
  }
  const svg=new Element();
  const rect={left:0,top:0,width:1060,height:650,...options.rect};
  svg.clientHeight=options.layoutHeight||rect.height;svg.getBoundingClientRect=()=>({...rect});
  svg.ctmReads=0;svg.getScreenCTM=()=>{svg.ctmReads++;const [x,y,width,height]=(svg.attrs.viewBox||'0 0 1060 650').split(' ').map(Number),unit=Math.min(rect.width/width,rect.height/height),matrix={a:unit,b:0,c:0,d:unit,e:rect.left+(rect.width-width*unit)/2-x*unit,f:rect.top+(rect.height-height*unit)/2-y*unit};matrix.inverse=()=>({a:1/unit,b:0,c:0,d:1/unit,e:-matrix.e/unit,f:-matrix.f/unit});return matrix;};
  svg.querySelector=selector=>{if(selector.startsWith('#')){const id=selector.slice(1),match=markup.match(new RegExp(`<symbol id="${id}"[^>]*>([\\s\\S]*?)<\\/symbol>`));return {innerHTML:match?.[1]||''};}if(!layers.has(selector))layers.set(selector,new Element());return layers.get(selector);};
  svg.querySelectorAll=selector=>{
    if(groups.has(selector))return groups.get(selector);
    const pattern=selector==='[data-node]'?/<g class="cnl-node" data-node="([^"]+)"/g:selector==='[data-device]'?/<g class="cnl-device" data-device="([^"]+)"/g:/<g class="cnl-link" data-a="([^"]+)" data-b="([^"]+)"/g;
    const result=[...markup.matchAll(pattern)].map(m=>{const el=new Element();el.dataset[selector==='[data-node]'?'node':selector==='[data-device]'?'device':'a']=m[1];if(m[2])el.dataset.b=m[2];return el;});groups.set(selector,result);return result;
  };
  const preference={matches:options.reducedMotion===true,addEventListener:(_type,fn)=>preferenceListeners.add(fn),removeEventListener:(_type,fn)=>preferenceListeners.delete(fn)};
  const doc={hidden:false,createElementNS:()=>new Element(),addEventListener:(type,fn)=>visibility.set(type,fn),removeEventListener:type=>visibility.delete(type)};
  const windowTarget=new Element();
  globalThis.document=doc;globalThis.window=windowTarget;globalThis.DOMPoint=class{constructor(x=0,y=0){this.x=x;this.y=y;}matrixTransform(matrix){return new globalThis.DOMPoint(this.x*matrix.a+this.y*matrix.c+matrix.e,this.x*matrix.b+this.y*matrix.d+matrix.f);}};globalThis.ResizeObserver=class{observe(){}disconnect(){}};globalThis.requestAnimationFrame=()=>0;globalThis.cancelAnimationFrame=()=>{};globalThis.matchMedia=()=>preference;if(options.frames){globalThis.performance={now:()=>clock};globalThis.requestAnimationFrame=fn=>{const id=++sequence;pending.set(id,fn);return id;};globalThis.cancelAnimationFrame=id=>pending.delete(id);}
  const container={set innerHTML(v){markup=v;},querySelector:()=>svg,getBoundingClientRect:()=>({...rect})};
  const scene=mountScene(container,callbacks);
  return {scene,svg,layers,groups,preferenceListeners,pending,doc,visibility,windowTarget,screen(point){return new DOMPoint(point.x,point.y).matrixTransform(svg.getScreenCTM());},input(type,values={}){const event={target:{closest:()=>null},button:0,pointerId:1,pointerType:'mouse',clientX:530,clientY:325,deltaMode:0,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;},...values};svg.listeners.get(type)?.(event);return event;},frame(){const callbacks=[...pending.values()];pending.clear();clock+=34;callbacks.forEach(fn=>fn(clock));},drain(){for(let i=0;i<1000&&pending.size;i++)this.frame();assert.equal(pending.size,0);},get markup(){return markup;},destroy(){scene.destroy();Object.assign(globalThis,previous);}};
}

test('general office is a selectable topology endpoint and keeps existing department endpoints',()=>{
  const selected=[],f=sceneFixture({onSelectNode:id=>selected.push(id)});
  try {
    const nodes=f.groups.get('[data-node]');
    assert.equal(nodes.length,Object.keys(NODE_META).length);
    for(const id of ['investment','general_office','executive','workstations','server'])assert.ok(nodes.some(n=>n.dataset.node===id),id);
    const office=nodes.find(n=>n.dataset.node==='general_office');office.listeners.get('click')({stopPropagation(){}});
    assert.deepEqual(selected,['general_office']);assert.equal(office.attrs['aria-pressed'],'true');
    assert.ok(f.markup.includes('投资者关系部'));assert.ok(f.markup.includes('data-device="general_office"'));
  }finally{f.destroy();}
});

test('a visiting reviewer, the virtual assistant and the real owner occupy separate general-office positions',()=>{
  const f=sceneFixture();
  try {
    f.scene.update({runId:'position-proof',animateEvents:false,agents:[{id:'invest_risk',nodeId:'general_office',status:'working',configured:true},{id:'boss',nodeId:'general_office',status:'working',configured:true}]});
    const agents=f.layers.get('.cnl-agent-layer').children;
    const reviewer=agents.find(a=>a.dataset.agent==='invest_risk'),assistant=agents.find(a=>a.dataset.agent==='boss');
    assert.equal(reviewer.dataset.x,'670.00');assert.equal(assistant.dataset.x,'584.00');
    const owner=HUMAN_EMPLOYEES.find(h=>h.id==='owner');assert.equal(owner.nodeId,'general_office');assert.equal(owner.x,755);
    const renderedOwner=f.layers.get('.cnl-human-layer').children.find(h=>h.dataset.human==='owner');
    assert.equal(renderedOwner.attrs.transform,'translate(755 87)');
    assert.ok(assistant.classes.has('is-seated'));assert.ok(!reviewer.classes.has('is-seated'));
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
 const f=sceneFixture({}, {frames:true});try{f.drain();assert.equal(f.scene.zoom(.3),1.3);f.frame();f.frame();const middle=Number(f.svg.attrs.viewBox.split(' ')[2]);assert.ok(middle<1060&&middle>1060/1.3);f.drain();assert.ok(Math.abs(Number(f.svg.attrs.viewBox.split(' ')[2])-1060/1.3)<.001);
  const node=f.groups.get('[data-node]').find(node=>node.dataset.node==='server'),target={closest:()=>node};f.svg.listeners.get('pointerover')({target});assert.equal(node.animations.length,1);f.svg.listeners.get('pointerover')({target});assert.equal(node.animations.length,1);f.svg.listeners.get('pointerdown')({button:0,target});assert.equal(node.animations.length,2);
  [...f.preferenceListeners][0]({matches:true});f.scene.resetView();assert.equal(Number(f.svg.attrs.viewBox.split(' ')[2]),1060);f.svg.listeners.get('pointerdown')({button:0,target});assert.equal(node.animations.length,2);f.drain();
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
  f.frame();assert.equal(bubble.attrs.transform,human.attrs.transform);
  f.svg.listeners.get('pointerout')({relatedTarget:null});f.svg.listeners.get('pointerover')({target});assert.equal(arm.animations.length,1);f.drain();
  f.svg.listeners.get('pointerleave')();f.svg.listeners.get('pointerover')({target});assert.equal(arm.animations.length,2);
  f.scene.update({runId:'greet-delivery',animateEvents:false,logs:[]});f.scene.update({runId:'greet-delivery',logs:[{id:'actual-handoff',type:'handoff',sourceAgentId:'zhang',targetHumanId:'signed-in-employee'}]});assert.equal(arm.animations[1].cancelled,true);assert.equal(f.svg.dataset.deliveryActive,'1');
  const legacy=f.layers.get('.cnl-human-layer').children[0];f.svg.listeners.get('pointerover')({target:eventTarget(legacy)});assert.equal(bubble.style.display,'none');assert.equal(legacy.attrs['aria-hidden'],'true');assert.equal(legacy.attrs.tabindex,'-1');
 }finally{f.destroy();}
});

const almost=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<1e-7,message||`${actual} differs from ${expected}`);
const sceneScale=f=>1060/Number((f.svg.attrs.viewBox||'0 0 1060 650').split(' ')[2]);

test('2D anchored zoom writes only its final viewBox once per frame without a forced CTM read between writes',()=>{
  const f=sceneFixture({}, {frames:true,rect:{left:80,top:60,width:720,height:450},layoutHeight:900});try{f.drain();const world={x:700,y:250},anchor=f.screen(world);f.input('wheel',{deltaY:-80,clientX:anchor.x,clientY:anchor.y});
    for(let i=0;i<16;i++){const writes=f.svg.writes.filter(key=>key==='viewBox').length,reads=f.svg.ctmReads;f.frame();assert.ok(f.svg.writes.filter(key=>key==='viewBox').length-writes<=1);assert.equal(f.svg.ctmReads,reads,'camera animation uses its stored anchor instead of forcing layout');almost(f.screen(world).x,anchor.x);almost(f.screen(world).y,anchor.y);}f.drain();assert.equal(f.pending.size,0);
    f.input('gesturestart',{clientX:anchor.x,clientY:anchor.y});const writes=f.svg.writes.filter(key=>key==='viewBox').length,reads=f.svg.ctmReads;f.input('gesturechange',{scale:1.3,clientX:anchor.x,clientY:anchor.y});assert.equal(f.svg.writes.filter(key=>key==='viewBox').length-writes,1);assert.equal(f.svg.ctmReads-reads,1);almost(f.screen(world).x,anchor.x);almost(f.screen(world).y,anchor.y);f.input('gestureend');f.drain();
  }finally{f.destroy();}
});

test('2D drag and wheel stay attached to the pointer through a scaled stage and SVG letterboxing',()=>{
 const f=sceneFixture({}, {frames:true,rect:{left:80,top:60,width:720,height:450},layoutHeight:900});
 try{
  f.drain();assert.match(f.markup,/viewBox="0 0 1060 650"/);assert.match(f.markup,/preserveAspectRatio="xMidYMid meet"/);
  const world={...NODE_META.server},initial=f.screen(world);
  f.input('pointerdown',{pointerId:8,clientX:250,clientY:260});f.input('pointermove',{pointerId:8,clientX:280,clientY:275});f.input('pointerup',{pointerId:8});
  const dragged=f.screen(world);almost(dragged.x,initial.x+30);almost(dragged.y,initial.y+15);assert.equal(f.svg.captured.size,0);
  const wheel=f.input('wheel',{deltaY:-80,clientX:dragged.x,clientY:dragged.y});assert.equal(wheel.defaultPrevented,true);almost(sceneScale(f),1,'wheel begins a transition rather than jumping');
  f.frame();f.frame();assert.ok(sceneScale(f)>1&&sceneScale(f)<1.1);almost(f.screen(world).x,dragged.x);almost(f.screen(world).y,dragged.y);
  f.drain();almost(f.screen(world).x,dragged.x);almost(f.screen(world).y,dragged.y);
  f.scene.resetView();f.drain();assert.equal(f.svg.attrs.viewBox,'0 0 1060 650');almost(f.screen(world).x,initial.x);almost(f.screen(world).y,initial.y);
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
  f.scene.resetView();f.drain();assert.equal(f.svg.attrs.viewBox,'0 0 1060 650');
  f.input('gesturestart',{clientX:undefined,clientY:undefined});f.input('gesturechange',{scale:1.2,clientX:undefined,clientY:undefined});almost(sceneScale(f),1.2);f.input('gestureend');f.drain();assert.equal(f.pending.size,0);
 }finally{f.destroy();}
});

test('two-pointer 2D pinch can start on an object and does not double-apply Safari gestures or select the object',()=>{
 const selected=[],f=sceneFixture({onSelectNode:id=>selected.push(id)}, {frames:true});
 try{
  f.drain();const server=f.groups.get('[data-node]').find(n=>n.dataset.node==='server'),target={closest:()=>server},world={x:500,y:300};
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
