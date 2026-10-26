import test from 'node:test';
import assert from 'node:assert/strict';
import {createOfficeSVGVariants} from '../src/office-svg-variants.mjs';

function fixture(){
 let parses=0;
 class Element{
  constructor(){this.childNodes=[];}
  set innerHTML(markup){parses++;this.childNodes=[{markup,parentNode:this}];}
  replaceChildren(...nodes){for(const node of this.childNodes)node.parentNode=null;this.childNodes=[];for(const node of nodes){if(node.parentNode)node.parentNode.childNodes=node.parentNode.childNodes.filter(other=>other!==node);node.parentNode=this;this.childNodes.push(node);}}
 }
 return {document:{createElementNS:()=>new Element()},element:new Element(),get parses(){return parses;}};
}

test('workplace variants retain parsed nodes and atomically replace the previous scale',()=>{
 const f=fixture(),cache=createOfficeSVGVariants(f.document),render=value=>()=>value;
 cache.show(f.element,'overview',render('large representative'));const overview=f.element.childNodes[0];
 cache.prime(f.element,'detail',render('compact complete'));assert.equal(f.element.childNodes[0],overview,'idle prewarming does not change the live desk');
 cache.show(f.element,'detail',render('must not parse'));const detail=f.element.childNodes[0];assert.equal(overview.parentNode,null);assert.equal(f.element.childNodes.length,1);assert.equal(detail.markup,'compact complete');
 for(let i=0;i<10;i++){cache.show(f.element,'overview',render('must not parse'));assert.equal(f.element.childNodes[0],overview);assert.equal(detail.parentNode,null);cache.show(f.element,'detail',render('must not parse'));assert.equal(f.element.childNodes[0],detail);assert.equal(overview.parentNode,null);}
 assert.equal(f.parses,2,'repeated zoom changes reuse the exact nodes without SVG parsing');assert.equal(cache.show(f.element,'detail',render('must not parse')),false);
});

test('cache is bounded through wardrobe updates and reparses evicted geometry safely',()=>{
 const f=fixture(),cache=createOfficeSVGVariants(f.document);let built=0;const render=()=>String(++built);
 cache.show(f.element,'old-overview',render);const old=f.element.childNodes[0];cache.show(f.element,'old-detail',render);cache.show(f.element,'new-overview',render);cache.show(f.element,'new-detail',render);
 assert.equal(f.element.childNodes.length,1);assert.equal(old.parentNode,null);cache.show(f.element,'old-overview',render);assert.equal(built,5,'the previous appearance was evicted rather than retained indefinitely');cache.clear();cache.show(f.element,'old-overview',render);assert.equal(built,6);
});
