/* Organization posts describe the office plan. They never create login accounts,
 * online presence, credentials or authorization roles. Both renderers consume
 * these same coordinates; one person may hold more than one workplace. */
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}

export const OFFICE_WORLD = freeze({x:0,y:0,width:1390,height:1100});
export const OFFICE_BOUNDS = OFFICE_WORLD;
export const OFFICE_BULLETIN_AREA=freeze({
  id:'bulletin',title:'信息公开栏',x:900,y:900,w:420,h:145,
  board:{x:1110,y:935,w:340,h:20},
  benches:[{x:1045,y:1007,w:110,h:30},{x:1185,y:1007,w:110,h:30}],
  plants:[{x:920,y:1015,w:24,h:28},{x:1300,y:1015,w:24,h:28}],
  anchor:{x:1110,y:955},
  arrivalLine:[[920,975],[1300,975]],
});
export const OFFICE_CONVENIENCE_AREA=freeze({
  id:'convenience',title:'无人便利店',x:655,y:640,w:140,h:100,
  shelf:{x:775,y:669,w:24,h:44},
  fridge:{x:741,y:662,w:30,h:30},
  counter:{x:725,y:713,w:90,h:24},
  anchor:{x:706,y:737},
});


// Shared amenities use the same footprints in both views. They do not add
// departments, employee accounts or routes to the business navigation graph.
export const OFFICE_RECREATION_AREA=freeze({
  id:'recreation',title:'健身区',x:320,y:580,w:125,h:160,
  treadmill:{x:346,y:621,w:32,h:43},
  weightRack:{x:417,y:619,w:23,h:42},
  bench:{x:399,y:651,w:42,h:14},
  poolTable:{x:382,y:700,w:104,h:56},
  cueRack:{x:438,y:698,w:6,h:48},
});
export const OFFICE_DATA_CENTER=freeze({
  id:'data_center',title:'莱森购数据中心',x:-155,y:810,w:180,h:260,
  racks:[-122,-66,-10].flatMap((x,column)=>[920,1006].map((y,row)=>({id:`dc-rack-${column+1}-${row+1}`,x,y,w:34,h:35}))),
  serviceConsole:{x:-66,y:850,w:65,h:18},
  cooling:{x:-3,y:1043,w:44,h:18},ups:{x:-125,y:1041,w:20,h:28},
  door:{x:-65,y:1070,w:46},
});

// The annex has one entrance on its south edge. Cross aisles run between the
// rack rows; longitudinal lanes stay in the gaps between the rack columns.
export const OFFICE_DATA_CENTER_WALKING_SEGMENTS=freeze([
  [[25,1080],[-65,1080]],[[-65,1080],[-65,1058]],
  [[-140,1058],[12,1058]],[[-140,965],[12,965]],[[-140,875],[12,875]],
  [[-94,875],[-94,1058]],[[-38,875],[-38,1058]],
]);

const specs = [
  {id:'business',name:'商务部',english:'BUSINESS',staff:5,x:895,y:40,w:220,h:180,columns:3,rowGap:51,doorSide:'bottom',floor:'#f0dfb9',manager:'business_channels_manager'},
  {id:'hr_admin',name:'人力资源与行政管理部',english:'PEOPLE & ADMINISTRATION',staff:3,x:40,y:300,w:210,h:240,columns:2,rowGap:64,doorSide:'right',doorY:450,floor:'#e3ecc7'},
  {id:'finance',name:'财务部',english:'FINANCE',staff:4,x:40,y:570,w:230,h:250,columns:2,rowGap:54,doorSide:'right',doorY:710,floor:'#d8e9cd'},
  {id:'legal',name:'法务与合规部',english:'LEGAL & COMPLIANCE',staff:1,x:705,y:80,w:155,h:150,doorSide:'bottom',floor:'#e4def2'},
  {id:'channels',name:'渠道部',english:'CHANNELS',staff:7,x:1150,y:80,w:200,h:180,columns:4,rowGap:51,doorSide:'bottom',floor:'#efceb0',manager:'business_channels_manager'},
  {id:'research',name:'研发部',english:'RESEARCH & DEVELOPMENT',staff:8,x:300,y:800,w:290,h:260,columns:3,rowGap:55,deskTop:70,doorSide:'top',floor:'#cbe7e5'},
  {id:'operations',name:'商务运营部',english:'OPERATIONS',staff:5,x:610,y:800,w:220,h:260,columns:2,rowGap:55,deskTop:70,doorSide:'top',floor:'#daeac7'},
  {id:'general_office',name:'总经办',english:'EXECUTIVE OFFICE',staff:0,chairman:1,x:40,y:40,w:250,h:210,deskTop:75,doorSide:'bottom',floor:'#f0e1be'},
  {id:'ai_data',name:'AI数据算法部',english:'AI DATA & ALGORITHMS',staff:200,heads:5,x:850,y:330,w:500,h:540,doorSide:'left',floor:'#c8e6db'},
  {id:'investment',name:'投资者关系部',english:'INVESTOR RELATIONS',staff:0,x:515,y:40,w:155,h:155,doorSide:'bottom',floor:'#d4e6ed'},
  {id:'maintenance',name:'运维部',english:'INFRASTRUCTURE',staff:0,manager:'research_staff_002',x:40,y:850,w:230,h:210,doorSide:'right',doorY:1010,floor:'#cfe4dd'},
  {id:'public_affairs',name:'公共事务关系部',english:'PUBLIC AFFAIRS',staff:0,x:325,y:80,w:155,h:150,doorSide:'bottom',floor:'#e9e4cb'},
];

