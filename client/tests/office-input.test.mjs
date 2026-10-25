import test from 'node:test';
import assert from 'node:assert/strict';
import {mountOfficeInput,officeInputIsEditing} from '../src/office-input.mjs';

function fixture(){
 const handlers=new Map(),frames=new Map(),steps=[],stops=[],actions=[];let id=0,time=0,enabled=true,blocked=false,focused=true,startAllowed=true;
 const node={addEventListener(type,fn,options){handlers.set(type,{fn,options});},removeEventListener(type){handlers.delete(type);}};
 const document={...node,hidden:false,activeElement:null,modal:false,hasFocus:()=>focused,querySelector(){return this.modal?{}:null;}};
 const window={addEventListener(type,fn,options){handlers.set('window:'+type,{fn,options});},removeEventListener(type){handlers.delete('window:'+type);}};
 const input=mountOfficeInput({document,window,isEnabled:()=>enabled,isBlocked:()=>blocked,onStart(){actions.push('start');return startAllowed;},onStep:(direction,dt)=>steps.push({direction,dt}),onStop:reason=>stops.push(reason.reason),onEscape:()=>{actions.push('escape');return true;},onHome:()=>{actions.push('home');return true;},requestFrame:fn=>{frames.set(++id,fn);return id;},cancelFrame:id=>frames.delete(id)});
 function emit(type,value={}){const event={key:'',target:null,prevented:false,stopped:false,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...value};handlers.get(type)?.fn(event);return event;}
 return{input,document,handlers,frames,steps,stops,actions,emit,frame(ms=16){time+=ms;const batch=[...frames.values()];frames.clear();for(const fn of batch)fn(time);},enable:v=>enabled=v,block:v=>blocked=v,focus:v=>focused=v,startAllowed:v=>startAllowed=v};
}
test('WASD and arrows share smooth screen-relative movement without relying on key-repeat',()=>{
 const f=fixture();assert.equal(f.handlers.get('keydown').options,true);
 const down=f.emit('keydown',{key:'w',code:'KeyW'});assert.equal(down.prevented,true);assert.equal(down.stopped,true);assert.equal(f.input.active,true);
 f.frame();f.frame();f.emit('keydown',{key:'d',code:'KeyD'});f.frame();assert.equal(f.actions.filter(x=>x==='start').length,1);assert.equal(f.steps[0].direction.y,-1);assert.equal(f.steps[0].direction.x,0);assert.ok(Math.abs(Math.hypot(f.steps[2].direction.x,f.steps[2].direction.y)-1)<1e-12);
 f.emit('keyup',{key:'w',code:'KeyW'});f.frame();assert.deepEqual(f.steps.at(-1).direction,{x:1,y:0});f.emit('keyup',{key:'d',code:'KeyD'});assert.equal(f.input.active,false);assert.deepEqual(f.stops,['release']);assert.equal(f.frames.size,0);
 f.emit('keydown',{key:'ArrowLeft'});f.frame();assert.deepEqual(f.steps.at(-1).direction,{x:-1,y:0});f.input.destroy();assert.equal(f.handlers.size,0);
});
test('typing, IME, shortcuts, native modals and unauthorized or unfocused maps never move',()=>{
 for(const context of['input','contenteditable','ime','shortcut','modal','blocked','disabled','blurred','hidden','activeEditor']){
  const f=fixture(),event={key:'a',code:'KeyA'};
  if(context==='input')event.target={closest:()=>({})};
  if(context==='contenteditable')event.target={isContentEditable:true};
  if(context==='ime')event.isComposing=true;if(context==='shortcut')event.metaKey=true;if(context==='modal')f.document.modal=true;
  if(context==='blocked')f.block(true);if(context==='disabled')f.enable(false);if(context==='blurred')f.focus(false);if(context==='hidden')f.document.hidden=true;
  if(context==='activeEditor')f.document.activeElement={isContentEditable:true};
  const result=f.emit('keydown',event);assert.equal(result.prevented,false,context);assert.equal(f.input.active,false,context);assert.equal(f.frames.size,0,context);assert.deepEqual(f.actions,[],context);f.input.destroy();
 }
 assert.equal(officeInputIsEditing({isContentEditable:true}),true);assert.equal(officeInputIsEditing(null),false);
});
test('lost focus, hidden tab, editor focus and modal opening release held keys once and never resume themselves',()=>{
 for(const reason of['blur','hidden','focus','modal','disabled']){
  const f=fixture();f.emit('keydown',{key:'ArrowUp'});f.frame();assert.equal(f.steps.length,1);
  if(reason==='blur')f.emit('window:blur');
  if(reason==='hidden'){f.document.hidden=true;f.emit('visibilitychange');}
  if(reason==='focus')f.emit('focusin',{target:{isContentEditable:true}});
  if(reason==='modal'){f.document.modal=true;f.frame();}
  if(reason==='disabled'){f.enable(false);f.frame();}
  assert.equal(f.stops.length,1,reason);f.frame();assert.equal(f.steps.length,1,reason);assert.equal(f.input.active,false);f.document.hidden=false;f.document.modal=false;f.enable(true);f.emit('visibilitychange');f.frame();assert.equal(f.steps.length,1);f.input.destroy();assert.equal(f.stops.length,1);
 }
});
test('Escape delegates a native modal, respects one layer, and Home never hijacks text editing',()=>{
 const f=fixture();f.document.modal=true;assert.equal(f.emit('keydown',{key:'Escape'}).prevented,false);assert.deepEqual(f.actions,[]);f.document.modal=false;
 assert.equal(f.emit('keydown',{key:'Escape'}).prevented,true);assert.deepEqual(f.actions,['escape']);
 assert.equal(f.emit('keydown',{key:'Escape',repeat:true}).prevented,true);assert.deepEqual(f.actions,['escape'],'holding Escape never exits a second layer');
 assert.equal(f.emit('keydown',{key:'Home',target:{isContentEditable:true}}).prevented,false);assert.equal(f.emit('keydown',{key:'Home'}).prevented,true);assert.deepEqual(f.actions,['escape','home']);
 f.input.destroy();
});
test('rejected startup and long-frame suspension cannot strand movement or create a giant step',()=>{
 const f=fixture();f.startAllowed(false);f.emit('keydown',{key:'w'});assert.equal(f.input.active,false);assert.equal(f.frames.size,0);f.startAllowed(true);f.emit('keydown',{key:'w'});f.frame();f.frame(5000);assert.equal(f.steps.at(-1).dt,50);f.emit('keydown',{key:'s'});f.frame();const count=f.steps.length;f.frame();assert.equal(f.steps.length,count,'opposing keys stop direction without losing held-key tracking');f.input.stop();assert.equal(f.input.active,false);f.input.destroy();
});
test('closing a modal or returning focus cannot restart an old held-key repeat until a fresh press',()=>{
 const f=fixture();f.emit('keydown',{key:'w',code:'KeyW'});f.frame();f.document.modal=true;f.frame();f.document.modal=false;
 const before=f.steps.length;f.emit('keydown',{key:'w',code:'KeyW',repeat:true});f.frame();assert.equal(f.input.active,false);assert.equal(f.steps.length,before);
 f.emit('keyup',{key:'w',code:'KeyW'});f.emit('keydown',{key:'w',code:'KeyW'});f.frame();assert.equal(f.input.active,true);assert.equal(f.steps.length,before+1);
 f.emit('window:blur');f.emit('keydown',{key:'w',code:'KeyW',repeat:false});f.frame();assert.equal(f.input.active,true,'a fresh physical press after the browser missed keyup works');f.input.destroy();
});
