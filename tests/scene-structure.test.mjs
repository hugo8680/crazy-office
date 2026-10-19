import test from 'node:test';
import assert from 'node:assert/strict';
import { mountScene, NODE_META } from '../dist/scene.js';
import { HUMAN_EMPLOYEES } from '../dist/people.js';

// A minimal SVG DOM records public scene interactions without a browser, model,
// or production-only testing controls.
function sceneFixture(callbacks={}) {
  const previous={document:globalThis.document,ResizeObserver:globalThis.ResizeObserver,requestAnimationFrame:globalThis.requestAnimationFrame,cancelAnimationFrame:globalThis.cancelAnimationFrame,matchMedia:globalThis.matchMedia};
  let markup='';const layers=new Map(),groups=new Map(),preferenceListeners=new Set();
  class Element {
    constructor(){this.attrs={};this.dataset={};this.children=[];this.innerHTML='';this.classes=new Set();this.listeners=new Map();this.props={};this.style={setProperty:(k,v)=>this.props[k]=v};this.classList={add:(...xs)=>xs.forEach(x=>this.classes.add(x)),remove:(...xs)=>xs.forEach(x=>this.classes.delete(x)),toggle:(x,on)=>{if(on??!this.classes.has(x))this.classes.add(x);else this.classes.delete(x);},contains:x=>this.classes.has(x)};}
    setAttribute(k,v){this.attrs[k]=v;}addEventListener(k,fn){this.listeners.set(k,fn);}removeEventListener(k){this.listeners.delete(k);}append(el){this.children.push(el);}querySelector(){return new Element();}
  }
  const svg=new Element();
  svg.querySelector=selector=>{if(selector.startsWith('#')){const id=selector.slice(1),match=markup.match(new RegExp(`<symbol id="${id}"[^>]*>([\\s\\S]*?)<\\/symbol>`));return {innerHTML:match?.[1]||''};}if(!layers.has(selector))layers.set(selector,new Element());return layers.get(selector);};
  svg.querySelectorAll=selector=>{
    if(groups.has(selector))return groups.get(selector);
    const pattern=selector==='[data-node]'?/<g class="cnl-node" data-node="([^"]+)"/g:selector==='[data-device]'?/<g class="cnl-device" data-device="([^"]+)"/g:/<g class="cnl-link" data-a="([^"]+)" data-b="([^"]+)"/g;
    const result=[...markup.matchAll(pattern)].map(m=>{const el=new Element();el.dataset[selector==='[data-node]'?'node':selector==='[data-device]'?'device':'a']=m[1];if(m[2])el.dataset.b=m[2];return el;});groups.set(selector,result);return result;
  };
  const preference={matches:false,addEventListener:(_type,fn)=>preferenceListeners.add(fn),removeEventListener:(_type,fn)=>preferenceListeners.delete(fn)};
  globalThis.document={createElementNS:()=>new Element()};globalThis.ResizeObserver=class{observe(){}disconnect(){}};globalThis.requestAnimationFrame=()=>0;globalThis.cancelAnimationFrame=()=>{};globalThis.matchMedia=()=>preference;
  const container={set innerHTML(v){markup=v;},querySelector:()=>svg};
  const scene=mountScene(container,callbacks);
  return {scene,layers,groups,preferenceListeners,get markup(){return markup;},destroy(){scene.destroy();Object.assign(globalThis,previous);}};
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
