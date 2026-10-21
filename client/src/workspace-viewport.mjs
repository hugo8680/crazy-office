const OWNED_PROPERTIES=['left','top','width','height','transform','transform-origin'];

/** Keep office controls in the visible viewport without scaling business content. */
export function mountWorkspaceViewport(element,{
  viewport=globalThis.visualViewport,
  windowTarget=globalThis.window,
  requestFrame=globalThis.requestAnimationFrame,
  cancelFrame=globalThis.cancelAnimationFrame
}={}){
  if(!element?.style||!viewport)return {destroy(){}};
  const style=element.style;
  const original=new Map(OWNED_PROPERTIES.map(name=>[name,{value:style.getPropertyValue(name),priority:style.getPropertyPriority(name)}]));
  const written=new Map(),touched=new Set();
  let destroyed=false,pending=null;

  function update(){
    if(destroyed)return;
    const {offsetLeft:left,offsetTop:top,width,height,scale}=viewport;
    if(![left,top,width,height,scale].every(value=>typeof value==='number'&&Number.isFinite(value))||left<0||top<0||width<=0||height<=0||scale<=0)return;
    const scaledWidth=width*scale,scaledHeight=height*scale,inverse=1/scale;
    if(![scaledWidth,scaledHeight,inverse].every(value=>Number.isFinite(value)&&value>0))return;
    const next={left:`${left}px`,top:`${top}px`,width:`${scaledWidth}px`,height:`${scaledHeight}px`,transform:`scale(${inverse})`,'transform-origin':'0 0'};
    for(const name of OWNED_PROPERTIES){
      const value=next[name];
      if(written.get(name)===value)continue;
      written.set(name,value);
      if(style.getPropertyValue(name)===value&&!style.getPropertyPriority(name))continue;
      touched.add(name);
      style.setProperty(name,value);
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
    for(const name of touched){
      const saved=original.get(name);
      if(saved.value)style.setProperty(name,saved.value,saved.priority);
      else style.removeProperty(name);
    }
    touched.clear();written.clear();
  }};
}
