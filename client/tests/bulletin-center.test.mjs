import test from 'node:test';
import assert from 'node:assert/strict';
import {mountBulletinCenter,safeBoardVideo,renderBoardMessages,renderTrainingRows,renderBoardMetrics,renderBoardPreview} from '../src/bulletin-center.js';
import {panelDom,deferred,flush} from './fixtures/office-panel-dom.mjs';
const state=()=>({dashboard:{metrics:[{label:'在办项目',value:3,unit:'项'}]},training:{canManage:true,entries:[]},video:{canManage:true,src:'/media/film.webm',title:'宣传片',version:2},messages:{canPost:true,items:[{id:'m1',authorName:'王敏',body:'已完成',version:3,canDelete:true}],hasMore:true,nextCursor:'m1'}});
function harness(responder){const dom=panelDom(),calls=[],errors=[],closes=[];let answer=responder||(()=>({board:state()})),blocked=false;const ui=mountBulletinCenter({...dom,request:async(path,method='GET',body)=>{calls.push({path,method,body});return answer({path,method,body});},session:{actor:{id:'me',name:'王敏'}},getSnapshot:()=>({projects:[{id:'p1',name:'研发项目',status:'active'}],documents:[{id:'d1',status:'draft',createdAt:new Date().toISOString()}]}),onError:message=>errors.push(message),onClose:()=>closes.push(dialog.open),isBlocked:()=>blocked,random:()=>0});const dialog=dom.container.children[0],tv=dom.chrome.children[0];return{...dom,ui,calls,errors,closes,dialog,tv,respond(fn){answer=fn;},block(value){blocked=value;},form(kind){return dialog.forms.find(form=>form.dataset.bulletinForm===kind);},set(kind,values){const form=this.form(kind);for(const[name,value]of Object.entries(values)){const field=form.elements.find(field=>field.name===name);assert.ok(field,name);field.value=String(value);}return form;},click(action,data={}){const button=dialog.buttons.find(button=>button.dataset.bulletinAction===action&&(!data.id||button.dataset.id===data.id))||tv.buttons.find(button=>button.dataset.bulletinAction===action)||{dataset:{bulletinAction:action,...data},closest(){return this;}};return dialog.emit('click',button);},tab(section){return dialog.emit('click',{dataset:{bulletinTab:section},closest(){return this;}});},submit(form){return dialog.emit('submit',form);},destroy(){ui.destroy();dom.restore();}};}

