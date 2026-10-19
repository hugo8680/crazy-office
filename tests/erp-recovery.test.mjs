import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {createErpIdentity} from '../server/erp-identity.mjs';
import {createErpStore} from '../server/erp-store.mjs';
import {ErpService} from '../server/erp-service.mjs';

const projectRoot=fileURLToPath(new URL('../',import.meta.url));
const providerStatus=async()=>({ready:true,model:'isolated-recovery-controller'});
const plan={summary:'依据当前工作资料整理本阶段办理方案',steps:['由两名不同真实员工依次审批后办理'],checks:['核对当前工作单、数量和业务范围'],missing:[]};
const review={passed:true,summary:'原始资料和同事方案的业务范围一致',checks:['独立核对当前工作单及工具核算'],missing:[]};

async function fixture(t){
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'office-erp-recovery-'));
 const identity=await createErpIdentity({filePath:path.join(dataDir,'erp','identities.json')});
 async function employee(username,roles){const invite=await identity.createInvitation('bootstrap',{username,name:username,department:'恢复测试部',title:'测试工程师',roles});return identity.acceptInvitation({token:invite.token,password:'isolated-recovery-test-password'});}
 const admin=identity.resolveLegacy(null),worker=await employee('worker',['employee','project_manager','warehouse','hr']),reviewer=await employee('reviewer',['manager','finance','project_manager']),other=await employee('other',['employee']);
 const store=createErpStore({dataDir}),command=(actor,action,payload)=>store.command({...actor,displayName:actor.name},action,payload,{idempotencyKey:randomUUID()});
 const project=await command(admin,'project.create',{name:'恢复测试项目A',customer:'测试客户',ownerId:worker.id,members:[worker.id,reviewer.id,other.id]});
 const calls=[];
 const modelCall=async input=>{calls.push(structuredClone({...input,signal:undefined}));return {action:'tool',tool:input.messages.length?(input.role.id==='liu'?'review_plan':'prepare_plan'):'read_work_context',args:input.messages.length?structuredClone(input.role.id==='liu'?review:plan):{},model:'isolated-recovery-controller'};};
 const service=new ErpService({store,identity,dataDir,modelCall,providerStatus});await service.ready;
 t.after(async()=>{await service.shutdown();await fs.rm(dataDir,{recursive:true,force:true});});
 async function postSeed(type,input,lines=[],projectId=project.id){
  let document=await command(worker,'document.create',{type,projectId,input,lines});
  const runId=randomUUID(),receipt=await store.recordAgentResult({documentId:document.id,expectedVersion:document.version,runId,proposal:{fixture:'仅准备隔离数据库台账'},evidence:[{agentId:'seed-prepare',success:true,runId},{agentId:'seed-review',success:true,runId}]});
  document=await command(worker,'document.submit',{id:document.id,version:receipt.version});
  document=await command(reviewer,'document.approve',{id:document.id,version:document.version,note:'隔离台账一级核对'});
  document=await command(admin,'document.approve',{id:document.id,version:document.version,note:'隔离台账二级核对'});
  return command(admin,'document.post',{id:document.id,version:document.version,reference:'ISOLATED-SEED-'+randomUUID()});
 }
 return {dataDir,identity,admin,worker,reviewer,other,store,command,service,project,calls,modelCall,postSeed};
}

