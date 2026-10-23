import test from 'node:test';
import assert from 'node:assert/strict';
import {OFFICE_WORLD,OFFICE_ROOMS,OFFICE_SEATS,OFFICE_OVERVIEW_SEATS,OFFICE_DETAIL_ZOOM,officeSeatsForView,ORGANIZATION_DEPARTMENTS,ORGANIZATION_PEOPLE,ORGANIZATION_TOTALS,OFFICE_AGENT_HOMES,OFFICE_NODE_ANCHORS,OFFICE_WALKING_SEGMENTS,OFFICE_DATA_CENTER_WALKING_SEGMENTS,OFFICE_FITTINGS,OFFICE_SHARED_AREAS,OFFICE_LANDSCAPE,OFFICE_BULLETIN_AREA,OFFICE_CONVENIENCE_AREA,canonicalDepartmentId,departmentById,roomForDepartment,departmentWorkPoint} from '../src/organization.mjs';

test('organization has exact requested posts without inventing accounts',()=>{
  assert.equal(ORGANIZATION_DEPARTMENTS.length,12);
  assert.equal(OFFICE_ROOMS.length,12);
  assert.equal(OFFICE_SEATS.length,251);
  assert.equal(ORGANIZATION_PEOPLE.length,249);
  const counts={business:6,hr_admin:4,finance:5,legal:2,channels:8,research:9,operations:6,general_office:2,ai_data:206,investment:1,maintenance:1,public_affairs:1};
  for(const [id,count] of Object.entries(counts))assert.equal(departmentById(id).headcount,count,id);
  assert.equal(ORGANIZATION_TOTALS.workplaces,251);
  assert.deepEqual(ORGANIZATION_TOTALS,{departments:12,people:249,workplaces:251,managers:11,chairmen:1,heads:5,staff:232});
  assert.equal(OFFICE_SEATS.filter(post=>post.role==='chairman').length,1);
  assert.equal(OFFICE_SEATS.filter(post=>post.role==='chairman')[0].departmentId,'general_office');
  for(const person of ORGANIZATION_PEOPLE){assert.equal(person.username,undefined);assert.equal(person.password,undefined);assert.equal(person.permissions,undefined);}
});

test('business and channels share one manager and only one visible occupant',()=>{
  const business=roomForDepartment('business').seats.find(post=>post.role==='manager');
  const channels=roomForDepartment('channels').seats.find(post=>post.role==='manager');
  assert.equal(business.personId,channels.personId);
  assert.notEqual(business.id,channels.id);
  assert.equal(business.occupantVisible,true);assert.equal(channels.occupantVisible,false);
  assert.equal(channels.label,'商务部经理兼任');
  assert.equal(OFFICE_SEATS.filter(post=>post.occupantVisible).length,249);
  const manager=ORGANIZATION_PEOPLE.find(person=>person.id===business.personId);
  assert.deepEqual(manager.departmentIds,['business','channels']);
  assert.equal(manager.primarySeatId,business.id);
});

test('maintenance manager lives in maintenance and keeps the research post without a duplicate person',()=>{
  const maintenance=roomForDepartment('maintenance').seats.find(post=>post.role==='manager');
  const research=roomForDepartment('research').seats.find(post=>post.personId===maintenance.personId);
  assert.ok(research,'shared research appointment is retained');
  assert.equal(maintenance.primarySeat,true);assert.equal(maintenance.occupantVisible,true);
  assert.equal(maintenance.label,'运维部经理');
  assert.equal(research.primarySeat,false);assert.equal(research.occupantVisible,false);
  assert.equal(research.label,'运维部经理兼任');
  const manager=ORGANIZATION_PEOPLE.find(person=>person.id===maintenance.personId);
  assert.equal(manager.role,'manager');
  assert.equal(manager.primarySeatId,maintenance.id);
  assert.deepEqual(manager.departmentIds,['maintenance','research']);
  assert.deepEqual(manager.seatIds,[maintenance.id,research.id]);
  assert.equal(OFFICE_SEATS.filter(post=>post.personId===manager.id&&post.occupantVisible).length,1);
  assert.equal(ORGANIZATION_TOTALS.people,249);assert.equal(ORGANIZATION_TOTALS.workplaces,251);
  assert.equal(departmentById('maintenance').managerPersonId,manager.id);
  assert.equal(ORGANIZATION_PEOPLE.filter(person=>person.id===manager.id).length,1);
  assert.equal(OFFICE_SEATS.length-ORGANIZATION_PEOPLE.length,2,'business/channels and development/maintenance share two colleagues');
});

