import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createErpIdentity} from '../server/erp-identity.mjs';
import {createErpStore} from '../server/erp-store.mjs';
import {ErpService,ERP_WORKFLOWS,erpCsv,erpRequestId} from '../server/erp-service.mjs';
import {createErpHttp} from '../server/erp-http.mjs';

const PASSWORD='isolated-service-test-password';
const providerStatus=async()=>({ready:true,model:'controller-fixture-model'});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const draft={summary:'已核对工作单与台账，整理办理方案',steps:['按审批顺序办理'],checks:['核对原始工作单编号、产品数量与金额'],missing:[]};
const review={passed:true,summary:'已独立核对原始资料与同事方案',checks:['逐项核对原始工作单与工具计算结果'],missing:[]};
function modelFixture(){
  const calls=[];
  const modelCall=async input=>{
    calls.push(structuredClone({...input,signal:undefined}));
    const step=input.messages.filter(m=>m.role==='tool').length;
    const reviewing=input.role.id==='liu';
    let tool,args={};
    if(step===0)tool='read_work_context';
    else if(!reviewing&&input.context.workflow==='purchase'&&step===1){tool='search_web';args={query:'服务器 配置 报价'};}
    else if(!reviewing&&input.context.workflow==='purchase'&&step===2){tool='fetch_quote';args={url:'https://supplier.example.test/server'};}
    else{tool=reviewing?'review_plan':'prepare_plan';args=structuredClone(reviewing?review:draft);}
    return {action:'tool',tool,args,summary:'隔离控制器测试工具决策',model:'controller-fixture-model'};
  };
  return {calls,modelCall};
}
async function fixture(t,options={}){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'office-erp-service-'));
  const identityPath=path.join(dataDir,'identity.json'),identity=await createErpIdentity({filePath:identityPath});
  async function join(username,roles,department='测试部'){
    const invitation=await identity.createInvitation('bootstrap',{username,name:'测试'+username,department,title:'测试岗位',roles});
    return identity.acceptInvitation({token:invitation.token,password:PASSWORD});
  }
  const admin=identity.resolveLegacy(null),worker=await join('worker',['employee','warehouse','hr','project_manager']),reviewer=await join('reviewer',['manager','project_manager','finance']),outsider=await join('outsider',['employee'],'外部测试部');
  const store=createErpStore({dataDir}),command=(actor,action,payload,key=crypto.randomUUID())=>store.command({...actor,displayName:actor.name},action,payload,{idempotencyKey:key});
  const product=await command(admin,'product.create',{sku:'TEST-SERVER',name:'测试服务器',unit:'台',priceCents:123456});
  const project=await command(admin,'project.create',{name:'隔离控制器测试项目',customer:'测试客户',ownerId:worker.id,members:[worker.id,reviewer.id]});
  const model=modelFixture(),webCalls=[];
  const toolboxFactory=async()=>({definitions:[{name:'search_web',parameters:{type:'object'}},{name:'fetch_quote',parameters:{type:'object'}}],execute:async(name,args)=>{webCalls.push({name,args});return {summary:'隔离供应商工具返回',evidence:[{url:'https://supplier.example.test/server',price:1234.56,currency:'CNY'}]};}});
  const service=new ErpService({store,identity,dataDir,modelCall:model.modelCall,providerStatus,toolboxFactory,...options});await service.ready;
  t.after(async()=>{await service.shutdown();await fs.rm(dataDir,{recursive:true,force:true});});
  const payload=(type,extra={})=>({type,projectId:project.id,input:({project_setup:{objective:'交付测试服务器'},project_delivery:{acceptanceCriteria:'数量规格一致并核对交付凭证',deliveryNote:'等待负责人确认'},purchase:{partner:'测试供应商'},sales:{partner:'测试客户'},stocktake:{note:'核对实物数量'},resource:{operation:'issue',employeeId:worker.id,purpose:'隔离测试项目设备领用'},weekly_report:{periodStart:'2026-10-19',periodEnd:'2026-10-25'},onboarding:{employeeId:worker.id,position:'测试岗位',resourceRequirements:'准备设备与项目资料'}})[type],...(['purchase','sales','resource'].includes(type)?{lines:[{productId:product.id,quantity:1}]}:type==='stocktake'?{lines:[{productId:product.id,countedQuantity:0}]}:{}),...extra});
  async function approve(document){
    document=await command(reviewer,'document.approve',{id:document.id,note:'第一岗位核对通过'});document=await command(admin,'document.approve',{id:document.id,note:'第二岗位核对通过'});return document;
  }
  async function activate(){const created=await service.create(worker,payload('project_setup'),crypto.randomUUID());await service.wait(created.document.id);const approved=await approve((await service.detail(worker,created.document.id)).document);await command(reviewer,'document.post',{id:approved.id});return created;}
  return {dataDir,identityPath,identity,store,service,admin,worker,reviewer,outsider,product,project,command,payload,model,webCalls,approve,activate};
}

