import test from 'node:test';
import assert from 'node:assert/strict';
import {OFFICE_CAMERA_LIMITS,clampOfficeScale,officeWheelScale,officePinchScale,officeCameraChanged} from '../src/office-camera.mjs';

test('automatic framing leaves ample manual zoom room and rejects invalid scale inputs',()=>{
  assert.ok(OFFICE_CAMERA_LIMITS.maxManualScale>OFFICE_CAMERA_LIMITS.maxAutomaticScale+8);
  assert.equal(clampOfficeScale(100,{automatic:true}),18);assert.equal(clampOfficeScale(100),32);assert.equal(clampOfficeScale(-4),.72);
  for(const invalid of[NaN,Infinity,-Infinity,undefined,'invalid'])assert.equal(clampOfficeScale(invalid),1);
  assert.equal(clampOfficeScale(NaN,{fallback:2}),2);
});

test('pixel, line and page wheel units share one bounded zoom policy and reverse immediately at both limits',()=>{
  assert.equal(officeWheelScale(6.5,-60),officeWheelScale(6.5,-60/16,1));assert.equal(officeWheelScale(6.5,-60),officeWheelScale(6.5,-60/900,2,900));
  assert.ok(officeWheelScale(6.5,-80)>6.5);
  for(const mode of[0,1,2]){let scale=1;for(let i=0;i<100;i++)scale=officeWheelScale(scale,-1000,mode);assert.equal(scale,32);assert.ok(officeWheelScale(scale,1,mode)<32);for(let i=0;i<100;i++)scale=officeWheelScale(scale,1000,mode);assert.equal(scale,.72);assert.ok(officeWheelScale(scale,-1,mode)>.72);}
  for(const invalid of[NaN,Infinity,undefined])assert.equal(officeWheelScale(4,invalid),4);
});

test('incremental pinch immediately reverses at limits and no-op camera targets are detectable',()=>{
  assert.equal(officePinchScale(31,2),32);assert.ok(officePinchScale(32,.99)<32);assert.equal(officePinchScale(.8,.1),.72);assert.ok(officePinchScale(.72,1.01)>.72);
  for(const invalid of[NaN,Infinity,0,-1])assert.equal(officePinchScale(4,invalid),4);
  assert.equal(officeCameraChanged({scale:24,panX:1},{scale:24,panX:1}),false);assert.equal(officeCameraChanged({scale:24},{scale:24-1e-9}),false);assert.equal(officeCameraChanged({scale:24},{scale:23.9}),true);
});

test('wheel input distinguishes two-finger scroll from pinch and retains momentum type until the sequence ends',async()=>{
 const {createOfficeWheelInput,officeScreenDirection}=await import('../src/office-camera.mjs');let time=0;const input=createOfficeWheelInput({now:()=>time});
 assert.equal(input({deltaMode:0,deltaY:3.5}).kind,'pan');time+=16;assert.equal(input({deltaMode:0,deltaY:96}).kind,'pan');
 time+=200;assert.equal(input({deltaMode:0,deltaY:-120}).kind,'zoom');time+=16;assert.equal(input({deltaMode:0,deltaY:4}).kind,'zoom','small reversal immediately reverses a mouse wheel zoom');
 assert.equal(input({deltaMode:0,deltaY:4,ctrlKey:true}).kind,'zoom');assert.equal(input({deltaMode:0,deltaX:12,deltaY:4}).kind,'pan');
 assert.deepEqual(officeScreenDirection(0,-1),{x:0,y:-1});assert.deepEqual(officeScreenDirection(1,0,{right:{x:0,y:1},up:{x:1,y:0}}),{x:0,y:1});
});