test('AI department contains five complete divisions with one head and forty staff each',()=>{
  const ai=departmentById('ai_data');
  assert.equal(ai.roleCounts.manager,1);assert.equal(ai.roleCounts.head,5);assert.equal(ai.roleCounts.staff,200);
  assert.equal(ai.teams.length,5);
  const ids=new Set();
  for(const team of ai.teams){
    assert.equal(team.staffCount,40);assert.equal(team.memberPersonIds.length,41);
    assert.equal(OFFICE_SEATS.filter(post=>post.teamId===team.id&&post.role==='head').length,1);
    assert.equal(OFFICE_SEATS.filter(post=>post.teamId===team.id&&post.role==='staff').length,40);
    for(const id of team.memberPersonIds){assert.ok(!ids.has(id),id);ids.add(id);}
  }
  assert.equal(ids.size,205);
});

test('all stable workplaces, desks and people stay within their rooms without desk collisions',()=>{
  assert.equal(new Set(OFFICE_SEATS.map(post=>post.id)).size,OFFICE_SEATS.length);
  const inside=(x,y,room)=>x>room.x&&x<room.x+room.w&&y>room.y&&y<room.y+room.h;
  for(const room of OFFICE_ROOMS){
    assert.ok(room.x>=OFFICE_WORLD.x&&room.y>=OFFICE_WORLD.y);
    assert.ok(room.x+room.w<=OFFICE_WORLD.width&&room.y+room.h<=OFFICE_WORLD.height);
    for(const post of room.seats){
      const d=post.desk;
      assert.ok(inside(post.x,post.y,room),post.id);
      assert.ok(inside(d.x-d.w/2,d.y-d.h/2,room),post.id);
      assert.ok(inside(d.x+d.w/2,d.y+d.h/2,room),post.id);
      for(const other of room.seats){if(other===post)continue;const e=other.desk;assert.ok(Math.abs(d.x-e.x)>=(d.w+e.w)/2||Math.abs(d.y-e.y)>=(d.h+e.h)/2,`${post.id} overlaps ${other.id}`);}
    }
  }
});

test('department aliases preserve existing business references and reject unknown values',()=>{
  const aliases={workstations:'hr_admin',executive:'business',reception:'channels',meeting:'research',server:'maintenance',internet:'maintenance','业务部':'business','投资者关系不':'investment',' 财务办公室 ':'finance','AI 数据算法部':'ai_data'};
  for(const [alias,id]of Object.entries(aliases))assert.equal(canonicalDepartmentId(alias),id);
  assert.equal(canonicalDepartmentId('unknown'),null);assert.equal(roomForDepartment('unknown'),null);assert.equal(departmentWorkPoint('unknown'),null);
});

