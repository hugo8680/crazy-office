import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './fixtures/session-harness.mjs';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../src/session-ui.js',import.meta.url),'utf8');
const css=await readFile(new URL('../src/session-ui.css',import.meta.url),'utf8');
const AUTH={authenticated:true,username:'lin',expiresAt:'2099-01-01T00:00:00Z',actor:{id:'staff-1',name:'林青',username:'lin',department:'项目部',title:'项目经理',roles:['employee','project_manager'],source:'employee'}};
const PASSWORD='employee-password-2026',TOKEN='t'.repeat(43);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});

test('密码可按需查看，关闭与重开时恢复掩码并清空，不保留上次明文状态',async()=>{
  const h=harness();await h.ui.ready;
  const field=h.element('#session-password');field.value=PASSWORD;
  h.click('toggle-password');assert.equal(field.type,'text');
  assert.equal(h.element('[data-session-action="toggle-password"]').getAttribute('aria-pressed'),'true');
  h.ui.close();assert.equal(field.value,'');assert.equal(field.type,'password');
  h.ui.open();assert.equal(field.type,'password');assert.equal(field.value,'');h.destroy();
});

test('匿名访问只读取公开会话，办公室内显示登录，不请求业务或跳转',async()=>{
  const h=harness();await h.ui.ready;
  assert.equal(h.dialog.open,true);assert.equal(h.element('#session-title').textContent,'登录');assert.equal(h.element('#session-login-form').hidden,false);
  assert.deepEqual(h.requests.map(r=>r.url),['/api/session']);assert.deepEqual(h.redirects,[]);assert.equal(h.events.authenticated.length,0);
  const req=h.requests[0];assert.equal(req.options.credentials,'same-origin');assert.equal(req.options.cache,'no-store');assert.equal(req.options.referrerPolicy,'no-referrer');h.destroy();
});

test('登录保持同页，防止重复提交，成功清除口令并交回真实会话',async()=>{
  const h=harness();await h.ui.ready;const pending=deferred();h.setResponder(()=>pending.promise);
  const first=h.login(' lin ');await h.login();assert.equal(h.requests.length,2);assert.equal(h.element('#session-password').disabled,true);
  assert.deepEqual(JSON.parse(h.requests[1].options.body),{username:'lin',password:PASSWORD});
  pending.resolve(response({session:AUTH}));await first;
  assert.equal(h.ui.session.username,'lin');assert.equal(h.events.authenticated.length,1);assert.equal(h.dialog.open,false);assert.equal(h.element('#session-password').value,'');assert.equal(h.element('#session-password').disabled,false);assert.deepEqual(h.redirects,[]);h.destroy();
});

test('登录失败或不完整成功响应不授权，也不回显服务端诊断中的凭据',async()=>{
  const h=harness();await h.ui.ready;
  for(const server of [response({error:PASSWORD+' sk-secret'},401),response({error:'stack and secret'},500),response({session:{username:'lin'}})]){
    h.setResponder(async()=>server);await h.login();assert.equal(h.ui.session,null);assert.equal(h.events.authenticated.length,0);assert.equal(h.element('#session-password').value,'');assert.equal(h.element('#session-login-form').hidden,false);assert.equal(h.element('#session-password').disabled,false);assert.doesNotMatch(h.element('#session-login-error').textContent,/sk-secret|stack|employee-password/);
  }
  h.setResponder(async()=>response({},429));await h.login();assert.match(h.element('#session-login-error').textContent,/尝试过多/);h.destroy();
});

test('失效通知清理会话，原地重新登录，过时探测结果不能恢复旧身份',async()=>{
  const h=harness({session:AUTH});await h.ui.ready;const late=deferred();h.setResponder(()=>late.promise);const refresh=h.ui.refresh();
  h.ui.requireLogin('登录已过期，请重新登录。');assert.equal(h.ui.session,null);assert.equal(h.events.expired,1);assert.equal(h.dialog.open,true);assert.equal(h.element('#session-message').textContent,'登录已过期，请重新登录。');
  late.resolve(response({session:AUTH}));await refresh;assert.equal(h.ui.session,null);assert.equal(h.events.authenticated.length,1);assert.equal(h.element('#session-title').textContent,'登录');h.destroy();
});

