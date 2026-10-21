import test from 'node:test';
import assert from 'node:assert/strict';
import {employeeAppearance,employeeAppearanceKey,employeeAppearanceStyle,EMPLOYEE_APPEARANCE,EMPLOYEE_WARDROBE} from '../src/employee-appearance.mjs';
import {HUMAN_EMPLOYEES} from '../src/people.js';
import {normalizeOfficePresence} from '../src/erp-presence.js';

test('six fixed outfits are shared by employees and assistants, with stable per-person selection',()=>{
 assert.equal(EMPLOYEE_WARDROBE.length,6);assert.equal(new Set(EMPLOYEE_WARDROBE.map(x=>x.garment)).size,6);assert.ok(Object.isFrozen(EMPLOYEE_APPEARANCE));
 const chosen=new Set();for(let i=0;i<250;i++){const id=`colleague-${i}@laisengou.com`,human=employeeAppearance({id}),virtual=employeeAppearance({id,virtual:true});chosen.add(human.outfitId);assert.deepEqual(employeeAppearance({id}),human);assert.equal(human.outfitId,virtual.outfitId);assert.equal(human.uniform,virtual.uniform);assert.equal(human.synthetic,false);assert.equal(virtual.synthetic,true);assert.notEqual(human.face,virtual.face);assert.ok(Object.isFrozen(human));}
 assert.equal(chosen.size,6);
});

test('named outfit selection is validated and cannot change synthetic identity',()=>{
 const selected=employeeAppearance({id:'zhangqiang@laisengou.com',outfitId:'plum',virtual:true});assert.equal(selected.outfitId,'plum');assert.equal(selected.synthetic,true);assert.equal(employeeAppearance({id:'A@LAISENGOU.COM'}).outfitId,employeeAppearance({id:'a@laisengou.com'}).outfitId);
 assert.equal(employeeAppearance({id:'stable',outfitId:'<script>'}).outfitId,employeeAppearance(false,'stable').outfitId);assert.equal(employeeAppearanceKey({id:'uid',username:'a@laisengou.com'}),'a@laisengou.com');
 for(const appearance of [selected,employeeAppearance(false,'human')])assert.match(employeeAppearanceStyle(appearance),/^--shirt:#[0-9a-f]{6};/);
});

test('a real account keeps the outfit of its primary workplace when moving between departments',()=>{
 const key=employeeAppearanceKey({id:'private-id',username:'fixture@example.invalid',organizationSeatIds:['research_staff_002','maintenance_manager_001']});
 assert.equal(key,'research_staff_002');
 assert.deepEqual(employeeAppearance({id:key}),employeeAppearance({id:'research_staff_002'}));
 assert.equal(employeeAppearanceKey({appearanceKey:'research_staff_002',id:'private-id'}),key);
});

test('authenticated presence and functional representatives use stable wardrobe identity, ignoring external colors',()=>{
 for(const person of HUMAN_EMPLOYEES)assert.equal(person.color,employeeAppearance(false,person.id).uniform);
 const people=normalizeOfficePresence({enabled:true,people:[{id:'a',username:'lin@laisengou.com',online:true,color:'#ff0000'},{id:'b',online:true,outfitId:'linen'}]}).people;
 assert.equal(people.length,2);assert.equal(people[0].appearanceKey,'lin@laisengou.com');assert.equal(people[0].color,employeeAppearance(false,'lin@laisengou.com').uniform);assert.equal(people[1].outfitId,'linen');assert.equal(people[1].color,employeeAppearance(false,'b','linen').uniform);
});