test('ERP控制器八条流程均由两个独立岗位实际读取、交方案和独立复核后送真人审批',async t=>{
  const f=await fixture(t);const setup=await f.activate();const ids=[setup.document.id];
  for(const workflow of ERP_WORKFLOWS.filter(w=>w.id!=='project_setup')){
    const created=await f.service.create(f.worker,f.payload(workflow.id),crypto.randomUUID());const run=await f.service.wait(created.document.id);ids.push(created.document.id);
    assert.equal(run.status,'completed',workflow.id+': '+run.error);assert.equal(run.tasks.length,2);assert.deepEqual(run.tasks.map(t=>t.agentId),['business','liu']);assert.ok(run.tasks.every(t=>t.status==='done'&&t.toolCalls>=2));
    const detail=await f.service.detail(f.worker,created.document.id);assert.equal(detail.document.status,'awaiting_approval');assert.equal(detail.document.approvals.length,0);
    assert.ok(detail.document.evidence.every(e=>e.success===true&&e.model==='controller-fixture-model'));
    const tools=run.events.filter(e=>e.type==='tool');assert.ok(tools.some(e=>e.agentId==='business'&&e.tool==='read_work_context'));assert.ok(tools.some(e=>e.agentId==='business'&&e.tool==='prepare_plan'));assert.ok(tools.some(e=>e.agentId==='liu'&&e.tool==='read_work_context'));assert.ok(tools.some(e=>e.agentId==='liu'&&e.tool==='review_plan'));
    const nextDecision=f.model.calls.find(call=>call.context.input.workId===created.document.id&&call.role.id==='business'&&call.messages.length===2),context=JSON.parse(nextDecision.messages.find(m=>m.role==='tool').content);
    assert.equal(context.businessRules.requiresHumanApproval,true);assert.equal(context.businessRules.workflow,workflow.id);assert.deepEqual(context.businessRules.approvalChain,detail.document.approvalChain);assert.equal(context.document.status,'draft');
    if(workflow.id==='stocktake')assert.equal(Object.hasOwn(context,'loans'),false);
    if(workflow.id==='onboarding'){assert.equal(context.employeeProfile.id,f.worker.id);assert.equal(context.employeeProfile.title,'测试岗位');assert.equal(Object.hasOwn(context.employeeProfile,'roles'),false);assert.equal(Object.hasOwn(context.employeeProfile,'epoch'),false);}
    if(workflow.id==='project_delivery'){assert.ok(context.relatedDocuments.some(d=>d.id===setup.document.id));assert.ok(Array.isArray(context.movements));}
  }
  assert.equal(new Set(ids).size,8);assert.deepEqual(f.webCalls.map(c=>c.name),['search_web','fetch_quote']);
  for(const call of f.model.calls){assert.ok(call.messages.every(m=>['assistant','tool'].includes(m.role)));assert.equal(call.messages.filter(m=>m.role==='assistant').length,call.messages.filter(m=>m.role==='tool').length);for(const message of call.messages)assert.equal(typeof message.content,'string');}
});