test('all rooms and agent homes connect to the shared floor graph on walkable chair-side lanes',()=>{
  const on=(p,s)=>Math.abs((p.x-s[0][0])*(s[1][1]-s[0][1])-(p.y-s[0][1])*(s[1][0]-s[0][0]))<.001&&p.x>=Math.min(s[0][0],s[1][0])&&p.x<=Math.max(s[0][0],s[1][0])&&p.y>=Math.min(s[0][1],s[1][1])&&p.y<=Math.max(s[0][1],s[1][1]);
  const intersects=(a,b)=>a.some(p=>on({x:p[0],y:p[1]},b))||b.some(p=>on({x:p[0],y:p[1]},a))||(a[0][0]===a[1][0]&&b[0][1]===b[1][1]&&on({x:a[0][0],y:b[0][1]},a)&&on({x:a[0][0],y:b[0][1]},b))||(b[0][0]===b[1][0]&&a[0][1]===a[1][1]&&on({x:b[0][0],y:a[0][1]},a)&&on({x:b[0][0],y:a[0][1]},b));
  const reached=new Set([0]);let size=0;
  while(size!==reached.size){size=reached.size;for(let i=0;i<OFFICE_WALKING_SEGMENTS.length;i++)if(!reached.has(i)&&[...reached].some(j=>intersects(OFFICE_WALKING_SEGMENTS[i],OFFICE_WALKING_SEGMENTS[j])))reached.add(i);}
  assert.equal(reached.size,OFFICE_WALKING_SEGMENTS.length,'floor graph must be connected');
  assert.equal(Object.keys(OFFICE_AGENT_HOMES).length,11);
  for(const home of Object.values(OFFICE_AGENT_HOMES))assert.ok(OFFICE_WALKING_SEGMENTS.some(s=>on(home,s)),home.name);
  for(const room of OFFICE_ROOMS){assert.ok(OFFICE_WALKING_SEGMENTS.some(s=>on(room.door,s)),room.id);assert.ok(OFFICE_WALKING_SEGMENTS.some(s=>on(departmentWorkPoint(room.id),s)),room.id);}
  for(const id of ['server','firewall','core','storage','ups','access','internet'])assert.equal(OFFICE_NODE_ANCHORS[id].departmentId,'maintenance');
});

test('organization and nested geometry are immutable shared data',()=>{
  assert.ok(Object.isFrozen(OFFICE_SEATS));assert.ok(Object.isFrozen(OFFICE_SEATS[0].desk));
  assert.throws(()=>{OFFICE_SEATS[0].desk.x=0;},TypeError);
  assert.throws(()=>{ORGANIZATION_DEPARTMENTS[0].members.push('invented');},TypeError);
  assert.ok(Object.isFrozen(OFFICE_WALKING_SEGMENTS[0][0]));
});

test('navigation segments remain orthogonal, within the campus and never cross a desk',()=>{
  for(const segment of OFFICE_WALKING_SEGMENTS){
    const [a,b]=segment;
    assert.ok(a[0]===b[0]||a[1]===b[1],'orthogonal segment');
    assert.notDeepEqual(a,b,'nonempty segment');
    for(const p of segment){const annexLane=OFFICE_DATA_CENTER_WALKING_SEGMENTS.includes(segment);assert.ok(p[0]>=(annexLane?-155:0)&&p[1]>=0&&p[0]<=OFFICE_WORLD.width&&p[1]<=OFFICE_WORLD.height);}
    for(const post of OFFICE_SEATS){
      const d=post.desk;
      const crosses=a[1]===b[1]
        ?a[1]>d.y-d.h/2&&a[1]<d.y+d.h/2&&Math.max(a[0],b[0])>d.x-d.w/2&&Math.min(a[0],b[0])<d.x+d.w/2
        :a[0]>d.x-d.w/2&&a[0]<d.x+d.w/2&&Math.max(a[1],b[1])>d.y-d.h/2&&Math.min(a[1],b[1])<d.y+d.h/2;
      assert.equal(crosses,false,`navigation crosses ${post.id}`);
    }
  }
});

