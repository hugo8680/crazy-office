/* Screen-space name selection shared by both renderers. Names come from the
 * authenticated runtime directory; this module contains no employee records. */
export function selectOfficeNameLabels(candidates=[],{width=0,height=0,gap=4,fontSize=9}={}){
 const visible=[],accepted=[],seen=new Set();
 const measure=(name,size)=>Math.min(114,[...name].reduce((sum,char)=>sum+(/[\u2e80-\uffff]/u.test(char)?size:size*.57),0)+4);
 for(const item of Array.isArray(candidates)?candidates:[]){
  if(!item||typeof item.id!=='string'||seen.has(item.id)||typeof item.name!=='string'||!item.name.trim()||!Number.isFinite(item.x)||!Number.isFinite(item.y))continue;
  seen.add(item.id);const name=[...item.name.trim()].slice(0,12).join(''),size=Number.isFinite(item.fontSize)?Math.max(6,Math.min(14,item.fontSize)):fontSize,w=measure(name,size),h=size+4;
  if(item.x-w/2<0||item.x+w/2>width||item.y-h<0||item.y>height)continue;
  visible.push({...item,name,fontSize:size,box:{x:item.x-w/2,y:item.y-h,w,h},priority:Number.isFinite(item.priority)?item.priority:3});
 }
 visible.sort((a,b)=>a.priority-b.priority||a.id.localeCompare(b.id));
 for(const item of visible){const a=item.box;if(!item.required&&accepted.some(other=>{const b=other.box;return a.x<b.x+b.w+gap&&a.x+a.w+gap>b.x&&a.y<b.y+b.h+gap&&a.y+a.h+gap>b.y;}))continue;accepted.push(item);}
 return accepted;
}
