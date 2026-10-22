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

// Camera intent and authenticated presence share a destination, not permissions.
// Superseded navigation is checked again inside the presence command queue.
export function createOfficeNavigation({scene,getPresence=()=>null,requireAccount=()=>false,isBlocked=()=>false}={}){
 let revision=0,currentArea=null,pending=null,destroyed=false;
 const focus=id=>id?(typeof scene.focusArea==='function'?scene.focusArea(id):scene.focusNode?.(id)):scene.resetView();
 function restore(){if(destroyed||isBlocked())return false;focus(currentArea);return true;}
 function enterArea(id,{point}={}){
  const area=officeArea(id);if(destroyed||!area||isBlocked()||!requireAccount())return Promise.resolve(false);
  const presence=getPresence();if(!presence)return Promise.resolve(false);
  const destination=point?validPoint(point)?{x:point.x,y:point.y}:null:area.nodeId?{x:area.x+area.w/2,y:area.y+area.h+4}:presencePosition(area.id);
  if(!destination)return Promise.resolve(false);
  const key=area.id+':'+destination.x+':'+destination.y;
  if(pending?.key===key&&pending.presence===presence)return pending.promise;
  const hadPending=!!pending,ticket=++revision,previous=currentArea;currentArea=area.id;focus(area.id);
  const current=()=>!destroyed&&revision===ticket&&getPresence()===presence&&!isBlocked();
  const promise=(async()=>{
   await presence.ready;if(!current())return false;
   if(!hadPending&&near(presence.self,destination))return true;
   const accepted=await presence.movePoint(destination,{shouldRun:current});
   if(!current())return false;
   if(!accepted){currentArea=previous;restore();return false;}return true;
  })().finally(()=>{if(pending?.ticket===ticket)pending=null;});
  pending={key,presence,ticket,promise};return promise;
 }
 return{enterArea,
  movePoint(point){if(!validPoint(point))return Promise.resolve(false);return enterArea(officeAreaAt(point)?.id,{point});},
  locateSelf(){const presence=getPresence(),me=presence?.self;if(destroyed||!me||isBlocked())return false;++revision;pending=null;currentArea=(validPoint(me)?officeAreaAt(me):officeArea(me.nodeId||me.department))?.id||null;return restore();},
  restore,
  home(){if(destroyed)return;++revision;pending=null;currentArea=null;focus(null);},
  reset(){++revision;pending=null;currentArea=null;},
  get areaId(){return currentArea;},
  destroy(){destroyed=true;++revision;pending=null;currentArea=null;},
 };
}
