import test from 'node:test';
import assert from 'node:assert/strict';
import {createOfficeNavigation,officeArea,officeAreaAt} from '../src/office-navigation.mjs';
import {OFFICE_ROOMS,OFFICE_FITTINGS} from '../src/organization.mjs';
import {presencePosition} from '../src/erp-presence.js';
import {routeBetweenPoints} from '../src/scene-motion.js';
const deferred=()=>{let resolve;return {promise:new Promise(yes=>resolve=yes),get resolve(){return resolve;}};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){const calls=[],moves=[],self={id:'me',...presencePosition('hr_admin')},presence={ready:Promise.resolve(),self,async movePoint(point,options){if(!options.shouldRun())return false;moves.push(point);Object.assign(self,point);return true;}};let owner=presence,allowed=true,blocked=false;const scene={focusArea:id=>calls.push(id),resetView:()=>calls.push('home')};const nav=createOfficeNavigation({scene,getPresence:()=>owner,requireAccount:()=>allowed,isBlocked:()=>blocked});return{nav,scene,presence,self,calls,moves,setOwner:value=>owner=value,setAllowed:value=>allowed=value,setBlocked:value=>blocked=value};}
const arrive=(f,point=f.moves.at(-1))=>f.nav.observePresence({point,person:{id:f.self.id,current:true,point},walking:false,arrived:true});
test('department destinations wait for the rendered arrival before framing an office',async()=>{
 const f=fixture();for(const room of OFFICE_ROOMS){const before=f.calls.length;await f.nav.enterArea(room.id);assert.equal(f.calls.length,before,'HTTP success is not a walking arrival');assert.deepEqual({x:f.self.x,y:f.self.y},presencePosition(room.id));arrive(f);assert.equal(f.calls.at(-1),room.id);}assert.equal(f.self.id,'me');assert.equal(f.self.department,undefined);
});
test('compatibility team and amenity destinations never expand an AI team or invent a department',async()=>{
 const f=fixture();for(const room of OFFICE_ROOMS)for(const team of room.teamZones){await f.nav.enterArea(team.id);assert.deepEqual(f.moves.at(-1),{x:team.x+team.w/2,y:team.y+team.h-4});arrive(f);assert.equal(f.calls.at(-1),'ai_data');f.nav.locateSelf();assert.equal(f.calls.at(-1),'ai_data');}for(const id of ['bulletin','convenience','recreation','data_center','shared_lounge']){const before=f.calls.length;await f.nav.enterArea(id);arrive(f);assert.equal(f.calls.length,before);assert.ok(f.self.x>=-155&&f.self.x<=1370&&f.self.y>=20&&f.self.y<=1080);}
});
test('floor walking frames once after entering the real target doorway, while close restores without another move',async()=>{
 const f=fixture(),room=officeArea('finance'),point={x:room.x+24,y:room.y+room.h-20};await f.nav.movePoint(point);assert.deepEqual(f.moves,[point]);assert.deepEqual(f.calls,[]);
 const step=p=>f.nav.observePresence({point:p,person:{id:f.self.id,current:true,point},walking:true,arrived:false});step({x:285,y:710});assert.equal(f.calls.length,0);step({x:265,y:710});assert.deepEqual(f.calls,['finance']);arrive(f,point);assert.equal(f.calls.length,1);f.nav.restore();assert.equal(f.calls.at(-1),'finance');f.nav.locateSelf();assert.equal(f.calls.at(-1),'finance');assert.equal(f.moves.length,1);f.nav.home();f.nav.restore();assert.equal(f.calls.at(-1),'home');
});
test('latest destination replaces a waiting intent and repeated clicks share one request',async()=>{
 const f=fixture(),wait=deferred();f.presence.ready=wait.promise;const first=f.nav.enterArea('finance'),second=f.nav.enterArea('research'),duplicate=f.nav.enterArea('research');assert.equal(second,duplicate);wait.resolve();assert.equal(await first,false);assert.equal(await second,true);assert.deepEqual(f.moves,[presencePosition('research')]);assert.equal(f.calls.length,0);arrive(f);assert.equal(f.calls.at(-1),'research');await f.nav.enterArea('research');assert.equal(f.moves.length,1);
});
test('returning to the initial office while an earlier move is in flight still submits the return command',async()=>{
 const f=fixture(),wait=deferred(),queue=[];let chain=Promise.resolve();f.presence.movePoint=(point,options)=>{const job=chain.then(async()=>{if(!options.shouldRun())return false;queue.push(point);if(queue.length===1)await wait.promise;Object.assign(f.self,point);return true;});chain=job;return job;};const outward=f.nav.enterArea('finance');await tick();const back=f.nav.enterArea('hr_admin');wait.resolve();await Promise.all([outward,back]);assert.equal(queue.length,2);assert.deepEqual(queue.at(-1),presencePosition('hr_admin'));assert.equal(f.calls.length,0);arrive(f,queue.at(-1));assert.equal(f.calls.at(-1),'hr_admin');assert.deepEqual({x:f.self.x,y:f.self.y},presencePosition('hr_admin'));
});
test('sign-out, identity replacement, blocked surfaces and invalid coordinates cannot submit stale moves',async()=>{
 const f=fixture(),wait=deferred();f.presence.ready=wait.promise;const moving=f.nav.enterArea('finance');f.nav.reset();f.setOwner(null);wait.resolve();assert.equal(await moving,false);assert.deepEqual(f.moves,[]);f.setOwner(f.presence);f.setAllowed(false);assert.equal(await f.nav.enterArea('finance'),false);f.setAllowed(true);f.setBlocked(true);assert.equal(await f.nav.enterArea('finance'),false);f.setBlocked(false);for(const p of [{x:NaN,y:400},{x:200,y:0},{x:2000,y:200}])assert.equal(await f.nav.movePoint(p),false);assert.equal(await f.nav.enterArea('missing'),false);f.nav.destroy();assert.equal(await f.nav.enterArea('finance'),false);assert.deepEqual(f.moves,[]);
});
test('walking inside an already framed office keeps manual zoom and never reframes every floor click',async()=>{
 const f=fixture();await f.nav.enterArea('finance');arrive(f);const before=f.calls.length,room=officeArea('finance');await f.nav.movePoint({x:room.x+20,y:room.y+room.h-20});arrive(f);assert.equal(f.calls.length,before);assert.equal(f.moves.length,2);await f.nav.enterArea('finance');arrive(f);assert.equal(f.calls.length,before);
});
test('closing a surface preserves manual overview and department cameras without sending a walk or refitting',async()=>{
 const f=fixture();await f.nav.enterArea('finance');arrive(f);const moves=f.moves.length,calls=f.calls.length;
 assert.equal(f.nav.setContext(null),true);assert.equal(f.nav.areaId,null);assert.equal(f.calls.length,calls);f.nav.restore();assert.equal(f.calls.length,calls);assert.equal(f.moves.length,moves);
 assert.equal(f.nav.setContext('research'),true);assert.equal(f.nav.areaId,'research');f.nav.restore();assert.equal(f.calls.length,calls);assert.equal(f.moves.length,moves);assert.equal(f.nav.setContext('unknown'),false);assert.equal(f.nav.areaId,'research');f.nav.destroy();assert.equal(f.nav.setContext('finance'),false);assert.equal(f.nav.areaId,null);
});
test('manual context changes cancel only framing and never swallow a queued physical destination',async()=>{
 for(const next of[null,'research']){const f=fixture(),wait=deferred();f.presence.ready=wait.promise;f.nav.setContext('finance');const pending=f.nav.enterArea('business');assert.equal(f.nav.setContext(next),true);wait.resolve();assert.equal(await pending,true);assert.equal(f.nav.areaId,next);assert.deepEqual(f.moves,[presencePosition('business')]);arrive(f);f.nav.restore();assert.deepEqual(f.calls,[]);}
});
test('a matching framing callback cannot cancel its own accepted arrival',async()=>{
 const f=fixture();f.scene.focusArea=id=>{f.calls.push(id);f.nav.setContext(id);};await f.nav.enterArea('finance');assert.equal(f.moves.length,1);assert.equal(arrive(f),true);assert.equal(f.nav.areaId,'finance');assert.deepEqual(f.calls,['finance']);f.nav.restore();assert.equal(f.moves.length,1);
});
test('only the current employee and matching route can focus, with real arrival fallback after a coarse frame',async()=>{
 const f=fixture();await f.nav.enterArea('finance');const destination=f.moves[0],step={point:destination,walking:false,arrived:true};
 assert.equal(f.nav.observePresence({...step,person:{id:'other',point:destination}}),false);assert.equal(f.nav.observePresence({...step,person:{id:'me',point:presencePosition('research')}}),false);assert.equal(f.nav.observePresence({...step,person:{id:'me',point:destination},arrived:false}),false);assert.equal(f.calls.length,0);assert.equal(arrive(f),true);assert.deepEqual(f.calls,['finance']);assert.equal(arrive(f),false);
});
test('manual camera intent cancels only automatic framing and cannot cancel an already requested walk',async()=>{
 const f=fixture(),wait=deferred();f.presence.movePoint=async point=>{f.moves.push(point);await wait.promise;return true;};const pending=f.nav.enterArea('finance');await tick();assert.equal(f.nav.cancelAutoFocus(),true);wait.resolve();assert.equal(await pending,true);arrive(f);assert.equal(f.calls.length,0);assert.equal(f.moves.length,1);
});
test('an actual arrival emitted during a synchronous presence response is retained until that request is accepted',async()=>{
 const f=fixture();f.presence.movePoint=async point=>{f.moves.push(point);Object.assign(f.self,point);f.nav.observePresence({point,person:{id:'me',point},walking:false,arrived:true});assert.equal(f.calls.length,0);return true;};assert.equal(await f.nav.enterArea('finance'),true);assert.deepEqual(f.calls,['finance']);
});
test('a rejected move, reset or replaced employee cannot trigger a late framing step',async()=>{
 for(const action of['reject','reset','identity','home']){const f=fixture();if(action==='reject')f.presence.movePoint=async()=>false;await f.nav.enterArea('finance');if(action==='reset')f.nav.reset();if(action==='identity')f.setOwner({...f.presence,self:{...f.self,id:'other'}});if(action==='home')f.nav.home();arrive(f,presencePosition('finance'));assert.equal(f.calls.filter(id=>id==='finance').length,0,action);}
});

