import {OFFICE_ROOMS,OFFICE_SHARED_AREAS,OFFICE_BULLETIN_AREA,OFFICE_CONVENIENCE_AREA,OFFICE_RECREATION_AREA,OFFICE_DATA_CENTER,canonicalDepartmentId} from './organization.mjs';
import {presencePosition} from './erp-presence.js';
import {resolveFloorDestination} from './scene-motion.js';
import {officeWalkingStep} from './office-walking.mjs';

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
 let revision=0,currentArea=null,pending=null,walkIntent=null,destinationIntent=null,destroyed=false,lastObserved=null,keyboard=null,localOverride=null,localGeneration=0;
 const focus=id=>id?(typeof scene.focusArea==='function'?scene.focusArea(id):scene.focusNode?.(id)):scene.resetView();
 const pointCopy=p=>({x:p.x,y:p.y});
 const drawnPoint=presence=>lastObserved?.presence===presence&&lastObserved.id===presence?.self?.id?lastObserved.point:scene.getPresenceState?.()?.positions?.[presence?.self?.id]||presence?.self;
 function clearDestination(){destinationIntent=null;scene.setNavigationTarget?.(null);}
 function clearOverride(owner=localOverride){if(owner&&owner===localOverride){scene.clearLocalPresencePoint?.(owner.id);localOverride=null;}}
 function cancelAutoFocus(){const cancelled=!!walkIntent;walkIntent=null;return cancelled;}
 // Closing a panel restores interaction. The camera never left the office;
 // fitting it again here would throw away the person's pan/zoom/rotation.
 function restore(){if(destroyed||isBlocked())return false;if(walkIntent?.step)evaluateStep(walkIntent,walkIntent.step);return true;}
 function setContext(id){
  if(destroyed)return false;
  const next=id===null?null:officeArea(id)?.id;if(next===undefined)return false;
  if(next===currentArea)return true;
  cancelAutoFocus();currentArea=next;return true;
 }
 function evaluateStep(intent,step){
  if(!intent||walkIntent!==intent||!intent.accepted||revision!==intent.ticket||getPresence()!==intent.presence||isBlocked())return false;
  const at=pointCopy(step.point),previous=intent.lastPoint;intent.lastPoint=at;
  const crossed=step.walking===true&&enteredDoor(intent.room,previous,at);
  if(!crossed&&!(step.arrived===true&&near(at,intent.destination)))return false;
  walkIntent=null;currentArea=intent.room.id;focus(currentArea);return true;
 }
 function observePresence(step={}){
  const presence=getPresence(),me=presence?.self,person=step.person;
  if(destroyed||!me||person?.id!==me.id||!validPoint(step.point))return false;
  const at=pointCopy(step.point);lastObserved={presence,id:me.id,point:at};
  const destination=destinationIntent;
  if(destination&&destination.presence===presence){const target=person.point||(validPoint(person)?person:null);if((!target||near(target,destination.destination))&&step.arrived===true&&near(at,destination.destination)){destination.arrived=true;if(destination.accepted)clearDestination();}}
  if(keyboard?.presence===presence)return false;
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
  const requested=point?validPoint(point)?pointCopy(point):null:area.nodeId?{x:area.x+area.w/2,y:area.y+area.h-4}:presencePosition(area.id);
  if(!requested)return Promise.resolve(false);
  const key=area.id+':'+requested.x+':'+requested.y;
  if(pending?.key===key&&pending.presence===presence)return pending.promise;
  if(keyboard)void finishKeyboard();
  const hadPending=!!pending,ticket=++revision,room=departmentAt(requested),heldOverride=localOverride;
  // A new floor click replaces a pending keyboard save, while retaining its
  // visible position until the new authoritative route has arrived.
  const drawn=drawnPoint(presence);
  cancelAutoFocus();
  clearDestination();
  const intent=frame&&room&&room.id!==currentArea?{key,ticket,presence,room,destination:requested,lastPoint:validPoint(drawn)?pointCopy(drawn):null,accepted:false,step:null}:null;
  walkIntent=intent;
  const current=()=>!destroyed&&revision===ticket&&getPresence()===presence;
  const promise=(async()=>{
   await presence.ready;if(!current()||isBlocked()){if(walkIntent===intent)cancelAutoFocus();return false;}
   const actual=localOverride?.presence===presence?localOverride.point:drawnPoint(presence);
   const destination=resolveFloorDestination(actual,requested);
   if(!destination){if(walkIntent===intent)cancelAutoFocus();return false;}
   if(heldOverride&&heldOverride===localOverride)heldOverride.generation=++localGeneration;
   if(intent){intent.destination=destination;intent.lastPoint=validPoint(actual)?pointCopy(actual):null;}
   if(!hadPending&&!heldOverride&&near(actual,destination)){if(walkIntent===intent)cancelAutoFocus();return true;}
   const feedback={ticket,presence,destination,accepted:false,arrived:false};destinationIntent=feedback;scene.setNavigationTarget?.(destination);
   const accepted=await presence.movePoint(destination,{shouldRun:()=>current()&&!isBlocked()});
   if(!current())return false;
   if(!accepted){if(walkIntent===intent)cancelAutoFocus();if(destinationIntent===feedback)clearDestination();clearOverride(heldOverride);return false;}
   if(destinationIntent===feedback){feedback.accepted=true;if(feedback.arrived)clearDestination();}clearOverride(heldOverride);
   if(walkIntent===intent&&intent){intent.accepted=true;if(intent.step)evaluateStep(intent,intent.step);}return true;
  })().finally(()=>{if(pending?.ticket===ticket)pending=null;});
  pending={key,presence,ticket,promise};return promise;
 }
 function beginKeyboard(){
  if(destroyed||isBlocked()||!requireAccount())return false;
  const presence=getPresence(),me=presence?.self,at=localOverride?.presence===presence?localOverride.point:drawnPoint(presence);
  if(!me||!validPoint(at)||typeof scene.setLocalPresencePoint!=='function')return false;
  ++revision;pending=null;cancelAutoFocus();clearDestination();
  keyboard={presence,id:me.id,point:pointCopy(at),generation:++localGeneration,changed:false};localOverride=keyboard;
  scene.setLocalPresencePoint(me.id,keyboard.point,{moving:false});return true;
 }
 function stepKeyboard(direction,milliseconds){
  const move=keyboard;if(!move||destroyed||getPresence()!==move.presence||isBlocked())return false;
  const delta=scene.screenDirectionToWorld?.(direction.x,direction.y)||direction,previous=move.point,next=officeWalkingStep(previous,delta,milliseconds);
  if(!next)return false;
  const moved=Math.hypot(next.x-previous.x,next.y-previous.y)>.00001;
  move.point=next;move.changed||=moved;lastObserved={presence:move.presence,id:move.id,point:next};
  const dx=next.x-previous.x,dy=next.y-previous.y;
  if(moved)move.heading=Math.abs(dx)>=Math.abs(dy)?(dx<0?'left':'right'):(dy<0?'up':'down');
  scene.setLocalPresencePoint(move.id,next,{moving:moved,...(move.heading?{heading:move.heading}:{})});
  if(moved){
   const room=departmentAt(next),oldRoom=departmentAt(previous);
   if(room&&room.id!==currentArea&&enteredDoor(room,previous,next)){currentArea=room.id;focus(currentArea);}
   else if(!room&&oldRoom?.id===currentArea&&enteredDoor(oldRoom,next,previous)){currentArea=null;focus(null);}
  }return moved;
 }
 async function finishKeyboard(){
  const move=keyboard;if(!move)return false;keyboard=null;
  scene.setLocalPresencePoint?.(move.id,move.point,{moving:false});
  const generation=move.generation,current=()=>!destroyed&&getPresence()===move.presence&&localOverride===move&&move.generation===generation;
  // Even a very short key tap stops an existing click route at the visible
  // point. One queued save carries the last server revision; no per-frame HTTP.
  const accepted=await move.presence.movePoint(move.point,{shouldRun:current});
  if(current())clearOverride(move);return accepted===true;
 }
 async function stopWalking(){
  if(keyboard)return finishKeyboard();
  if(!destinationIntent&&!pending)return false;
  const presence=getPresence(),at=drawnPoint(presence);if(!presence?.self||!validPoint(at))return false;
  ++revision;pending=null;cancelAutoFocus();clearDestination();
  const move={presence,id:presence.self.id,point:pointCopy(at),generation:++localGeneration};localOverride=move;
  scene.setLocalPresencePoint?.(move.id,move.point,{moving:false});
  const current=()=>!destroyed&&getPresence()===presence&&localOverride===move;
  const accepted=await presence.movePoint(move.point,{shouldRun:current});if(current())clearOverride(move);return accepted===true;
 }
 return{enterArea,setContext,observePresence,cancelAutoFocus,beginKeyboard,stepKeyboard,finishKeyboard,stopWalking,
  movePoint(point){if(!validPoint(point))return Promise.resolve(false);const room=departmentAt(point),id=room?.id||officeAreaAt(point)?.id;return enterArea(id,{point,frame:!!room&&room.id!==currentArea});},
  locateSelf(){const presence=getPresence(),me=presence?.self;if(destroyed||!me||isBlocked())return false;cancelAutoFocus();const at=drawnPoint(presence);currentArea=(validPoint(at)?departmentAt(at):OFFICE_ROOMS.find(room=>room.id===canonicalDepartmentId(me.nodeId||me.department)))?.id||null;focus(currentArea);scene.ensurePresenceVisible?.(me.id,{afterFit:true});return true;},
  restore,
  home(){if(destroyed)return;cancelAutoFocus();currentArea=null;focus(null);},
  reset(){++revision;++localGeneration;keyboard=null;clearOverride();clearDestination();pending=null;cancelAutoFocus();lastObserved=null;currentArea=null;},
  get walking(){return !!keyboard||!!destinationIntent||!!pending;},
  get areaId(){return currentArea;},
  destroy(){destroyed=true;++revision;++localGeneration;keyboard=null;clearOverride();clearDestination();pending=null;cancelAutoFocus();lastObserved=null;currentArea=null;},
 };
}
