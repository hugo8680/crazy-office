import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createAccessGate, hashAccessPassword } from '../server/access.mjs';

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