test('首次探测晚于登录返回时不覆盖新身份',async()=>{
  const probe=deferred(),h=harness({responder:()=>probe.promise});h.setResponder(async()=>response({session:AUTH}));await h.login();probe.resolve(response({session:{authenticated:false}}));await h.ui.ready;
  assert.equal(h.ui.session.username,'lin');assert.equal(h.dialog.open,false);assert.equal(h.events.authenticated.length,1);h.destroy();
});

test('后台撤销的会话在探测后通知主界面清理业务，改密过程中不插入并行探测',async()=>{
  const h=harness({session:AUTH});await h.ui.ready;h.setResponder(async()=>response({session:{authenticated:false}}));await h.ui.refresh();
  assert.equal(h.ui.session,null);assert.equal(h.events.expired,1);assert.match(h.element('#session-message').textContent,/登录已过期/);h.destroy();
  const active=harness({session:AUTH});await active.ui.ready;active.ui.open();active.click('password');const pending=deferred();active.setResponder(()=>pending.promise);const change=active.password();await active.ui.refresh();assert.equal(active.requests.length,2);pending.resolve(response({ok:true}));await change;assert.equal(active.events.signedOut,1);active.destroy();
});

test('账户显示本人资料且不会把姓名作为 HTML 注入；原始管理账号不提供无效改密入口',async()=>{
  const actor={...AUTH.actor,name:'<script>staff</script>',source:'legacy'},h=harness({session:{...AUTH,actor}});await h.ui.ready;h.ui.open();
  assert.equal(h.element('#session-name').textContent,actor.name);assert.equal(h.dialog.innerHTML.includes(actor.name),false);assert.equal(h.element('#session-roles').textContent,'员工、项目经理');assert.equal(h.element('#session-password-entry').hidden,true);assert.equal(h.element('#session-profile').hidden,false);h.destroy();
});

test('退出请求失败保留会话，成功后在办公室重新登录且防止双击',async()=>{
  const h=harness({session:AUTH});await h.ui.ready;h.ui.open();h.setResponder(async()=>response({},503));await h.ui.signOut();assert.equal(h.ui.session.username,'lin');assert.equal(h.events.signedOut,0);
  const pending=deferred();h.setResponder(()=>pending.promise);const first=h.ui.signOut();await h.ui.signOut();assert.equal(h.requests.filter(r=>r.url==='/api/session/logout').length,2);pending.resolve(response({ok:true}));await first;
  assert.equal(h.ui.session,null);assert.equal(h.events.signedOut,1);assert.equal(h.element('#session-title').textContent,'登录');assert.deepEqual(h.redirects,[]);h.destroy();
});

test('明确到期时间触发同页重新登录，不显示过期业务身份',async()=>{
  const h=harness({session:AUTH});await h.ui.ready;const timer=[...h.timers.values()][0];assert.ok(timer);timer.fn();assert.equal(h.ui.session,null);assert.equal(h.events.expired,1);assert.equal(h.dialog.open,true);h.destroy();
});

test('改密先校验口令，原密码错误不撤销有效会话，改密完成后必须重新登录',async()=>{
  const h=harness({session:AUTH});await h.ui.ready;h.ui.open();h.click('password');
  for(const args of [[PASSWORD,'short','short'],[PASSWORD,PASSWORD+'a',PASSWORD+'b'],[PASSWORD,'汉'.repeat(400),'汉'.repeat(400)]])await h.password(...args);
  assert.equal(h.requests.length,1);
  h.setResponder(async()=>response({error:'原密码不正确。'},401));await h.password();assert.equal(h.ui.session.username,'lin');assert.equal(h.element('#session-password-error').textContent,'原密码不正确。');assert.equal(h.events.expired,0);assert.equal(h.element('#session-current').value,'');
  h.setResponder(async()=>response({ok:true}));await h.password();assert.equal(h.ui.session,null);assert.equal(h.events.signedOut,1);assert.equal(h.element('#session-title').textContent,'登录');assert.equal(h.element('#session-message').textContent,'密码已修改，请登录。');h.destroy();
});

test('销毁中断请求并清理口令，晚到响应不会重建身份或触发回调',async()=>{
  const h=harness();await h.ui.ready;const pending=deferred();h.setResponder(()=>pending.promise);const submit=h.login();const signal=h.requests.at(-1).options.signal;h.destroy();assert.equal(signal.aborted,true);assert.equal(h.element('#session-password').value,'');assert.equal(h.timers.size,0);pending.resolve(response({session:AUTH}));await submit;assert.equal(h.ui.session,null);assert.equal(h.events.authenticated.length,0);
});

