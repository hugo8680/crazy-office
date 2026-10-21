/* Decorative exterior only. None of these objects changes routing, hit targets,
 * business state, camera fit or the office's canonical world dimensions. */
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
export const OFFICE_EXTERIOR=freeze({
  lawn:{x:-145,y:-120,w:1680,h:1375,color:'#e4ead8'},
  paths:[{id:'entry',x:625,y:1092,w:180,h:160},{id:'west-walk',x:-38,y:130,w:45,h:810},{id:'east-walk',x:1383,y:205,w:44,h:690}],
  gardens:[{id:'northwest',x:-115,y:-75,w:345,h:58},{id:'northeast',x:1150,y:-75,w:340,h:58},{id:'west',x:-112,y:400,w:48,h:335},{id:'east',x:1462,y:415,w:44,h:340},{id:'southwest',x:30,y:1155,w:385,h:42}],
  trees:[{id:'northwest-a',x:-78,y:-21,r:30},{id:'northwest-b',x:155,y:-32,r:24},{id:'northwest-c',x:329,y:-52,r:23},{id:'northeast-a',x:1245,y:-28,r:29},{id:'northeast-b',x:1465,y:76,r:31},{id:'west-a',x:-91,y:276,r:27},{id:'west-b',x:-105,y:920,r:33},{id:'east-a',x:1477,y:318,r:26},{id:'east-b',x:1478,y:956,r:29},{id:'south-a',x:132,y:1194,r:28},{id:'south-b',x:1320,y:1192,r:31}],
  parking:{x:938,y:1127,w:280,h:93,spaces:4},
  bikes:{x:432,y:1153,count:4,spacing:23},
  forecourt:{x:630,y:1120,w:170,h:94},
});
