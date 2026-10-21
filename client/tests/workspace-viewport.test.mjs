import test from 'node:test';
import assert from 'node:assert/strict';
import {mountWorkspaceViewport} from '../src/workspace-viewport.mjs';

class Events{
  listeners=new Map();
  addEventListener(type,listener){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(listener);}
  removeEventListener(type,listener){this.listeners.get(type)?.delete(listener);}
  emit(type){for(const listener of this.listeners.get(type)||[])listener();}
  get size(){return [...this.listeners.values()].reduce((n,listeners)=>n+listeners.size,0);}
}
class InlineStyle{
  constructor(initial={}){this.values=new Map(Object.entries(initial).map(([name,value])=>[name,typeof value==='string'?{value,priority:''}:value]));this.writes=[];}
  getPropertyValue(name){return this.values.get(name)?.value||'';}
  getPropertyPriority(name){return this.values.get(name)?.priority||'';}
  setProperty(name,value,priority=''){this.values.set(name,{value,priority});this.writes.push({name,value,priority});}
  removeProperty(name){this.values.delete(name);this.writes.push({name,removed:true});}
  snapshot(){return Object.fromEntries(this.values);}
}
function fixture({viewport:metrics={offsetLeft:0,offsetTop:0,width:1440,height:900,scale:1},initial={},requestFrame=true,children=[],boundsTarget}={}){
  const viewport=metrics===null?null:Object.assign(new Events(),metrics),windowTarget=new Events(),style=new InlineStyle(initial),frames=new Map(),cancelled=[];
  let sequence=0;
  const options={viewport,windowTarget,boundsTarget,requestFrame:requestFrame?(fn=>{const id=sequence++;frames.set(id,fn);return id;}):undefined,cancelFrame:id=>{cancelled.push(id);frames.delete(id);}};
  const element={style,children},mounted=mountWorkspaceViewport(element,options);
  return {element,viewport,windowTarget,style,frames,cancelled,mounted,flush(){const queued=[...frames.values()];frames.clear();for(const fn of queued)fn();}};
}

// A simple CSS geometry interpreter: position children inside their containing
// block, apply the ancestor transform, then apply the browser's visible zoom.
// Assertions concern on-screen control bounds rather than the module's strings.
function screenBounds(style,viewport,child,{parentWidth=1440,parentHeight=900}={}){
  const length=(name,parent)=>{const value=style.getPropertyValue(name);return value.endsWith('%')?parseFloat(value)/100*parent:parseFloat(value)||0;};
  const width=length('width',parentWidth),height=length('height',parentHeight),scale=style.getPropertyValue('transform').match(/^scale\((.+)\)$/)?.[1]||1;
  const localWidth=Math.min(child.width,width-32),left=child.center?(width-localWidth)/2:width-child.right-localWidth,top=height-child.bottom-child.height;
  return {left:(length('left',parentWidth)+left*scale-viewport.offsetLeft)*viewport.scale,top:(length('top',parentHeight)+top*scale-viewport.offsetTop)*viewport.scale,width:localWidth*scale*viewport.scale,height:child.height*scale*viewport.scale};
}
function assertVisible(bounds,viewport){assert.ok(bounds.left>=0);assert.ok(bounds.top>=0);assert.ok(bounds.left+bounds.width<=viewport.width*viewport.scale+.001);assert.ok(bounds.top+bounds.height<=viewport.height*viewport.scale+.001);}

test('pinch and pan keep dock and its menu in screen bounds at their intended physical size',()=>{
  const f=fixture({viewport:{offsetLeft:320,offsetTop:120,width:720,height:450,scale:2}});
  try{
    assert.equal(f.frames.size,0,'initial position is synchronous');
    for(const metrics of [{offsetLeft:320,offsetTop:120,width:720,height:450,scale:2},{offsetLeft:550,offsetTop:200,width:480,height:300,scale:3},{offsetLeft:50,offsetTop:100,width:195,height:260,scale:2}]){
      Object.assign(f.viewport,metrics);f.viewport.emit('resize');f.viewport.emit('scroll');f.flush();
      const dock=screenBounds(f.style,f.viewport,{width:960,height:66,bottom:18,center:true}),menu=screenBounds(f.style,f.viewport,{width:244,height:240,bottom:98,right:22});
      assertVisible(dock,f.viewport);assertVisible(menu,f.viewport);
      assert.equal(dock.height,66);assert.equal(menu.height,240);
      assert.equal(Math.round(f.viewport.height*f.viewport.scale-dock.top-dock.height),18);
      assert.equal(f.frames.size,0,'no idle animation frame');
    }
  }finally{f.mounted.destroy();}
});