test('shared furniture stays inside its area without overlapping desks, furniture or navigation',()=>{
  const overlaps=(a,b)=>Math.abs(a.x-b.x)<(a.w+b.w)/2&&Math.abs(a.y-b.y)<(a.h+b.h)/2;
  const areas=[...OFFICE_ROOMS,...OFFICE_SHARED_AREAS];
  assert.equal(new Set(OFFICE_FITTINGS.map(item=>item.id)).size,OFFICE_FITTINGS.length);
  for(const item of OFFICE_FITTINGS){
    const area=areas.find(room=>room.id===item.roomId);
    assert.ok(area,item.id);
    assert.ok(item.x-item.w/2>area.x&&item.x+item.w/2<area.x+area.w&&item.y-item.h/2>area.y&&item.y+item.h/2<area.y+area.h,item.id);
    assert.ok(Object.isFrozen(item));
    for(const post of OFFICE_SEATS)assert.equal(overlaps(item,post.desk),false,`${item.id} overlaps ${post.id}`);
    for(const other of OFFICE_FITTINGS)if(other!==item)assert.equal(overlaps(item,other),false,`${item.id} overlaps ${other.id}`);
    for(const [a,b]of OFFICE_WALKING_SEGMENTS){
      const crosses=a[1]===b[1]
        ?a[1]>item.y-item.h/2&&a[1]<item.y+item.h/2&&Math.max(a[0],b[0])>item.x-item.w/2&&Math.min(a[0],b[0])<item.x+item.w/2
        :a[0]>item.x-item.w/2&&a[0]<item.x+item.w/2&&Math.max(a[1],b[1])>item.y-item.h/2&&Math.min(a[1],b[1])<item.y+item.h/2;
      assert.equal(crosses,false,`navigation crosses ${item.id}`);
    }
  }
});

test('executive and sparse offices, shared lounge and AI manager bay have functional furniture',()=>{
  const kinds=roomId=>OFFICE_FITTINGS.filter(item=>item.roomId===roomId).map(item=>item.kind);
  for(const id of ['general_office','investment','public_affairs','legal'])for(const kind of ['sofa','coffee_table','cabinet'])assert.ok(kinds(id).includes(kind),`${id} ${kind}`);
  assert.equal(kinds('shared_lounge').filter(kind=>kind==='sofa').length,2);
  assert.ok(kinds('shared_lounge').includes('coffee_table'));
  assert.ok(kinds('ai_data').includes('sofa'));
  assert.equal(kinds('research').length,0,'keep the three-row development room clear');
  assert.equal(ORGANIZATION_PEOPLE.length,249,'furnishing does not create staff');
  assert.equal(ORGANIZATION_DEPARTMENTS.length,12,'shared lounge is not a new department');
});

test('compact courtyard campus uses varied room sizes and routes cross walls only through doors',()=>{
  assert.ok(OFFICE_WORLD.width<=1540&&OFFICE_WORLD.height<=1100);
  assert.ok(new Set(OFFICE_ROOMS.map(room=>`${room.w}x${room.h}`)).size>=6);
  assert.deepEqual(new Set(OFFICE_ROOMS.map(room=>room.door.side)),new Set(['bottom','right','top','left']));
  const eps=.001;
  for(const room of OFFICE_ROOMS){
    for(const other of OFFICE_ROOMS)if(other!==room)assert.ok(room.x+room.w<=other.x||other.x+other.w<=room.x||room.y+room.h<=other.y||other.y+other.h<=room.y,`${room.id} overlaps ${other.id}`);
    for(const [a,b]of OFFICE_WALKING_SEGMENTS){
      const crossings=[];
      if(a[0]===b[0]&&a[0]>room.x+eps&&a[0]<room.x+room.w-eps){
        for(const [side,y]of [['top',room.y],['bottom',room.y+room.h]])if(y>=Math.min(a[1],b[1])-eps&&y<=Math.max(a[1],b[1])+eps)crossings.push({side,x:a[0],y});
      }
      if(a[1]===b[1]&&a[1]>room.y+eps&&a[1]<room.y+room.h-eps){
        for(const [side,x]of [['left',room.x],['right',room.x+room.w]])if(x>=Math.min(a[0],b[0])-eps&&x<=Math.max(a[0],b[0])+eps)crossings.push({side,x,y:a[1]});
      }
      for(const point of crossings){
        assert.equal(point.side,room.door.side,`route crosses ${room.id} ${point.side} wall`);
        assert.ok(Math.abs(point.x-room.door.x)+Math.abs(point.y-room.door.y)<=room.door.width/2+eps,`route misses ${room.id} doorway`);
      }
    }
  }
});

