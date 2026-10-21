import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const css=await readFile(new URL('../src/session-ui.css',import.meta.url),'utf8');
const declarations=body=>Object.fromEntries(body.split(';').filter(Boolean).map(item=>{const index=item.indexOf(':');return[item.slice(0,index).trim(),item.slice(index+1).trim()];}));
const base=declarations(css.match(/^\.session-dialog\{([^}]+)\}/m)[1]);
const mobile=declarations(css.match(/@media\(max-width:520px\)\{\.session-dialog\{([^}]+)\}/)[1]);

// Resolve the actual native-dialog CSS frame against a panned/pinched visual
// viewport. The geometry is independent of the stage's inverse transform and
// does not infer visibility from a string containing the expected variable.
function length(value,layout,visible){
  const expression=value.replace(/var\(--workspace-visible-(left|top|width|height),([^)]*)\)/g,(_all,key,fallback)=>visible?String(visible[key]):fallback)
    .replace(/100vw/g,String(layout.width)).replace(/100dvh/g,String(layout.height)).replace(/(-?[\d.]+)px/g,'$1')
    .replace(/calc\(/g,'(').replace(/min\(/g,'Math.min(');
  assert.match(expression.replace(/Math\.min/g,''),/^[\d\s.,+*/()\-]+$/);
  return Function(`return (${expression});`)();
}
function frame(layout,visible,contentHeight=700){
  const rules={...base,...(layout.width<=520?mobile:{})},viewport=visible||{left:0,top:0,width:layout.width,height:layout.height,scale:1};
  const width=length(rules.width,layout,visible),height=Math.min(contentHeight,length(rules['max-height'],layout,visible));
  const centerX=length(rules.left,layout,visible),centerY=length(rules.top,layout,visible);
  return{width:width*viewport.scale,height:height*viewport.scale,left:(centerX-width/2-viewport.left)*viewport.scale,top:(centerY-height/2-viewport.top)*viewport.scale,availableWidth:viewport.width*viewport.scale,availableHeight:viewport.height*viewport.scale};
}
function contained(bounds){
  assert.ok(bounds.width>0&&bounds.height>0);assert.ok(bounds.left>=0&&bounds.top>=0);
  assert.ok(bounds.left+bounds.width<=bounds.availableWidth+.001);assert.ok(bounds.top+bounds.height<=bounds.availableHeight+.001);
}

test('native account windows stay wholly inside a panned visual viewport at scale 1, 2 and 3',()=>{
  const layout={width:1440,height:900};
  for(const visible of [{left:0,top:0,width:1440,height:900,scale:1},{left:320,top:120,width:720,height:450,scale:2},{left:450,top:200,width:480,height:300,scale:3}]){
    const bounds=frame(layout,visible);contained(bounds);
    assert.equal(bounds.left,(bounds.availableWidth-bounds.width)/2);assert.equal(bounds.top,(bounds.availableHeight-bounds.height)/2);
  }
});

test('small-screen and keyboard viewports keep scrollable account windows within their current visible bounds',()=>{
  for(const [layout,visible] of [[{width:390,height:844},{left:0,top:180,width:390,height:300,scale:1}],[{width:390,height:844},{left:90,top:120,width:195,height:300,scale:2}],[{width:844,height:390},{left:0,top:0,width:844,height:390,scale:1}]])contained(frame(layout,visible));
  assert.equal(base.overflow,'auto');assert.equal(base.position,'fixed');assert.equal(base.margin,'0');assert.equal(base.translate,'-50% -50%');
  assert.equal(base.transform,undefined,'viewport positioning must not overwrite entrance/exit transforms');
});

test('missing VisualViewport retains normal centering and page zoom does not alter form typography',()=>{
  const desktop=frame({width:1440,height:900});contained(desktop);assert.equal(desktop.width,480);assert.equal(desktop.left,480);
  const phone=frame({width:390,height:844});contained(phone);assert.equal(phone.width,366);assert.equal(phone.left,12);
  assert.doesNotMatch(base.transform||'',/scale/);assert.match(css,/\.session-form input\{[^}]*font-size:16px/);
});
