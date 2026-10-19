import {writeFile,readFile,copyFile,chmod,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {isIP} from 'node:net';
import {randomUUID,createHash} from 'node:crypto';
import {ERP_ROLE_LABELS,ERP_WORKFLOWS,erpRequestId,erpCsv} from './erp-service.mjs';

const fail=(s,status=400)=>Object.assign(new Error(s),{status});
const admin=actor=>{if(!actor.roles.includes('admin'))throw fail('需要管理员办理。',403);};
export function createErpHttp({service,identity,store,dataDir,identityPath}){
 const attempts=new Map();
 const input=async(req,limit)=>{const value=await bodyReader(req,limit);delete value._requestId;return value;};let bodyReader;
 const addressOf=req=>{let ip=String(req.socket?.remoteAddress||'unknown');if(ip.startsWith('::ffff:'))ip=ip.slice(7);const forwarded=req.headers['x-real-ip'];return (ip==='::1'||ip.startsWith('127.'))&&typeof forwarded==='string'&&isIP(forwarded.trim())?forwarded.trim():ip;};
 return async function handle({req,res,pathname,actor,body,json}){
  if(!pathname.startsWith('/api/erp/'))return false;bodyReader=body;
  if(pathname==='/api/erp/invitations/accept'&&req.method==='POST'){
   const address=addressOf(req),now=Date.now();let bucket=attempts.get(address);
   if(!bucket||now-bucket.at>900000){bucket={at:now,count:0};if(attempts.size>10000)attempts.clear();attempts.set(address,bucket);}
   if(++bucket.count>20)throw fail('尝试过多，请15分钟后再试。',429);
   const {token,password}=await body(req,8192);const employee=await identity.acceptInvitation({token,password});json(res,200,{employee});return true;
  }
  if(!actor)throw fail('请登录办公室。',401);
  actor={...actor,displayName:actor.name||actor.username};
  const send=(status,value)=>{json(res,status,value);return true;};
  if(pathname==='/api/erp/catalog'&&req.method==='GET')return send(200,{workflows:ERP_WORKFLOWS,roles:ERP_ROLE_LABELS});
  if(pathname==='/api/erp/snapshot'&&req.method==='GET')return send(200,await service.snapshot(actor));
  if(pathname==='/api/erp/users'&&req.method==='GET')return send(200,{users:actor.roles.includes('admin')?identity.listEmployees(actor.id):identity.listDirectory(actor.id)});
  if(pathname==='/api/erp/invitations'&&req.method==='POST')return send(201,await identity.createInvitation(actor.id,await input(req,8192)));
  if(pathname==='/api/erp/identity/password'&&req.method==='POST'){const p=await body(req,8192);await identity.changePassword(actor.id,p);res.setHeader('Set-Cookie','__Host-office_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict');return send(200,{ok:true,message:'密码已修改，请重新登录。'});}
  const user=pathname.match(/^\/api\/erp\/users\/([A-Za-z0-9_-]{1,100})(?:\/(reset|invite))?$/);
  if(user){const [,id,action]=user;if(req.method==='PUT'&&!action)return send(200,{employee:await identity.updateEmployee(actor.id,id,await input(req,8192))});if(req.method==='POST'&&action==='reset')return send(201,await identity.createPasswordReset(actor.id,{employeeId:id}));if(req.method==='POST'&&action==='invite')return send(201,await identity.reissueInvitation(actor.id,id));}
  if(pathname==='/api/erp/masterdata'&&req.method==='POST'){
   const p=await body(req,32000);const action=({products:'product.create',product:'product.create',projects:'project.create',project:'project.create'})[p.kind];if(!action)throw fail('请选择产品或项目档案。');
   const record=p.record||{};if(action==='project.create'&&!record.ownerId)record.ownerId=actor.id;service.validatePeople(action,record);
   return send(201,{record:await store.command(actor,action,record,{idempotencyKey:erpRequestId(p)})});
  }
  const project=pathname.match(/^\/api\/erp\/projects\/([A-Za-z0-9_-]{1,100})$/);
  if(project&&req.method==='PUT'){const p=await body(req,32000),record=p.record||p;service.validatePeople('project.update',record);return send(200,{record:await store.command(actor,'project.update',{...record,id:project[1]},{idempotencyKey:erpRequestId(p)})});}
  if(pathname==='/api/erp/workitems'&&req.method==='POST'){const p=await body(req,128000);return send(202,await service.create(actor,p,erpRequestId(p)));}
  const item=pathname.match(/^\/api\/erp\/workitems\/([A-Za-z0-9_-]{1,100})(?:\/([a-z_]+))?$/);
  if(item){const [,id,action]=item;if(!action&&req.method==='GET')return send(200,await service.detail(actor,id));if(action==='report'&&req.method==='GET'){const data=await service.report(actor,id);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Disposition':"attachment; filename=office-report.html; filename*=UTF-8''"+encodeURIComponent('协作办理报告.html'),'Cache-Control':'no-store'});res.end(data);return true;}if(action&&req.method==='POST'){const p=await body(req,128000);return send(200,await service.action(actor,id,action,p,erpRequestId(p)));}}
  if(pathname==='/api/erp/tasks'&&req.method==='POST'){const p=await body(req,32000),record=p.record||p;service.validatePeople('task.create',record);return send(201,{task:await store.command(actor,'task.create',record,{idempotencyKey:erpRequestId(p)})});}
  const task=pathname.match(/^\/api\/erp\/tasks\/([A-Za-z0-9_-]{1,100})\/(complete|accept|return|reassign)$/);
  if(task&&req.method==='POST'){const p=await body(req,64000);if(task[2]==='reassign')service.validatePeople('task.reassign',p);return send(200,{task:await store.command(actor,'task.'+task[2],{...p,id:task[1]},{idempotencyKey:erpRequestId(p)})});}
  if(pathname==='/api/erp/presence'){
   if(req.method==='GET')return send(200,{online:service.online(),currentUser:actor});
   if(req.method==='PUT'){const p=await body(req,4096);return send(200,{online:service.touch(actor,p.nodeId),currentUser:actor});}
  }
  if(pathname==='/api/erp/export'&&req.method==='POST'){
   const p=await body(req,4096);const allowed=['products','projects','inventory','movements','tasks','performance','documents'];if(!allowed.includes(p.kind))throw fail('请选择有效报表。');
   const snapshot=await service.snapshot(actor),csv=erpCsv(snapshot[p.kind]);res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename=office-report.csv','Cache-Control':'no-store'});res.end(csv);return true;
  }
  if(pathname==='/api/erp/backup'&&req.method==='POST'){
   admin(actor);const id=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8);const dest=join(dataDir,'backups',id+'.sqlite');
   const database=await store.backup(dest,{actor});const file=join(dataDir,'backups',id+'.identities.json');await copyFile(identityPath,file);await chmod(file,0o600);const bytes=await readFile(file);
   const manifest={id,createdAt:new Date().toISOString(),actorId:actor.id,database,identity:{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},scope:'业务数据库与身份库分别生成一致副本，恢复前需在隔离环境核对'};await writeFile(join(dataDir,'backups',id+'.manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});return send(201,{backup:{id,createdAt:manifest.createdAt,database:{bytes:database.bytes,sha256:database.sha256,integrity:database.integrity},identity:manifest.identity}});
  }
  throw fail('业务接口不存在。',404);
 };
}