test('courtyard landscape leaves desks, furniture and walking lanes clear',()=>{
  const overlaps=(a,b)=>Math.abs(a.x-b.x)<(a.w+b.w)/2&&Math.abs(a.y-b.y)<(a.h+b.h)/2;
  assert.ok(OFFICE_LANDSCAPE.some(item=>item.kind==='pond'));
  assert.ok(OFFICE_LANDSCAPE.some(item=>item.kind==='tree_island'));
  assert.equal(new Set(OFFICE_LANDSCAPE.map(item=>item.id)).size,OFFICE_LANDSCAPE.length);
  for(const item of OFFICE_LANDSCAPE){
    const area=item.roomId?roomForDepartment(item.roomId):OFFICE_SHARED_AREAS[0];
    assert.ok(item.x-item.w/2>area.x&&item.x+item.w/2<area.x+area.w&&item.y-item.h/2>area.y&&item.y+item.h/2<area.y+area.h,item.id);
    for(const other of [...OFFICE_FITTINGS,...OFFICE_SEATS.map(post=>post.desk),...OFFICE_LANDSCAPE])if(other!==item)assert.equal(overlaps(item,other),false,`${item.id} overlaps ${other.id}`);
    for(const [a,b]of OFFICE_WALKING_SEGMENTS){
      const crosses=a[1]===b[1]
        ?a[1]>item.y-item.h/2&&a[1]<item.y+item.h/2&&Math.max(a[0],b[0])>item.x-item.w/2&&Math.min(a[0],b[0])<item.x+item.w/2
        :a[0]>item.x-item.w/2&&a[0]<item.x+item.w/2&&Math.max(a[1],b[1])>item.y-item.h/2&&Math.min(a[1],b[1])<item.y+item.h/2;
      assert.equal(crosses,false,`navigation crosses ${item.id}`);
    }
  }
});

test('overview uses readable representative geometry while preserving exact full rosters',()=>{
  const overview=officeSeatsForView();
  assert.equal(OFFICE_SEATS.length,251);assert.equal(OFFICE_OVERVIEW_SEATS.length,overview.length);
  assert.equal(new Set(overview.map(post=>post.id)).size,overview.length);
  for(const room of OFFICE_ROOMS){
    const visible=overview.filter(post=>post.departmentId===room.id);
    assert.equal(visible.length,room.overviewSeatIds.length);
    if(room.id==='ai_data')assert.equal(visible.length,21);else{assert.equal(visible.length,room.seats.length,'ordinary departments never hide members');for(const post of visible)assert.equal(post,OFFICE_SEATS.find(item=>item.id===post.id),'ordinary overview preserves exact workstation geometry');}
  }
  for(const team of roomForDepartment('ai_data').teamZones){
    const visible=overview.filter(post=>post.teamId===team.id);
    assert.equal(visible.length,4);assert.equal(team.overviewSeatIds.length,4);
    assert.equal(visible.filter(post=>post.role==='head').length,1);
    for(const post of visible){
      assert.equal(post.scale,.72);assert.equal(post.desk.w,64);assert.equal(post.desk.h,28);
      assert.ok(post.x>team.x&&post.x<team.x+team.w&&post.y>team.y&&post.y<team.y+team.h);
      const full=OFFICE_SEATS.find(item=>item.id===post.id);
      assert.equal(full.personId,post.personId);assert.equal(full.role,post.role);assert.equal(full.desk.w,14);
    }
  }
});