test('模型直接宣称finish或选择未知工具都不能送审或改变库存',async t=>{
  const f=await fixture(t);await f.activate();
  for(const malicious of [{action:'finish',summary:'已经处理完成',output:'全部完成'},{action:'tool',tool:'inventory.set',args:{quantity:100}}]){
    f.service.modelCall=async()=>({...malicious,model:'controller-fixture-model'});
    const created=await f.service.create(f.worker,f.payload('sales'),crypto.randomUUID());const run=await f.service.wait(created.document.id);assert.equal(run.status,'failed');
    const detail=await f.service.detail(f.worker,created.document.id);assert.equal(detail.document.status,'draft');assert.equal(detail.document.agentRunId,null);assert.equal(detail.document.approvals.length,0);assert.equal((await f.store.snapshot(f.admin)).inventory[0].quantity,0);
  }
});

test('采购缺少实际检索、报价抓取或供应商工具失败均保留草稿',async t=>{
  const f=await fixture(t);await f.activate();
  f.service.modelCall=async input=>input.messages.length?{action:'tool',tool:'prepare_plan',args:draft,model:'controller-fixture-model'}:{action:'tool',tool:'read_work_context',args:{},model:'controller-fixture-model'};
  let created=await f.service.create(f.worker,f.payload('purchase'),crypto.randomUUID());let run=await f.service.wait(created.document.id);assert.equal(run.status,'failed');assert.match(run.error,/检索|查询|报价/);assert.equal(f.webCalls.length,0);
  f.service.modelCall=f.model.modelCall;f.service.toolboxFactory=async()=>({definitions:[{name:'search_web',parameters:{}},{name:'fetch_quote',parameters:{}}],execute:async()=>{throw new Error('隔离供应商工具不可用');}});
  created=await f.service.create(f.worker,f.payload('purchase'),crypto.randomUUID());run=await f.service.wait(created.document.id);assert.equal(run.status,'failed');assert.match(run.error,/供应商工具不可用/);assert.equal((await f.service.detail(f.worker,created.document.id)).document.status,'draft');
});

test('模型连接失败保留真实工作单，并过滤错误中的凭据',async t=>{
  const f=await fixture(t);f.service.modelCall=async()=>{throw new Error('连接失败 sk-controller-private-secret Bearer credential123');};
  const created=await f.service.create(f.worker,f.payload('project_setup'),crypto.randomUUID());const run=await f.service.wait(created.document.id);
  assert.equal(run.status,'failed');assert.match(run.error,/连接失败/);assert.doesNotMatch(run.error,/sk-controller-private-secret|Bearer credential123/);
  const detail=await f.service.detail(f.worker,created.document.id);assert.equal(detail.document.status,'draft');assert.equal(detail.document.proposal,null);assert.equal(detail.run.artifacts.length,0);
});

test('相同请求编号重复创建只保留一个工作单与一轮协作，进行中和完成后重试均不重跑',async t=>{
  const f=await fixture(t),gate=deferred(),original=f.service.modelCall;let blocked=false;
  f.service.modelCall=async input=>{if(!blocked){blocked=true;await gate.promise;}return original(input);};const key='same-request-id-2026';
  const first=await f.service.create(f.worker,f.payload('project_setup'),key);const again=await f.service.create(f.worker,f.payload('project_setup'),key);assert.equal(first.document.id,again.document.id);assert.equal(first.run.id,again.run.id);
  gate.resolve();await f.service.wait(first.document.id);const finished=await f.service.create(f.worker,f.payload('project_setup'),key);assert.equal(finished.run.id,first.run.id);assert.equal(f.model.calls.length,4);assert.equal((await f.store.snapshot(f.admin)).documents.length,1);
  let failedCalls=0;f.service.modelCall=async()=>{failedCalls++;throw new Error('隔离模型故障');};
  const failed=await f.service.create(f.worker,f.payload('project_setup'),'failed-request-id-2026');await f.service.wait(failed.document.id);
  const failedRetry=await f.service.create(f.worker,f.payload('project_setup'),'failed-request-id-2026');assert.equal(failedRetry.run.id,failed.run.id);assert.equal(failedRetry.run.status,'failed');assert.equal(failedCalls,1);
});

