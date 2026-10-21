import test from 'node:test';
import assert from 'node:assert/strict';
import {greetingForPerson} from '../src/person-greeting.mjs';

test('real employees greet by the office time in Shanghai at each time boundary',()=>{
  for(const [time,text]of [
    ['2026-10-20T20:59:59Z','晚上好！'],
    ['2026-10-20T21:00:00Z','早上好！'],
    ['2026-10-21T02:59:59Z','早上好！'],
    ['2026-10-21T03:00:00Z','中午好！'],
    ['2026-10-21T05:59:59Z','中午好！'],
    ['2026-10-21T06:00:00Z','下午好！'],
    ['2026-10-21T10:59:59Z','下午好！'],
    ['2026-10-21T11:00:00Z','晚上好！'],
    ['2026-10-21T16:00:00Z','晚上好！'],
  ])assert.deepEqual(greetingForPerson({now:new Date(time)}),{kind:'human',text});
});

test('virtual employees always return the exact stand-by greeting and robot identity',()=>{
  for(const time of ['2026-10-21T00:00:00Z','2026-10-21T04:00:00Z','2026-10-21T08:00:00Z','2026-10-21T15:00:00Z']){
    assert.deepEqual(greetingForPerson({virtual:true,now:new Date(time)}),{kind:'robot',text:'随时待命！'});
  }
  assert.deepEqual(greetingForPerson({virtual:true,now:new Date(NaN)}),{kind:'robot',text:'随时待命！'});
});

test('a clock change is reflected on the next greeting, without caching stale text',()=>{
  assert.equal(greetingForPerson({now:'2026-10-21T02:59:59Z'}).text,'早上好！');
  assert.equal(greetingForPerson({now:'2026-10-21T03:00:00Z'}).text,'中午好！');
  assert.equal(greetingForPerson({now:new Date(NaN)}).text,'你好！');
});
