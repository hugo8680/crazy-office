import test from 'node:test';
import assert from 'node:assert/strict';
import {organizationOccupant,setOrganizationOccupants,subscribeOrganizationOccupants} from '../src/organization-occupants.mjs';

test('认证目录将兼任岗位关联同一个人，清理后不留姓名；重复响应不触发重绘',()=>{
  setOrganizationOccupants([]);let changes=0;const unsubscribe=subscribeOrganizationOccupants(()=>changes++);
  const record={personId:'same-person',name:'测试人员',username:'fixture@example.invalid',title:'经理',seatIds:['primary','shared']};
  setOrganizationOccupants([record]);assert.equal(changes,1);
  assert.equal(organizationOccupant('primary'),organizationOccupant({id:'shared'}));
  assert.equal(organizationOccupant('primary').name,record.name);
  setOrganizationOccupants([record]);assert.equal(changes,1);
  assert.ok(Object.isFrozen(organizationOccupant('primary')));
  setOrganizationOccupants([]);assert.equal(changes,2);assert.equal(organizationOccupant('primary'),null);
  unsubscribe();setOrganizationOccupants([record]);assert.equal(changes,2);setOrganizationOccupants([]);
});
