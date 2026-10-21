import test from 'node:test';
import assert from 'node:assert/strict';
import {OFFICE_EXTERIOR} from '../src/office-environment.mjs';
import {OFFICE_WORLD,OFFICE_SEATS,OFFICE_ROOMS,OFFICE_SHARED_AREAS,OFFICE_RECREATION_AREA,OFFICE_DATA_CENTER,OFFICE_WALKING_SEGMENTS} from '../src/organization.mjs';
import {renderExteriorEnvironment,renderOrganizationPositionContents,renderRecreationArea,renderDataCenter,ORGANIZATION_POSITION_META} from '../src/scene-floor2d.mjs';
import {employeeAppearance} from '../src/employee-appearance.mjs';
import {setOrganizationOccupants} from '../src/organization-occupants.mjs';

test('exterior adds a bounded passive garden and arrival area without increasing camera fit or routing bounds',()=>{
 assert.deepEqual(OFFICE_WORLD,{x:0,y:0,width:1390,height:1100});assert.ok(Object.isFrozen(OFFICE_EXTERIOR));assert.ok(Object.isFrozen(OFFICE_EXTERIOR.trees));assert.equal(OFFICE_EXTERIOR.trees.length,11);
 for(const tree of OFFICE_EXTERIOR.trees)assert.ok(tree.x<0||tree.y<0||tree.x>OFFICE_WORLD.width||tree.y>OFFICE_WORLD.height);
 const markup=renderExteriorEnvironment();assert.match(markup,/pointer-events="none" aria-hidden="true"/);assert.equal([...markup.matchAll(/data-exterior-tree=/g)].length,11);assert.match(markup,/cnl-exterior-bicycle/);assert.match(markup,/cnl-exterior-parking/);assert.doesNotMatch(markup,/<filter|animation|data-node|tabindex|role="button"/);assert.ok(markup.length<32000,'static exterior remains a small one-time SVG group');
});

test('two posts held by one colleague share the same primary-post wardrobe identity',()=>{
 const seats=OFFICE_SEATS.filter(seat=>seat.personId==='business_channels_manager');assert.equal(seats.length,2);assert.equal(new Set(seats.map(seat=>ORGANIZATION_POSITION_META[seat.id].appearance.outfitId)).size,1);assert.equal(ORGANIZATION_POSITION_META[seats[0].id].appearance.uniform,employeeAppearance(false,seats.find(seat=>seat.primarySeat).id).uniform);
});

test('authenticated directory names are escaped and title markers never infer an employee promotion from map geometry',()=>{
 const seat=OFFICE_SEATS.find(seat=>seat.role==='manager'),artwork={use:()=>'',seated:()=>''};
 try{setOrganizationOccupants([{name:'<林青>',username:'test@example.invalid',title:'',seatIds:[seat.id]}]);const result=renderOrganizationPositionContents(seat,artwork);assert.match(result,/&lt;林青&gt;/);assert.doesNotMatch(result,/cnl-position-rank|<林青>/);
 setOrganizationOccupants([{name:'林青',username:'test@example.invalid',title:'总经理',seatIds:[seat.id]}]);assert.match(renderOrganizationPositionContents(seat,artwork),/>总经理<\/text>/);
 }finally{setOrganizationOccupants([]);}
});


test('recreation equipment fits the lower-left courtyard without crossing its walkways or changing the twelve departments',()=>{
 const area=OFFICE_RECREATION_AREA,lounge=OFFICE_SHARED_AREAS.find(item=>item.id==='shared_lounge');assert.ok(area.x>lounge.x&&area.y>lounge.y&&area.x+area.w<lounge.x+lounge.w&&area.y+area.h<lounge.y+lounge.h);assert.equal(OFFICE_ROOMS.length,12);
 const fixtures=[area.treadmill,area.weightRack,area.bench,area.poolTable,area.cueRack];for(const fixture of fixtures){assert.ok(fixture.x-fixture.w/2>area.x&&fixture.x+fixture.w/2<area.x+area.w&&fixture.y-fixture.h/2>area.y&&fixture.y+fixture.h/2<area.y+area.h);for(const [a,b]of OFFICE_WALKING_SEGMENTS){const crosses=a[1]===b[1]?a[1]>fixture.y-fixture.h/2&&a[1]<fixture.y+fixture.h/2&&Math.max(a[0],b[0])>fixture.x-fixture.w/2&&Math.min(a[0],b[0])<fixture.x+fixture.w/2:a[0]>fixture.x-fixture.w/2&&a[0]<fixture.x+fixture.w/2&&Math.max(a[1],b[1])>fixture.y-fixture.h/2&&Math.min(a[1],b[1])<fixture.y+fixture.h/2;assert.equal(crosses,false);}}
 const markup=renderRecreationArea(area);for(const kind of ['treadmill','weights','bench','pool','cues'])assert.match(markup,new RegExp(`data-recreation-fixture="${kind}"`));assert.equal([...markup.matchAll(/fill="#344f46"/g)].length,6,'six physical pool-table pockets');assert.doesNotMatch(markup,/data-node|data-position|tabindex|role="button"/);
});

test('the independent data center sits beside maintenance with six detailed rack enclosures and no invented department',()=>{
 const area=OFFICE_DATA_CENTER;assert.equal(area.title,'莱森购数据中心');assert.ok(area.x+area.w<=40);assert.equal(area.racks.length,6);assert.ok(Object.isFrozen(area.racks));for(const room of OFFICE_ROOMS)assert.ok(area.x+area.w<=room.x||area.x>=room.x+room.w||area.y+area.h<=room.y||area.y>=room.y+room.h);
 for(const rack of area.racks)assert.ok(rack.x-rack.w/2>area.x&&rack.x+rack.w/2<area.x+area.w&&rack.y-rack.h/2>area.y&&rack.y+rack.h/2<area.y+area.h);
 const markup=renderDataCenter(area,{use:(name,x,y,scale)=>`<use data-symbol="${name}" transform="translate(${x} ${y}) scale(${scale})"/>`});assert.equal([...markup.matchAll(/data-data-center-rack=/g)].length,6);assert.equal([...markup.matchAll(/data-symbol="server"/g)].length,6);for(const fixture of ['console','cooling','ups'])assert.match(markup,new RegExp(`data-data-center-fixture="${fixture}"`));assert.doesNotMatch(markup,/data-node=|tabindex=|role="button"/);
});

test('four custom vehicle silhouettes share fixed parking slots and use different body and grille geometry',()=>{
 assert.deepEqual(OFFICE_EXTERIOR.vehicles.map(car=>car.make),['mercedes','bmw','audi','land_rover']);assert.equal(new Set(OFFICE_EXTERIOR.vehicles.map(car=>car.id)).size,4);assert.equal(OFFICE_EXTERIOR.vehicles.filter(car=>car.body==='suv').length,1);
 const parking=OFFICE_EXTERIOR.parking;for(const car of OFFICE_EXTERIOR.vehicles)assert.ok(car.x-car.w/2>parking.x&&car.x+car.w/2<parking.x+parking.w&&car.y-car.h/2>parking.y&&car.y+car.h/2<parking.y+parking.h);
 const markup=renderExteriorEnvironment();for(const make of ['mercedes','bmw','audi','land_rover'])assert.match(markup,new RegExp(`data-make="${make}"`));assert.equal([...markup.matchAll(/class="cnl-exterior-vehicle"/g)].length,4);assert.doesNotMatch(markup,/https?:|<image|<filter|animation/);
});