test('请求超时只取消一次操作，错误可恢复且不后台重复登录',async()=>{
  const h=harness();await h.ui.ready;h.setResponder((_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted')))));
  const pending=h.login();[...h.timers.values()][0].fn();await pending;assert.equal(h.requests.length,2);assert.match(h.element('#session-login-error').textContent,/连接中断/);assert.equal(h.element('#session-password').disabled,false);assert.equal(h.timers.size,0);h.destroy();
});

test('关闭在原生对话框内完成短退出，先清除口令，结束后归还焦点',async()=>{
  const h=harness({reducedMotion:false});await h.ui.ready;
  h.element('#session-password').value=PASSWORD;h.ui.close();
  assert.equal(h.dialog.open,true);assert.equal(h.dialog.dataset.closing,'true');assert.equal(h.element('#session-password').value,'');assert.equal(h.element('#session-password').disabled,true);assert.equal(h.element('before-focus').focused,0);
  h.ui.close();assert.equal(h.timers.size,1);h.runTimer(140);
  assert.equal(h.dialog.open,false);assert.equal(h.dialog.dataset.closing,undefined);assert.equal(h.element('#session-password').disabled,false);assert.equal(h.element('before-focus').focused,1);assert.equal(h.timers.size,0);h.destroy();
});

test('退出过程中再次打开或会话失效会撤销旧退出，不被过时定时器关闭',async()=>{
  const h=harness({reducedMotion:false});await h.ui.ready;h.ui.close();h.ui.open();
  assert.equal(h.dialog.open,true);assert.equal(h.dialog.dataset.closing,undefined);assert.equal(h.element('#session-password').disabled,false);assert.equal(h.timers.size,0);
  h.ui.close();h.ui.requireLogin('登录已过期，请重新登录。');
  assert.equal(h.dialog.open,true);assert.equal(h.dialog.dataset.closing,undefined);assert.equal(h.timers.size,0);assert.equal(h.element('#session-message').textContent,'登录已过期，请重新登录。');h.destroy();
});

test('登录请求有等待反馈且不可被 Esc 中断，成功立即清密后平滑退出',async()=>{
  const h=harness({reducedMotion:false});await h.ui.ready;const pending=deferred();h.setResponder(()=>pending.promise);const submit=h.login();
  assert.equal(h.element('#session-login-label').textContent,'正在进入');assert.equal(h.element('#session-login-spinner').hidden,false);assert.equal(h.element('#session-login-submit').dataset.busy,'true');assert.equal(h.dialog.getAttribute('aria-busy'),'true');
  assert.equal(h.escape(),true);assert.equal(h.dialog.open,true);assert.equal(h.dialog.dataset.closing,undefined);assert.equal([...h.timers.values()].some(timer=>timer.delay===140),false);
  pending.resolve(response({session:AUTH}));await submit;
  assert.equal(h.events.authenticated.length,1);assert.equal(h.element('#session-password').value,'');assert.equal(h.element('#session-login-spinner').hidden,true);assert.equal(h.element('#session-login-label').textContent,'进入办公室');assert.equal(h.dialog.dataset.closing,'true');
  h.runTimer(140);assert.equal(h.dialog.open,false);assert.equal(h.ui.session.username,'lin');h.destroy();
});

test('Esc 使用同一关闭流程，减少动态效果时立即关闭且不留动画定时器',async()=>{
  for(const reducedMotion of [false,true]){
    const h=harness({reducedMotion});await h.ui.ready;h.element('#session-password').value=PASSWORD;
    assert.equal(h.escape(),true);assert.equal(h.element('#session-password').value,'');
    assert.equal(h.dialog.open,!reducedMotion);
    if(reducedMotion)assert.equal(h.timers.size,0);else h.runTimer(140);
    assert.equal(h.dialog.open,false);h.destroy();
  }
});

test('保存密码与退出的等待标签只出现在当前操作，失败后恢复原按钮',async()=>{
  const h=harness({session:AUTH});await h.ui.ready;h.ui.open();h.click('password');
  let pending=deferred();h.setResponder(()=>pending.promise);let submit=h.password();
  assert.equal(h.element('#session-password-label').textContent,'正在保存');assert.equal(h.element('#session-password-spinner').hidden,false);assert.equal(h.element('#session-login-spinner').hidden,true);
  pending.resolve(response({error:'原密码不正确。'},401));await submit;
  assert.equal(h.element('#session-password-label').textContent,'保存密码');assert.equal(h.element('#session-password-spinner').hidden,true);assert.equal(h.element('#session-password-error').hidden,false);
  h.click('profile');pending=deferred();h.setResponder(()=>pending.promise);submit=h.ui.signOut();
  assert.equal(h.element('#session-signout-label').textContent,'正在退出');assert.equal(h.element('#session-signout-spinner').hidden,false);
  pending.resolve(response({},503));await submit;assert.equal(h.element('#session-signout-label').textContent,'退出登录');assert.equal(h.element('#session-signout-spinner').hidden,true);assert.equal(h.ui.session.username,'lin');h.destroy();
});

test('同一登录视图的探测不抢输入焦点，销毁清理未结束的退出',async()=>{
  const h=harness({reducedMotion:false});await h.ui.ready;const usernameFocus=h.element('#session-username').focused,passwordFocus=h.element('#session-password').focused;
  await h.ui.refresh();h.ui.open();assert.equal(h.element('#session-username').focused,usernameFocus);assert.equal(h.element('#session-password').focused,passwordFocus);
  h.ui.close();assert.equal(h.timers.size,1);h.destroy();assert.equal(h.timers.size,0);assert.equal(h.dialog.open,false);assert.equal(h.dialog.isConnected,false);
});

test('同一登录窗口的重复打开和会话探测保留正在填写的口令与反馈',async()=>{
  const h=harness();await h.ui.ready;
  h.setResponder(async()=>response({},401));await h.login();
  const error=h.element('#session-login-error').textContent;
  h.element('#session-password').value='password-being-edited';
  h.dialog.scrollTop=96;
  h.ui.open();
  assert.equal(h.element('#session-password').value,'password-being-edited');
  assert.equal(h.element('#session-login-error').textContent,error);
  h.setResponder(async()=>response({session:{authenticated:false}}));await h.ui.refresh();
  assert.equal(h.element('#session-password').value,'password-being-edited');
  assert.equal(h.element('#session-login-error').textContent,error);
  assert.equal(h.dialog.scrollTop,96);
  h.ui.requireLogin('请重新登录。');
  assert.equal(h.element('#session-password').value,'');
  assert.equal(h.element('#session-login-error').hidden,true);
  h.destroy();
});

test('保存中的账户窗口重复打开不会切换视图或丢失当前等待状态',async()=>{
  const h=harness({session:AUTH});await h.ui.ready;h.ui.open();h.click('password');
  const pending=deferred();h.setResponder(()=>pending.promise);const submit=h.password();
  h.ui.open();
  assert.equal(h.dialog.dataset.view,'password');
  assert.equal(h.element('#session-password-form').hidden,false);
  assert.equal(h.element('#session-password-label').textContent,'正在保存');
  assert.equal(h.element('#session-password-spinner').hidden,false);
  pending.resolve(response({error:'原密码不正确。'},401));await submit;
  assert.equal(h.element('#session-password-error').textContent,'原密码不正确。');
  assert.equal(h.element('#session-password-label').textContent,'保存密码');
  h.destroy();
});

test('被取消的旧登录、改密或邀请请求结束时不清除新登录口令',async()=>{
  for(const kind of ['login','password','invitation']){
    const h=harness(kind==='password'?{session:AUTH}:kind==='invitation'?{fragment:'#token='+TOKEN}:{});
    await h.ui.ready;
    if(kind==='password'){h.ui.open();h.click('password');}
    const late=deferred();h.setResponder(()=>late.promise);
    const submit=kind==='password'?h.password():kind==='invitation'?h.invitation():h.login();
    h.ui.requireLogin('请重新登录。');
    h.element('#session-password').value='new-login-draft-after-reset';
    late.resolve(response(kind==='login'?{session:AUTH}:kind==='invitation'?{employee:{id:'new',username:'new'}}:{ok:true}));
    await submit;
    assert.equal(h.element('#session-password').value,'new-login-draft-after-reset',kind);
    assert.equal(h.ui.session,null,kind);
    assert.equal(h.dialog.dataset.view,'login',kind);
    assert.equal(h.element('#session-login-submit').disabled,false,kind);
    h.destroy();
  }
});

test('账户对话框具备原生焦点隔离和表单语义，没有模型、演示或技术介绍',()=>{
  assert.match(source,/createElement\('dialog'\)/);assert.match(source,/showModal\(\)/);assert.match(source,/aria-labelledby/);assert.match(source,/autocomplete="current-password"/);assert.match(source,/autocomplete="new-password"/);assert.match(source,/role="alert"/);
  assert.doesNotMatch(source,/localStorage|sessionStorage|console\.|模型|Agent|虚拟员工|功能介绍|查看进展/);
  assert.doesNotMatch(css,/text-shadow|filter\s*:|border-(?:left|right|top|bottom)\s*:/);
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);assert.match(css,/animation:none!important;transition:none!important/);assert.match(css,/@keyframes session-exit/);assert.match(css,/@keyframes session-content-enter/);
});


test('session close callbacks fire after actual API, button, Escape or native closure once per displayed surface',async()=>{
 const h=harness({session:AUTH});await h.ui.ready;
 assert.equal(h.ui.isOpen,false);h.ui.close();assert.equal(h.events.closed,0);
 for(const channel of ['api','button','escape','native']){
  h.ui.open();assert.equal(h.ui.isOpen,true);
  if(channel==='api')h.ui.close();
  if(channel==='button')h.click('close');
  if(channel==='escape')h.escape();
  if(channel==='native'){h.dialog.close();h.dialog.listeners.get('close')();}
  assert.equal(h.ui.isOpen,false);assert.equal(h.events.closed,['api','button','escape','native'].indexOf(channel)+1);
  h.dialog.listeners.get('close')();h.ui.close();
 }
 assert.deepEqual(h.events.closedWhileOpen,[false,false,false,false]);
 h.ui.open();h.dialog.listeners.get('close')();assert.equal(h.events.closed,4,'an older queued close event does not notify an open surface');
 h.destroy();assert.equal(h.events.closed,4);assert.equal(h.dialog.listeners.has('close'),false);
});

test('session callbacks wait for close animation and obsolete animation completions cannot close a reopened or destroyed surface',async()=>{
 for(const destination of ['open','expired','destroy']){
  const h=harness({reducedMotion:false});await h.ui.ready;
  h.ui.close();const old=[...h.timers.values()].find(timer=>timer.delay===140).fn;
  assert.equal(h.events.closed,0);assert.equal(h.ui.isOpen,true);
  if(destination==='open')h.ui.open();
  if(destination==='expired')h.ui.requireLogin('请重新登录。');
  if(destination==='destroy')h.destroy();
  old();assert.equal(h.events.closed,0);
  if(destination!=='destroy'){assert.equal(h.ui.isOpen,true);h.ui.close();assert.equal(h.events.closed,0);h.runTimer(140);assert.equal(h.ui.isOpen,false);assert.equal(h.events.closed,1);h.dialog.listeners.get('close')();assert.equal(h.events.closed,1);h.destroy();}
 }
});

test('successful login closes the real session surface once while a cancelled old login has no close notification',async()=>{
 for(const reducedMotion of [true,false]){
  const h=harness({reducedMotion});await h.ui.ready;h.setResponder(async()=>response({session:AUTH}));await h.login();
  assert.equal(h.events.closed,reducedMotion?1:0);if(!reducedMotion)h.runTimer(140);
  assert.equal(h.events.closed,1);assert.equal(h.ui.isOpen,false);assert.deepEqual(h.events.closedWhileOpen,[false]);h.destroy();assert.equal(h.events.closed,1);
 }
 const h=harness(),slow=deferred();await h.ui.ready;h.setResponder(()=>slow.promise);const pending=h.login();h.ui.requireLogin('请重新登录。');slow.resolve(response({session:AUTH}));await pending;
 assert.equal(h.events.closed,0);assert.equal(h.ui.isOpen,true);h.destroy();assert.equal(h.events.closed,0);
});

test('native session closure clears a pending exit animation and never notifies a newer surface',async()=>{
 const h=harness({reducedMotion:false});await h.ui.ready;h.ui.close();const old=[...h.timers.values()].find(timer=>timer.delay===140).fn;
 h.dialog.close();h.dialog.listeners.get('close')();assert.equal(h.events.closed,1);assert.equal(h.timers.size,0);assert.equal(h.dialog.dataset.closing,undefined);
 h.ui.open();old();h.dialog.listeners.get('close')();assert.equal(h.ui.isOpen,true);assert.equal(h.events.closed,1);h.destroy();
});
