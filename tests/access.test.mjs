import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAccessGate, hashAccessPassword } from '../server/access.mjs';
import { createErpIdentity } from '../server/erp-identity.mjs';

const PASSWORD='an-isolated-test-password-2026';
const HASH=await hashAccessPassword(PASSWORD);
const SECRET='a-test-only-session-secret-at-least-32-bytes';
const configuration={OFFICE_PUBLIC_ORIGIN:'https://office.example.test',OFFICE_ACCESS_PASSWORD_HASH:HASH,OFFICE_SESSION_SECRET:SECRET};
const request=(ip='203.0.113.7',headers={})=>({socket:{remoteAddress:ip},headers:{origin:'https://office.example.test',...headers}});
const withCookie=(cookie,req=request())=>({...req,headers:{...req.headers,cookie:cookie.split(';')[0]}});

test('本地未配置公开来源时默认不要求登录',async()=>{
  const gate=createAccessGate({env:{}});assert.equal(gate.enabled,false);assert.deepEqual(gate.publicSession(request()),{enabled:false,authenticated:true,username:null,expiresAt:null});assert.ok(gate.authenticate(request()));assert.equal((await gate.login(request(),{})).cookie,null);
});

test('公网缺认证配置、弱会话密钥或无效来源都会拒绝启动',()=>{
  for(const env of [{OFFICE_PUBLIC_ORIGIN:'https://office.example.test'},{...configuration,OFFICE_SESSION_SECRET:'short'},{...configuration,OFFICE_ACCESS_PASSWORD_HASH:'malformed'},{...configuration,OFFICE_PUBLIC_ORIGIN:'http://office.example.test'},{...configuration,OFFICE_PUBLIC_ORIGIN:'https://office.example.test/path'},{...configuration,OFFICE_PUBLIC_ORIGIN:'https://secret@office.example.test'},{...configuration,OFFICE_ACCESS_USERNAME:'invalid name'}])assert.throws(()=>createAccessGate({env}));
});

test('Scrypt散列使用随机盐，格式严格验证，不保存明文',async()=>{
  const other=await hashAccessPassword(PASSWORD);assert.notEqual(HASH,other);assert.equal(HASH.includes(PASSWORD),false);assert.match(HASH,/^scrypt\$16384\$8\$1\$[-_A-Za-z0-9]+\$[-_A-Za-z0-9]+$/);
  await assert.rejects(hashAccessPassword('short'));await assert.rejects(hashAccessPassword('a'.repeat(1025)));
  assert.throws(()=>createAccessGate({env:{...configuration,OFFICE_ACCESS_PASSWORD_HASH:HASH.replace('$16384$','$1048576$')}}));
});

