const FRAME_PROPERTIES=['left','top','width','height','transform','transform-origin'];
const BOUNDS_PROPERTIES=['--workspace-visible-left','--workspace-visible-top','--workspace-visible-width','--workspace-visible-height','--workspace-inverse-scale','--workspace-logical-width','--workspace-logical-height'];

function ownedStyle(style,names){
  const original=new Map(names.map(name=>[name,{value:style.getPropertyValue(name),priority:style.getPropertyPriority(name)}]));
  const written=new Map(),touched=new Set();
  return {
    set(name,value){
      if(written.get(name)===value)return;
      written.set(name,value);
      if(style.getPropertyValue(name)===value&&!style.getPropertyPriority(name))return;
      touched.add(name);style.setProperty(name,value);
    },
    restore(){
      for(const name of touched){const saved=original.get(name);if(saved.value)style.setProperty(name,saved.value,saved.priority);else style.removeProperty(name);}
      touched.clear();written.clear();
    }
  };
}

/** One viewport transaction keeps the scene, business windows and controls aligned. */
export function mountWorkspaceViewport(elements,{
  viewport=globalThis.visualViewport,
  boundsTarget,
  windowTarget=globalThis.window,
  requestFrame=globalThis.requestAnimationFrame,
  cancelFrame=globalThis.cancelAnimationFrame
}={}){
  const frames=[...new Set((Array.isArray(elements)?elements:[elements]).filter(element=>element?.style))];
  if(!frames.length||!viewport)return {destroy(){}};
  const styles=frames.map(element=>ownedStyle(element.style,FRAME_PROPERTIES));
  const bounds=boundsTarget?.style?ownedStyle(boundsTarget.style,BOUNDS_PROPERTIES):null;
  let destroyed=false,pending=null;
  function update(){
    if(destroyed)return;
    const {offsetLeft:left,offsetTop:top,width,height,scale}=viewport;
    if(![left,top,width,height,scale].every(value=>typeof value==='number'&&Number.isFinite(value))||left<0||top<0||width<=0||height<=0||scale<=0)return;
    // Pinch reports fractional dimensions. Whole CSS pixels prevent microscopic
    // rounding differences from repeatedly reallocating a WebGL drawing buffer.
    const logicalWidth=Math.round(width*scale),logicalHeight=Math.round(height*scale),inverse=1/scale;
    if(![logicalWidth,logicalHeight,inverse].every(value=>Number.isFinite(value)&&value>0))return;
    const values=[`${left}px`,`${top}px`,`${logicalWidth}px`,`${logicalHeight}px`,`scale(${inverse})`,'0 0'];
    for(const style of styles)for(const [index,name] of FRAME_PROPERTIES.entries())style.set(name,values[index]);
    if(bounds){
      const values=[`${left}px`,`${top}px`,`${width}px`,`${height}px`,String(inverse),`${logicalWidth}px`,`${logicalHeight}px`];
      for(const [index,name] of BOUNDS_PROPERTIES.entries())bounds.set(name,values[index]);
    }
  }
  function schedule(){
    if(destroyed||pending!==null)return;
    if(typeof requestFrame!=='function'){update();return;}
    pending=requestFrame(()=>{pending=null;update();});
  }
  update();
  viewport.addEventListener?.('resize',schedule);
  viewport.addEventListener?.('scroll',schedule);
  windowTarget?.addEventListener?.('resize',schedule);
  return {destroy(){
    if(destroyed)return;
    destroyed=true;
    viewport.removeEventListener?.('resize',schedule);
    viewport.removeEventListener?.('scroll',schedule);
    windowTarget?.removeEventListener?.('resize',schedule);
    if(pending!==null&&typeof cancelFrame==='function')cancelFrame(pending);
    pending=null;
    for(const style of styles)style.restore();
    bounds?.restore();
  }};
}