const seats = [], rooms = [], departments = [];
function seat(spec,role,index,x,deskY,{teamId=null,compact=false,personId,label,primarySeat=true,deskWidth=74}={}) {
  const id = `${spec.id}_${role}_${String(index).padStart(3,'0')}`;
  const result = {
    id, personId:personId || id, departmentId:spec.id, role, teamId,
    label:label || (role==='chairman'?'董事长':role==='manager'?'经理':role==='head'?`第${index}部部长`:`员工 ${String(index).padStart(3,'0')}`),
    x, y:deskY+(compact?9:deskWidth<60?20:24), facing:'north', scale:compact?.24:deskWidth<60?.58:.72,
    desk:{x,y:deskY,w:compact?14:deskWidth,h:compact?9:28},
    primarySeat, occupantVisible:primarySeat,
  };
  seats.push(result);
  return result;
}

for (const spec of specs) {
  const roomSeats=[], teamZones=[];
  const {w,h}=spec;
  if(spec.id==='ai_data') {
    for(let team=1;team<=5;team++) {
      const [x,y]=[[870,390],[1175,390],[1180,570],[1030,715],[865,585]][team-1];
      const teamId=`ai_data_team_${team}`;
      const head=seat(spec,'head',team,x+143,y+18,{teamId,compact:true});
      const teamStaff=[];
      for(let member=0;member<40;member++) {
        const staff=seat(spec,'staff',(team-1)*40+member+1,x+12+(member%8)*18,y+43+Math.floor(member/8)*18,{teamId,compact:true});
        teamStaff.push(staff);roomSeats.push(staff);
      }
      roomSeats.push(head);
      teamZones.push({id:teamId,title:`第${team}部`,x,y,w:160,h:130,headPersonId:head.personId,staffCount:40,seats:[head,...teamStaff]});
    }
    roomSeats.unshift(seat(spec,'manager',1,1095,415,{label:'AI数据算法部经理',deskWidth:56}));
  } else {
    const posts=[...(spec.chairman?[{role:'chairman',index:1}]:[]),{role:'manager',index:1},...Array.from({length:spec.staff},(_,i)=>({role:'staff',index:i+1}))];
    const columns=spec.columns||(posts.length<=2?posts.length:3);
    const pitch=(w-32)/columns,deskWidth=Math.min(74,pitch-12);
    for(const [index,post] of posts.entries()) {
      const col=index%columns,row=Math.floor(index/columns);
      const x=spec.x+16+pitch*(col+.5);
      roomSeats.push(seat(spec,post.role,post.index,x,spec.y+(spec.deskTop||65)+row*(spec.rowGap||54),{
        deskWidth,
        ...(post.role==='manager'&&spec.manager?{personId:spec.manager}:{}),
        ...(spec.id==='channels'&&post.role==='manager'?{primarySeat:false,label:'商务部经理兼任'}:{}),
        ...(spec.id==='research'&&post.role==='staff'&&post.index===2?{primarySeat:false,label:'运维部经理兼任'}:{}),
        ...(spec.id==='maintenance'&&post.role==='manager'?{label:'运维部经理'}:{}),
      }));
    }
  }
  const members=roomSeats.map(post=>post.personId);
  const roleCounts={manager:1,chairman:spec.chairman||0,head:spec.heads||0,staff:spec.staff};
  const arrivalLine=spec.id==='ai_data'?[[857,850],[1343,850]]:[[spec.x+14,spec.y+h-20],[spec.x+w-14,spec.y+h-20]];
  const door=spec.id==='ai_data'?{x:850,y:540,side:'left',width:40}:spec.doorSide==='right'?{x:spec.x+w,y:spec.doorY,side:'right',width:34}:{x:spec.x+w/2,y:spec.y+(spec.doorSide==='bottom'?h:0),side:spec.doorSide,width:34};
  rooms.push({id:spec.id,title:spec.name,english:spec.english,x:spec.x,y:spec.y,w,h,floor:spec.floor,headcount:members.length,roleCounts,door,arrivalLine,seats:roomSeats,teamZones});
  departments.push({id:spec.id,name:spec.name,title:spec.name,managerPersonId:spec.manager||`${spec.id}_manager_001`,headcount:members.length,roleCounts,members,teams:teamZones.map(team=>({id:team.id,name:team.title,headPersonId:team.headPersonId,staffCount:team.staffCount,memberPersonIds:team.seats.map(post=>post.personId)}))});
}