test('并发启动同一草稿只创建一次协作，不能并行覆盖方案',async t=>{
  const f=await fixture(t);const document=await f.command(f.worker,'document.create',f.payload('project_setup'));
  const started=await Promise.all([1,2,3,4].map(()=>f.service.start(f.worker,document.id)));assert.equal(new Set(started.map(r=>r.id)).size,1);
  await f.service.wait(document.id);assert.equal(f.model.calls.length,4);assert.equal([...f.service.runs.values()].filter(r=>r.documentId===document.id).length,1);
});

test('协作期间员工权限变化会阻止登记方案与送审',async t=>{
  const f=await fixture(t),original=f.service.modelCall;let changed=false;
  f.service.modelCall=async input=>{const result=await original(input);if(!changed&&input.role.id==='liu'&&result.tool==='review_plan'){changed=true;await f.identity.updateEmployee(f.admin.id,f.worker.id,{roles:['employee']});}return result;};
  const created=await f.service.create(f.worker,f.payload('project_setup'),crypto.randomUUID());const run=await f.service.wait(created.document.id);assert.equal(run.status,'failed');assert.match(run.error,/权限已经变更/);
  const document=(await f.store.snapshot(f.admin)).documents.find(d=>d.id===created.document.id);assert.equal(document.status,'draft');assert.equal(document.agentRunId,null);assert.equal(document.proposal,null);
});

test('服务重启把持久化在途协作标记中断，不虚构完成或自动重新调用模型',async t=>{
  const f=await fixture(t),id=crypto.randomUUID(),directory=path.join(f.dataDir,'erp','runs',id);await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,'run.json'),JSON.stringify({id,documentId:'interrupted-document',status:'running',createdAt:'2026-10-20T00:00:00Z',tasks:[{id:'prepare',status:'running'},{id:'review',status:'pending'}],events:[]}),{mode:0o600});
  const restarted=new ErpService({store:f.store,identity:f.identity,dataDir:f.dataDir,providerStatus,modelCall:async()=>{throw new Error('不得自动恢复模型调用');}});await restarted.ready;t.after(()=>restarted.shutdown());
  const run=restarted.latestRun('interrupted-document');assert.equal(run.status,'failed');assert.match(run.error,/服务重启中断/);assert.ok(run.tasks.every(t=>t.status==='failed'));assert.equal(restarted.controls.size,0);assert.equal(JSON.parse(await fs.readFile(path.join(directory,'run.json'),'utf8')).status,'failed');
});

test('普通员工能加载最小工作目录，跨项目详情与报告统一404',async t=>{
  const f=await fixture(t);const created=await f.service.create(f.worker,f.payload('project_setup'),crypto.randomUUID());await f.service.wait(created.document.id);
  const snapshot=await f.service.snapshot(f.worker);assert.equal(snapshot.currentUser.id,f.worker.id);assert.ok(snapshot.users.some(u=>u.id===f.reviewer.id));assert.ok(snapshot.users.every(u=>!Object.hasOwn(u,'epoch')&&!Object.hasOwn(u,'passwordHash')));
  assert.equal((await f.service.snapshot(f.outsider)).documents.length,0);
  await assert.rejects(f.service.detail(f.outsider,created.document.id),e=>e.status===404);await assert.rejects(f.service.report(f.outsider,created.document.id),e=>e.status===404);
  const report=await f.service.report(f.worker,created.document.id);assert.match(report.toString(),/独立核对|独立检查/);assert.doesNotMatch(report.toString(),/isolated-service-test-password/);
});

