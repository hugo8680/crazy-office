// Authenticated directory data lives in memory only, separate from public geometry.
let occupants=new Map();
const listeners=new Set();
export function organizationOccupant(seatOrId){return occupants.get(typeof seatOrId==='string'?seatOrId:seatOrId?.id)||null;}
export function setOrganizationOccupants(records=[]){
  const next=new Map();
  for(const record of Array.isArray(records)?records:[]){
    if(!record||typeof record.name!=='string'||!Array.isArray(record.seatIds))continue;
    const person=Object.freeze({personId:String(record.personId||''),name:record.name,username:String(record.username||''),title:String(record.title||''),placeholder:record.placeholder===true,seatIds:Object.freeze(record.seatIds.filter(id=>typeof id==='string'))});
    for(const id of person.seatIds)next.set(id,person);
  }
  const signature=map=>JSON.stringify([...map].map(([id,p])=>[id,p.name,p.username,p.title,p.personId]));
  if(signature(next)===signature(occupants))return;
  occupants=next;for(const listener of listeners)listener();
}
export function subscribeOrganizationOccupants(listener){listeners.add(listener);return()=>listeners.delete(listener);}
