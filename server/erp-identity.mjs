import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { hashAccessPassword } from './access.mjs';

const scrypt=promisify(scryptCallback);
const SCRYPT={N:16384,r:8,p:1,maxmem:64*1024*1024};
const MAX_EMPLOYEES=2000,MAX_AUDIT=10000,MAX_FILE_BYTES=16*1024*1024;
export const ERP_ROLES=Object.freeze(['admin','manager','procurement','warehouse','project_manager','employee','finance','hr']);
const knownRoles=new Set(ERP_ROLES);
const fail=(message,status=400)=>Object.assign(new Error(message),{status,statusCode:status});
const digest=value=>createHash('sha256').update(value).digest('hex');
const clone=value=>structuredClone(value);
const has=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);

function usernameOf(value){
  if(typeof value!=='string'||!/^[A-Za-z0-9_.@-]{1,80}$/.test(value))throw fail('账号需为1至80位字母、数字或 . _ @ -。');
  return value.toLowerCase();
}
function textOf(value,label,required=false,max=80){
  if(typeof value!=='string'||value.length>max||/[\u0000-\u001f\u007f]/.test(value)||required&&!value.trim())throw fail(`${label}填写不正确。`);
  return value.trim();
}
function rolesOf(value){
  if(!Array.isArray(value)||!value.length||value.length>ERP_ROLES.length||value.some(role=>!knownRoles.has(role)))throw fail('请选择有效岗位角色。');
  return [...new Set(value)].sort();
}
function profileOf(input){return {name:textOf(input.name,'姓名',true),department:textOf(input.department??'','部门'),title:textOf(input.title??'','岗位')};}
function parsePasswordHash(value){
  if(typeof value!=='string')return null;
  const p=value.split('$');
  if(p.length!==6||p[0]!=='scrypt'||p[1]!=='16384'||p[2]!=='8'||p[3]!=='1')return null;
  const decode=(v,n)=>{if(!/^[-_A-Za-z0-9]+$/.test(v))return null;const b=Buffer.from(v,'base64url');return b.length===n&&b.toString('base64url')===v?b:null;};
  const salt=decode(p[4],16),key=decode(p[5],64);return salt&&key?{salt,key}:null;
}
async function passwordMatches(password,passwordHash){
  const parsed=parsePasswordHash(passwordHash);
  if(!parsed)throw new Error('员工口令记录损坏。');
  const shape=typeof password==='string'&&Buffer.byteLength(password,'utf8')<=1024;
  const key=await scrypt(shape?password:'invalid-credential-placeholder',parsed.salt,64,SCRYPT);
  return Boolean(shape&&timingSafeEqual(key,parsed.key));
}
async function employeePassword(password){
  try{return await hashAccessPassword(password);}catch{throw fail('密码需至少12个字符，且不超过1024字节。');}
}
function publicEmployee(employee){
  return {id:employee.id,username:employee.username,name:employee.name,department:employee.department,title:employee.title,roles:[...employee.roles],active:employee.status==='active',status:employee.status,source:employee.source,createdAt:employee.createdAt,updatedAt:employee.updatedAt};
}
function trustedIdentity(employee){return {...publicEmployee(employee),epoch:employee.epoch};}
function validateState(data){
  if(!data||data.version!==1||!Array.isArray(data.employees)||data.employees.length>MAX_EMPLOYEES||!Array.isArray(data.invitations)||data.invitations.length>10000||!Array.isArray(data.audit)||data.audit.length>MAX_AUDIT)throw new Error('员工账号文件格式不正确。');
  const ids=new Set(),names=new Set();
  for(const e of data.employees){
    if(!e||typeof e.id!=='string'||!/^(bootstrap|[0-9a-f-]{36})$/.test(e.id)||ids.has(e.id)||e.username!==usernameOf(e.username)||names.has(e.username)||!Number.isSafeInteger(e.epoch)||e.epoch<1||!['active','invited','disabled'].includes(e.status)||!['legacy','employee'].includes(e.source))throw new Error('员工账号记录损坏。');
    rolesOf(e.roles);profileOf(e);
    if(e.source==='employee'&&e.status==='active'&&!parsePasswordHash(e.passwordHash)||e.passwordHash!==null&&!parsePasswordHash(e.passwordHash)||!Number.isFinite(Date.parse(e.createdAt))||!Number.isFinite(Date.parse(e.updatedAt)))throw new Error('员工账号记录损坏。');
    ids.add(e.id);names.add(e.username);
  }
  const invitationIds=new Set(),hashes=new Set();
  for(const i of data.invitations){
    if(!i||typeof i.id!=='string'||invitationIds.has(i.id)||!ids.has(i.employeeId)||!ids.has(i.createdBy)||i.kind!==undefined&&!['join','reset'].includes(i.kind)||!Number.isFinite(Date.parse(i.expiresAt))||!Number.isFinite(Date.parse(i.createdAt))||i.usedAt!==null&&!Number.isFinite(Date.parse(i.usedAt))||i.tokenHash!==null&&(!/^[a-f0-9]{64}$/.test(i.tokenHash)||hashes.has(i.tokenHash)))throw new Error('员工邀请记录损坏。');
    invitationIds.add(i.id);if(i.tokenHash)hashes.add(i.tokenHash);
  }
  if(!data.employees.some(e=>e.status==='active'&&e.roles.includes('admin')))throw new Error('员工账号缺少有效管理员。');
  return data;
}

