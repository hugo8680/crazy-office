import {OFFICE_ROOMS,OFFICE_SHARED_AREAS,OFFICE_BULLETIN_AREA,OFFICE_CONVENIENCE_AREA,OFFICE_RECREATION_AREA,OFFICE_DATA_CENTER,canonicalDepartmentId} from './organization.mjs';
import {presencePosition} from './erp-presence.js';

const contains=(area,point)=>point&&Number.isFinite(point.x)&&Number.isFinite(point.y)&&point.x>=area.x&&point.x<=area.x+area.w&&point.y>=area.y&&point.y<=area.y+area.h;
const teams=OFFICE_ROOMS.flatMap(room=>room.teamZones.map(team=>({...team,nodeId:room.id})));
const shared=[OFFICE_BULLETIN_AREA,OFFICE_CONVENIENCE_AREA,OFFICE_RECREATION_AREA,OFFICE_DATA_CENTER,...OFFICE_SHARED_AREAS];
export function officeArea(id){
 const key=id==='courtyard'?'shared_lounge':id;
 return teams.find(area=>area.id===key)||shared.find(area=>area.id===key)||OFFICE_ROOMS.find(area=>area.id===(canonicalDepartmentId(key)||key))||null;
}
export function officeAreaAt(point){return shared.find(area=>contains(area,point))||teams.find(area=>contains(area,point))||OFFICE_ROOMS.find(area=>contains(area,point))||officeArea('shared_lounge');}
const validPoint=point=>Number.isFinite(point?.x)&&Number.isFinite(point?.y)&&point.x>=-155&&point.x<=1370&&point.y>=20&&point.y<=1080;
const near=(a,b)=>validPoint(a)&&validPoint(b)&&Math.hypot(a.x-b.x,a.y-b.y)<1;