test('占用端口启动的候选服务不能恢复或覆盖正在运行的ERP任务',async t=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'office-erp-port-owner-')),runId=randomUUID(),runDirectory=path.join(dataDir,'erp','runs',runId);
 await fs.mkdir(runDirectory,{recursive:true});
 const active={id:runId,documentId:'active-document',status:'running',createdAt:'2026-10-20T00:00:00.000Z',tasks:[{id:'prepare',status:'running'},{id:'review',status:'pending'}],events:[]};
 const file=path.join(runDirectory,'run.json'),original=JSON.stringify(active,null,2);await fs.writeFile(file,original);
 const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');
 const env={...process.env,PORT:String(listener.address().port),HOST:'127.0.0.1',OFFICE_DATA_DIR:dataDir,OFFICE_PUBLIC_ORIGIN:''};
 delete env.OFFICE_ACCESS_PASSWORD_HASH;
 const child=spawn(process.execPath,['scripts/server.mjs'],{cwd:projectRoot,env,stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await new Promise(resolve=>listener.close(resolve));await fs.rm(dataDir,{recursive:true,force:true});});
 const timer=setTimeout(()=>child.kill('SIGKILL'),15000);let code,signal;
 try{[code,signal]=await once(child,'close');}finally{clearTimeout(timer);}
 assert.equal(signal,null,output);assert.notEqual(code,0,output);assert.match(output,/EADDRINUSE/);
 assert.equal(await fs.readFile(file,'utf8'),original,'未获得监听端口的进程不得写入任务恢复状态');
});

test('报告文件写入失败保留可重试草稿，恢复磁盘路径后重新协作才能送审',async t=>{
 const f=await fixture(t);let blockedReport;
 f.service.modelCall=async input=>{
  const decision=await f.modelCall(input);
  if(!blockedReport&&decision.tool==='review_plan'){
   const run=f.service.latestRun(input.context.input.workId);blockedReport=path.join(f.service.dataDir,run.id,'report.html');await fs.mkdir(blockedReport);
  }
  return decision;
 };
 const created=await f.service.create(f.worker,{type:'project_setup',projectId:f.project.id,title:'报告失败恢复测试',input:{objective:'验证完整生成报告后才送审'}},randomUUID());
 const failed=await f.service.wait(created.document.id),detail=await f.service.detail(f.worker,created.document.id);
 assert.equal(failed.status,'failed');assert.match(failed.error,/EISDIR|directory|目录/i);assert.equal(failed.report,false);
 assert.equal(detail.document.status,'draft');assert.equal(detail.document.agentRunId,null);assert.equal(detail.document.proposal,null);assert.equal(detail.document.evidence.length,0);assert.ok(detail.document.allowedActions.includes('run_agents'));assert.equal(detail.document.reportUrl,null);
 await assert.rejects(f.service.report(f.worker,created.document.id),error=>error.status===404);
 await fs.rm(blockedReport,{recursive:true});f.service.modelCall=f.modelCall;
 await f.service.action(f.worker,created.document.id,'retry',{},randomUUID());
 const recovered=await f.service.wait(created.document.id),after=await f.service.detail(f.worker,created.document.id);
 assert.notEqual(recovered.id,failed.id);assert.equal(recovered.status,'completed',recovered.error);assert.equal(after.document.status,'awaiting_approval');assert.equal(after.document.agentRunId,recovered.id);assert.equal(after.document.approvals.length,0);assert.ok(after.document.reportUrl);
 assert.match((await f.service.report(f.worker,created.document.id)).toString(),/报告失败恢复测试/);
});