test('正确账号取得12小时安全cookie；错误账号密码统一返回401',async()=>{
  let now=Date.parse('2026-10-19T02:00:00Z');const gate=createAccessGate({env:configuration,now:()=>now});
  for(const credentials of [{username:'office',password:'wrong'},{username:'different',password:PASSWORD},{username:'office',password:'a'.repeat(1025)},{}])await assert.rejects(gate.login(request(),credentials),error=>error.status===401&&error.message==='账号或密码错误。');
  const result=await gate.login(request(),{username:'office',password:PASSWORD});assert.match(result.cookie,/^__Host-office_session=/);assert.match(result.cookie,/Path=\//);assert.match(result.cookie,/Max-Age=43200/);assert.match(result.cookie,/Secure; HttpOnly; SameSite=Strict/);assert.equal(result.cookie.includes(PASSWORD),false);assert.equal(result.session.authenticated,true);
  const req=withCookie(result.cookie);assert.deepEqual(gate.authenticate(req),{username:'office',expiresAt:'2026-10-19T14:00:00.000Z'});now+=43200*1000;assert.equal(gate.authenticate(req),null);
});

test('篡改、错误签名、重复cookie与非法会话字段都无法通过',async()=>{
  const now=Date.parse('2026-10-19T02:00:00Z'),gate=createAccessGate({env:configuration,now:()=>now});const {cookie}=await gate.login(request(),{username:'office',password:PASSWORD});
  const raw=cookie.split(';')[0],token=raw.slice(raw.indexOf('=')+1);assert.equal(gate.authenticate(request('203.0.113.7',{cookie:raw+'; '+raw})),null);
  for(const value of [token+'x','bad.cookie','a'.repeat(9000),token.slice(0,-3)+'aaa'])assert.equal(gate.authenticate(request('203.0.113.7',{cookie:'__Host-office_session='+value})),null);
  const original=JSON.parse(Buffer.from(token.split('.')[0],'base64url').toString('utf8'));
  for(const patch of [{sub:'other'},{iat:original.iat+61,exp:original.exp+61},{exp:original.exp+1},{nonce:'bad'},{v:2}]){
    const body=Buffer.from(JSON.stringify({...original,...patch})).toString('base64url'),signature=createHmac('sha256',SECRET).update(body).digest('base64url');assert.equal(gate.authenticate(request('203.0.113.7',{cookie:'__Host-office_session='+body+'.'+signature})),null);
  }
});

test('登录来源必须匹配公开HTTPS来源；登出cookie明确清除',async()=>{
  const gate=createAccessGate({env:configuration});for(const origin of [undefined,'null','https://evil.example.test','https://office.example.test.attacker.test'])await assert.rejects(gate.login(request('203.0.113.7',{origin}),{username:'office',password:PASSWORD}),error=>error.status===403);
  assert.match(gate.logoutCookie(),/^__Host-office_session=; Path=\/; Max-Age=0; Secure; HttpOnly; SameSite=Strict$/);
});

test('同一地址8次失败后限速15分钟，其他地址不受影响',async()=>{
  let now=Date.parse('2026-10-19T02:00:00Z');const gate=createAccessGate({env:configuration,now:()=>now});
  for(let i=0;i<8;i++)await assert.rejects(gate.login(request(),{username:'office',password:'incorrect'}),error=>error.status===401);
  await assert.rejects(gate.login(request(),{username:'office',password:PASSWORD}),error=>error.status===429&&error.retryAfter===900);
  assert.equal((await gate.login(request('203.0.113.8'),{username:'office',password:PASSWORD})).session.authenticated,true);
  now+=15*60000;assert.equal((await gate.login(request(),{username:'office',password:PASSWORD})).session.authenticated,true);
});

test('只有环回反向代理的单个有效X-Real-IP能作为限速地址',async()=>{
  const gate=createAccessGate({env:configuration});
  for(let i=0;i<8;i++)await assert.rejects(gate.login(request('198.51.100.9',{'x-real-ip':'203.0.113.'+i}),{username:'office',password:'incorrect'}),error=>error.status===401);
  await assert.rejects(gate.login(request('198.51.100.9',{'x-real-ip':'203.0.113.77'}),{username:'office',password:PASSWORD}),error=>error.status===429);
  for(let i=0;i<8;i++)await assert.rejects(gate.login(request('127.0.0.1',{'x-real-ip':'203.0.113.55'}),{username:'office',password:'incorrect'}),error=>error.status===401);
  await assert.rejects(gate.login(request('::ffff:127.0.0.1',{'x-real-ip':'203.0.113.55'}),{username:'office',password:PASSWORD}),error=>error.status===429);
  assert.equal((await gate.login(request('::1',{'x-real-ip':'203.0.113.56'}),{username:'office',password:PASSWORD})).session.authenticated,true);
});

test('并发错误登录不能超过8个在途校验以绕过限速',async()=>{
  const gate=createAccessGate({env:configuration});const results=await Promise.all(Array.from({length:12},()=>gate.login(request(),{username:'office',password:'incorrect'}).then(()=>200,error=>error.status)));
  assert.equal(results.filter(status=>status===401).length,8);assert.equal(results.filter(status=>status===429).length,4);
});

test('自定义账号被纳入签名会话，切换密钥使旧会话失效',async()=>{
  const gate=createAccessGate({env:{...configuration,OFFICE_ACCESS_USERNAME:'office-owner'}});const {cookie}=await gate.login(request(),{username:'office-owner',password:PASSWORD});assert.equal(gate.publicSession(withCookie(cookie)).username,'office-owner');
  const rotated=createAccessGate({env:{...configuration,OFFICE_ACCESS_USERNAME:'office-owner',OFFICE_SESSION_SECRET:'another-test-only-session-secret-over-32-bytes'}});assert.equal(rotated.publicSession(withCookie(cookie)).authenticated,false);
});

async function identityFixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'office-access-identity-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const identity=await createErpIdentity({filePath:path.join(directory,'identity.json'),legacyUsername:'office'});
  const invitation=await identity.createInvitation('bootstrap',{username:'zhang',name:'张明',department:'采购部',title:'采购员',roles:['procurement']});
  const employee=await identity.acceptInvitation({token:invitation.token,password:PASSWORD});
  return {identity,employee,gate:createAccessGate({env:configuration,identity})};
}

test('身份模块接入后员工登录使用 v2 安全会话，响应仅包含可信角色',async t=>{
  const {gate,employee}=await identityFixture(t);const result=await gate.login(request(),{username:'zhang',password:PASSWORD,roles:['admin'],id:'bootstrap'});
  assert.equal(result.session.id,employee.id);assert.deepEqual(result.session.roles,['procurement']);assert.equal(result.session.actor.id,employee.id);
  assert.equal(JSON.stringify(result).includes(PASSWORD),false);assert.equal(JSON.stringify(result).includes('passwordHash'),false);
  assert.match(result.cookie,/Secure; HttpOnly; SameSite=Strict/);
  const raw=result.cookie.split(';')[0].split('=')[1],body=JSON.parse(Buffer.from(raw.split('.')[0],'base64url').toString('utf8'));
  assert.equal(body.v,2);assert.equal(body.sub,employee.id);assert.equal(body.epoch,employee.epoch);assert.equal(body.roles,undefined);
  const session=gate.publicSession(withCookie(result.cookie));assert.equal(session.authenticated,true);assert.equal(session.actor.username,'zhang');
  assert.equal(createAccessGate({env:configuration}).authenticate(withCookie(result.cookie)),null);
});

