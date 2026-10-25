import {OFFICE_WORLD,OFFICE_ROOMS,OFFICE_FITTINGS,OFFICE_LANDSCAPE,OFFICE_BULLETIN_AREA,OFFICE_CONVENIENCE_AREA,OFFICE_RECREATION_AREA,OFFICE_DATA_CENTER} from './organization.mjs';
import {floorSegmentClear} from './floor-routing.mjs';

const rectangle=({x,y,w,h},padding=1.5)=>({x:x-w/2-padding,y:y-h/2-padding,w:w+padding*2,h:h+padding*2});
const obstacles=[...OFFICE_ROOMS.flatMap(room=>room.seats.map(seat=>seat.desk)),...OFFICE_FITTINGS,...OFFICE_LANDSCAPE.filter(item=>!['stepping_stone','deck'].includes(item.kind)),...['shelf','fridge','counter'].map(key=>OFFICE_CONVENIENCE_AREA[key]),...['treadmill','weightRack','bench','poolTable','cueRack'].map(key=>OFFICE_RECREATION_AREA[key]),OFFICE_BULLETIN_AREA.board,...OFFICE_BULLETIN_AREA.benches,...OFFICE_DATA_CENTER.racks,OFFICE_DATA_CENTER.serviceConsole,OFFICE_DATA_CENTER.cooling,OFFICE_DATA_CENTER.ups].map(item=>rectangle(item));
function roomWalls(room){
 const {x,y,w,h,door}=room,side=door.side||'bottom',width=door.width||door.w||34,walls=[];
 for(const edge of['left','right','top','bottom']){
  const vertical=edge==='left'||edge==='right',position=vertical?(edge==='left'?x:x+w):(edge==='top'?y:y+h),start=vertical?y:x,length=vertical?h:w;
  const parts=edge===side?[[start,(vertical?door.y:door.x)-width/2],[((vertical?door.y:door.x)+width/2),start+length]]:[[start,start+length]];
  for(const [from,to]of parts)if(to>from)walls.push(vertical?{x:position-.8,y:from,w:1.6,h:to-from}:{x:from,y:position-.8,w:to-from,h:1.6});
 }return walls;
}
const walls=[...OFFICE_ROOMS.flatMap(roomWalls),...roomWalls(OFFICE_DATA_CENTER)];
const all=[...obstacles,...walls];
const finite=point=>Number.isFinite(point?.x)&&Number.isFinite(point?.y);
const within=point=>point.y>=20&&point.y<=OFFICE_WORLD.height-20&&(point.x>=20&&point.x<=OFFICE_WORLD.width-20||point.x>=OFFICE_DATA_CENTER.x&&point.x<=OFFICE_DATA_CENTER.x+OFFICE_DATA_CENTER.w&&point.y>=OFFICE_DATA_CENTER.y);
const penetration=(point,box)=>Math.min(point.x-box.x,box.x+box.w-point.x,point.y-box.y,box.y+box.h-point.y);
function clear(from,to){
 if(!within(to))return false;
 for(const box of all){
  if(floorSegmentClear(from,to,[box]))continue;
  // Old saved positions may overlap furniture. Let the person leave the
  // existing footprint, without crossing a different obstacle or a wall.
  if(obstacles.includes(box)&&!floorSegmentClear(from,from,[box])&&penetration(to,box)<penetration(from,box))continue;
  return false;
 }return true;
}
// Direct steering uses the same furniture/door footprints as click routing.
// Slide along a wall when one component is blocked; never find a hidden detour
// or send the employee out of a door to move a few pixels inside their room.
export function officeWalkingStep(from,direction,milliseconds,{speed=105}={}){
 if(!finite(from)||!finite(direction)||!Number.isFinite(milliseconds)||!Number.isFinite(speed))return finite(from)?{x:from.x,y:from.y}:null;
 const length=Math.hypot(direction.x,direction.y),amount=Math.min(50,Math.max(0,milliseconds))*Math.max(0,speed)/1000;
 if(!length||!amount)return{x:from.x,y:from.y};
 const delta={x:direction.x/length*amount,y:direction.y/length*amount},next={x:from.x+delta.x,y:from.y+delta.y};
 if(clear(from,next))return next;
 const axes=Math.abs(delta.x)>=Math.abs(delta.y)?['x','y']:['y','x'];let point={x:from.x,y:from.y};
 for(const axis of axes){const candidate={...point,[axis]:point[axis]+delta[axis]};if(clear(point,candidate))point=candidate;}
 return point;
}
