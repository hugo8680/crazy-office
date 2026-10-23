// A room's automatic framing is a comfortable starting view, not the user's
// zoom limit. Both renderers and every input device share this policy.
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