test('closing a work window consumes a real arrival received while the window held the camera',async()=>{
 const f=fixture();await f.nav.enterArea('finance');f.setBlocked(true);assert.equal(arrive(f),false);assert.equal(f.calls.length,0);
 f.setBlocked(false);assert.equal(f.nav.restore(),true);assert.deepEqual(f.calls,['finance']);assert.equal(f.nav.areaId,'finance');assert.equal(f.moves.length,1);
});

test('a furniture click submits a reachable floor correction and waits for that actual arrival',async()=>{
 const f=fixture(),sofa=OFFICE_FITTINGS.find(item=>item.id==='legal_sofa_1'),target={x:sofa.x,y:sofa.y},start={...f.self};
 assert.equal(await f.nav.movePoint(target),true);assert.equal(f.moves.length,1);const resolved=f.moves[0];assert.notDeepEqual(resolved,target);assert.deepEqual(routeBetweenPoints(start,resolved).at(-1),resolved);assert.deepEqual(f.calls,[]);
 assert.equal(f.nav.observePresence({point:resolved,person:{id:f.self.id,point:resolved},walking:false,arrived:true}),true);assert.deepEqual(f.calls,['legal']);
});

test('navigation preflights against the actual drawn position, refusing an unusable origin without HTTP or a fake camera arrival',async()=>{
 const f=fixture(),sofa=OFFICE_FITTINGS.find(item=>item.id==='legal_sofa_1');
 // A valid old server goal must not mask an unusable drawn origin.
 f.scene.getPresenceState=()=>({positions:{me:{x:NaN,y:sofa.y}}});
 assert.equal(await f.nav.movePoint(presencePosition('finance')),false);assert.deepEqual(f.moves,[]);assert.deepEqual(f.calls,[]);
 f.scene.getPresenceState=()=>({positions:{me:presencePosition('research')}});
 assert.equal(await f.nav.movePoint(presencePosition('finance')),true);assert.equal(f.moves.length,1);
});