test('viewport compensation belongs to the container and never replaces a menu animation or business style',()=>{
  const menu={style:new InlineStyle({transform:'translateY(10px) scale(.98)'})},business={style:new InlineStyle({transform:'none',width:'70vw'})};
  const f=fixture({viewport:{offsetLeft:80,offsetTop:60,width:720,height:450,scale:2},children:[menu,business]});
  try{
    menu.style.setProperty('transform','translateY(0) scale(1)');
    f.viewport.offsetTop=90;f.viewport.emit('scroll');f.flush();
    assert.equal(menu.style.getPropertyValue('transform'),'translateY(0) scale(1)');
    assert.equal(business.style.getPropertyValue('transform'),'none');assert.equal(business.style.getPropertyValue('width'),'70vw');
    assert.equal(f.style.getPropertyValue('transform'),'scale(0.5)');
  }finally{f.mounted.destroy();}
});

test('resize and scroll updates coalesce once, avoid unchanged style writes and restore the normal parent frame',()=>{
  const f=fixture();
  try{
    assert.equal(f.style.getPropertyValue('width'),'1440px');assert.equal(f.style.getPropertyValue('height'),'900px');
    const writes=f.style.writes.length;
    f.viewport.emit('resize');f.viewport.emit('scroll');f.windowTarget.emit('resize');
    assert.equal(f.frames.size,1);f.flush();assert.equal(f.style.writes.length,writes);assert.equal(f.frames.size,0);
    Object.assign(f.viewport,{offsetLeft:100,offsetTop:50,width:720,height:450,scale:2});f.viewport.emit('scroll');f.flush();
    Object.assign(f.viewport,{offsetLeft:0,offsetTop:0,width:1440,height:900,scale:1});f.windowTarget.emit('resize');f.flush();
    const dock=screenBounds(f.style,f.viewport,{width:960,height:66,bottom:18,center:true});assertVisible(dock,f.viewport);assert.equal(dock.top,816);assert.equal(dock.width,960);
    assert.equal(f.style.getPropertyValue('width'),'1440px');assert.equal(f.style.getPropertyValue('height'),'900px');assert.equal(f.style.getPropertyValue('transform'),'scale(1)');
  }finally{f.mounted.destroy();}
});

test('invalid viewport dimensions cannot replace the last usable frame',()=>{
  const f=fixture({viewport:{offsetLeft:30,offsetTop:20,width:720,height:450,scale:2}});
  try{
    const before=f.style.snapshot(),valid={offsetLeft:30,offsetTop:20,width:720,height:450,scale:2};
    for(const bad of [{width:0},{height:-1},{scale:0},{scale:NaN},{scale:Infinity},{offsetLeft:NaN},{offsetTop:Infinity},{offsetLeft:-1},{width:'720'},{width:Number.MAX_VALUE,scale:2},{scale:Number.MIN_VALUE}]){
      Object.assign(f.viewport,valid,bad);f.viewport.emit('resize');f.flush();assert.deepEqual(f.style.snapshot(),before);
    }
  }finally{f.mounted.destroy();}
});

test('teardown cancels a queued frame, detaches listeners and restores exact prior inline values and priorities',()=>{
  const initial={left:'8px',top:'12px',width:{value:'87%',priority:'important'},height:'90%',transform:'translate(3px,7px)','transform-origin':'center',background:'#fffdf6'};
  const original=new InlineStyle(initial).snapshot(),f=fixture({initial});
  assert.equal(f.viewport.size,2);assert.equal(f.windowTarget.size,1);
  f.viewport.scale=2;f.viewport.emit('resize');assert.equal(f.frames.size,1);
  const late=[...f.frames.values()][0];f.mounted.destroy();
  assert.equal(f.viewport.size,0);assert.equal(f.windowTarget.size,0);assert.equal(f.frames.size,0);assert.deepEqual(f.cancelled,[0]);assert.deepEqual(f.style.snapshot(),original);
  const writes=f.style.writes.length;late();f.viewport.emit('scroll');f.windowTarget.emit('resize');f.mounted.destroy();assert.equal(f.style.writes.length,writes);assert.equal(f.frames.size,0);
});

test('a keyboard-sized visual viewport raises controls without resizing business content',()=>{
  const f=fixture();
  try{Object.assign(f.viewport,{width:390,height:420,scale:1});f.viewport.emit('resize');f.flush();const dock=screenBounds(f.style,f.viewport,{width:960,height:66,bottom:18,center:true});assertVisible(dock,f.viewport);assert.equal(dock.top,336);assert.equal(dock.height,66);assert.equal(f.style.getPropertyValue('height'),'420px');}finally{f.mounted.destroy();}
});

test('missing VisualViewport leaves the CSS fallback and unrelated inline styles untouched',()=>{
  const f=fixture({viewport:null,initial:{width:'100%',height:'100%',transform:'none',background:'#fffdf6'}}),before=f.style.snapshot();
  assert.equal(f.style.writes.length,0);assert.equal(f.windowTarget.size,0);assert.equal(f.frames.size,0);assert.doesNotThrow(()=>mountWorkspaceViewport({style:{}},{viewport:undefined}).destroy());
  f.windowTarget.emit('resize');f.mounted.destroy();assert.deepEqual(f.style.snapshot(),before);assert.equal(f.style.writes.length,0);
});

