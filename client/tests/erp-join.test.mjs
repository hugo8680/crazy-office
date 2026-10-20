import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {harness} from './fixtures/session-harness.mjs';

const TOKEN='t'.repeat(43),PASSWORD='employee-password-2026';
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};

test('入驻直接进入办公室密码对话框，立即清除 fragment 且不把令牌放进 DOM、日志或存储',async()=>{
  const h=harness({fragment:'#token='+TOKEN,pathname:'/join'});await h.ui.ready;assert.deepEqual(h.history,['/']);assert.equal(h.scope.window.location.hash,'');assert.equal(h.requests.length,0);assert.equal(h.element('#session-title').textContent,'设置密码');assert.equal(h.element('#session-invitation-form').hidden,false);assert.equal(h.dialog.innerHTML.includes(TOKEN),false);h.destroy();
});

test('无效、缺失及重复入驻令牌仅提示失效，不提交密码',async()=>{
  for(const fragment of ['', '#token=short','#token='+TOKEN+'&token='+TOKEN,'#token='+encodeURIComponent('<script>')]){
    const h=harness({fragment,pathname:'/join'});await h.ui.ready;await h.invitation();assert.equal(h.element('#session-title').textContent,'登录');assert.match(h.element('#session-message').textContent,/链接已失效/);assert.equal(h.requests.length,0);h.destroy();
  }
});

test('入驻密码长度、一致性和 UTF-8 字节限制在提交前验证',async()=>{
  const h=harness({fragment:'#token='+TOKEN});await h.ui.ready;
  for(const [password,confirmation,expected] of [['short','short','至少'],[PASSWORD,PASSWORD+'wrong','不一致'],['汉'.repeat(400),'汉'.repeat(400),'过长']]){await h.invitation(password,confirmation);assert.match(h.element('#session-invitation-error').textContent,new RegExp(expected));assert.equal(h.requests.length,0);}
  h.destroy();
});

test('单次设置成功只调用一次接受接口，清空口令与令牌，明确重新登录而不自动授权',async()=>{
  const h=harness({fragment:'#token='+TOKEN});await h.ui.ready;const pending=deferred();h.setResponder(url=>url==='/api/erp/invitations/accept'?pending.promise:response({ok:true}));
  const first=h.invitation();await h.invitation();assert.equal(h.requests.length,1);assert.equal(h.element('#session-invitation-password').disabled,true);
  const request=h.requests[0];assert.equal(request.url,'/api/erp/invitations/accept');assert.equal(request.options.referrerPolicy,'no-referrer');assert.deepEqual(JSON.parse(request.options.body),{token:TOKEN,password:PASSWORD});
  pending.resolve(response({employee:{id:'staff-1',username:'lin'}}));await first;
  assert.equal(h.ui.session,null);assert.equal(h.events.authenticated.length,0);assert.equal(h.element('#session-title').textContent,'登录');assert.equal(h.element('#session-username').value,'lin');assert.equal(h.element('#session-invitation-password').value,'');assert.equal(h.element('#session-invitation-confirm').value,'');assert.equal(h.requests.length,1);assert.equal(h.timers.size,0);
  await h.invitation();assert.equal(h.requests.length,1);assert.deepEqual(h.redirects,[]);h.destroy();
});

test('失败保留可重试令牌而不回显秘密；失效令牌清除后不能重复提交',async()=>{
  const h=harness({fragment:'#token='+TOKEN});await h.ui.ready;h.setResponder(async()=>response({error:TOKEN+PASSWORD},400));await h.invitation();assert.doesNotMatch(h.element('#session-invitation-error').textContent,new RegExp(TOKEN+'|'+PASSWORD));assert.equal(h.element('#session-invitation-password').value,'');assert.equal(h.element('#session-invitation-password').disabled,false);
  h.setResponder(async()=>response({error:'expired'},410));await h.invitation();assert.equal(h.element('#session-title').textContent,'登录');assert.match(h.element('#session-message').textContent,/链接已失效/);await h.invitation();assert.equal(h.requests.length,2);h.destroy();
});

test('无结果的成功响应与网络中断不伪装设置完成，随后可重试',async()=>{
  const h=harness({fragment:'#token='+TOKEN});await h.ui.ready;
  for(const responder of [async()=>response({}),async()=>{throw Error('disconnected');},async()=>response({},503)]){h.setResponder(responder);await h.invitation();assert.equal(h.element('#session-title').textContent,'设置密码');assert.equal(h.element('#session-invitation-password').disabled,false);assert.equal(h.element('#session-invitation-password').value,'');}
  h.destroy();
});

test('旧静态登录和邀请文档仅兼容回到办公室，不保留第二套表单',async()=>{
  for(const name of ['login','join']){
    const html=await readFile(new URL(`../src/${name}.html`,import.meta.url),'utf8');assert.doesNotMatch(html,/<form|<input|<main/);assert.match(html,/name="referrer" content="no-referrer"/);
    const source=await readFile(new URL(`../src/${name}.js`,import.meta.url),'utf8'),calls=[];vm.runInNewContext(source,{window:{location:{hash:'#token='+TOKEN,replace:url=>calls.push(url)}}});assert.deepEqual(calls,['/#token='+TOKEN]);
  }
});

test('两种生产静态部署都公开场景壳、将旧登录回到根路径、邀请直接使用同一index',async()=>{
  for(const name of ['nginx.locations.conf','default.conf.template']){
    const config=await readFile(new URL(`../deploy/${name}`,import.meta.url),'utf8');assert.match(config,/location = \/login \{ return 302 \/; \}/);assert.match(config,/location = \/login\.html \{ return 302 \/; \}/);assert.match(config,/location = \/join \{ try_files \/index\.html =404; \}/);assert.match(config,/location = \/join\.html \{ try_files \/index\.html =404; \}/);assert.doesNotMatch(config,/auth_request|error_page 401|@office_login/);assert.match(config,/location \^~ \/api\/ \{\s*proxy_pass/);
  }
});