test('需求修订后隐藏旧轮次方案和报告，新Agent完成后才提供新版本报告',async t=>{
 const f=await fixture(t);
 const created=await f.service.create(f.worker,{type:'project_setup',projectId:f.project.id,title:'第一版项目要求',input:{objective:'第一版目标'}},randomUUID());await f.service.wait(created.document.id);
 assert.ok((await f.service.detail(f.worker,created.document.id)).document.reportUrl);
 let document=await f.service.document(f.worker,created.document.id);
 await f.service.action(f.admin,document.id,'return',{expectedVersion:document.version,note:'修改项目要求'},randomUUID());
 document=await f.service.document(f.worker,document.id);
 await f.service.action(f.worker,document.id,'revise',{expectedVersion:document.version,title:'第二版项目要求',input:{objective:'第二版不同目标'}},randomUUID());
 const revised=await f.service.detail(f.worker,document.id),snapshot=await f.service.snapshot(f.worker),row=snapshot.documents.find(d=>d.id===document.id);
 assert.equal(revised.document.status,'draft');assert.equal(revised.document.agentRunId,null);assert.equal(revised.document.proposal,null);assert.equal(revised.document.reportUrl,null);assert.equal(revised.run,null);assert.equal(row.reportUrl,null);assert.equal(row.agentRun,undefined);
 await assert.rejects(f.service.report(f.worker,document.id),error=>error.status===404);
 await f.service.action(f.worker,document.id,'run_agents',{},randomUUID());await f.service.wait(document.id);
 const fresh=await f.service.detail(f.worker,document.id),html=(await f.service.report(f.worker,document.id)).toString();
 assert.equal(fresh.document.status,'awaiting_approval');assert.ok(fresh.document.reportUrl);assert.match(html,/第二版项目要求/);assert.doesNotMatch(html,/第一版项目要求/);
 const read=f.calls.filter(c=>c.context.input.workId===document.id&&c.role.id==='business'&&c.messages.length===2).at(-1);
 assert.equal(JSON.parse(read.messages.find(m=>m.role==='tool').content).document.input.objective,'第二版不同目标');
});

test('业务动作必须带有效版本，过期版本拒绝，成功请求原样重试不重复审批',async t=>{
 const f=await fixture(t),created=await f.service.create(f.worker,{type:'project_setup',projectId:f.project.id,input:{objective:'验证版本门禁与响应丢失后的安全重试'}},randomUUID());
 await f.service.wait(created.document.id);
 const document=await f.service.document(f.worker,created.document.id);assert.equal(document.status,'awaiting_approval');assert.ok(document.version>1);
 for(const invalid of [undefined,null,0,-1,1.5,'3']){
  const payload={note:'尚未批准'};if(invalid!==undefined)payload.expectedVersion=invalid;
  await assert.rejects(f.service.action(f.reviewer,document.id,'approve',payload,randomUUID()),error=>error.status===400&&/版本/.test(error.message));
 }
 await assert.rejects(f.service.action(f.reviewer,document.id,'approve',{expectedVersion:document.version-1,note:'旧版本操作'},randomUUID()),error=>error.status===409&&error.code==='VERSION_CONFLICT');
 assert.equal((await f.service.document(f.worker,document.id)).approvals.length,0);
 const requestId=randomUUID(),payload={expectedVersion:document.version,note:'核对当前版本后批准'};
 const first=await f.service.action(f.reviewer,document.id,'approve',payload,requestId);
 assert.equal(first.document.approvalIndex,1);assert.equal(first.document.approvals.length,1);assert.ok(first.document.version>document.version);
 const repeated=await f.service.action(f.reviewer,document.id,'approve',payload,requestId);
 assert.deepEqual(repeated.document,first.document,'同请求号与原始payload重试应命中成功结果，即使其版本已经过期');
 const persisted=await f.service.document(f.worker,document.id);assert.equal(persisted.approvalIndex,1);assert.equal(persisted.approvals.length,1);assert.equal(persisted.version,first.document.version);assert.equal(persisted.status,'awaiting_approval');
});