test('old saved furniture positions can submit a legal exit without pretending the employee has already arrived',async()=>{
 const f=fixture(),sofa=OFFICE_FITTINGS.find(item=>item.id==='legal_sofa_1'),inside={x:sofa.x,y:sofa.y},target=presencePosition('legal');Object.assign(f.self,inside);f.scene.getPresenceState=()=>({positions:{me:inside}});
 assert.equal(await f.nav.movePoint(target),true);assert.deepEqual(f.moves,[target]);assert.deepEqual(f.calls,[]);const path=routeBetweenPoints(inside,target);assert.deepEqual(path[0],inside);assert.notDeepEqual(path[1],target);
 assert.equal(f.nav.observePresence({point:path[1],person:{id:f.self.id,point:target},walking:true,arrived:false}),false);assert.deepEqual(f.calls,[]);
 assert.equal(f.nav.observePresence({point:target,person:{id:f.self.id,point:target},walking:false,arrived:true}),true);assert.deepEqual(f.calls,['legal']);
});

function localFixture(){
 const f=fixture(),updates=[],clears=[],targets=[];let drawn={x:285,y:775};
 f.scene.getPresenceState=()=>({positions:{me:{...drawn}}});
 f.scene.screenDirectionToWorld=(x,y)=>({x:-y,y:x});
 f.scene.setLocalPresencePoint=(id,point,options)=>{drawn={...point};updates.push({id,point:{...point},...options});return true;};
 f.scene.clearLocalPresencePoint=id=>clears.push(id);f.scene.setNavigationTarget=point=>targets.push(point&&{...point});
 return{...f,updates,clears,targets,drawn:()=>({...drawn}),setDrawn:point=>drawn={...point}};
}
test('keyboard steering uses camera-relative direction locally and persists only once at the released visible point',async()=>{
 const f=localFixture(),start=f.drawn();assert.equal(f.nav.beginKeyboard(),true);assert.equal(f.moves.length,0);
 for(let i=0;i<30;i++)assert.equal(f.nav.stepKeyboard({x:0,y:-1},16),true);
 assert.equal(f.moves.length,0,'render frames never create HTTP commands');assert.ok(f.drawn().x>start.x);assert.equal(f.drawn().y,start.y);assert.equal(f.updates.at(-1).heading,'right');
 const end=f.drawn();f.setBlocked(true);assert.equal(f.nav.stepKeyboard({x:0,y:-1},16),false);assert.deepEqual(f.drawn(),end);
 assert.equal(await f.nav.finishKeyboard(),true);assert.deepEqual(f.moves,[end]);assert.deepEqual(f.clears,['me']);assert.equal(f.updates.at(-1).moving,false);assert.equal(await f.nav.finishKeyboard(),false);
});
test('keyboard control immediately replaces a queued click, and late responses cannot remove the local owner',async()=>{
 const f=localFixture(),wait=deferred();f.presence.ready=wait.promise;const click=f.nav.enterArea('finance');
 assert.equal(f.nav.beginKeyboard(),true);f.nav.stepKeyboard({x:0,y:-1},16);wait.resolve();assert.equal(await click,false);assert.deepEqual(f.moves,[]);assert.deepEqual(f.clears,[]);
 const end=f.drawn();assert.equal(await f.nav.finishKeyboard(),true);assert.deepEqual(f.moves,[end]);assert.deepEqual(f.clears,['me']);
});
test('new keyboard ownership survives a slow prior release and sign-out prevents queued position writes',async()=>{
 const f=localFixture(),wait=deferred();f.presence.movePoint=async(point,{shouldRun})=>{await wait.promise;if(!shouldRun())return false;f.moves.push({...point});return true;};
 assert.equal(f.nav.beginKeyboard(),true);f.nav.stepKeyboard({x:0,y:-1},16);const first=f.nav.finishKeyboard();assert.equal(f.nav.beginKeyboard(),true);f.nav.stepKeyboard({x:0,y:-1},16);
 wait.resolve();assert.equal(await first,false);assert.deepEqual(f.clears,[]);assert.deepEqual(f.moves,[]);const last=f.drawn();assert.equal(await f.nav.finishKeyboard(),true);assert.deepEqual(f.moves,[last]);assert.deepEqual(f.clears,['me']);
 assert.equal(f.nav.beginKeyboard(),true);f.nav.stepKeyboard({x:0,y:-1},16);f.nav.reset();f.setOwner(null);assert.equal(await f.nav.finishKeyboard(),false);assert.deepEqual(f.moves,[last]);assert.equal(f.nav.beginKeyboard(),false);
});
test('a floor target replaces a pending keyboard save and releases its override only after the new route is accepted',async()=>{
 const f=localFixture(),wait=deferred(),jobs=[];let chain=Promise.resolve();
 f.presence.movePoint=(point,{shouldRun})=>{const job=chain.then(async()=>{await wait.promise;if(!shouldRun())return false;f.moves.push({...point});return true;});chain=job; jobs.push(job);return job;};
 f.nav.beginKeyboard();f.nav.stepKeyboard({x:0,y:-1},16);const save=f.nav.finishKeyboard(),click=f.nav.enterArea('finance');await tick();assert.deepEqual(f.clears,[]);
 wait.resolve();await Promise.all([save,click]);assert.deepEqual(f.moves,[presencePosition('finance')]);assert.deepEqual(f.clears,['me']);assert.deepEqual(f.targets.at(-1),presencePosition('finance'));assert.equal(f.nav.walking,true);
 arrive(f,presencePosition('finance'));assert.equal(f.targets.at(-1),null);assert.equal(f.nav.walking,false);
});
test('the destination indicator survives a manual camera gesture, but a stop saves the visible position and cancels framing',async()=>{
 const f=localFixture();await f.nav.enterArea('finance');const destination=f.moves[0];assert.deepEqual(f.targets.at(-1),destination);
 f.nav.cancelAutoFocus();assert.deepEqual(f.targets.at(-1),destination);f.setDrawn({x:285,y:690});assert.equal(await f.nav.stopWalking(),true);assert.deepEqual(f.moves.at(-1),{x:285,y:690});assert.equal(f.targets.at(-1),null);assert.deepEqual(f.calls,[]);arrive(f,destination);assert.deepEqual(f.calls,[]);
});
test('walking directly through a department door frames only once and leaving through the door returns to overview',async()=>{
 const f=localFixture(),room=officeArea('research');f.scene.screenDirectionToWorld=(x,y)=>({x,y});f.setDrawn({x:room.door.x,y:room.y-2});
 assert.equal(f.nav.beginKeyboard(),true);f.nav.stepKeyboard({x:0,y:1},40);assert.equal(f.nav.areaId,room.id);assert.deepEqual(f.calls,[room.id]);
 f.nav.stepKeyboard({x:0,y:1},16);assert.deepEqual(f.calls,[room.id]);f.nav.stepKeyboard({x:0,y:-1},40);f.nav.stepKeyboard({x:0,y:-1},40);assert.equal(f.nav.areaId,null);assert.deepEqual(f.calls,[room.id,'home']);await f.nav.finishKeyboard();
});
test('a modal opened after the move was sent cannot strand acceptance, arrival or the destination indicator',async()=>{
 const f=localFixture(),wait=deferred();f.presence.movePoint=async point=>{f.moves.push({...point});await wait.promise;return true;};const moving=f.nav.enterArea('finance');await tick();
 f.setBlocked(true);wait.resolve();assert.equal(await moving,true);assert.equal(f.nav.walking,true);assert.equal(arrive(f),false);assert.equal(f.targets.at(-1),null);assert.equal(f.nav.walking,false);assert.deepEqual(f.calls,[]);
 f.setBlocked(false);f.nav.restore();assert.deepEqual(f.calls,['finance']);assert.equal(f.nav.areaId,'finance');
});
test('Home returns the camera to overview while an already requested walk and its target remain valid',async()=>{
 const f=localFixture(),wait=deferred();f.presence.ready=wait.promise;const moving=f.nav.enterArea('finance');f.nav.home();wait.resolve();assert.equal(await moving,true);assert.deepEqual(f.moves,[presencePosition('finance')]);assert.deepEqual(f.calls,['home']);arrive(f);assert.deepEqual(f.calls,['home']);assert.equal(f.targets.at(-1),null);
});
test('explicit self location frames the drawn department then ensures the employee remains above the dock after the fit',()=>{
 const f=fixture(),checks=[],drawn=presencePosition('research');Object.assign(f.self,presencePosition('finance'));f.scene.getPresenceState=()=>({positions:{me:drawn}});f.scene.ensurePresenceVisible=(id,options)=>checks.push({id,...options});
 assert.equal(f.nav.locateSelf(),true);assert.deepEqual(f.calls,['research']);assert.deepEqual(checks,[{id:'me',afterFit:true}]);assert.deepEqual(f.moves,[]);
 f.nav.restore();f.nav.observePresence({person:{id:'me',point:drawn},point:drawn,walking:false,arrived:false});assert.equal(checks.length,1,'a presence refresh or a panel close never adds a camera correction');
 f.setBlocked(true);assert.equal(f.nav.locateSelf(),false);assert.equal(checks.length,1);
});
