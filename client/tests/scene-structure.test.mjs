import test from 'node:test';
import assert from 'node:assert/strict';
import { mountScene, NODE_META } from '../src/scene.js';
import { HUMAN_EMPLOYEES } from '../src/people.js';

// A minimal SVG DOM records public scene interactions without a browser, model,
// or production-only testing controls.
function sceneFixture(callbacks={},options={}) {
  const previous={document:globalThis.document,ResizeObserver:globalThis.ResizeObserver,requestAnimationFrame:globalThis.requestAnimationFrame,cancelAnimationFrame:globalThis.cancelAnimationFrame,matchMedia:globalThis.matchMedia,performance:globalThis.performance};
  let markup='',clock=1000,sequence=0;const layers=new Map(),groups=new Map(),preferenceListeners=new Set(),pending=new Map();
  class Element {
    constructor(){this.attrs={};this.dataset={};this.children=[];this.innerHTML='';this.classes=new Set();this.listeners=new Map();this.props={};this.animations=[];this.style={setProperty:(k,v)=>this.props[k]=v};this.classList={add:(...xs)=>xs.forEach(x=>this.classes.add(x)),remove:(...xs)=>xs.forEach(x=>this.classes.delete(x)),toggle:(x,on)=>{if(on??!this.classes.has(x))this.classes.add(x);else this.classes.delete(x);},contains:x=>this.classes.has(x)};}
    animate(frames,settings){const animation={frames,settings,cancel(){this.cancelled=true;}};this.animations.push(animation);return animation;}setAttribute(k,v){this.attrs[k]=v;}addEventListener(k,fn){this.listeners.set(k,fn);}removeEventListener(k){this.listeners.delete(k);}append(el){this.children.push(el);}querySelector(){return new Element();}
  }
  const svg=new Element();
  svg.querySelector=selector=>{if(selector.startsWith('#')){const id=selector.slice(1),match=markup.match(new RegExp(`<symbol id="${id}"[^>]*>([\\s\\S]*?)<\\/symbol>`));return {innerHTML:match?.[1]||''};}if(!layers.has(selector))layers.set(selector,new Element());return layers.get(selector);};
  svg.querySelectorAll=selector=>{
    if(groups.has(selector))return groups.get(selector);
    const pattern=selector==='[data-node]'?/<g class="cnl-node" data-node="([^"]+)"/g:selector==='[data-device]'?/<g class="cnl-device" data-device="([^"]+)"/g:/<g class="cnl-link" data-a="([^"]+)" data-b="([^"]+)"/g;
    const result=[...markup.matchAll(pattern)].map(m=>{const el=new Element();el.dataset[selector==='[data-node]'?'node':selector==='[data-device]'?'device':'a']=m[1];if(m[2])el.dataset.b=m[2];return el;});groups.set(selector,result);return result;
  };
  const preference={matches:false,addEventListener:(_type,fn)=>preferenceListeners.add(fn),removeEventListener:(_type,fn)=>preferenceListeners.delete(fn)};
  globalThis.document={createElementNS:()=>new Element()};globalThis.ResizeObserver=class{observe(){}disconnect(){}};globalThis.requestAnimationFrame=()=>0;globalThis.cancelAnimationFrame=()=>{};globalThis.matchMedia=()=>preference;if(options.frames){globalThis.performance={now:()=>clock};globalThis.requestAnimationFrame=fn=>{const id=++sequence;pending.set(id,fn);return id;};globalThis.cancelAnimationFrame=id=>pending.delete(id);}
  const container={set innerHTML(v){markup=v;},querySelector:()=>svg};
  const scene=mountScene(container,callbacks);
  return {scene,svg,layers,groups,preferenceListeners,pending,frame(){const callbacks=[...pending.values()];pending.clear();clock+=34;callbacks.forEach(fn=>fn(clock));},drain(){for(let i=0;i<1000&&pending.size;i++)this.frame();assert.equal(pending.size,0);},get markup(){return markup;},destroy(){scene.destroy();Object.assign(globalThis,previous);}};
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