test('项目工作单只向模型提供本项目的关联单据和员工借用台账',async t=>{
 const f=await fixture(t),product=await f.command(f.admin,'product.create',{sku:'SCOPE-ASSET',name:'隔离测试设备',unit:'台',priceCents:10000});
 await f.postSeed('project_setup',{objective:'启用项目A'});
 const projectB=await f.command(f.admin,'project.create',{name:'恢复测试项目B',customer:'另一客户',ownerId:f.worker.id,members:[f.worker.id,f.reviewer.id]});
 await f.postSeed('project_setup',{objective:'启用项目B'},[],projectB.id);
 await f.postSeed('stocktake',{note:'隔离测试初始实盘凭证'},[{productId:product.id,countedQuantity:6}]);
 const lines=[{productId:product.id,quantity:1}],loanA=await f.postSeed('resource',{operation:'issue',employeeId:f.worker.id,purpose:'项目A设备'},lines),loanB=await f.postSeed('resource',{operation:'issue',employeeId:f.worker.id,purpose:'项目B设备'},lines,projectB.id);
 const created=await f.service.create(f.worker,{type:'resource',projectId:f.project.id,input:{operation:'issue',employeeId:f.worker.id,purpose:'项目A追加设备'},lines},randomUUID());await f.service.wait(created.document.id);
 const decision=f.calls.find(c=>c.context.input.workId===created.document.id&&c.role.id==='business'&&c.messages.length===2),context=JSON.parse(decision.messages.find(m=>m.role==='tool').content);
 assert.ok(context.relatedDocuments.some(d=>d.id===loanA.id));assert.ok(context.employeeLoans.some(l=>l.documentId===loanA.id));assert.ok(context.loans.some(l=>l.documentId===loanA.id));
 assert.ok(context.relatedDocuments.every(d=>d.id!==loanB.id));assert.ok(context.employeeLoans.every(l=>l.documentId!==loanB.id));assert.ok(context.loans.every(l=>l.documentId!==loanB.id));
 assert.ok(context.tasks.every(task=>task.projectId===f.project.id));
});

test('无项目岗位准备只关联同一员工的无项目资源记录，不发送无关员工或项目资料',async t=>{
 const f=await fixture(t),product=await f.command(f.admin,'product.create',{sku:'COMPANY-ASSET',name:'公司公用设备',unit:'台',priceCents:5000});
 await f.postSeed('project_setup',{objective:'启用项目准备隔离测试'});
 await f.postSeed('stocktake',{note:'公用设备隔离期初盘点凭证'},[{productId:product.id,countedQuantity:8}]);
 const lines=[{productId:product.id,quantity:1}],ownCompanyLoan=await f.postSeed('resource',{operation:'issue',employeeId:f.worker.id,purpose:'本员工公司办公'},lines,null),otherCompanyLoan=await f.postSeed('resource',{operation:'issue',employeeId:f.other.id,purpose:'其他员工公司办公'},lines,null),projectLoan=await f.postSeed('resource',{operation:'issue',employeeId:f.worker.id,purpose:'本员工项目设备'},lines,f.project.id);
 const otherPreparation=await f.command(f.worker,'document.create',{type:'onboarding',input:{employeeId:f.other.id,position:'其他员工岗位',resourceRequirements:'其他员工资料不属于本任务'}});
 const unrelatedPurchase=await f.command(f.worker,'document.create',{type:'purchase',input:{partner:'与岗位准备无关的供应商'},lines});
 const created=await f.service.create(f.worker,{type:'onboarding',title:'本员工岗位准备',input:{employeeId:f.worker.id,position:'测试工程师',resourceRequirements:'核对现有公司设备领用记录'}},randomUUID());await f.service.wait(created.document.id);
 const decision=f.calls.find(c=>c.context.input.workId===created.document.id&&c.role.id==='business'&&c.messages.length===2),context=JSON.parse(decision.messages.find(m=>m.role==='tool').content);
 assert.deepEqual(context.relatedDocuments.map(d=>d.id),[ownCompanyLoan.id]);assert.deepEqual(context.employeeLoans.map(l=>l.documentId),[ownCompanyLoan.id]);assert.equal(context.tasks.length,0);
 for(const id of [otherCompanyLoan.id,projectLoan.id,otherPreparation.id,unrelatedPurchase.id])assert.ok(!JSON.stringify(context).includes(id));
 assert.equal(context.employeeProfile.id,f.worker.id);assert.equal(Object.hasOwn(context.employeeProfile,'roles'),false);assert.equal(Object.hasOwn(context.employeeProfile,'epoch'),false);
});