// A move request reserves a destination; only the rendered walk can announce
// arrival. Manual camera work cancels framing, never fabricates a walking step.
const departmentAt=point=>OFFICE_ROOMS.find(room=>contains(room,point))||null;
const inside=(room,p)=>contains(room,p)&&p.x>room.x+.001&&p.x<room.x+room.w-.001&&p.y>room.y+.001&&p.y<room.y+room.h-.001;
function enteredDoor(room,from,to){
 if(!validPoint(from)||!inside(room,to)||inside(room,from))return false;
 const door=room.door,vertical=door.side==='left'||door.side==='right',axis=vertical?'x':'y',cross=vertical?'y':'x',delta=to[axis]-from[axis];
 if(Math.abs(delta)<.0001)return false;
 const t=(door[axis]-from[axis])/delta;if(t<-.001||t>1.001)return false;
 return Math.abs(from[cross]+(to[cross]-from[cross])*t-door[cross])<=door.width/2+.5;
}
export function createOfficeNavigation({scene,getPresence=()=>null,requireAccount=()=>false,isBlocked=()=>false}={}){
 let revision=0,currentArea=null,pending=null,walkIntent=null,destroyed=false,lastObserved=null;
 const focus=id=>id?(typeof scene.focusArea==='function'?scene.focusArea(id):scene.focusNode?.(id)):scene.resetView();
 function cancelAutoFocus(){const cancelled=!!walkIntent;walkIntent=null;return cancelled;}
 function restore(){if(destroyed||isBlocked())return false;if(walkIntent?.step&&evaluateStep(walkIntent,walkIntent.step))return true;focus(currentArea);return true;}
 function setContext(id){
  if(destroyed)return false;
  const next=id===null?null:officeArea(id)?.id;if(next===undefined)return false;
  if(next===currentArea)return true;
  ++revision;pending=null;cancelAutoFocus();currentArea=next;return true;
 }
 function evaluateStep(intent,step){
  if(!intent||walkIntent!==intent||!intent.accepted||revision!==intent.ticket||getPresence()!==intent.presence||isBlocked())return false;
  const at=pointCopy(step.point),previous=intent.lastPoint;intent.lastPoint=at;
  const crossed=step.walking===true&&enteredDoor(intent.room,previous,at);
  if(!crossed&&!(step.arrived===true&&near(at,intent.destination)))return false;
  walkIntent=null;currentArea=intent.room.id;focus(currentArea);return true;
 }
 const pointCopy=p=>({x:p.x,y:p.y});
 function observePresence(step={}){
  const presence=getPresence(),me=presence?.self,person=step.person;
  if(destroyed||!me||person?.id!==me.id||!validPoint(step.point))return false;
  const at=pointCopy(step.point);lastObserved={presence,id:me.id,point:at};
  const intent=walkIntent;if(!intent||intent.presence!==presence)return false;
  // A heartbeat or the last frame of an old walk cannot complete a new click.
  const target=person.point||(validPoint(person)?person:null);
  if(target&&!near(target,intent.destination))return false;
  if(step.walking!==true&&step.arrived!==true)return false;
  intent.step={...step,point:at};return evaluateStep(intent,intent.step);
 }
 function enterArea(id,{point,frame=true}={}){
  const area=officeArea(id);if(destroyed||!area||isBlocked()||!requireAccount())return Promise.resolve(false);
  const presence=getPresence();if(!presence)return Promise.resolve(false);
  const destination=point?validPoint(point)?pointCopy(point):null:area.nodeId?{x:area.x+area.w/2,y:area.y+area.h-4}:presencePosition(area.id);
  if(!destination)return Promise.resolve(false);
  const key=area.id+':'+destination.x+':'+destination.y;
  if(pending?.key===key&&pending.presence===presence)return pending.promise;
  const hadPending=!!pending,ticket=++revision,room=departmentAt(destination);
  const drawn=lastObserved?.presence===presence&&lastObserved.id===presence.self?.id?lastObserved.point:scene.getPresenceState?.()?.positions?.[presence.self?.id]||presence.self;
  cancelAutoFocus();
  const intent=frame&&room&&room.id!==currentArea?{key,ticket,presence,room,destination,lastPoint:validPoint(drawn)?pointCopy(drawn):null,accepted:false,step:null}:null;
  walkIntent=intent;
  const current=()=>!destroyed&&revision===ticket&&getPresence()===presence&&!isBlocked();
  const promise=(async()=>{
   await presence.ready;if(!current())return false;
   if(!hadPending&&near(presence.self,destination)){if(walkIntent===intent)cancelAutoFocus();return true;}
   const accepted=await presence.movePoint(destination,{shouldRun:current});
   if(!current())return false;
   if(!accepted){if(walkIntent===intent)cancelAutoFocus();return false;}
   if(walkIntent===intent&&intent){intent.accepted=true;if(intent.step)evaluateStep(intent,intent.step);}return true;
  })().finally(()=>{if(pending?.ticket===ticket)pending=null;});
  pending={key,presence,ticket,promise};return promise;
 }
 return{enterArea,setContext,observePresence,cancelAutoFocus,
  movePoint(point){if(!validPoint(point))return Promise.resolve(false);const room=departmentAt(point),id=room?.id||officeAreaAt(point)?.id;return enterArea(id,{point,frame:!!room&&room.id!==currentArea});},
  locateSelf(){const presence=getPresence(),me=presence?.self;if(destroyed||!me||isBlocked())return false;++revision;pending=null;cancelAutoFocus();currentArea=(validPoint(me)?departmentAt(me):OFFICE_ROOMS.find(room=>room.id===canonicalDepartmentId(me.nodeId||me.department)))?.id||null;return restore();},
  restore,
  home(){if(destroyed)return;++revision;pending=null;cancelAutoFocus();currentArea=null;focus(null);},
  reset(){++revision;pending=null;cancelAutoFocus();lastObserved=null;currentArea=null;},
  get areaId(){return currentArea;},
  destroy(){destroyed=true;++revision;pending=null;cancelAutoFocus();lastObserved=null;currentArea=null;},
 };
}
