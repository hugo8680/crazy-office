import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const tool=fileURLToPath(new URL('../tools/erp_store.py',import.meta.url));
export const ERP_WORKFLOW_TYPES=['project_setup','project_delivery','purchase','sales','stocktake','resource','weekly_report','onboarding'];
export class ErpStoreError extends Error {
  constructor(message,code='VALIDATION',status=400){super(message);this.name='ErpStoreError';this.code=code;this.status=status;}
}

/** The actor is supplied by the authenticated HTTP session, never by request JSON.
 * recordAgentResult is a server-only capability: command deliberately exposes no equivalent action.
 */
export function createErpStore({dataDir,python=process.env.OFFICE_PYTHON||'/usr/bin/python3'}={}){
  if(typeof dataDir!=='string'||!dataDir)throw new Error('ERP需要持久化目录');
  const directory=path.join(path.resolve(dataDir),'erp');
  const backupDirectory=path.join(path.resolve(dataDir),'backups');
  const databasePath=path.join(directory,'office-erp.sqlite');
  const ready=fs.mkdir(directory,{recursive:true,mode:0o700});
  async function call(message){
    await ready;
    return new Promise((resolve,reject)=>{
      let stdout='',stderr='',done=false;
      const child=spawn(python,['-B',tool],{stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});
      const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value);};
      const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new ErpStoreError('业务台账处理超时，请用原请求编号重试以核对结果','TIMEOUT',503));},20000);
      child.stdout.on('data',chunk=>{stdout+=chunk.toString();if(stdout.length>12*1024*1024){child.kill('SIGKILL');finish(new ErpStoreError('业务台账响应超过上限','LIMIT',413));}});
      child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-1000);});
      child.on('error',()=>finish(new ErpStoreError('业务台账Python工具无法启动','UNAVAILABLE',503)));
      child.on('close',()=>{if(done)return;try{const r=JSON.parse(stdout);if(!r.ok)finish(new ErpStoreError(r.error||'业务处理失败',r.code||'VALIDATION',r.status||400));else finish(null,r.result);}catch{finish(new ErpStoreError('业务台账返回异常，请查阅服务日志','UNAVAILABLE',503));}});
      child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({...message,databasePath}));
    });
  }
  return {
    databasePath,
    snapshot:actor=>call({operation:'snapshot',actor}),
    command:(actor,action,payload={},options={})=>call({operation:'command',actor,action,payload,idempotencyKey:options.idempotencyKey}),
    recordAgentResult:({documentId,proposal,evidence,runId,expectedVersion})=>call({operation:'agent_result',payload:{documentId,proposal,evidence,runId,expectedVersion}}),
    async backup(destination,{actor}={}){
      if(typeof destination!=='string'||path.dirname(path.resolve(destination))!==backupDirectory||! /^[A-Za-z0-9_.-]+\.sqlite$/.test(path.basename(destination))){throw new ErpStoreError('备份须保存在本公司backups目录内，文件名须以.sqlite结尾');}
      await fs.mkdir(backupDirectory,{recursive:true,mode:0o700});
      const [realBase,realBackup]=await Promise.all([fs.realpath(path.resolve(dataDir)),fs.realpath(backupDirectory)]);
      if(realBackup!==path.join(realBase,'backups'))throw new ErpStoreError('备份目录不能指向其他位置','FORBIDDEN',403);
      return call({operation:'backup',actor,payload:{destination:path.resolve(destination)}});
    },
  };
}