async function atomicSave(filePath,data){
  const directory=path.dirname(filePath),temporary=path.join(directory,`.${path.basename(filePath)}.${randomBytes(12).toString('hex')}.tmp`);
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  let handle;
  try{
    handle=await fs.open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);
    await handle.writeFile(JSON.stringify(data)+'\n','utf8');await handle.sync();await handle.close();handle=null;
    await fs.rename(temporary,filePath);await fs.chmod(filePath,0o600);
    const dir=await fs.open(directory,constants.O_RDONLY);try{await dir.sync();}finally{await dir.close();}
  }catch(error){if(handle)await handle.close().catch(()=>{});await fs.unlink(temporary).catch(()=>{});throw error;}
}

/** Single-process identity store. Business permissions must use these trusted IDs,
 * never roles supplied in a request body. The access gate owns cookie signing,
 * origin checks, login rate limits and CSRF; resolveSession checks revocation. */
export async function createErpIdentity({filePath,legacyUsername=process.env.OFFICE_ACCESS_USERNAME||process.env.OFFICE_ACCESS_USER||'office',now=Date.now}={}){
  if(typeof filePath!=='string'||!filePath)throw new Error('需要员工账号文件路径。');
  filePath=path.resolve(filePath);legacyUsername=usernameOf(legacyUsername);
  const timestamp=()=>new Date(now()).toISOString();
  let state;
  try{
    const handle=await fs.open(filePath,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    try{const stat=await handle.stat();if(!stat.isFile()||stat.size>MAX_FILE_BYTES)throw new Error('员工账号文件不可读取。');state=validateState(JSON.parse(await handle.readFile('utf8')));}finally{await handle.close();}
  }catch(error){
    if(error.code!=='ENOENT')throw error;
    const date=timestamp();state={version:1,employees:[{id:'bootstrap',username:legacyUsername,name:'系统管理员',department:'总经办',title:'管理员',roles:['admin'],status:'active',source:'legacy',passwordHash:null,epoch:1,createdAt:date,updatedAt:date}],invitations:[],audit:[]};
    await atomicSave(filePath,state);
  }
  const dummyHash=await hashAccessPassword(randomBytes(32).toString('base64url'));
  let queue=Promise.resolve();
  function transact(mutator){
    const result=queue.then(async()=>{const next=clone(state),value=await mutator(next);validateState(next);await atomicSave(filePath,next);state=next;return value;});
    queue=result.catch(()=>{});return result;
  }
  function activeEmployee(data,id){const e=data.employees.find(e=>e.id===id);if(!e||e.status!=='active')throw fail('员工账号不可用。',403);return e;}
  function administrator(data,id){const e=activeEmployee(data,id);if(!e.roles.includes('admin'))throw fail('需要管理员权限。',403);return e;}
  function audit(data,action,actorId,employeeId,detail={}){data.audit.push({id:randomUUID(),action,actorId,employeeId,at:timestamp(),...detail});if(data.audit.length>MAX_AUDIT)data.audit.splice(0,data.audit.length-MAX_AUDIT);}
  function invitation(data,actorId,employee,expiresInHours,kind='join'){
    if(!Number.isInteger(expiresInHours)||expiresInHours<1||expiresInHours>168)throw fail('邀请有效期需为1至168小时。');
    for(const previous of data.invitations)if(previous.employeeId===employee.id&&!previous.usedAt)previous.tokenHash=null;
    const token=randomBytes(32).toString('base64url'),record={id:randomUUID(),kind,employeeId:employee.id,createdBy:actorId,createdAt:timestamp(),expiresAt:new Date(now()+expiresInHours*3600000).toISOString(),usedAt:null,tokenHash:digest(token)};
    // Expired/revoked invitations carry no usable token and need not grow forever.
    data.invitations=data.invitations.filter(i=>i.tokenHash!==null&&Date.parse(i.expiresAt)>now());
    data.invitations.push(record);audit(data,kind==='reset'?'password.reset.requested':'invitation.created',actorId,employee.id);
    return {id:record.id,kind,token,expiresAt:record.expiresAt,employee:publicEmployee(employee)};
  }
  return {
    roles:ERP_ROLES,
    getEmployee(id){const e=state.employees.find(e=>e.id===id);return e?publicEmployee(e):null;},
    resolveLegacy(username){const e=state.employees.find(e=>e.source==='legacy'&&e.username===String(username??legacyUsername).toLowerCase());return e?.status==='active'?trustedIdentity(e):null;},
    resolveSession(session){const e=state.employees.find(e=>e.id===session?.id);return e?.status==='active'&&e.epoch===session.epoch?trustedIdentity(e):null;},
    listEmployees(actorId){administrator(state,actorId);return state.employees.map(publicEmployee);},
    listDirectory(actorId){activeEmployee(state,actorId);return state.employees.filter(e=>e.status==='active').map(e=>({id:e.id,username:e.username,name:e.name,department:e.department,title:e.title,roles:[...e.roles],active:true,status:'active'}));},
    listAudit(actorId){administrator(state,actorId);return clone(state.audit);},
    async authenticate(credentials){
      let username;try{username=usernameOf(credentials?.username);}catch{username='';}
      const before=state.employees.find(e=>e.username===username&&e.source==='employee');
      const ok=await passwordMatches(credentials?.password,before?.passwordHash||dummyHash);
      // Re-read after the expensive password check so disabling or changing a
      // password while a login is in flight cannot mint a current session.
      const current=state.employees.find(e=>e.id===before?.id);
      return ok&&current?.status==='active'&&current.epoch===before.epoch&&current.passwordHash===before.passwordHash?trustedIdentity(current):null;
    },
    async createInvitation(actorId,input={}){
      administrator(state,actorId);
      const username=usernameOf(input.username),profile=profileOf(input),roles=rolesOf(input.roles??['employee']);
      return transact(data=>{administrator(data,actorId);if(data.employees.length>=MAX_EMPLOYEES)throw fail('员工账号数量已达上限。',409);if(data.employees.some(e=>e.username===username))throw fail('账号已存在。',409);
        const date=timestamp(),employee={id:randomUUID(),username,...profile,roles,status:'invited',source:'employee',passwordHash:null,epoch:1,createdAt:date,updatedAt:date};data.employees.push(employee);return invitation(data,actorId,employee,input.expiresInHours??72);});
    },
    async reissueInvitation(actorId,employeeId,{expiresInHours=72}={}){
      return transact(data=>{administrator(data,actorId);const employee=data.employees.find(e=>e.id===employeeId);if(!employee||employee.source!=='employee'||employee.passwordHash!==null||!['invited','disabled'].includes(employee.status))throw fail('仅未完成入驻的账号可以重新邀请。',409);
        if(employee.status==='disabled'){employee.status='invited';employee.epoch++;employee.updatedAt=timestamp();}
        return invitation(data,actorId,employee,expiresInHours);});
    },
    async createPasswordReset(actorId,{employeeId,expiresInHours=24}={}){
      return transact(data=>{administrator(data,actorId);const employee=activeEmployee(data,employeeId);if(employee.source==='legacy')throw fail('管理员原始登录口令由服务器配置维护。',409);return invitation(data,actorId,employee,expiresInHours,'reset');});
    },
    async acceptInvitation({token,password}={}){
      const tokenShape=typeof token==='string'&&/^[-_A-Za-z0-9]{43}$/.test(token),hash=tokenShape?digest(token):'';
      const available=data=>data.invitations.find(i=>i.tokenHash===hash&&!i.usedAt&&Date.parse(i.expiresAt)>now());
      if(!tokenShape||!available(state))throw fail('邀请无效或已过期。',410);
      const passwordHash=await employeePassword(password);
      return transact(data=>{const invite=available(data),employee=data.employees.find(e=>e.id===invite?.employeeId),reset=invite?.kind==='reset';if(!invite||employee?.source!=='employee'||employee.status!==(reset?'active':'invited'))throw fail('邀请无效或已过期。',410);
        employee.passwordHash=passwordHash;employee.status='active';employee.epoch++;employee.updatedAt=timestamp();invite.usedAt=timestamp();invite.tokenHash=null;audit(data,reset?'password.reset.completed':'employee.joined',employee.id,employee.id);return trustedIdentity(employee);});
    },
    async updateEmployee(actorId,employeeId,input={}){
      const allowed=new Set(['active','roles','name','department','title']);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed.has(key)))throw fail('员工资料字段不正确。');
      return transact(data=>{administrator(data,actorId);const employee=data.employees.find(e=>e.id===employeeId);if(!employee)throw fail('员工不存在。',404);
        const nextRoles=has(input,'roles')?rolesOf(input.roles):employee.roles;
        if(has(input,'active')&&typeof input.active!=='boolean')throw fail('员工状态不正确。');
        if(employee.status==='invited'&&input.active===true)throw fail('员工需要先完成邀请入驻。',409);
        if(input.active===true&&employee.source==='employee'&&!employee.passwordHash)throw fail('请重新邀请员工完成入驻。',409);
        const nextStatus=has(input,'active')?(input.active?'active':'disabled'):employee.status;
        const rolesChanged=JSON.stringify(nextRoles)!==JSON.stringify(employee.roles);
        if(actorId===employeeId&&(nextStatus!=='active'||rolesChanged))throw fail('不能停用自己或修改自己的角色。',409);
        if(employee.status==='active'&&employee.roles.includes('admin')&&(nextStatus!=='active'||!nextRoles.includes('admin'))&&!data.employees.some(e=>e.id!==employee.id&&e.status==='active'&&e.roles.includes('admin')))throw fail('至少保留一名有效管理员。',409);
        for(const [key,label] of [['name','姓名'],['department','部门'],['title','岗位']])if(has(input,key))employee[key]=textOf(input[key],label,key==='name');
        const previousStatus=employee.status;employee.roles=nextRoles;employee.status=nextStatus;
        if(rolesChanged||previousStatus!==nextStatus)employee.epoch++;
        if(nextStatus==='disabled')for(const invite of data.invitations)if(invite.employeeId===employee.id)invite.tokenHash=null;
        employee.updatedAt=timestamp();audit(data,'employee.updated',actorId,employee.id,{roles:[...nextRoles],status:nextStatus});return publicEmployee(employee);});
    },
    async changePassword(actorId,{currentPassword,newPassword}={}){
      const before=activeEmployee(state,actorId);if(before.source==='legacy')throw fail('管理员原始登录口令由服务器配置维护。',409);
      if(!await passwordMatches(currentPassword,before.passwordHash))throw fail('原密码不正确。',401);
      const nextHash=await employeePassword(newPassword);
      return transact(data=>{const employee=activeEmployee(data,actorId);if(employee.epoch!==before.epoch||employee.passwordHash!==before.passwordHash)throw fail('账号已变更，请重新登录。',409);employee.passwordHash=nextHash;employee.epoch++;employee.updatedAt=timestamp();audit(data,'password.changed',actorId,actorId);return trustedIdentity(employee);});
    },
    assertCanApprove(actorId,{requesterId,requiredRoles=[]}={}){
      const employee=activeEmployee(state,actorId);if(typeof requesterId!=='string'||!requesterId)throw fail('缺少申请人。');
      if(actorId===requesterId)throw fail('申请人不能审批自己的申请。',403);
      if(!Array.isArray(requiredRoles)||requiredRoles.some(role=>!knownRoles.has(role)))throw fail('审批角色不正确。');
      if(!employee.roles.includes('admin')&&(!requiredRoles.length||!requiredRoles.some(role=>employee.roles.includes(role))))throw fail('没有此项审批权限。',403);
      return publicEmployee(employee);
    }
  };
}
