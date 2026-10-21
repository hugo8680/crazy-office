import test from 'node:test';
import assert from 'node:assert/strict';
import { mountScene, NODE_META } from '../src/scene.js';
import { HUMAN_EMPLOYEES } from '../src/people.js';
import {greetingForPerson} from '../src/person-greeting.mjs';

// A minimal SVG DOM records public scene interactions without a browser, model,
// or production-only testing controls.
function sceneFixture(callbacks={},options={}) {
  const previous={document:globalThis.document,ResizeObserver:globalThis.ResizeObserver,requestAnimationFrame:globalThis.requestAnimationFrame,cancelAnimationFrame:globalThis.cancelAnimationFrame,matchMedia:globalThis.matchMedia,performance:globalThis.performance};
  let markup='',clock=1000,sequence=0;const layers=new Map(),groups=new Map(),preferenceListeners=new Set(),pending=new Map(),visibility=new Map();
  class Element {
    constructor(){this.attrs={};this.dataset={};this.children=[];this.innerHTML='';this.classes=new Set();this.listeners=new Map();this.props={};this.animations=[];this.queries=new Map();this.style={setProperty:(k,v)=>this.props[k]=v};this.classList={add:(...xs)=>xs.forEach(x=>this.classes.add(x)),remove:(...xs)=>xs.forEach(x=>this.classes.delete(x)),toggle:(x,on)=>{if(on??!this.classes.has(x))this.classes.add(x);else this.classes.delete(x);},contains:x=>this.classes.has(x)};}
    animate(frames,settings){const animation={frames,settings,cancel(){this.cancelled=true;}};this.animations.push(animation);return animation;}setAttribute(k,v){this.attrs[k]=v;}removeAttribute(k){delete this.attrs[k];}addEventListener(k,fn){this.listeners.set(k,fn);}removeEventListener(k){this.listeners.delete(k);}append(el){el.parent=this;this.children.push(el);}remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}querySelector(selector){if(!this.queries.has(selector))this.queries.set(selector,new Element());return this.queries.get(selector);}
  }
  const svg=new Element();
  svg.querySelector=selector=>{if(selector.startsWith('#')){const id=selector.slice(1),match=markup.match(new RegExp(`<symbol id="${id}"[^>]*>([\\s\\S]*?)<\\/symbol>`));return {innerHTML:match?.[1]||''};}if(!layers.has(selector))layers.set(selector,new Element());return layers.get(selector);};
  svg.querySelectorAll=selector=>{
    if(groups.has(selector))return groups.get(selector);
    const pattern=selector==='[data-node]'?/<g class="cnl-node" data-node="([^"]+)"/g:selector==='[data-device]'?/<g class="cnl-device" data-device="([^"]+)"/g:/<g class="cnl-link" data-a="([^"]+)" data-b="([^"]+)"/g;
    const result=[...markup.matchAll(pattern)].map(m=>{const el=new Element();el.dataset[selector==='[data-node]'?'node':selector==='[data-device]'?'device':'a']=m[1];if(m[2])el.dataset.b=m[2];return el;});groups.set(selector,result);return result;
  };
  const preference={matches:options.reducedMotion===true,addEventListener:(_type,fn)=>preferenceListeners.add(fn),removeEventListener:(_type,fn)=>preferenceListeners.delete(fn)};
  const doc={hidden:false,createElementNS:()=>new Element(),addEventListener:(type,fn)=>visibility.set(type,fn),removeEventListener:type=>visibility.delete(type)};
  globalThis.document=doc;globalThis.ResizeObserver=class{observe(){}disconnect(){}};globalThis.requestAnimationFrame=()=>0;globalThis.cancelAnimationFrame=()=>{};globalThis.matchMedia=()=>preference;if(options.frames){globalThis.performance={now:()=>clock};globalThis.requestAnimationFrame=fn=>{const id=++sequence;pending.set(id,fn);return id;};globalThis.cancelAnimationFrame=id=>pending.delete(id);}
  const container={set innerHTML(v){markup=v;},querySelector:()=>svg};
  const scene=mountScene(container,callbacks);
  return {scene,svg,layers,groups,preferenceListeners,pending,doc,visibility,frame(){const callbacks=[...pending.values()];pending.clear();clock+=34;callbacks.forEach(fn=>fn(clock));},drain(){for(let i=0;i<1000&&pending.size;i++)this.frame();assert.equal(pending.size,0);},get markup(){return markup;},destroy(){scene.destroy();Object.assign(globalThis,previous);}};
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