// The campus uses representatives. Department detail renders the complete
// canonical roster in place; explicit legacy team interiors use display maps.
function sampleTeamSeats(team) {
  const staff=team.seats.filter(post=>post.role!=='head');
  for(let i=staff.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[staff[i],staff[j]]=[staff[j],staff[i]];}
  return [team.seats.find(post=>post.role==='head'),...staff.slice(0,3)];
}
for(const room of rooms) {
  const visible=new Set();
  if(room.id==='ai_data') {
    const manager=room.seats.find(post=>post.role==='manager');
    visible.add(manager.id);
    manager.overviewGeometry={x:manager.x,y:manager.desk.y+24,scale:.72,desk:{...manager.desk,w:64,h:28}};
    manager.detailGeometry=manager.overviewGeometry;
    for(const team of room.teamZones) {
      const selected=sampleTeamSeats(team);
      team.detailSeatIds=team.seats.map(post=>post.id);
      team.overviewSeatIds=selected.map(post=>post.id);
      team.detailBounds={id:team.id,title:team.title,x:team.x+team.w/2-420,y:team.y+team.h/2-240,w:840,h:480};
      for(const post of team.seats){
        const x=team.detailBounds.x+78+(post.x-team.x-12)*88/18,y=team.detailBounds.y+168+(post.y-team.y-52)*58/18;
        post.detailGeometry={x,y,scale:.72,desk:{x,y:y-24,w:64,h:28}};
      }
      for(const [index,post]of selected.entries()){
        const x=team.x+(index%2?120:40),deskY=team.y+40+Math.floor(index/2)*52;
        visible.add(post.id);post.overviewGeometry={x,y:deskY+24,scale:.72,desk:{x,y:deskY,w:64,h:28}};
      }
    }
  } else {
    for(const post of room.seats)visible.add(post.id);
  }
  room.overviewSeatIds=[...visible];
  for(const post of room.seats)post.overviewVisible=visible.has(post.id);

}