test('员工的角色更新、停用与改密均撤销 v2 Cookie；个人资料读取最新值',async t=>{
  const {gate,identity,employee}=await identityFixture(t);const first=await gate.login(request(),{username:'zhang',password:PASSWORD});
  await identity.updateEmployee('bootstrap',employee.id,{name:'张明宇'});assert.equal(gate.authenticate(withCookie(first.cookie)).name,'张明宇');
  await identity.updateEmployee('bootstrap',employee.id,{roles:['warehouse']});assert.equal(gate.authenticate(withCookie(first.cookie)),null);
  const second=await gate.login(request(),{username:'zhang',password:PASSWORD});assert.deepEqual(second.session.roles,['warehouse']);
  await identity.updateEmployee('bootstrap',employee.id,{active:false});assert.equal(gate.authenticate(withCookie(second.cookie)),null);
  await assert.rejects(gate.login(request(),{username:'zhang',password:PASSWORD}),e=>e.status===401&&e.message==='账号或密码错误。');
  await identity.updateEmployee('bootstrap',employee.id,{active:true});const third=await gate.login(request(),{username:'zhang',password:PASSWORD});
  await identity.changePassword(employee.id,{currentPassword:PASSWORD,newPassword:PASSWORD+'-changed'});assert.equal(gate.authenticate(withCookie(third.cookie)),null);
});

test('原管理员密码与旧 v1 Cookie 兼容，身份停用后旧 Cookie 不再有效',async t=>{
  const {gate,identity,employee}=await identityFixture(t);const oldGate=createAccessGate({env:configuration});const old=await oldGate.login(request(),{username:'office',password:PASSWORD});
  assert.equal(gate.authenticate(withCookie(old.cookie)).id,'bootstrap');assert.deepEqual(gate.authenticate(withCookie(old.cookie)).roles,['admin']);
  assert.equal((await gate.login(request(),{username:'office',password:PASSWORD})).session.actor.id,'bootstrap');
  await identity.updateEmployee('bootstrap',employee.id,{roles:['admin']});await identity.updateEmployee(employee.id,'bootstrap',{active:false});
  assert.equal(gate.authenticate(withCookie(old.cookie)),null);await assert.rejects(gate.login(request(),{username:'office',password:PASSWORD}),e=>e.status===401);
});

test('员工登录沿用来源检查、统一错误与失败次数限制',async t=>{
  const {gate}=await identityFixture(t);
  await assert.rejects(gate.login(request('203.0.113.7',{origin:'https://evil.example.test'}),{username:'zhang',password:PASSWORD}),e=>e.status===403);
  for(let i=0;i<8;i++)await assert.rejects(gate.login(request(),{username:i%2?'none':'zhang',password:'incorrect'}),e=>e.status===401&&e.message==='账号或密码错误。');
  await assert.rejects(gate.login(request(),{username:'zhang',password:PASSWORD}),e=>e.status===429);
  assert.equal((await gate.login(request('203.0.113.8'),{username:'zhang',password:PASSWORD})).session.actor.username,'zhang');
});

test('身份会话不信任签名之外的角色或篡改 epoch，测试签名旧版本也无法冒充员工',async t=>{
  const {gate,employee}=await identityFixture(t);const {cookie}=await gate.login(request(),{username:'zhang',password:PASSWORD});
  const original=JSON.parse(Buffer.from(cookie.split(';')[0].split('=')[1].split('.')[0],'base64url').toString('utf8'));
  const signed=patch=>{const body=Buffer.from(JSON.stringify({...original,...patch})).toString('base64url');return '__Host-office_session='+body+'.'+createHmac('sha256',SECRET).update(body).digest('base64url');};
  for(const patch of [{epoch:employee.epoch+1},{epoch:0},{epoch:'2'},{sub:'missing'},{v:1,sub:'zhang'},{v:3}])assert.equal(gate.authenticate(request('203.0.113.7',{cookie:signed(patch)})),null);
  assert.deepEqual(gate.authenticate(request('203.0.113.7',{cookie:signed({roles:['admin']})})).roles,['procurement']);
});

test('本机未启用登录时可映射管理员，但不配置身份模块的旧行为保持不变',async t=>{
  const {identity}=await identityFixture(t);const gate=createAccessGate({env:{},identity});assert.equal(gate.enabled,false);
  assert.equal(gate.publicSession(request()).actor.id,'bootstrap');assert.equal(gate.authenticate(request()).id,'bootstrap');
  assert.equal((await gate.login(request(),{})).session.actor.id,'bootstrap');
});