test('detail is scoped to a selected department or team and never unfolds all two hundred AI staff on zoom',()=>{
  assert.equal(officeSeatsForView({zoom:20}).length,OFFICE_OVERVIEW_SEATS.length);
  assert.equal(officeSeatsForView({focusedDepartmentId:'ai_data'}).length,OFFICE_OVERVIEW_SEATS.length);
  assert.equal(officeSeatsForView({zoom:20,detailDepartmentId:'ai_data'}).length,OFFICE_OVERVIEW_SEATS.length);
  const team=roomForDepartment('ai_data').teamZones[0];
  const focused=officeSeatsForView({focusedTeamId:team.id});
  assert.equal(focused.filter(post=>post.teamId===team.id).length,6);
  assert.equal(focused.filter(post=>post.teamId===team.id&&post.role==='staff').length,5);
  assert.equal(team.seats.length,41,'representative geometry preserves every real employee');
  assert.deepEqual(focused.filter(post=>post.teamId===team.id).map(post=>post.id).sort(),[...team.detailSeatIds].sort());
  for(const post of focused.filter(post=>post.teamId===team.id)){assert.equal(post.scale,.72);assert.equal(post.desk.w,64);assert.equal(post.desk.h,28);}
  assert.equal(focused.filter(post=>post.departmentId==='ai_data'&&post.teamId!==team.id).length,17);
  assert.equal(officeSeatsForView({zoom:OFFICE_DETAIL_ZOOM-.01,detailTeamId:team.id}).length,OFFICE_OVERVIEW_SEATS.length);
  assert.equal(officeSeatsForView({zoom:OFFICE_DETAIL_ZOOM,detailTeamId:team.id}).length,focused.length);
  const research=officeSeatsForView({focusedDepartmentId:'research'});
  assert.equal(research.filter(post=>post.departmentId==='research').length,9);
  for(const post of research.filter(post=>post.departmentId==='research'))assert.equal(post,OFFICE_SEATS.find(item=>item.id===post.id));
});

test('crowded team samples stay stable across redraws, camera changes and both view levels',()=>{
  for(const team of roomForDepartment('ai_data').teamZones){
    const overview=()=>officeSeatsForView().filter(post=>post.teamId===team.id);
    const detail=()=>officeSeatsForView({focusedTeamId:team.id}).filter(post=>post.teamId===team.id);
    const initialOverview=overview().map(post=>post.id),initialDetail=detail().map(post=>post.id);
    assert.equal(new Set(team.detailSeatIds).size,6);
    assert.ok(team.overviewSeatIds.every(id=>team.detailSeatIds.includes(id)));
    for(let i=0;i<20;i++){officeSeatsForView({focusedTeamId:`ai_data_team_${i%5+1}`,zoom:i+1});assert.deepEqual(overview().map(post=>post.id),initialOverview);assert.deepEqual(detail().map(post=>post.id),initialDetail);}
    for(const post of overview()){const expanded=detail().find(item=>item.id===post.id);assert.deepEqual(post.desk,expanded.desk);assert.equal(post.scale,expanded.scale);}
    for(const post of detail())for(const other of detail())if(post.id!==other.id)assert.ok(Math.abs(post.x-other.x)>=(post.desk.w+other.desk.w)/2||Math.abs(post.desk.y-other.desk.y)>=(post.desk.h+other.desk.h)/2,'normal desks must not overlap');
  }
});

test('readable overview desks do not intersect other visible desks, furniture, landscape or common walking lanes',()=>{
  const overlaps=(a,b)=>Math.abs(a.x-b.x)<(a.w+b.w)/2&&Math.abs(a.y-b.y)<(a.h+b.h)/2;
  const overview=officeSeatsForView();
  for(const post of overview){
    const item=post.desk,room=roomForDepartment(post.departmentId);
    assert.ok(item.x-item.w/2>room.x&&item.x+item.w/2<room.x+room.w&&item.y-item.h/2>room.y&&item.y+item.h/2<room.y+room.h,post.id);
    for(const other of overview)if(other!==post)assert.equal(overlaps(item,other.desk),false,`${post.id} overlaps ${other.id}`);
    for(const other of [...OFFICE_FITTINGS,...OFFICE_LANDSCAPE])assert.equal(overlaps(item,other),false,`${post.id} overlaps ${other.id}`);
    for(const [a,b]of OFFICE_WALKING_SEGMENTS){
      const crosses=a[1]===b[1]
        ?a[1]>item.y-item.h/2&&a[1]<item.y+item.h/2&&Math.max(a[0],b[0])>item.x-item.w/2&&Math.min(a[0],b[0])<item.x+item.w/2
        :a[0]>item.x-item.w/2&&a[0]<item.x+item.w/2&&Math.max(a[1],b[1])>item.y-item.h/2&&Math.min(a[1],b[1])<item.y+item.h/2;
      assert.equal(crosses,false,`navigation crosses overview ${post.id}`);
    }
  }
});