export const OFFICE_ROOMS=freeze(rooms);
export const OFFICE_SEATS=freeze(seats);
const detailTeams=new Map(rooms.flatMap(room=>room.teamZones).map(team=>[team.id,team]));
export function officeTeamDetail(id){return detailTeams.get(id)||null;}
export function officePointInTeam(point,teamId,{margin=8}={}){
  const team=officeTeamDetail(teamId);
  return !!team&&Number.isFinite(point?.x)&&Number.isFinite(point?.y)&&point.x>=team.x-margin&&point.x<=team.x+team.w+margin&&point.y>=team.y-margin&&point.y<=team.y+team.h+margin;
}
export function officeDisplayPoint(point,teamId){
  const team=officeTeamDetail(teamId);if(!team||!point)return point;
  return {...point,x:team.detailBounds.x+78+(point.x-team.x-12)*88/18,y:team.detailBounds.y+168+(point.y-team.y-52)*58/18};
}
export function officeCanonicalPoint(point,teamId){
  const team=officeTeamDetail(teamId);if(!team||!point)return point;
  return {...point,x:team.x+12+(point.x-team.detailBounds.x-78)*18/88,y:team.y+52+(point.y-team.detailBounds.y-168)*18/58};
}
export function officeSeatForView(post,{detail=false}={}) {
  const geometry=detail?post.detailGeometry:post.overviewGeometry;
  return geometry?Object.freeze({...post,...geometry}):post;
}
export const OFFICE_OVERVIEW_SEATS=freeze(seats.filter(post=>post.overviewVisible).map(post=>officeSeatForView(post)));
export const OFFICE_DETAIL_ZOOM=2.4;
export function officeSeatsForView({zoom=1,focusedDepartmentId,focusedTeamId,detailDepartmentId,detailTeamId}={}) {
  const team=focusedTeamId||(zoom>=OFFICE_DETAIL_ZOOM?detailTeamId:null);
  const department=canonicalDepartmentId(focusedDepartmentId||(zoom>=OFFICE_DETAIL_ZOOM?detailDepartmentId:null));
  if(officeTeamDetail(team))return OFFICE_SEATS.filter(post=>post.teamId===team).map(post=>officeSeatForView(post,{detail:true}));
  if(department)return OFFICE_SEATS.filter(post=>post.departmentId===department||post.overviewVisible).map(post=>post.departmentId===department?post:officeSeatForView(post));
  const detail=post=>team&&post.teamId===team;
  return OFFICE_SEATS.filter(post=>post.overviewVisible||(detail(post)&&(!post.teamId||post.detailGeometry))).map(post=>officeSeatForView(post,{detail:!!detail(post)}));
}
export const ORGANIZATION_DEPARTMENTS=freeze(departments);
export const ORGANIZATION_PEOPLE=freeze([...new Map(seats.map(post=>[post.personId,{
  id:post.personId,role:post.role,
  departmentIds:[...new Set(seats.filter(other=>other.personId===post.personId).sort((a,b)=>Number(b.primarySeat)-Number(a.primarySeat)).map(other=>other.departmentId))],
  primarySeatId:seats.find(other=>other.personId===post.personId&&other.primarySeat).id,
  seatIds:seats.filter(other=>other.personId===post.personId).sort((a,b)=>Number(b.primarySeat)-Number(a.primarySeat)).map(other=>other.id),
}])).values()]);
const peopleInRole=role=>ORGANIZATION_PEOPLE.filter(person=>person.role===role).length;
export const ORGANIZATION_TOTALS=freeze({departments:departments.length,people:ORGANIZATION_PEOPLE.length,workplaces:seats.length,managers:peopleInRole('manager'),chairmen:peopleInRole('chairman'),heads:peopleInRole('head'),staff:peopleInRole('staff')});

const roomById=new Map(rooms.map(room=>[room.id,room]));
export const DEPARTMENT_ALIASES=freeze({
  business:'business','商务部':'business','商务':'business',executive:'business','业务管理室':'business','业务部':'business','业务':'business',
  hr_admin:'hr_admin','人力资源与行政管理部':'hr_admin','人力资源部':'hr_admin','人力资源':'hr_admin','行政部':'hr_admin','人事':'hr_admin','人事部':'hr_admin',workstations:'hr_admin','开放办公区':'hr_admin',
  finance:'finance','财务部':'finance','财务办公室':'finance','财务':'finance',
  legal:'legal','法务与合规部':'legal','法务部':'legal','法务':'legal',
  channels:'channels','渠道部':'channels',reception:'channels','客户会见厅':'channels','采购':'channels','采购部':'channels',
  research:'research','研发部':'research','研发':'research',meeting:'research','会议室':'research','技术部':'research','技术':'research',
  operations:'operations','商务运营部':'operations','运营部':'operations','运营':'operations',
  general_office:'general_office','总经办':'general_office','总经理办公室':'general_office','管理':'general_office',
  ai_data:'ai_data','ai数据部':'ai_data','ai数据算法部':'ai_data','数据算法部':'ai_data',
  investment:'investment','投资者关系部':'investment','投资者关系不':'investment','投资':'investment','投资部':'investment',
  maintenance:'maintenance','运维部':'maintenance','运维':'maintenance',server:'maintenance',internet:'maintenance',firewall:'maintenance',core:'maintenance',storage:'maintenance',ups:'maintenance',access:'maintenance','网络机房':'maintenance','it':'maintenance','it部':'maintenance',
  public_affairs:'public_affairs','公共事务关系部':'public_affairs','公共事务部':'public_affairs',
});
export function canonicalDepartmentId(value) {
  const key=String(value??'').trim().replace(/\s+/g,'').toLowerCase();
  return DEPARTMENT_ALIASES[key]||null;
}
export function departmentById(value) { const id=canonicalDepartmentId(value);return departments.find(department=>department.id===id)||null; }
export function roomForDepartment(value) { return roomById.get(canonicalDepartmentId(value))||null; }
export function seatsForDepartment(value) { return roomForDepartment(value)?.seats||Object.freeze([]); }
export function departmentWorkPoint(value,index=0) {
  const room=roomForDepartment(value);if(!room)return null;
  const [a,b]=room.arrivalLine;
  const slot=Math.max(0,Math.min(7,Number.isFinite(index)?Math.floor(index):0));
  return {x:a[0]+(b[0]-a[0])*(slot+1)/9,y:a[1]};
}

