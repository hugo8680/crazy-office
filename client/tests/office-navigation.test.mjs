import test from 'node:test';
import assert from 'node:assert/strict';
import {createOfficeNavigation,officeArea,officeAreaAt} from '../src/office-navigation.mjs';
import {OFFICE_ROOMS} from '../src/organization.mjs';
import {presencePosition} from '../src/erp-presence.js';
const deferred=()=>{let resolve;return {promise:new Promise(yes=>resolve=yes),get resolve(){return resolve;}};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){const calls=[],moves=[],self={id:'me',...presencePosition('hr_admin')},presence={ready:Promise.resolve(),self,async movePoint(point,options){if(!options.shouldRun())return false;moves.push(point);Object.assign(self,point);return true;}};let owner=presence,allowed=true,blocked=false;const scene={focusArea:id=>calls.push(id),resetView:()=>calls.push('home')};const nav=createOfficeNavigation({scene,getPresence:()=>owner,requireAccount:()=>allowed,isBlocked:()=>blocked});return{nav,presence,self,calls,moves,setOwner:value=>owner=value,setAllowed:value=>allowed=value,setBlocked:value=>blocked=value};}
test('each department click sends one authenticated destination and focuses that office without changing business membership',async()=>{
 const f=fixture();for(const room of OFFICE_ROOMS){await f.nav.enterArea(room.id);assert.equal(f.calls.at(-1),room.id);assert.deepEqual({x:f.self.x,y:f.self.y},presencePosition(room.id));}assert.equal(f.self.id,'me');assert.equal(f.self.department,undefined);
});
test('AI teams arrive below the desks, and each shared amenity has a bounded real destination',async()=>{
 const f=fixture();for(const room of OFFICE_ROOMS)for(const team of room.teamZones){await f.nav.enterArea(team.id);assert.equal(f.calls.at(-1),team.id);assert.deepEqual(f.moves.at(-1),{x:team.x+team.w/2,y:team.y+team.h+4});}for(const id of ['bulletin','convenience','recreation','data_center','shared_lounge']){await f.nav.enterArea(id);assert.equal(f.calls.at(-1),id);assert.ok(f.self.x>=-155&&f.self.x<=1370&&f.self.y>=20&&f.self.y<=1080);}
});
test('floor clicks preserve their coordinates, while login and closing surfaces restore the current area without sending a move',async()=>{
 const f=fixture(),room=officeArea('finance'),point={x:room.x+24,y:room.y+room.h-20};await f.nav.movePoint(point);assert.deepEqual(f.moves,[point]);f.nav.restore();assert.equal(f.calls.at(-1),'finance');f.nav.locateSelf();assert.equal(f.calls.at(-1),'finance');assert.equal(f.moves.length,1);f.nav.home();f.nav.restore();assert.equal(f.calls.at(-1),'home');
});
test('latest destination replaces a waiting intent and repeated clicks share one request',async()=>{
 const f=fixture(),wait=deferred();f.presence.ready=wait.promise;const first=f.nav.enterArea('finance'),second=f.nav.enterArea('research'),duplicate=f.nav.enterArea('research');assert.equal(second,duplicate);wait.resolve();assert.equal(await first,false);assert.equal(await second,true);assert.deepEqual(f.moves,[presencePosition('research')]);assert.equal(f.calls.at(-1),'research');await f.nav.enterArea('research');assert.equal(f.moves.length,1);
});
test('returning to the initial office while an earlier move is in flight still submits the return command',async()=>{
 const f=fixture(),wait=deferred(),queue=[];let chain=Promise.resolve();f.presence.movePoint=(point,options)=>{const job=chain.then(async()=>{if(!options.shouldRun())return false;queue.push(point);if(queue.length===1)await wait.promise;Object.assign(f.self,point);return true;});chain=job;return job;};const outward=f.nav.enterArea('finance');await tick();const back=f.nav.enterArea('hr_admin');wait.resolve();await Promise.all([outward,back]);assert.equal(queue.length,2);assert.deepEqual(queue.at(-1),presencePosition('hr_admin'));assert.equal(f.calls.at(-1),'hr_admin');assert.deepEqual({x:f.self.x,y:f.self.y},presencePosition('hr_admin'));
});
test('sign-out, identity replacement, blocked surfaces and invalid coordinates cannot submit stale moves',async()=>{
 const f=fixture(),wait=deferred();f.presence.ready=wait.promise;const moving=f.nav.enterArea('finance');f.nav.reset();f.setOwner(null);wait.resolve();assert.equal(await moving,false);assert.deepEqual(f.moves,[]);f.setOwner(f.presence);f.setAllowed(false);assert.equal(await f.nav.enterArea('finance'),false);f.setAllowed(true);f.setBlocked(true);assert.equal(await f.nav.enterArea('finance'),false);f.setBlocked(false);for(const p of [{x:NaN,y:400},{x:200,y:0},{x:2000,y:200}])assert.equal(await f.nav.movePoint(p),false);assert.equal(await f.nav.enterArea('missing'),false);f.nav.destroy();assert.equal(await f.nav.enterArea('finance'),false);assert.deepEqual(f.moves,[]);
});


test('walking inside an already framed office keeps the user zoom instead of fitting the same area again',async()=>{
 const f=fixture();await f.nav.enterArea('finance');const before=f.calls.length,room=officeArea('finance');await f.nav.movePoint({x:room.x+20,y:room.y+room.h-20});assert.equal(f.calls.length,before);assert.equal(f.moves.length,2);await f.nav.enterArea('finance');assert.equal(f.calls.at(-1),'finance','explicitly choosing the office still restores its framing');
});
