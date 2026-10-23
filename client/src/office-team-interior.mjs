// Both renderers use these quiet floor finishes and furniture footprints. They
// are presentation only: employee seats and navigation stay in organization.
export const OFFICE_TEAM_MATERIALS=Object.freeze({
  floor:'#eeeade',joint:'#dcded0',island:'#e0e5d8',alternateIsland:'#e6e4d5',headRug:'#e9ddc7',
  upholstery:'#9fb19c',cushion:'#bac8ad',wood:'#c3a277',woodTop:'#e2c89e',woodDark:'#8c7658',
  paper:'#f6f0df',pot:'#d9c5a4',leaf:'#86a483',darkLeaf:'#63856c',
});
export function officeTeamInterior(team){
  const {x,y}=team.detailBounds,head=team.seats.find(seat=>seat.role==='head').detailGeometry;
  return {
    islands:Array.from({length:4},(_,index)=>({x:x+122+index*176,y:y+272,w:160,h:296,color:index%2?OFFICE_TEAM_MATERIALS.alternateIsland:OFFICE_TEAM_MATERIALS.island})),
    headRug:{x:head.x,y:head.y-4,w:108,h:88},
    bench:{x:x+183,y:y+94,w:146,h:24},
    table:{x:x+310,y:y+94,w:44,h:22},
    cabinet:{x:x+478,y:y+25,w:148,h:18},
    plants:[{x:x+30,y:y+76,r:8},{x:x+800,y:y+76,r:8}],
  };
}