const network={
  internet:{x:235,y:895,label:'互联网'},firewall:{x:85,y:975,label:'安全网关'},
  core:{x:145,y:975,label:'核心交换机'},server:{x:210,y:970,label:'应用服务器'},
  storage:{x:210,y:1020,label:'NAS 存储'},ups:{x:85,y:1020,label:'UPS 电源'},
  access:{x:145,y:1020,label:'接入交换机'},
};
const anchors=Object.fromEntries(rooms.map(room=>[room.id,{...departmentWorkPoint(room.id,3),departmentId:room.id,label:room.title}]));
anchors.bulletin={...OFFICE_BULLETIN_AREA.anchor,departmentId:null,label:OFFICE_BULLETIN_AREA.title};
for(const [id,node] of Object.entries(network))anchors[id]={...node,departmentId:'maintenance'};
for(const [legacy,departmentId] of Object.entries({workstations:'hr_admin',executive:'business',meeting:'research',reception:'channels'}))anchors[legacy]={...anchors[departmentId]};
export const OFFICE_NODE_ANCHORS=freeze(anchors);
export const OFFICE_WORK_POSITIONS=freeze(Object.fromEntries(Object.keys(anchors).map(id=>[id,Array.from({length:3},(_,index)=>{const p=departmentWorkPoint(anchors[id].departmentId,index+2)||anchors[id];return[p.x,p.y];})])));

const identities={
  hr:{name:'小禾',role:'入职登记专员',departmentId:'hr_admin',hair:'#51453d',slot:5},
  invest_research:{name:'沈研',role:'投资研究员',departmentId:'investment',hair:'#514333',slot:1},
  invest_finance:{name:'顾衡',role:'财务尽调师',departmentId:'investment',hair:'#474b45',slot:3},
  invest_risk:{name:'何审',role:'独立风险审查',departmentId:'investment',hair:'#493d50',slot:5},
  zhang:{name:'小张',role:'网络工程师',departmentId:'maintenance',hair:'#514333',slot:1},
  liu:{name:'小刘',role:'安全工程师',departmentId:'maintenance',hair:'#493d50',slot:3},
  lead:{name:'陈工',role:'技术组长',departmentId:'research',hair:'#474b45',slot:5},
  business:{name:'林悦',role:'业务组长',departmentId:'business',hair:'#6b483d',slot:5},
  finance:{name:'许姐',role:'财务',departmentId:'finance',hair:'#5e443d',slot:5},
  boss:{name:'周助理',role:'管理审校',departmentId:'general_office',hair:'#4d4440',slot:5},
  ops:{name:'阿杰',role:'机房运维',departmentId:'maintenance',hair:'#484b3d',slot:5},
};
export const OFFICE_AGENT_HOMES=freeze(Object.fromEntries(Object.entries(identities).map(([id,{slot,...identity}])=>[id,{...identity,...departmentWorkPoint(identity.departmentId,slot),seated:false}])));

