// One public-wall layout is shared by SVG artwork, WebGL picks and content.
export const BULLETIN_SECTIONS=Object.freeze([
 Object.freeze({id:'dashboard',title:'数据看板',symbol:'activity',accent:'#416f66',paper:'#e7f0e6'}),
 Object.freeze({id:'training',title:'标注排行榜',symbol:'activity',accent:'#a78043',paper:'#f2e7d0'}),
 Object.freeze({id:'video',title:'宣传视频',symbol:'play',accent:'#6a7893',paper:'#e5eaf1'}),
 Object.freeze({id:'messages',title:'员工留言板',symbol:'users',accent:'#997763',paper:'#f2e5dc'}),
]);
export const bulletinSection=id=>BULLETIN_SECTIONS.find(section=>section.id===id)||null;
export function bulletinTile(area,id){
 const index=BULLETIN_SECTIONS.findIndex(section=>section.id===id);if(index<0)return null;
 const column=index%2,row=Math.floor(index/2),board=area.board;
 return {x:board.x+(column?1:-1)*(board.w-22)/4,y:board.y-13+row*32,w:(board.w-30)/2,h:28,
   world:{x:board.x+(column?1:-1)*(board.w-22)/4,y:board.y+6.4,height:row?26:58,w:(board.w-30)/2,h:28}};
}