test('all board content is escaped and video URLs cannot create executable or credential-bearing markup',()=>{const attack='<img src=x onerror=alert(1)>';for(const html of[renderBoardMessages({items:[{id:'x" onclick="bad',authorName:attack,body:attack}]}),renderTrainingRows([{employeeName:attack,department:attack}]),renderBoardMetrics([{label:attack,value:2}])]){assert.doesNotMatch(html,/<img|onclick="bad/);assert.match(html,/&lt;img/);}for(const value of['javascript:alert(1)','http://insecure/video.mp4','https://user:password@example.test/a.mp4','/media/../secret.mp4'])assert.equal(safeBoardVideo(value),'');assert.equal(safeBoardVideo('/media/film.webm'),'/media/film.webm');});

test('loading, mutation and pagination completions cannot repopulate or report errors after sign-out destroys the board',async()=>{for(const operation of['load','page','users','post']){const slow=deferred(),h=harness();try{let pending;if(operation==='load'){h.respond(()=>slow.promise);pending=h.ui.open();}else{await h.ui.open(operation==='users'?'training':'messages');h.respond(()=>slow.promise);pending=operation==='page'?h.click('more-messages'):operation==='users'?h.click('manage-training'):h.submit(h.set('message',{body:'旧账号私密草稿'}));}h.ui.destroy();slow.reject(new Error('旧账户私密错误'));await pending;await flush();assert.equal(h.dialog.innerHTML,'');assert.equal(h.tv.innerHTML,'');assert.equal(h.dialog.removed,true);assert.deepEqual(h.errors,[]);assert.equal(h.timers.size,0);}finally{h.destroy();}}});

test('message posting locks edits, prevents duplicate native submission and retries the same request id without losing its draft',async()=>{const h=harness(),slow=deferred();try{await h.ui.open('messages');h.respond(({method})=>method==='POST'?slow.promise:{board:state()});const form=h.set('message',{body:'<script>真实留言</script>'}),first=h.submit(form);assert.equal(form.elements[0].disabled,true);assert.equal(await h.submit(form),true,'a blocked duplicate still prevents browser navigation');assert.equal(h.calls.filter(call=>call.method==='POST').length,1);slow.reject(new Error('网络中断'));await first;assert.equal(h.form('message').elements[0].value,'<script>真实留言</script>');assert.doesNotMatch(h.dialog.innerHTML,/<script>/);const id=h.calls.find(call=>call.method==='POST').body._requestId;h.respond(({method})=>method==='POST'?{message:{id:'new'}}:{board:state()});await h.submit(h.form('message'));assert.equal(h.calls.filter(call=>call.method==='POST').at(-1).body._requestId,id);assert.equal(h.form('message').elements[0].value,'');assert.equal(h.dialog.attrs['aria-busy'],'false');}finally{h.destroy();}});

test('message drafts survive tabs and close, while training and video drafts survive failed writes',async()=>{const h=harness();try{await h.ui.open('messages');h.set('message',{body:'未发布的想法'});await h.tab('training');await h.tab('messages');assert.equal(h.form('message').elements[0].value,'未发布的想法');await h.ui.close();await h.ui.open('messages');assert.equal(h.form('message').elements[0].value,'未发布的想法');h.respond(({path})=>path==='/api/erp/users'?{users:[{id:'e1',name:'真实员工',department:'商务部'}]}:{board:state()});await h.tab('training');await h.click('manage-training');assert.match(h.dialog.innerHTML,/真实员工/);let form=h.set('training',{employeeId:'e1',periodStart:'2026-10-01',periodEnd:'2026-10-22',completedCount:20,accuracy:99.5});h.respond(()=>{throw new Error('保存失败');});await h.submit(form);assert.equal(h.form('training').elements.find(f=>f.name==='completedCount').value,'20');assert.equal(h.form('training').elements.find(f=>f.name==='employeeId').value,'e1');await h.tab('video');h.dialog.details.open=true;form=h.set('video',{src:'/media/new-film.mp4',title:'新版公司片'});await h.submit(form);assert.equal(h.form('video').elements.find(f=>f.name==='title').value,'新版公司片');assert.equal(h.dialog.details.open,true);}finally{h.destroy();}});

test('pagination serializes requests and removes repeated message ids, while a board refresh supersedes stale pagination',async()=>{const h=harness(),slow=deferred();try{await h.ui.open('messages');h.respond(()=>slow.promise);const first=h.click('more-messages');await h.click('more-messages');assert.equal(h.calls.filter(call=>call.path.includes('?before=')).length,1);slow.resolve({messages:{hasMore:false,items:[{id:'m1',body:'重复'},{id:'m2',body:'更早留言'}]}});await first;assert.equal((h.dialog.innerHTML.match(/data-message-id="m1"/g)||[]).length,1);assert.match(h.dialog.innerHTML,/更早留言/);assert.doesNotMatch(h.dialog.innerHTML,/more-messages/);const next=deferred();h.respond(({path})=>path.includes('?before=')?next.promise:{board:state()});await h.ui.refresh();const pending=h.click('more-messages');const fresh=state();fresh.messages.items=[{id:'fresh',body:'最新数据'}];h.respond(()=>({board:fresh}));await h.ui.refresh();next.resolve({messages:{items:[{id:'old',body:'迟到分页'}]}});await pending;assert.match(h.dialog.innerHTML,/最新数据/);assert.doesNotMatch(h.dialog.innerHTML,/迟到分页/);}finally{h.destroy();}});

test('deletion carries its actual version, training sends numeric results and video settings carry version checks',async()=>{const h=harness();try{await h.ui.open('messages');h.respond(({path,method})=>method==='GET'?path==='/api/erp/users'?{users:[{id:'e1',name:'员工'}]}:{board:state()}:{ok:true});await h.click('delete-message',{id:'m1'});const del=h.calls.find(call=>call.path.endsWith('/m1/delete'));assert.equal(del.body.expectedVersion,3);assert.ok(del.body._requestId);await h.tab('training');await h.click('manage-training');await h.submit(h.set('training',{employeeId:'e1',periodStart:'2026-10-01',periodEnd:'2026-10-22',completedCount:30,accuracy:98.25}));const score=h.calls.find(call=>call.path.endsWith('/training')).body.entries[0];assert.equal(score.completedCount,30);assert.equal(score.accuracy,98.25);assert.equal(score.expectedVersion,0);await h.tab('video');await h.submit(h.set('video',{src:'/media/approved.mp4',title:'公司片'}));const video=h.calls.find(call=>call.path.endsWith('/video'));assert.equal(video.body.expectedVersion,2);assert.equal(video.body.src,'/media/approved.mp4');}finally{h.destroy();}});

test('the public wall never schedules an unsolicited popup and each hovered section previews its own real content',async()=>{
 const h=harness();try{
  assert.equal(h.timers.size,0);assert.equal(h.tv.hidden,true);assert.equal(h.tv.className,'bulletin-preview');
  for(const section of['dashboard','training','video','messages']){
   await h.ui.preview(section,{x:900,y:700});assert.equal(h.tv.hidden,false);assert.equal(h.tv.dataset.section,section);
   assert.equal(h.tv.attrs['aria-busy'],'false');assert.equal(h.calls.at(-1).path,'/api/erp/bulletin');
   assert.match(h.tv.innerHTML,new RegExp(({dashboard:'近30天新增单据与已验收任务趋势',training:'暂无已登记的标注成绩',video:'宣传片',messages:'已完成'})[section]));
   h.ui.hidePreview();assert.equal(h.tv.hidden,true);assert.equal(h.tv.innerHTML,'');
  }
  assert.equal(h.timers.size,0);
 }finally{h.destroy();}
});

test('blocked and hidden hovers do not load, and late or obsolete responses cannot revive a departed preview',async()=>{
 const h=harness(),slow=deferred();try{
  h.block(true);await h.ui.preview('dashboard',{x:500,y:500});assert.equal(h.calls.length,0);h.block(false);
  h.respond(()=>slow.promise);const pending=h.ui.preview('dashboard',{x:500,y:500});h.ui.hidePreview();slow.resolve({board:state()});await pending;assert.equal(h.tv.hidden,true);
  h.respond(()=>({board:state()}));await h.ui.preview('messages',{x:500,y:500});assert.equal(h.tv.hidden,false);h.block(true);h.event('focusin');assert.equal(h.tv.hidden,true);h.block(false);
  h.document.hidden=true;await h.ui.preview('video',{x:500,y:500});assert.equal(h.tv.hidden,true);h.event('visibilitychange');assert.equal(h.timers.size,0);
 }finally{h.destroy();}
});

test('only the latest hovered board region paints when its shared request completes',async()=>{
 const h=harness(),slow=deferred();try{h.respond(()=>slow.promise);const first=h.ui.preview('dashboard',{x:400,y:400}),second=h.ui.preview('messages',{x:800,y:600});slow.resolve({board:state()});await Promise.all([first,second]);assert.equal(h.tv.dataset.section,'messages');assert.match(h.tv.innerHTML,/已完成/);assert.doesNotMatch(h.tv.innerHTML,/在办项目/);}finally{h.destroy();}
});

test('failed loads retry and unsupported fullscreen never traps the board or leaks errors after destruction',async()=>{const h=harness();try{h.respond(()=>{throw new Error('暂时无法读取');});await h.ui.open();assert.match(h.dialog.innerHTML,/暂时无法读取/);h.respond(()=>({board:state()}));await h.click('retry');assert.match(h.dialog.innerHTML,/在办项目/);assert.doesNotMatch(h.dialog.innerHTML,/暂时无法读取/);h.dialog.requestFullscreen=async()=>{throw new Error('全屏被拒绝');};await h.click('fullscreen');assert.equal(h.dialog.dataset.expanded,'true');assert.doesNotMatch(h.dialog.innerHTML,/全屏被拒绝/);h.document.fullscreenElement=h.dialog;h.document.exitFullscreen=()=>{throw new Error('不支持退出');};await h.ui.close();assert.equal(h.dialog.open,false);}finally{h.destroy();}});

test('a completed write waits for a new read instead of reusing an older in-flight snapshot',async()=>{const h=harness(),old=deferred(),fresh=deferred();try{await h.ui.open('messages');let reads=0;h.respond(({method})=>method==='POST'?{message:{id:'new'}}:++reads===1?old.promise:fresh.promise);const background=h.ui.refresh();const form=h.set('message',{body:'新留言'}),write=h.submit(form);await flush();assert.equal(reads,1);assert.equal(h.dialog.attrs['aria-busy'],'true');old.resolve({board:state()});await background;await flush();assert.equal(reads,2,'the write needs an actual read after the mutation');assert.equal(h.dialog.attrs['aria-busy'],'true');const saved=state();saved.messages.items=[{id:'new',body:'新留言'}];fresh.resolve({board:saved});await write;assert.equal(h.dialog.attrs['aria-busy'],'false');assert.match(h.dialog.innerHTML,/data-message-id="new"/);assert.equal(h.form('message').elements[0].value,'');}finally{h.destroy();}});

test('a private successful late response cannot revive a destroyed board or training editor',async()=>{for(const kind of['load','users']){const h=harness(),slow=deferred();try{if(kind==='users')await h.ui.open('training');h.respond(()=>slow.promise);const pending=kind==='load'?h.ui.open():h.click('manage-training');h.ui.destroy();slow.resolve(kind==='load'?{board:{...state(),dashboard:{metrics:[{label:'迟到的私密项目',value:99}]}}}:{users:[{id:'old',name:'前员工的私密姓名'}]});await pending;assert.equal(h.dialog.innerHTML,'');assert.equal(h.tv.innerHTML,'');assert.deepEqual(h.errors,[]);assert.equal(h.timers.size,0);}finally{h.destroy();}}});

test('a failed hover refresh never presents cached metrics as a fresh update',async()=>{const h=harness();try{await h.ui.open();await h.ui.close();h.respond(()=>{throw new Error('无法更新');});await h.ui.preview('dashboard',{x:700,y:500});assert.equal(h.tv.hidden,false);assert.equal(h.tv.dataset.failed,'true');assert.match(h.tv.innerHTML,/暂时无法读取/);assert.doesNotMatch(h.tv.innerHTML,/在办项目/);}finally{h.destroy();}});

test('each selected region opens its actual content directly in application-sized presentation',async()=>{const h=harness();try{for(const section of['dashboard','training','video','messages']){await h.ui.open(section,{expanded:true});assert.equal(h.dialog.dataset.expanded,'true');assert.match(h.dialog.innerHTML,new RegExp(`data-bulletin-tab="${section}" aria-current="page"`));assert.equal(h.tv.hidden,true);await h.ui.close();assert.equal(h.dialog.dataset.expanded,'false');}assert.equal(h.timers.size,0);}finally{h.destroy();}});

test('preview content is escaped and unknown regions contain no fabricated content',()=>{const attack='<img src=x onerror=alert(1)>';for(const section of['dashboard','training','video','messages']){const source={dashboard:{metrics:[{label:attack,value:1}]},training:{entries:[{employeeName:attack,rank:1,completedCount:2,accuracy:99}]},video:{src:'/media/office-film.webm',title:attack},messages:{items:[{authorName:attack,body:attack}]}};const html=renderBoardPreview(section,source);assert.doesNotMatch(html,/<img src=x/);if(section!=='dashboard')assert.match(html,/&lt;img/);}assert.equal(renderBoardPreview('unknown',{}),'');});

test('application presentation expands and exits even when native fullscreen is denied or unsupported, preserving its draft',async()=>{for(const unsupported of[false,true]){const h=harness();try{await h.ui.open('messages');const form=h.set('message',{body:'大屏切换前的草稿'});if(unsupported)h.dialog.requestFullscreen=undefined;else h.dialog.requestFullscreen=async()=>{throw Error('permission denied');};await h.click('fullscreen');assert.equal(h.dialog.dataset.expanded,'true');let control=h.dialog.querySelector('[data-bulletin-action="fullscreen"]');assert.equal(control.getAttribute('aria-label'),'退出大屏');assert.equal(control.getAttribute('aria-pressed'),'true');assert.equal(h.form('message'),form,'presentation does not replace the live form');await h.click('fullscreen');assert.equal(h.dialog.dataset.expanded,'false');assert.equal(control.getAttribute('aria-label'),'大屏展示');assert.equal(h.form('message').elements[0].value,'大屏切换前的草稿');await h.click('fullscreen');assert.equal(await h.dialog.emit('cancel',h.dialog),true);await flush();assert.equal(h.ui.isOpen,false);assert.equal(h.dialog.dataset.expanded,'false');await h.ui.open('messages');assert.equal(h.form('message').elements[0].value,'大屏切换前的草稿');assert.equal(h.dialog.dataset.expanded,'false');assert.deepEqual(h.errors,[]);}finally{h.destroy();}}});

test('native fullscreen exit synchronizes presentation state and destroyed panels remove every fullscreen listener',async()=>{const h=harness();try{await h.ui.open();await h.click('fullscreen');assert.equal(h.document.fullscreenElement,h.dialog);h.event('fullscreenchange');assert.equal(h.dialog.dataset.expanded,'true');h.document.fullscreenElement=null;h.event('fullscreenchange');assert.equal(h.dialog.dataset.expanded,'false');assert.equal(h.dialog.querySelector('[data-bulletin-action="fullscreen"]').getAttribute('aria-label'),'大屏展示');await h.click('fullscreen');h.ui.destroy();await flush();assert.equal(h.dialog.dataset.expanded,'false');assert.equal(h.document.fullscreenElement,null);assert.equal(h.listeners.has('fullscreenchange'),false);assert.equal(h.listeners.has('focusin'),false);assert.equal(h.listeners.has('visibilitychange'),false);}finally{h.destroy();}});

test('a native fullscreen permission response arriving after close cannot expand a closed board',async()=>{const h=harness(),slow=deferred();try{await h.ui.open();h.dialog.requestFullscreen=async()=>{await slow.promise;h.document.fullscreenElement=h.dialog;};const pending=h.click('fullscreen');assert.equal(h.dialog.dataset.expanded,'true');await h.ui.close();slow.resolve();await pending;assert.equal(h.ui.isOpen,false);assert.equal(h.dialog.dataset.expanded,'false');assert.equal(h.document.fullscreenElement,null);}finally{h.destroy();}});


test('hover previews stay next to their map panel under a scaled stage, and flip only at the viewport edge',async()=>{
 const h=harness();try{
  h.chrome.getBoundingClientRect=()=>({left:100,top:50,width:720,height:450});h.chrome.clientWidth=1440;h.chrome.clientHeight=900;
  await h.ui.preview('dashboard',{x:600,y:400});assert.equal(h.tv.style.left,'842px');assert.equal(h.tv.style.top,'478px');assert.equal(h.tv.dataset.placement,'above');
  await h.ui.preview('messages',{x:105,y:60});assert.equal(h.tv.style.left,'12px');assert.equal(h.tv.style.top,'40px');assert.equal(h.tv.dataset.placement,'below');
  h.ui.hidePreview();assert.equal(h.tv.hidden,true);
 }finally{h.destroy();}
});


test('a late leave from a previous wall region cannot dismiss the newly hovered preview',async()=>{const h=harness(),slow=deferred();try{await h.ui.preview('training',{x:600,y:500});h.respond(()=>slow.promise);const pending=h.ui.preview('video',{x:600,y:550});h.ui.hidePreview('training');assert.equal(h.tv.hidden,false);assert.equal(h.tv.dataset.section,'video');slow.resolve({board:state()});await pending;assert.equal(h.tv.hidden,false);assert.match(h.tv.innerHTML,/宣传片/);h.ui.hidePreview('video');assert.equal(h.tv.hidden,true);await h.ui.preview('messages',{x:700,y:550});h.ui.hidePreview();assert.equal(h.tv.hidden,true,'camera/global leave still clears the current preview');}finally{h.destroy();}});


test('board close callbacks follow the actual surface across API, button, Escape and native closing exactly once',async()=>{
 const h=harness();try{
  await h.ui.close();assert.deepEqual(h.closes,[]);
  for(const channel of ['api','button','escape','native']){
   await h.ui.open();assert.equal(h.ui.isOpen,true);
   if(channel==='api')await h.ui.close();
   if(channel==='button')await h.click('close');
   if(channel==='escape')await h.dialog.emit('cancel',h.dialog);
   if(channel==='native'){h.dialog.close();await h.dialog.emit('close',h.dialog);}
   assert.equal(h.ui.isOpen,false);assert.equal(h.closes.length,['api','button','escape','native'].indexOf(channel)+1);
   await h.dialog.emit('close',h.dialog);await h.ui.close();assert.equal(h.closes.at(-1),false);
  }
  await h.ui.open();await h.dialog.emit('close',h.dialog);assert.equal(h.closes.length,4,'a queued close from the previous display cannot close or notify the new surface');
  h.ui.destroy();await h.dialog.emit('close',h.dialog);assert.equal(h.closes.length,4);
 }finally{h.destroy();}
});

test('a delayed board fullscreen exit cannot close a reopened selection or notify after destruction',async()=>{
 for(const destination of ['reopen','destroy']){
  const h=harness(),slow=deferred();try{
   await h.ui.open('video',{expanded:true});h.document.fullscreenElement=h.dialog;h.document.exitFullscreen=()=>slow.promise;
   const pending=h.ui.close();
   if(destination==='reopen')await h.ui.open('messages',{expanded:true});else h.ui.destroy();
   h.document.fullscreenElement=null;slow.resolve();await pending;
   assert.deepEqual(h.closes,[]);
   if(destination==='reopen'){assert.equal(h.ui.isOpen,true);assert.equal(h.dialog.dataset.section,'messages');assert.equal(h.dialog.dataset.expanded,'true');await h.ui.close();assert.deepEqual(h.closes,[false]);}
  }finally{h.destroy();}
 }
});