// Orthogonal floor lanes are the common navigation graph, not renderer hints.
// Desk rows connect along chair-side lanes; vertical travel stays beside desks.
const walking=[
  ...OFFICE_DATA_CENTER_WALKING_SEGMENTS,
  [[285,280],[285,1080]],[[840,280],[840,1080]],
  [[25,280],[1360,280]],
  [[25,1080],[840,1080]],[[285,775],[840,775]],
  [[285,320],[840,320]],[[285,755],[840,755]],
  [[310,320],[310,755]],[[810,320],[810,755]],
  [[840,975],[1300,975]],
];
for(const room of rooms) {
  if(room.id==='ai_data')continue;
  const left=room.x+14,right=room.x+room.w-14,arrival=room.arrivalLine[0][1];
  const rows=[...new Set(room.seats.map(post=>post.y))];
  walking.push(room.arrivalLine);
  for(const y of rows)walking.push([[left,y],[right,y]]);
  if(room.door.side==='right') {
    walking.push([[right,Math.min(...rows,room.door.y)],[right,arrival]],[[right,room.door.y],[285,room.door.y]]);
  } else if(room.door.side==='top') {
    const entry=room.y+14;
    walking.push([[right,entry],[right,arrival]],[[room.door.x,775],[room.door.x,entry]],[[room.door.x,entry],[right,entry]]);
  } else {
    const hall=280;
    walking.push([[left,Math.min(...rows)],[left,arrival]],[[room.door.x,arrival],[room.door.x,hall]]);
  }
}
walking.push([[840,540],[857,540]],[[857,350],[857,850]],[[857,850],[1343,850]],[[1343,350],[1343,850]],[[857,530],[1343,530]]);
walking.push([[1037,435],[1037,530]],[[1037,435],[1155,435]]);
export const OFFICE_WALKING_SEGMENTS=freeze(walking);

// Furniture footprints use the same floor coordinates as posts and navigation.
// w/h are floor width/depth; renderers supply visual height and surface detail.
const fittings=[];
function fitting(roomId,kind,x,y,w,h,rotation=0) {
  fittings.push({id:`${roomId}_${kind}_${fittings.filter(item=>item.roomId===roomId&&item.kind===kind).length+1}`,roomId,kind,x,y,w,h,rotation});
}
for(const room of rooms) {
  if(['ai_data','research','maintenance','operations'].includes(room.id))continue;
  if(room.id==='general_office') {
    fitting(room.id,'sofa',room.x+115,room.y+135,130,30);
    fitting(room.id,'coffee_table',room.x+115,room.y+171,64,16);
    fitting(room.id,'cabinet',room.x+226,room.y+143,16,60);
  } else if(room.headcount<=2) {
    fitting(room.id,'sofa',room.x+70,room.y+106,90,22);
    fitting(room.id,'coffee_table',room.x+70,room.y+124,40,8);
    fitting(room.id,'cabinet',room.x+133,room.y+112,12,28);
  } else {
    fitting(room.id,'cabinet',room.x+room.w-42,room.y+40,48,12);
  }
}
fitting('shared_lounge','sofa',420,420,150,42);
fitting('shared_lounge','sofa',420,540,150,42,180);
fitting('shared_lounge','coffee_table',420,480,78,40);
fitting('shared_lounge','collaboration_table',540,680,170,80);
fitting('shared_lounge','plant',340,355,24,28);
fitting('shared_lounge','plant',770,355,24,28);
fitting('ai_data','sofa',1105,478,100,28);
fitting('ai_data','coffee_table',1105,508,54,12);
fitting('ai_data','plant',1155,512,16,18);
export const OFFICE_FITTINGS=freeze(fittings);
export const OFFICE_SHARED_AREAS=freeze([{id:'shared_lounge',x:310,y:320,w:500,h:435}]);
export const OFFICE_LANDSCAPE=freeze([
  {id:'courtyard_tree',kind:'tree_island',x:650,y:435,w:175,h:80},
  {id:'courtyard_water',kind:'pond',x:650,y:555,w:175,h:100},
  {id:'courtyard_deck',kind:'deck',x:650,y:620,w:205,h:18},
  {id:'courtyard_planter',kind:'planter',x:650,y:370,w:170,h:20},
  {id:'courtyard_stone_1',kind:'stepping_stone',x:515,y:555,w:18,h:14},
  {id:'courtyard_stone_2',kind:'stepping_stone',x:535,y:570,w:18,h:14},
  {id:'algorithm_tree',roomId:'ai_data',kind:'tree_island',x:1100,y:585,w:90,h:80},
]);

