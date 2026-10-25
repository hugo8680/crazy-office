// A room's automatic framing is a comfortable starting view, not the user's
// zoom limit. Both renderers and every input device share this policy.
export const OFFICE_DEPARTMENT_CAMERA_POLICY=Object.freeze({enterScale:1.12,exitRatio:.72});
export const OFFICE_CAMERA_LIMITS=Object.freeze({minScale:.72,maxManualScale:32,maxAutomaticScale:18});

export function clampOfficeScale(value,{automatic=false,fallback=1}={}){
  const number=Number(value),safe=Number.isFinite(number)?number:Number.isFinite(Number(fallback))?Number(fallback):1;
  return Math.max(OFFICE_CAMERA_LIMITS.minScale,Math.min(automatic?OFFICE_CAMERA_LIMITS.maxAutomaticScale:OFFICE_CAMERA_LIMITS.maxManualScale,safe));
}

export function officeWheelScale(scale,deltaY,deltaMode=0,height=900){
  const current=clampOfficeScale(scale),delta=Number(deltaY);if(!Number.isFinite(delta)||delta===0)return current;
  const page=Number.isFinite(Number(height))&&Number(height)>0?Number(height):900;
  const amount=delta*(deltaMode===1?16:deltaMode===2?page:1),bounded=Math.max(-180,Math.min(180,amount));
  return clampOfficeScale(current*Math.exp(-bounded*.0016));
}

export function officePinchScale(scale,ratio){
  const current=clampOfficeScale(scale),factor=Number(ratio);if(!Number.isFinite(factor)||factor<=0)return current;
  return clampOfficeScale(current*factor);
}

export function officeCameraChanged(previous,next,epsilon=1e-7){
  return Object.keys(next||{}).some(key=>Number.isFinite(next[key])&&(!Number.isFinite(previous?.[key])||Math.abs(next[key]-previous[key])>epsilon));
}

// Browsers expose trackpad pinch as ctrl+wheel and two-finger scrolling as
// pixel deltas. Preserve a smooth scroll sequence's classification: momentum
// can produce large integral deltas halfway through the same gesture.
export function createOfficeWheelInput({now=()=>performance.now()}={}){
  let previous=-Infinity,sequence=null;
  return event=>{
    const unit=event.deltaMode===1?16:event.deltaMode===2?(Number(event.height)||900):1;
    const dx=Number(event.deltaX)||0,dy=Number(event.deltaY)||0,stamp=now();
    const continued=stamp-previous<180;previous=stamp;
    if(event.ctrlKey||event.metaKey){sequence=null;return {kind:'zoom',dx:dx*unit,dy:dy*unit,pinch:true};}
    const smooth=event.deltaMode===0&&(dx!==0||Math.abs(dy)<40||!Number.isInteger(dy));
    const kind=dx!==0?'pan':continued&&sequence?sequence:smooth?'pan':'zoom';sequence=kind;
    return {kind,dx:dx*unit,dy:dy*unit,pinch:false};
  };
}

export function officeScreenDirection(dx,dy,{right={x:1,y:0},up={x:0,y:-1}}={}){
  const x=Number(dx)||0,y=Number(dy)||0;
  const point={x:right.x*x-up.x*y,y:right.y*x-up.y*y},length=Math.hypot(point.x,point.y);
  return length?{x:point.x/length,y:point.y/length}:{x:0,y:0};
}
