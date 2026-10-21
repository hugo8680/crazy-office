import test from 'node:test';
import assert from 'node:assert/strict';
import {OFFICE_EXTERIOR} from '../src/office-environment.mjs';
import {OFFICE_WORLD,OFFICE_SEATS} from '../src/organization.mjs';
import {renderExteriorEnvironment,renderOrganizationPositionContents,ORGANIZATION_POSITION_META} from '../src/scene-floor2d.mjs';
import {employeeAppearance} from '../src/employee-appearance.mjs';
import {setOrganizationOccupants} from '../src/organization-occupants.mjs';

test('exterior adds a bounded passive garden and arrival area without increasing camera fit or routing bounds',()=>{
 assert.deepEqual(OFFICE_WORLD,{x:0,y:0,width:1390,height:1100});assert.ok(Object.isFrozen(OFFICE_EXTERIOR));assert.ok(Object.isFrozen(OFFICE_EXTERIOR.trees));assert.equal(OFFICE_EXTERIOR.trees.length,11);
 for(const tree of OFFICE_EXTERIOR.trees)assert.ok(tree.x<0||tree.y<0||tree.x>OFFICE_WORLD.width||tree.y>OFFICE_WORLD.height);
 const markup=renderExteriorEnvironment();assert.match(markup,/pointer-events="none" aria-hidden="true"/);assert.equal([...markup.matchAll(/data-exterior-tree=/g)].length,11);assert.match(markup,/cnl-exterior-bicycle/);assert.match(markup,/cnl-exterior-parking/);assert.doesNotMatch(markup,/<filter|animation|data-node|tabindex|role="button"/);assert.ok(markup.length<24000,'static exterior remains a small one-time SVG group');
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