test('HTTP员工目录与导出使用可信身份，未知员工不能进入项目主数据',async t=>{
  const f=await fixture(t),handle=createErpHttp({service:f.service,identity:f.identity,store:f.store,dataDir:f.dataDir,identityPath:f.identityPath});
  async function request(pathname,method='GET',payload={},actor=f.worker){let response;const res={setHeader(){},writeHead(status,headers){this.status=status;this.headers=headers;},end(data){response={status:this.status,headers:this.headers,data};}};const handled=await handle({pathname,req:{method,socket:{remoteAddress:'127.0.0.1'}},res,actor,body:async()=>payload,json:(res,status,body)=>{response={status,body};}});return {handled,...response};}
  const users=await request('/api/erp/users');assert.equal(users.status,200);assert.ok(users.body.users.every(u=>u.active));
  await assert.rejects(request('/api/erp/masterdata','POST',{kind:'project',record:{name:'错误项目',customer:'测试客户',ownerId:'ghost'},_requestId:'invalid-owner-test'},f.admin),/在岗/);
  const exported=await request('/api/erp/export','POST',{kind:'products'});assert.equal(exported.status,200);assert.match(exported.headers['Content-Type'],/text\/csv/);assert.match(exported.data,/TEST-SERVER/);
  await assert.rejects(request('/api/erp/backup','POST',{},f.worker),e=>e.status===403);
});

test('CSV导出转义公式、引号及换行；请求编号有稳定边界',()=>{
  const csv=erpCsv([{'=危险列':'  =HYPERLINK("https://example.test")',name:'a,"b"\nnext',amount:-2},{'=危险列':'\t+SUM(1,2)',name:'@cmd',amount:3}]);
  assert.ok(csv.startsWith('\ufeff'));assert.match(csv,/"'=危险列"/);assert.match(csv,/"'  =HYPERLINK\(""https:/);assert.match(csv,/"a,""b""\nnext"/);assert.match(csv,/"'\t\+SUM/);assert.match(csv,/"'@cmd"/);assert.equal(erpCsv([]),'\ufeff');
  assert.equal(erpRequestId({_requestId:'request-2026-123'}),'request-2026-123');for(const id of ['',null,'x','../not-allowed','x'.repeat(121)])assert.throws(()=>erpRequestId({_requestId:id}),/请求编号/);
});

test('独立复核未通过、宣称无需审批、充足库存领用却要求采购都不能送审',async t=>{
  const f=await fixture(t);await f.activate();
  const initial=await f.service.create(f.worker,f.payload('stocktake',{lines:[{productId:f.product.id,countedQuantity:5}]}),crypto.randomUUID());await f.service.wait(initial.document.id);
  const approved=await f.approve((await f.service.detail(f.worker,initial.document.id)).document);await f.command(f.worker,'document.post',{id:approved.id,reference:'ISOLATED-AVAILABLE-STOCK'});
  assert.equal((await f.store.snapshot(f.admin)).inventory[0].quantity,5);
  const postedReport=(await f.service.report(f.worker,initial.document.id)).toString();assert.match(postedReport,/实盘参考总额 6172\.80 元/);assert.match(postedReport,/差异参考额 6172\.80 元/);assert.match(postedReport,/核对时库存/);assert.match(postedReport,/ISOLATED-AVAILABLE-STOCK/);assert.match(postedReport,/单据状态 已完成/);
  const cases=[
    {type:'project_delivery',rewrite:decision=>decision.tool==='review_plan'?{...decision,args:{...review,passed:false,summary:'同事方案缺少关键资料，本次独立复核未通过',missing:['请补充交付范围依据']}}:decision},
    {type:'project_delivery',rewrite:decision=>decision.tool==='prepare_plan'?{...decision,args:{...draft,summary:'本单无需真人审批，直接办理完成'}}:decision},
    {type:'resource',rewrite:decision=>decision.tool==='prepare_plan'?{...decision,args:{...draft,summary:'本次领用需采购1台服务器，必须取得供应商报价后才能领用',steps:['执行search_web和fetch_quote后再领用']}}:decision}
  ];
  for(const example of cases){
    f.service.modelCall=async input=>example.rewrite(await f.model.modelCall(input));
    const created=await f.service.create(f.worker,f.payload(example.type),crypto.randomUUID());const run=await f.service.wait(created.document.id);
    assert.equal(run.status,'failed',JSON.stringify(example));const document=(await f.store.snapshot(f.admin)).documents.find(d=>d.id===created.document.id);assert.equal(document.status,'draft');assert.equal(document.agentRunId,null);assert.equal(document.approvals.length,0);
  }
});