test('company bulletin occupies the empty southeast without changing department rosters or blocking paths',()=>{
  const area=OFFICE_BULLETIN_AREA,items=[area.board,...area.benches,...area.plants];
  assert.equal(area.id,'bulletin');assert.equal(ORGANIZATION_DEPARTMENTS.length,12);assert.equal(ORGANIZATION_PEOPLE.length,249);
  assert.equal(OFFICE_NODE_ANCHORS.bulletin.departmentId,null);assert.equal(canonicalDepartmentId('bulletin'),null);
  assert.ok(Object.isFrozen(area.board));
  for(const [x,y]of area.arrivalLine)assert.ok(OFFICE_WALKING_SEGMENTS.some(([a,b])=>a[1]===y&&b[1]===y&&x>=Math.min(a[0],b[0])&&x<=Math.max(a[0],b[0])),'bulletin visitors arrive on a connected hallway');
  for(const item of items){
    assert.ok(item.x-item.w/2>area.x&&item.x+item.w/2<area.x+area.w&&item.y-item.h/2>area.y&&item.y+item.h/2<area.y+area.h);
    for(const room of OFFICE_ROOMS)assert.ok(item.x+item.w/2<=room.x||item.x-item.w/2>=room.x+room.w||item.y+item.h/2<=room.y||item.y-item.h/2>=room.y+room.h);
    for(const [a,b]of OFFICE_WALKING_SEGMENTS){
      const crosses=a[1]===b[1]
        ?a[1]>item.y-item.h/2&&a[1]<item.y+item.h/2&&Math.max(a[0],b[0])>item.x-item.w/2&&Math.min(a[0],b[0])<item.x+item.w/2
        :a[0]>item.x-item.w/2&&a[0]<item.x+item.w/2&&Math.max(a[1],b[1])>item.y-item.h/2&&Math.min(a[1],b[1])<item.y+item.h/2;
      assert.equal(crosses,false,'bulletin furnishing blocks walkway');
    }
  }
});

test('convenience corner fits the courtyard and leaves the shared table and all walking lanes clear',()=>{
  const area=OFFICE_CONVENIENCE_AREA,courtyard=OFFICE_SHARED_AREAS[0],items=[area.shelf,area.fridge,area.counter];
  const overlaps=(a,b)=>Math.abs(a.x-b.x)<(a.w+b.w)/2&&Math.abs(a.y-b.y)<(a.h+b.h)/2;
  assert.ok(area.x>courtyard.x+courtyard.w/2&&area.y>courtyard.y+courtyard.h/2);
  assert.ok(area.x+area.w<courtyard.x+courtyard.w&&area.y+area.h<courtyard.y+courtyard.h);
  assert.equal(ORGANIZATION_DEPARTMENTS.length,12);assert.equal(ORGANIZATION_PEOPLE.length,249);
  assert.equal(canonicalDepartmentId(area.id),null);assert.ok(Object.isFrozen(area.counter));
  for(const item of items){
    assert.ok(item.x-item.w/2>area.x&&item.x+item.w/2<area.x+area.w&&item.y-item.h/2>area.y&&item.y+item.h/2<area.y+area.h);
    for(const other of [...items,...OFFICE_FITTINGS,...OFFICE_LANDSCAPE])if(other!==item)assert.equal(overlaps(item,other),false,'convenience furnishing overlaps courtyard');
    for(const [a,b]of OFFICE_WALKING_SEGMENTS){
      const crosses=a[1]===b[1]
        ?a[1]>item.y-item.h/2&&a[1]<item.y+item.h/2&&Math.max(a[0],b[0])>item.x-item.w/2&&Math.min(a[0],b[0])<item.x+item.w/2
        :a[0]>item.x-item.w/2&&a[0]<item.x+item.w/2&&Math.max(a[1],b[1])>item.y-item.h/2&&Math.min(a[1],b[1])<item.y+item.h/2;
      assert.equal(crosses,false,'convenience furnishing blocks walkway');
    }
  }
});
