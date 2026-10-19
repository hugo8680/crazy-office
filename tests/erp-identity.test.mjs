import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createErpIdentity, ERP_ROLES } from '../server/erp-identity.mjs';

const PASSWORD='employee-strong-password-2026';
async function fixture(t,options={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'office-erp-identity-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const filePath=path.join(directory,'private','identities.json');
  return {directory,filePath,store:await createErpIdentity({filePath,legacyUsername:'office',...options})};
}
const invite=(store,extra={})=>store.createInvitation('bootstrap',{username:'zhang',name:'张明',department:'项目部',title:'项目经理',roles:['project_manager'],...extra});
async function employee(store,extra={}){const invitation=await invite(store,extra);return {invitation,employee:await store.acceptInvitation({token:invitation.token,password:PASSWORD})};}

test('创建持久化管理员映射，不读取或复制旧登录口令；公开数据和审计没有秘密',async t=>{
  const {store,filePath}=await fixture(t);
  assert.deepEqual(store.resolveLegacy('office').roles,['admin']);assert.equal(store.resolveLegacy(null).id,'bootstrap');assert.equal(store.resolveLegacy('other'),null);
  assert.equal(store.getEmployee('bootstrap').name,'系统管理员');assert.equal(store.getEmployee('missing'),null);
  const invitation=await invite(store);const raw=await fs.readFile(filePath,'utf8');
  assert.equal(raw.includes(invitation.token),false);assert.equal(raw.includes(PASSWORD),false);
  assert.equal((await fs.stat(filePath)).mode&0o777,0o600);
  assert.equal(JSON.stringify(store.listEmployees('bootstrap')).includes('passwordHash'),false);
  assert.equal(JSON.stringify(store.listAudit('bootstrap')).includes(invitation.token),false);
  assert.ok(ERP_ROLES.includes('hr'));
});

test('员工自行设密入驻，只接受有效邀请一次；口令使用独立盐散列',async t=>{
  const {store,filePath}=await fixture(t);const invitation=await invite(store);
  assert.equal(invitation.employee.status,'invited');assert.equal(await store.authenticate({username:'zhang',password:PASSWORD}),null);
  await assert.rejects(store.acceptInvitation({token:invitation.token,password:'short'}),e=>e.status===400&&e.message.includes('12'));
  const joined=await store.acceptInvitation({token:invitation.token,password:PASSWORD});assert.equal(joined.status,'active');assert.equal(joined.epoch,2);
  assert.equal((await store.authenticate({username:'ZHANG',password:PASSWORD})).id,joined.id);
  assert.equal(await store.authenticate({username:'zhang',password:'incorrect'}),null);assert.equal(await store.authenticate({username:'none',password:PASSWORD}),null);
  assert.equal(await store.authenticate({username:'office',password:PASSWORD}),null);
  await assert.rejects(store.acceptInvitation({token:invitation.token,password:PASSWORD}),e=>e.status===410);
  const raw=await fs.readFile(filePath,'utf8');assert.equal(raw.includes(PASSWORD),false);assert.equal(raw.includes(invitation.token),false);assert.match(raw,/scrypt\$16384\$8\$1\$/);
  const other=await employee(store,{username:'liu'});const saved=JSON.parse(raw),savedOther=JSON.parse(await fs.readFile(filePath,'utf8'));
  assert.notEqual(saved.employees.find(e=>e.id===joined.id).passwordHash,savedOther.employees.find(e=>e.id===other.employee.id).passwordHash);
});

test('邀请到期边界和重新邀请均使旧链接失效，过期不会修改员工',async t=>{
  let now=Date.parse('2026-10-20T00:00:00Z');const {store}=await fixture(t,{now:()=>now});
  const invitation=await invite(store,{expiresInHours:1});now+=3600000;
  await assert.rejects(store.acceptInvitation({token:invitation.token,password:PASSWORD}),e=>e.status===410);
  const second=await store.reissueInvitation('bootstrap',invitation.employee.id);const third=await store.reissueInvitation('bootstrap',invitation.employee.id);
  await assert.rejects(store.acceptInvitation({token:second.token,password:PASSWORD}),e=>e.status===410);
  assert.equal((await store.acceptInvitation({token:third.token,password:PASSWORD})).active,true);
});

test('并发兑换同一个邀请仅一次成功，失败事务不会污染内存或阻塞队列',async t=>{
  const {store}=await fixture(t);const invitation=await invite(store);
  const results=await Promise.allSettled([1,2,3].map(()=>store.acceptInvitation({token:invitation.token,password:PASSWORD})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.status===410).length,2);
  await assert.rejects(invite(store,{username:'ZHANG'}),e=>e.status===409);
  const next=await invite(store,{username:'wang'});assert.equal(next.employee.username,'wang');
  assert.equal(store.listEmployees('bootstrap').length,3);
});

test('普通员工不能创建邀请、查管理员目录、改权限或重发邀请',async t=>{
  const {store}=await fixture(t);const {employee:person}=await employee(store,{roles:['employee']});
  await assert.rejects(store.createInvitation(person.id,{username:'victim',name:'王莉',roles:['admin']}),e=>e.status===403);
  assert.throws(()=>store.listEmployees(person.id),e=>e.status===403);assert.throws(()=>store.listAudit(person.id),e=>e.status===403);
  await assert.rejects(store.updateEmployee(person.id,person.id,{roles:['admin']}),e=>e.status===403);
  await assert.rejects(store.reissueInvitation(person.id,person.id),e=>e.status===403);
  assert.deepEqual(store.getEmployee(person.id).roles,['employee']);
});

test('权限或停用变更使已有 epoch 立即失效，重新启用也不恢复旧会话',async t=>{
  const {store}=await fixture(t);const {employee:person}=await employee(store);const identity=await store.authenticate({username:'zhang',password:PASSWORD});
  assert.ok(store.resolveSession(identity));await store.updateEmployee('bootstrap',person.id,{roles:['warehouse','employee']});
  assert.equal(store.resolveSession(identity),null);const next=await store.authenticate({username:'zhang',password:PASSWORD});assert.equal(next.epoch,identity.epoch+1);
  await store.updateEmployee('bootstrap',person.id,{active:false});assert.equal(store.resolveSession(next),null);assert.equal(await store.authenticate({username:'zhang',password:PASSWORD}),null);
  await store.updateEmployee('bootstrap',person.id,{active:true});assert.equal(store.resolveSession(next),null);assert.ok(await store.authenticate({username:'zhang',password:PASSWORD}));
});

test('姓名或部门更正无需退出，返回值不能篡改内部身份或权限',async t=>{
  const {store}=await fixture(t);const {employee:person}=await employee(store);const identity=await store.authenticate({username:'zhang',password:PASSWORD});
  const updated=await store.updateEmployee('bootstrap',person.id,{name:'张明宇',department:'技术中心',title:'工程师'});updated.roles.push('admin');updated.name='篡改';
  const resolved=store.resolveSession(identity);assert.equal(resolved.name,'张明宇');assert.deepEqual(resolved.roles,['project_manager']);
  const list=store.listEmployees('bootstrap');list[0].roles.length=0;assert.deepEqual(store.resolveLegacy('office').roles,['admin']);
});

test('不能自停用或自改角色，最后一个管理员受到保护',async t=>{
  const {store}=await fixture(t);
  await assert.rejects(store.updateEmployee('bootstrap','bootstrap',{active:false}),e=>e.status===409);
  await assert.rejects(store.updateEmployee('bootstrap','bootstrap',{roles:['employee']}),e=>e.status===409);
  const {employee:admin}=await employee(store,{roles:['admin']});
  await store.updateEmployee('bootstrap',admin.id,{active:false});assert.equal(store.getEmployee(admin.id).active,false);
  await assert.rejects(store.updateEmployee(admin.id,'bootstrap',{active:false}),e=>e.status===403);
  await store.updateEmployee('bootstrap',admin.id,{active:true});await store.updateEmployee(admin.id,'bootstrap',{roles:['manager']});
  await assert.rejects(store.updateEmployee(admin.id,admin.id,{roles:['employee']}),e=>e.status===409);
  assert.equal(store.listEmployees(admin.id).filter(e=>e.active&&e.roles.includes('admin')).length,1);
});

test('审批检查用可信身份判断岗位，管理员也不能自批',async t=>{
  const {store}=await fixture(t);const {employee:person}=await employee(store,{roles:['manager']});
  assert.equal(store.assertCanApprove(person.id,{requesterId:'bootstrap',requiredRoles:['manager']}).id,person.id);
  assert.throws(()=>store.assertCanApprove(person.id,{requesterId:person.id,requiredRoles:['manager']}),e=>e.status===403&&e.message.includes('自己'));
  assert.throws(()=>store.assertCanApprove('bootstrap',{requesterId:'bootstrap',requiredRoles:['admin']}),e=>e.status===403);
  assert.throws(()=>store.assertCanApprove(person.id,{requesterId:'other',requiredRoles:['finance']}),e=>e.status===403);
  assert.throws(()=>store.assertCanApprove(person.id,{requesterId:'other',requiredRoles:[]}),e=>e.status===403);
  assert.throws(()=>store.assertCanApprove(person.id,{requiredRoles:['manager']}),e=>e.status===400);
  assert.equal(store.assertCanApprove('bootstrap',{requesterId:person.id,requiredRoles:['finance']}).id,'bootstrap');
});

test('密码变更先验证原密码，撤销旧会话，并保留新密码可登录',async t=>{
  const {store,filePath}=await fixture(t);const {employee:person}=await employee(store);
  await assert.rejects(store.changePassword(person.id,{currentPassword:'wrong',newPassword:PASSWORD+'-new'}),e=>e.status===401);
  const updated=await store.changePassword(person.id,{currentPassword:PASSWORD,newPassword:PASSWORD+'-new'});
  assert.equal(store.resolveSession(person),null);assert.equal(await store.authenticate({username:'zhang',password:PASSWORD}),null);
  assert.ok(await store.authenticate({username:'zhang',password:PASSWORD+'-new'}));assert.ok(store.resolveSession(updated));
  await assert.rejects(store.changePassword('bootstrap',{currentPassword:PASSWORD,newPassword:PASSWORD}),e=>e.status===409);
  assert.equal((await fs.readFile(filePath,'utf8')).includes(PASSWORD),false);
});

test('停用期间正在计算的登录不能获得有效会话',async t=>{
  const {store}=await fixture(t);const {employee:person}=await employee(store);
  const pending=store.authenticate({username:'zhang',password:PASSWORD});await store.updateEmployee('bootstrap',person.id,{active:false});assert.equal(await pending,null);
});

test('重启保留员工、邀请和 epoch，校验损坏文件而非静默重建管理员',async t=>{
  const {store,filePath}=await fixture(t);const {employee:person}=await employee(store);const pending=await invite(store,{username:'waiting'});
  await store.updateEmployee('bootstrap',person.id,{roles:['finance']});const reopened=await createErpIdentity({filePath,legacyUsername:'office'});
  assert.equal(reopened.resolveSession(person),null);assert.deepEqual((await reopened.authenticate({username:'zhang',password:PASSWORD})).roles,['finance']);
  assert.equal((await reopened.acceptInvitation({token:pending.token,password:PASSWORD})).username,'waiting');
  await fs.writeFile(filePath,'{"version":1,"employees":[]}');await assert.rejects(createErpIdentity({filePath}),/员工账号/);
});

test('非法输入、重复账号与邀请有效期失败均不创建脏记录',async t=>{
  const {store}=await fixture(t);
  for(const patch of [{username:'../admin'},{name:' '},{department:'a\nsecret'},{roles:['root']},{roles:[]},{expiresInHours:0},{expiresInHours:169},{expiresInHours:1.2}])await assert.rejects(invite(store,patch),e=>e.status===400);
  assert.equal(store.listEmployees('bootstrap').length,1);
  const pending=await invite(store);await assert.rejects(store.updateEmployee('bootstrap',pending.employee.id,{active:true}),e=>e.status===409);
  await assert.rejects(store.updateEmployee('bootstrap',pending.employee.id,{epoch:100}),e=>e.status===400);
  await assert.rejects(store.updateEmployee('bootstrap',pending.employee.id,{active:'yes'}),e=>e.status===400);
  for(const token of ['',null,'x'.repeat(10000),'../../file'])await assert.rejects(store.acceptInvitation({token,password:PASSWORD}),e=>e.status===410);
});

test('账户文件软链接不会被读取，超大文件不会被解析',async t=>{
  const {directory}=await fixture(t);const link=path.join(directory,'symlink.json'),target=path.join(directory,'target.json');await fs.writeFile(target,'{}');await fs.symlink(target,link);
  await assert.rejects(createErpIdentity({filePath:link}));
  const huge=path.join(directory,'huge.json');const handle=await fs.open(huge,'w');await handle.truncate(16*1024*1024+1);await handle.close();await assert.rejects(createErpIdentity({filePath:huge}),/不可读取/);
});

test('管理员撤回未使用邀请后，需重新邀请入驻，旧链接始终不能恢复',async t=>{
  const {store}=await fixture(t);const original=await invite(store);
  await store.updateEmployee('bootstrap',original.employee.id,{active:false});
  await assert.rejects(store.acceptInvitation({token:original.token,password:PASSWORD}),e=>e.status===410);
  await assert.rejects(store.updateEmployee('bootstrap',original.employee.id,{active:true}),e=>e.status===409&&e.message.includes('重新邀请'));
  const replacement=await store.reissueInvitation('bootstrap',original.employee.id);assert.equal(replacement.employee.status,'invited');
  await assert.rejects(store.acceptInvitation({token:original.token,password:PASSWORD}),e=>e.status===410);
  assert.equal((await store.acceptInvitation({token:replacement.token,password:PASSWORD})).active,true);
});

test('管理员发起口令重设，员工自己设置新口令，角色保留且所有旧会话立即撤销',async t=>{
  const {store,filePath}=await fixture(t);const {employee:person}=await employee(store,{roles:['finance','employee']});
  const reset=await store.createPasswordReset('bootstrap',{employeeId:person.id});assert.equal(reset.kind,'reset');assert.ok(store.resolveSession(person));
  assert.equal((await fs.readFile(filePath,'utf8')).includes(reset.token),false);
  const changed=await store.acceptInvitation({token:reset.token,password:PASSWORD+'-reset'});assert.deepEqual(changed.roles,['employee','finance']);
  assert.equal(store.resolveSession(person),null);assert.equal(await store.authenticate({username:'zhang',password:PASSWORD}),null);
  assert.ok(await store.authenticate({username:'zhang',password:PASSWORD+'-reset'}));
  await assert.rejects(store.acceptInvitation({token:reset.token,password:PASSWORD}),e=>e.status===410);
  assert.ok(store.listAudit('bootstrap').some(e=>e.action==='password.reset.completed'));
});

test('重设邀请不可越权、过期或停用后不能使用，重发使旧链接失效',async t=>{
  let now=Date.parse('2026-10-20T00:00:00Z');const {store}=await fixture(t,{now:()=>now});const {employee:person}=await employee(store,{roles:['employee']});
  await assert.rejects(store.createPasswordReset(person.id,{employeeId:person.id}),e=>e.status===403);
  await assert.rejects(store.createPasswordReset('bootstrap',{employeeId:'bootstrap'}),e=>e.status===409);
  const expired=await store.createPasswordReset('bootstrap',{employeeId:person.id,expiresInHours:1});now+=3600000;
  await assert.rejects(store.acceptInvitation({token:expired.token,password:PASSWORD}),e=>e.status===410);
  const first=await store.createPasswordReset('bootstrap',{employeeId:person.id});const second=await store.createPasswordReset('bootstrap',{employeeId:person.id});
  await assert.rejects(store.acceptInvitation({token:first.token,password:PASSWORD}),e=>e.status===410);
  await store.updateEmployee('bootstrap',person.id,{active:false});await store.updateEmployee('bootstrap',person.id,{active:true});
  await assert.rejects(store.acceptInvitation({token:second.token,password:PASSWORD}),e=>e.status===410);
});

test('最后一位员工管理员可以重设自己口令而不修改角色或破坏管理员保护',async t=>{
  const {store}=await fixture(t);const {employee:admin}=await employee(store,{roles:['admin']});
  await store.updateEmployee(admin.id,'bootstrap',{active:false});const reset=await store.createPasswordReset(admin.id,{employeeId:admin.id});
  const updated=await store.acceptInvitation({token:reset.token,password:PASSWORD+'-last-admin'});assert.deepEqual(updated.roles,['admin']);assert.equal(store.resolveSession(admin),null);
  assert.equal(store.listEmployees(updated.id).filter(e=>e.active&&e.roles.includes('admin')).length,1);
});

test('在岗员工可读最小工作目录，用于选择成员和交接；不显示邀请、停用或内部字段',async t=>{
  const {store}=await fixture(t);const {employee:person}=await employee(store,{roles:['employee']});const waiting=await invite(store,{username:'waiting'});const {employee:disabled}=await employee(store,{username:'disabled'});
  await store.updateEmployee('bootstrap',disabled.id,{active:false});
  const directory=store.listDirectory(person.id);assert.deepEqual(directory.map(e=>e.id).sort(),['bootstrap',person.id].sort());
  for(const row of directory)assert.deepEqual(Object.keys(row).sort(),['id','username','name','department','title','roles','active','status'].sort());
  directory[0].roles.push('finance');assert.deepEqual(store.resolveLegacy('office').roles,['admin']);
  for(const id of ['missing',waiting.employee.id,disabled.id])assert.throws(()=>store.listDirectory(id),e=>e.status===403);
});
