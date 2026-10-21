import test from 'node:test';
import assert from 'node:assert/strict';
import {employeeAppearance,EMPLOYEE_APPEARANCE} from '../src/employee-appearance.mjs';
import {HUMAN_EMPLOYEES} from '../src/people.js';
import {normalizeOfficePresence} from '../src/erp-presence.js';

test('functional and authenticated humans share warm clothing, distinct from virtual uniforms',()=>{
 const human=employeeAppearance(false),virtual=employeeAppearance(true);
 assert.notEqual(human.uniform,virtual.uniform);
 assert.ok(Object.isFrozen(EMPLOYEE_APPEARANCE));assert.ok(Object.isFrozen(human));
 for(const p of HUMAN_EMPLOYEES)assert.equal(p.color,human.uniform);
 const people=normalizeOfficePresence({enabled:true,people:[{id:'a',online:true,color:virtual.uniform},{id:'b',online:true}]}).people;
 assert.equal(people.length,2);for(const p of people)assert.equal(p.color,human.uniform,'presence cannot impersonate a virtual uniform');
});