test('an environment without animation frames can update once without starting a timer loop',()=>{
  const f=fixture({requestFrame:false});
  try{Object.assign(f.viewport,{offsetLeft:10,offsetTop:20,width:720,height:450,scale:2});f.viewport.emit('resize');assert.equal(f.style.getPropertyValue('transform'),'scale(0.5)');assert.equal(f.frames.size,0);}finally{f.mounted.destroy();}
});

test('all surfaces share logical dimensions while native top-layer dialogs also receive visible bounds',()=>{
  const boundsTarget={style:new InlineStyle()},f=fixture({boundsTarget,viewport:{offsetLeft:310,offsetTop:120,width:720,height:450,scale:2}});
  try{
    assert.equal(f.style.getPropertyValue('width'),'1440px');
    assert.equal(boundsTarget.style.getPropertyValue('--workspace-visible-width'),'720px');
    assert.equal(boundsTarget.style.getPropertyValue('--workspace-visible-left'),'310px');
    assert.equal(boundsTarget.style.getPropertyValue('--workspace-visible-height'),'450px');assert.equal(boundsTarget.style.getPropertyValue('--workspace-logical-width'),'1440px');assert.equal(boundsTarget.style.getPropertyValue('--workspace-logical-height'),'900px');
    const writes=boundsTarget.style.writes.length;f.viewport.emit('resize');f.viewport.emit('scroll');f.flush();assert.equal(boundsTarget.style.writes.length,writes);
    Object.assign(f.viewport,{offsetLeft:420,offsetTop:180,width:480,height:300,scale:3});f.viewport.emit('resize');f.flush();
    assert.equal(boundsTarget.style.getPropertyValue('--workspace-visible-width'),'480px');
    assert.equal(boundsTarget.style.getPropertyValue('--workspace-visible-top'),'180px');
    assert.equal(f.style.getPropertyValue('width'),'1440px');
  }finally{f.mounted.destroy();}
});

test('business viewport bounds are restored with their prior priorities on teardown',()=>{
  const initial={'--workspace-visible-width':{value:'95vw',priority:'important'},color:'green'},style=new InlineStyle(initial),before=style.snapshot();
  const f=fixture({boundsTarget:{style},viewport:{offsetLeft:20,offsetTop:30,width:720,height:450,scale:2}});
  f.viewport.offsetTop=50;f.viewport.emit('scroll');const late=[...f.frames.values()][0];f.mounted.destroy();late();
  assert.deepEqual(style.snapshot(),before);
});


test('all sibling surfaces commit the same viewport in one frame and restore independently',()=>{
  const viewport=Object.assign(new Events(),{offsetLeft:0,offsetTop:0,width:1440,height:900,scale:1}),windowTarget=new Events(),frames=new Map();
  const surfaces=[new InlineStyle({width:'100%'}),new InlineStyle({height:'100%'}),new InlineStyle({transform:'none'})],originals=surfaces.map(style=>style.snapshot());
  const controller=mountWorkspaceViewport(surfaces.map(style=>({style})),{viewport,windowTarget,requestFrame:fn=>{frames.set(1,fn);return 1;},cancelFrame:id=>frames.delete(id)});
  assert.equal(viewport.size,2,'one listener per event, not one per layer');
  Object.assign(viewport,{offsetLeft:250,offsetTop:100,width:720,height:450,scale:2});
  for(let n=0;n<12;n++){viewport.emit('resize');viewport.emit('scroll');windowTarget.emit('resize');}
  assert.equal(frames.size,1);frames.get(1)();frames.clear();
  for(const style of surfaces){assert.equal(style.getPropertyValue('width'),'1440px');assert.equal(style.getPropertyValue('height'),'900px');assert.equal(style.getPropertyValue('left'),'250px');assert.equal(style.getPropertyValue('transform'),'scale(0.5)');}
  controller.destroy();surfaces.forEach((style,index)=>assert.deepEqual(style.snapshot(),originals[index]));assert.equal(viewport.size,0);assert.equal(windowTarget.size,0);
});

test('fractional pinch measurements cannot repeatedly resize logical rendering surfaces',()=>{
  const f=fixture();
  try{
    const initial=f.style.writes.filter(item=>['width','height'].includes(item.name)).length;
    for(const scale of [1.2,1.5,2,2.25,2.75,3]){
      Object.assign(f.viewport,{width:(1440+.00003)/scale,height:(900-.00002)/scale,scale});f.viewport.emit('resize');f.flush();
      assert.equal(f.style.getPropertyValue('width'),'1440px');assert.equal(f.style.getPropertyValue('height'),'900px');
    }
    assert.equal(f.style.writes.filter(item=>['width','height'].includes(item.name)).length,initial,'pinch changes the camera scale, not the logical buffer dimensions');
    assert.equal(f.frames.size,0);
  }finally{f.mounted.destroy();}
});
