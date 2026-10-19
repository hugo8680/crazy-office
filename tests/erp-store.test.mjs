import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {createErpStore} from '../server/erp-store.mjs';
import {mountErp} from '../dist/erp.js';
import {normalizeSnapshot,pendingTasks} from '../dist/erp-ui.mjs';

const role=(id,roles)=>({id,roles,displayName:id,department:'业务部'});
const users={admin:role('admin',['admin']),employee:role('employee',['employee']),manager:role('manager',['manager']),project_manager:role('pm',['project_manager']),finance:role('finance',['finance']),warehouse:role('warehouse',['warehouse']),hr:role('hr',['hr']),other:role('outsider',['employee'])};
async function fixture(t,{activate=true}={}){
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'office-erp-test-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
 const store=createErpStore({dataDir});
 const cmd=(actor,action,payload={},key=crypto.randomUUID())=>store.command(actor,action,payload,{idempotencyKey:key});
 const product=await cmd(users.admin,'product.create',{sku:'SERVER-01',name:'服务器',unit:'台',priceCents:100000});
 const project=await cmd(users.admin,'project.create',{name:'客户设备项目',customer:'客户A',ownerId:users.project_manager.id,members:Object.values(users).filter(a=>a.id!=='outsider').map(a=>a.id)});
 const create=(type,extra={},actor=users.employee)=>cmd(actor,'document.create',{type,projectId:project.id,input:{},...extra,...(type==='resource'?{input:{purpose:'隔离测试设备使用',...extra.input}}:{})});
 const agent=doc=>store.recordAgentResult({documentId:doc.id,runId:'run-'+crypto.randomUUID(),expectedVersion:doc.version,proposal:{summary:'已核对原始业务资料，待真人确认'},evidence:[{agentId:'operations',success:true,tool:'read_business_record'},{agentId:'reviewer',success:true,tool:'review_draft'}]});
 const approve=async(doc,requester=users.employee)=>{
  await agent(doc);doc=await cmd(requester,'document.submit',{id:doc.id});
  for(const stage of doc.approvalChain){let actor=users[stage];if(actor.id===requester.id)actor=users.admin;doc=await cmd(actor,'document.approve',{id:doc.id,note:'核对通过'});}
  return doc;
 };
 const stock=async quantity=>{let doc=await create('stocktake',{input:{note:'真实实物期初盘点'},lines:[{productId:product.id,countedQuantity:quantity}]},users.warehouse);doc=await approve(doc,users.warehouse);return cmd(users.warehouse,'document.post',{id:doc.id,reference:'COUNT-'+crypto.randomUUID()});};
 if(activate){const setup=await approve(await create('project_setup',{input:{objective:'客户设备交付项目'}}));await cmd(users.manager,'document.post',{id:setup.id});}
 return{store,cmd,product,project,create,agent,approve,stock};
}

test('ERP创建主数据，台账持久化、文件权限与参数化SQL',async t=>{
 const f=await fixture(t,{activate:false});assert.equal(f.project.status,'draft');assert.equal((await fs.stat(f.store.databasePath)).mode&0o777,0o600);
 const malicious="客户'); DROP TABLE products;--";
 await f.cmd(users.admin,'project.create',{name:'注入文本',customer:malicious});
 const next=createErpStore({dataDir:path.dirname(path.dirname(f.store.databasePath))});
 const s=await next.snapshot(users.admin);assert.equal(s.products.length,1);assert(s.projects.some(p=>p.customer===malicious));assert.equal(s.inventory[0].quantity,0);
});

test('ERP幂等请求防重复，同一编号不同资料拒绝，必须有请求编号',async t=>{
 const f=await fixture(t);const data={sku:'MOUSE',name:'鼠标'};
 const [a,b]=await Promise.all([f.cmd(users.admin,'product.create',data,'same'),f.cmd(users.admin,'product.create',data,'same')]);assert.deepEqual(a,b);
 await assert.rejects(()=>f.cmd(users.admin,'product.create',{...data,name:'改名'},'same'),e=>e.code==='IDEMPOTENCY_CONFLICT');
 await assert.rejects(()=>f.store.command(users.admin,'product.create',{sku:'NO',name:'无编号'}),/请求编号/);
 assert.equal((await f.store.snapshot(users.admin)).products.length,2);
});

test('ERP八种流程均要求真实多员工结果，普通command不能伪造协作或库存',async t=>{
 const f=await fixture(t);const d=await f.create('purchase',{input:{partner:'供应商A'},lines:[{productId:f.product.id,quantity:2}]});
 await assert.rejects(()=>f.cmd(users.employee,'document.submit',{id:d.id}),e=>e.code==='AGENT_REQUIRED');
 await assert.rejects(()=>f.cmd(users.employee,'document.agent_result',{id:d.id,proposal:'伪造'}),/不支持/);
 await assert.rejects(()=>f.store.recordAgentResult({documentId:d.id,runId:'one',proposal:'草案',evidence:[{agentId:'a'},{agentId:'a'}]}),/不同虚拟员工/);
 await assert.rejects(()=>f.store.recordAgentResult({documentId:d.id,runId:'bad',proposal:'草案',evidence:[{agentId:'a',success:false},{agentId:'b'}]}),e=>e.code==='AGENT_INCOMPLETE');
 await assert.rejects(()=>f.cmd(users.admin,'inventory.set',{quantity:99}),/不支持/);
 assert.equal((await f.store.snapshot(users.admin)).inventory[0].quantity,0);
});

test('ERP两级审批分离，申请人和同一审批人不能连续审批，admin也不能自批',async t=>{
 const f=await fixture(t);let d=await f.create('purchase',{input:{partner:'供应商'},lines:[{productId:f.product.id,quantity:1}]},users.admin);await f.agent(d);d=await f.cmd(users.admin,'document.submit',{id:d.id});
 await assert.rejects(()=>f.cmd(users.admin,'document.approve',{id:d.id}),e=>e.code==='SELF_APPROVAL');
 const dual=role('dual',['manager','finance']);d=await f.cmd(dual,'document.approve',{id:d.id});assert.equal(d.status,'awaiting_approval');
 await assert.rejects(()=>f.cmd(dual,'document.approve',{id:d.id}),e=>e.code==='SEPARATION_REQUIRED');
 d=await f.cmd(users.finance,'document.approve',{id:d.id});assert.equal(d.status,'approved');assert.equal(d.approvals.length,2);
 await assert.rejects(()=>f.cmd(users.employee,'document.receive',{id:d.id,reference:'r',lines:[{lineId:d.lines[0].id,quantity:1}]}),e=>e.code==='FORBIDDEN');
});

test('ERP项目成员权限、岗位权限和会话身份校验',async t=>{
 const f=await fixture(t);const d=await f.create('purchase',{input:{partner:'供应商'},lines:[{productId:f.product.id,quantity:1}]});
 assert.equal((await f.store.snapshot(users.other)).documents.length,0);assert.equal((await f.store.snapshot(users.other)).projects.length,0);
 await assert.rejects(()=>f.cmd(users.other,'document.submit',{id:d.id}),e=>e.code==='FORBIDDEN');
 await assert.rejects(()=>f.cmd(users.other,'document.create',{type:'purchase',projectId:f.project.id,input:{partner:'某人'},lines:[{productId:f.product.id,quantity:1}]}),e=>e.code==='FORBIDDEN');
 await assert.rejects(()=>f.cmd(users.employee,'product.create',{sku:'x',name:'x'}),e=>e.code==='FORBIDDEN');
 await assert.rejects(()=>f.store.snapshot(null),e=>e.status===401);
});

test('ERP采购分批真实收货，防重复凭证、超收、并发重试和金额浮点',async t=>{
 const f=await fixture(t);let d=await f.approve(await f.create('purchase',{input:{partner:'供应商A'},lines:[{productId:f.product.id,quantity:3,unitPriceCents:98999}]}));
 const receipt={id:d.id,reference:'ARRIVAL-1',lines:[{lineId:d.lines[0].id,quantity:1}]};d=await f.cmd(users.warehouse,'document.receive',receipt,'receive-1');assert.equal(d.status,'partially_received');
 assert.deepEqual(d,await f.cmd(users.warehouse,'document.receive',receipt,'receive-1'));
 await assert.rejects(()=>f.cmd(users.warehouse,'document.receive',receipt),e=>e.code==='DUPLICATE_RECEIPT');
 await assert.rejects(()=>f.cmd(users.warehouse,'document.receive',{...receipt,reference:'OVER',lines:[{lineId:d.lines[0].id,quantity:3}]}),e=>e.code==='OVER_FULFILMENT');
 d=await f.cmd(users.warehouse,'document.receive',{...receipt,reference:'ARRIVAL-2',lines:[{lineId:d.lines[0].id,quantity:2}]});assert.equal(d.status,'completed');
 const s=await f.store.snapshot(users.admin);assert.equal(s.inventory[0].quantity,3);assert.equal(s.movements.length,2);assert.equal(d.lines[0].unitPriceCents,98999);
 await assert.rejects(()=>f.create('purchase',{input:{partner:'供应商'},lines:[{productId:f.product.id,quantity:1,unitPriceCents:1.2}]}),/整数/);
});

test('ERP销售分批发货与负库存保护，多行失败整体回滚',async t=>{
 const f=await fixture(t);await f.stock(3);
 const other=await f.cmd(users.admin,'product.create',{sku:'EMPTY',name:'无库存产品'});
 let d=await f.approve(await f.create('sales',{input:{partner:'客户A'},lines:[{productId:f.product.id,quantity:3},{productId:other.id,quantity:1}]}));
 const payload={id:d.id,reference:'SHIP-FAIL',lines:d.lines.map(l=>({lineId:l.id,quantity:1}))};
 await assert.rejects(()=>f.cmd(users.warehouse,'document.ship',payload),e=>e.code==='STOCK_SHORTAGE');
 let s=await f.store.snapshot(users.admin);assert.equal(s.inventory.find(i=>i.productId===f.product.id).quantity,3);assert.equal(s.documents.find(x=>x.id===d.id).lines[0].completedQuantity,0);assert.equal(s.movements.filter(m=>m.kind==='ship').length,0);
 d=await f.cmd(users.warehouse,'document.ship',{id:d.id,reference:'SHIP-1',lines:[{lineId:d.lines[0].id,quantity:2}]});assert.equal(d.status,'partially_shipped');
 assert.equal((await f.store.snapshot(users.admin)).inventory.find(i=>i.productId===f.product.id).quantity,1);
});

test('ERP两个销售单并发争用库存，只有一个提交成功且余额不为负',async t=>{
 const f=await fixture(t);await f.stock(1);
 const a=await f.approve(await f.create('sales',{input:{partner:'客户A'},lines:[{productId:f.product.id,quantity:1}]}));
 const b=await f.approve(await f.create('sales',{input:{partner:'客户B'},lines:[{productId:f.product.id,quantity:1}]}));
 const results=await Promise.allSettled([a,b].map((doc,i)=>f.cmd(users.warehouse,'document.ship',{id:doc.id,reference:'CONCURRENT-'+i,lines:[{lineId:doc.lines[0].id,quantity:1}]})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.code==='STOCK_SHORTAGE').length,1);
 const s=await f.store.snapshot(users.admin);assert.equal(s.inventory[0].quantity,0);assert.equal(s.movements.filter(m=>m.kind==='ship').length,1);
});

test('ERP库存盘点必须审批，冻结账面数，有后续出入库时拒绝过期盘点',async t=>{
 const f=await fixture(t);await f.stock(5);
 let count=await f.create('stocktake',{input:{note:'实物清点差异核对'},lines:[{productId:f.product.id,countedQuantity:4}]},users.warehouse);count=await f.approve(count,users.warehouse);
 let purchase=await f.approve(await f.create('purchase',{input:{partner:'供应商'},lines:[{productId:f.product.id,quantity:1}]}));await f.cmd(users.warehouse,'document.receive',{id:purchase.id,reference:'NEW-STOCK',lines:[{lineId:purchase.lines[0].id,quantity:1}]});
 await assert.rejects(()=>f.cmd(users.warehouse,'document.post',{id:count.id,reference:'OLD-COUNT'}),e=>e.code==='STALE_STOCKTAKE');
 assert.equal((await f.store.snapshot(users.admin)).inventory[0].quantity,6);
 await f.stock(0);assert.equal((await f.store.snapshot(users.admin)).inventory[0].quantity,0);
});

test('ERP盘点后借还使数量恢复原值，仍凭流水版本识别为过期',async t=>{
 const f=await fixture(t);await f.stock(3);
 let count=await f.approve(await f.create('stocktake',{input:{note:'实物清点差异核对'},lines:[{productId:f.product.id,countedQuantity:2}]},users.warehouse),users.warehouse);
 let issue=await f.approve(await f.create('resource',{input:{operation:'issue',employeeId:'employee'},lines:[{productId:f.product.id,quantity:1}]}));issue=await f.cmd(users.warehouse,'document.post',{id:issue.id,reference:'BORROW'});
 let returned=await f.approve(await f.create('resource',{input:{operation:'return',employeeId:'employee',originalDocumentId:issue.id},lines:[{productId:f.product.id,quantity:1}]}));await f.cmd(users.warehouse,'document.post',{id:returned.id,reference:'BACK'});
 assert.equal((await f.store.snapshot(users.admin)).inventory[0].quantity,3);
 await assert.rejects(()=>f.cmd(users.warehouse,'document.post',{id:count.id,reference:'STALE'}),e=>e.code==='STALE_STOCKTAKE');
});

test('ERP办公资源真实借出、分次归还，拒绝超还及并发重复归还',async t=>{
 const f=await fixture(t);await f.stock(4);
 let issue=await f.approve(await f.create('resource',{input:{operation:'issue',employeeId:'employee'},lines:[{productId:f.product.id,quantity:3}]}));issue=await f.cmd(users.warehouse,'document.post',{id:issue.id,reference:'ISSUE-1'});
 assert.equal((await f.store.snapshot(users.admin)).inventory[0].quantity,1);
 const returnDoc=async quantity=>f.approve(await f.create('resource',{input:{operation:'return',employeeId:'employee',originalDocumentId:issue.id},lines:[{productId:f.product.id,quantity}]}));
 let first=await returnDoc(1);first=await f.cmd(users.warehouse,'document.post',{id:first.id,reference:'RETURN-1'});
 const a=await returnDoc(2),b=await returnDoc(2);
 await f.cmd(users.warehouse,'document.post',{id:a.id,reference:'RETURN-2'});
 await assert.rejects(()=>f.cmd(users.warehouse,'document.post',{id:b.id,reference:'RETURN-3'}),e=>e.code==='OVER_RETURN');
 const s=await f.store.snapshot(users.admin);assert.equal(s.inventory[0].quantity,4);assert.equal(s.loans[0].returnedQuantity,3);
 await assert.rejects(()=>returnDoc(1),e=>e.code==='OVER_RETURN');
});

test('ERP项目立项、任务交付、周报贡献事实确认、岗位准备完整链路',async t=>{
 const f=await fixture(t,{activate:false});
 let setup=await f.approve(await f.create('project_setup',{input:{objective:'交付客户的三台服务器'}}));setup=await f.cmd(users.manager,'document.post',{id:setup.id});assert.equal(setup.status,'completed');assert.equal((await f.store.snapshot(users.admin)).projects[0].status,'active');
 let task=await f.cmd(users.project_manager,'task.create',{projectId:f.project.id,title:'核对设备清单',assigneeId:'employee'});
 await assert.rejects(()=>f.cmd(users.manager,'task.complete',{id:task.id,result:'替他完成'}),e=>e.code==='FORBIDDEN');
 task=await f.cmd(users.employee,'task.complete',{id:task.id,result:'完成三台服务器规格核对',evidence:[{name:'设备清单',reference:'LIST-1'}]});assert.equal(task.status,'submitted');
 task=await f.cmd(users.project_manager,'task.accept',{id:task.id,note:'已核对设备清单'});assert.equal(task.status,'completed');
 let delivery=await f.approve(await f.create('project_delivery',{input:{acceptanceCriteria:'规格一致，开机检查通过',deliveryNote:'清单已交付'}}));delivery=await f.cmd(users.project_manager,'document.post',{id:delivery.id});assert.equal(delivery.status,'completed');
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
 let weekly=await f.create('weekly_report',{input:{periodStart:today,periodEnd:today}});assert.equal(weekly.input.facts.completedTasks,1);weekly=await f.approve(weekly);weekly=await f.cmd(users.manager,'document.post',{id:weekly.id});
 const perf=(await f.store.snapshot(users.admin)).performance[0];assert.equal(perf.facts.employees[0].employeeId,'employee');assert.equal(perf.facts.scoresAssigned,false);assert.equal(perf.confirmedBy,'manager');
 let onboard=await f.create('onboarding',{input:{employeeId:'employee',position:'项目专员',resourceRequirements:'显示器和项目资料访问待办'}},users.hr);onboard=await f.approve(onboard,users.hr);onboard=await f.cmd(users.hr,'document.post',{id:onboard.id});assert.equal(onboard.status,'completed');
 const sql="SELECT name FROM sqlite_master WHERE type='table' AND name IN ('employees','accounts')";
 const inspected=spawnSync(process.env.OFFICE_PYTHON||'/usr/bin/python3',['-c','import sqlite3,sys,json; print(json.dumps(sqlite3.connect(sys.argv[1]).execute(sys.argv[2]).fetchall()))',f.store.databasePath,sql],{encoding:'utf8'});assert.equal(inspected.status,0);assert.deepEqual(JSON.parse(inspected.stdout),[]);
});

test('ERP退回保留意见、原草案不可绕过重新审批，过期版本不能操作',async t=>{
 const f=await fixture(t);let d=await f.create('purchase',{input:{partner:'供应商'},lines:[{productId:f.product.id,quantity:1}]});await f.agent(d);d=await f.cmd(users.employee,'document.submit',{id:d.id});
 await assert.rejects(()=>f.cmd(users.manager,'document.approve',{id:d.id,version:1}),e=>e.code==='VERSION_CONFLICT');
 await assert.rejects(()=>f.cmd(users.manager,'document.reject',{id:d.id}),/退回/);
 d=await f.cmd(users.manager,'document.reject',{id:d.id,note:'请补充保修条款'});assert.equal(d.status,'rejected');assert.equal(d.approvals[0].note,'请补充保修条款');
 await assert.rejects(()=>f.agent(d),e=>e.code==='STATE_CONFLICT');await assert.rejects(()=>f.cmd(users.employee,'document.submit',{id:d.id}),e=>e.code==='AGENT_REQUIRED');
});

test('ERP数量、产品唯一性、日期及JSON结构严格校验',async t=>{
 const f=await fixture(t);
 for(const quantity of [0,-1,1.2,true,'1',null])await assert.rejects(()=>f.create('purchase',{input:{partner:'供应商'},lines:[{productId:f.product.id,quantity}]}),/整数/);
 await assert.rejects(()=>f.cmd(users.admin,'product.create',{sku:f.product.sku,name:'重复'}),e=>e.code==='CONSTRAINT');
 await assert.rejects(()=>f.create('weekly_report',{input:{periodStart:'2026-02-30',periodEnd:'2026-03-01'}}),/有效日期/);
 await assert.rejects(()=>f.create('purchase',{input:{partner:'供应商'},lines:[{productId:f.product.id,quantity:1},{productId:f.product.id,quantity:1}]}),/合并/);
 await assert.rejects(()=>f.create('onboarding',{input:{employeeId:'e',position:'p',resourceRequirements:'r'}},users.employee),e=>e.code==='FORBIDDEN');
});

test('ERP退回修订归档旧证据与审批，本轮必须重新协作且旧审批全部失效',async t=>{
 const f=await fixture(t);let d=await f.create('purchase',{input:{partner:'供应商A'},lines:[{productId:f.product.id,quantity:2}]});
 const run={documentId:d.id,runId:'original-agent-run',expectedVersion:d.version,proposal:'原方案',evidence:[{agentId:'writer'},{agentId:'reviewer'}]};await f.store.recordAgentResult(run);
 d=await f.cmd(users.employee,'document.submit',{id:d.id});d=await f.cmd(users.manager,'document.approve',{id:d.id,note:'预算通过'});d=await f.cmd(users.finance,'document.reject',{id:d.id,note:'需要减少采购数量'});
 assert.equal(d.approvals.length,2);const oldVersion=d.version;
 d=await f.cmd(users.employee,'document.revise',{id:d.id,version:d.version,title:'修订采购',input:{partner:'供应商B'},lines:[{productId:f.product.id,quantity:1}]},'revision');
 assert.equal(d.status,'draft');assert.equal(d.approvalRound,2);assert.equal(d.approvalIndex,0);assert.equal(d.proposal,null);assert.equal(d.agentRunId,null);assert.deepEqual(d.evidence,[]);assert.deepEqual(d.approvals,[]);assert.equal(d.approvalHistory.length,2);assert.equal(d.revisions[0].version,oldVersion);assert.equal(d.lines[0].quantity,1);assert.equal(d.agentHistory[0].runId,run.runId);
 await assert.rejects(()=>f.cmd(users.employee,'document.submit',{id:d.id}),e=>e.code==='AGENT_REQUIRED');
 await assert.rejects(()=>f.store.recordAgentResult({...run,expectedVersion:d.version}),e=>e.code==='AGENT_STALE');
 await assert.rejects(()=>f.store.recordAgentResult({...run,runId:'stale-version'}),e=>e.code==='VERSION_CONFLICT');
 await f.agent(d);d=await f.cmd(users.employee,'document.submit',{id:d.id});
 d=await f.cmd(users.manager,'document.approve',{id:d.id,note:'修订后重新审核'});d=await f.cmd(users.finance,'document.approve',{id:d.id,note:'新方案通过'});
 assert.equal(d.status,'approved');assert.equal(d.approvals.length,2);assert(d.approvals.every(a=>a.round===2));assert.equal(d.approvalHistory.length,4);
 const inspected=spawnSync(process.env.OFFICE_PYTHON||'/usr/bin/python3',['-c','import sqlite3,sys,json; print(sqlite3.connect(sys.argv[1]).execute("SELECT snapshot_json FROM document_history WHERE document_id=?",(sys.argv[2],)).fetchone()[0])',f.store.databasePath,d.id],{encoding:'utf8'});assert.equal(inspected.status,0);const preserved=JSON.parse(inspected.stdout);assert.equal(preserved.proposal,'原方案');assert.equal(preserved.lines[0].quantity,2);assert.equal(preserved.approvals[1].decision,'rejected');
});

test('ERP修订权限与状态保护，不能更换项目、跳过审批或改写已入账单据',async t=>{
 const f=await fixture(t);let d=await f.create('purchase',{input:{partner:'供应商'},lines:[{productId:f.product.id,quantity:1}]});
 await assert.rejects(()=>f.cmd(users.manager,'document.revise',{id:d.id,title:'越权改'}),e=>e.code==='FORBIDDEN');
 await assert.rejects(()=>f.cmd(users.employee,'document.revise',{id:d.id,projectId:null}),/所属项目/);
 await assert.rejects(()=>f.cmd(users.employee,'document.revise',{id:d.id,type:'sales'}),/业务流程/);
 d=await f.cmd(users.admin,'document.revise',{id:d.id,title:'管理员修订'});assert.equal(d.title,'管理员修订');
 d=await f.approve(d);await assert.rejects(()=>f.cmd(users.admin,'document.revise',{id:d.id,title:'改批准金额'}),e=>e.code==='STATE_CONFLICT');
 d=await f.cmd(users.warehouse,'document.receive',{id:d.id,reference:'RECEIVED',lines:[{lineId:d.lines[0].id,quantity:1}]});await assert.rejects(()=>f.cmd(users.admin,'document.revise',{id:d.id,lines:[{productId:f.product.id,quantity:99}]}),e=>e.code==='STATE_CONFLICT');
 assert.equal((await f.store.snapshot(users.admin)).inventory[0].quantity,1);
});

test('ERP自报交付不计业绩，独立真人验收或退回均有历史且不能自验收',async t=>{
 const f=await fixture(t);let task=await f.cmd(users.project_manager,'task.create',{projectId:f.project.id,title:'提交配置清单',assigneeId:'employee'});
 await assert.rejects(()=>f.cmd(users.employee,'task.complete',{id:task.id,result:'做完了'}),/凭证/);
 task=await f.cmd(users.employee,'task.complete',{id:task.id,result:'初稿已交付',evidence:[{name:'配置清单',reference:'DRAFT-1'}]});assert.equal(task.status,'submitted');
 await assert.rejects(()=>f.cmd(users.employee,'task.accept',{id:task.id}),e=>e.code==='SELF_APPROVAL');
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
 let report=await f.create('weekly_report',{input:{periodStart:today,periodEnd:today}});assert.equal(report.input.facts.completedTasks,0);
 task=await f.cmd(users.project_manager,'task.return',{id:task.id,note:'请补充保修条款'});assert.equal(task.status,'pending');assert.equal(task.history.at(-1).action,'returned');
 task=await f.cmd(users.employee,'task.complete',{id:task.id,result:'补充条款后交付',evidence:[{name:'配置清单二版',reference:'FINAL-2'}]});task=await f.cmd(users.project_manager,'task.accept',{id:task.id,note:'清单核对通过'});assert.equal(task.status,'completed');assert.equal(task.acceptedBy,'pm');assert.equal(task.history.length,4);
 report=await f.create('weekly_report',{input:{periodStart:today,periodEnd:today}});assert.equal(report.input.facts.completedTasks,1);assert.equal(report.input.facts.tasks[0].acceptedBy,'pm');
});

test('ERP周报按北京时间验收日期归属，UTC跨日不漏记不重复',async t=>{
 const f=await fixture(t);const tasks=[];
 for(let i=0;i<2;i++){let task=await f.cmd(users.project_manager,'task.create',{projectId:f.project.id,title:'跨日任务'+i,assigneeId:'employee'});await f.cmd(users.employee,'task.complete',{id:task.id,result:'完成交付',evidence:[{reference:'TZ-'+i}]});task=await f.cmd(users.project_manager,'task.accept',{id:task.id});tasks.push(task);}
 const changed=spawnSync(process.env.OFFICE_PYTHON||'/usr/bin/python3',['-c','import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("UPDATE tasks SET completed_at=? WHERE id=?",("2026-10-19T15:59:59.000Z",sys.argv[2])); c.execute("UPDATE tasks SET completed_at=? WHERE id=?",("2026-10-19T16:00:00.000Z",sys.argv[3])); c.commit()',f.store.databasePath,tasks[0].id,tasks[1].id],{encoding:'utf8'});assert.equal(changed.status,0);
 const first=await f.create('weekly_report',{input:{periodStart:'2026-10-19',periodEnd:'2026-10-19'}});const next=await f.create('weekly_report',{input:{periodStart:'2026-10-20',periodEnd:'2026-10-20'}});
 assert.equal(first.input.facts.tasks[0].id,tasks[0].id);assert.equal(next.input.facts.tasks[0].id,tasks[1].id);assert.equal(first.input.facts.completedTasks,1);assert.equal(next.input.facts.completedTasks,1);assert.equal(next.input.facts.timezone,'Asia/Shanghai');
});

test('ERP草稿项目允许准备但不能验收或实际库存流转，启用后可继续',async t=>{
 const f=await fixture(t,{activate:false});let p=await f.approve(await f.create('purchase',{input:{partner:'投前准备供应商'},lines:[{productId:f.product.id,quantity:1}]}));
 await assert.rejects(()=>f.cmd(users.warehouse,'document.receive',{id:p.id,reference:'PRE-ACTIVE',lines:[{lineId:p.lines[0].id,quantity:1}]}),e=>e.code==='PROJECT_NOT_ACTIVE');
 let task=await f.cmd(users.project_manager,'task.create',{projectId:f.project.id,title:'前期准备',assigneeId:'employee'});await f.cmd(users.employee,'task.complete',{id:task.id,result:'初步资料已准备',evidence:[{reference:'PREP-1'}]});
 await assert.rejects(()=>f.cmd(users.project_manager,'task.accept',{id:task.id}),e=>e.code==='PROJECT_NOT_ACTIVE');
 let setup=await f.approve(await f.create('project_setup',{input:{objective:'正式启动'}}));await f.cmd(users.manager,'document.post',{id:setup.id});
 p=await f.cmd(users.warehouse,'document.receive',{id:p.id,reference:'ACTIVE',lines:[{lineId:p.lines[0].id,quantity:1}]});assert.equal(p.status,'completed');task=await f.cmd(users.project_manager,'task.accept',{id:task.id});assert.equal(task.status,'completed');
});

test('ERP在线SQLite备份包含已提交WAL，独立恢复后库存和审计保持一致',async t=>{
 const f=await fixture(t);await f.stock(7);
 const python=spawn(process.env.OFFICE_PYTHON||'/usr/bin/python3',['-u','-c','import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("PRAGMA journal_mode=WAL"); c.execute("INSERT INTO products VALUES(?,?,?,?,?,?)",("WAL-PRODUCT","WAL-ONLY","WAL已提交产品","件",0,"2026-10-20T00:00:00Z")); c.execute("INSERT INTO audit VALUES(?,?,?,?,?,?)",("WAL-AUDIT","admin","wal.committed","WAL-PRODUCT","{}","2026-10-20T00:00:00Z")); c.commit(); print("READY",flush=True); sys.stdin.readline(); c.close()',f.store.databasePath],{stdio:['pipe','pipe','pipe']});
 t.after(()=>{if(python.exitCode===null)python.kill('SIGKILL');});await new Promise((resolve,reject)=>{python.stdout.once('data',chunk=>String(chunk).includes('READY')?resolve():reject(new Error('WAL准备失败')));python.once('error',reject);python.once('exit',code=>{if(code!==null&&code!==0)reject(new Error('WAL准备进程失败'));});});
 const before=await f.store.snapshot(users.admin);const dest=path.join(path.dirname(path.dirname(f.store.databasePath)),'backups','isolated.sqlite');const backup=await f.store.backup(dest,{actor:users.admin});assert.equal(backup.integrity,'ok');assert.equal(backup.sha256,crypto.createHash('sha256').update(await fs.readFile(dest)).digest('hex'));assert.equal((await fs.stat(dest)).mode&0o777,0o600);
 python.stdin.end('\n');
 const restoredDir=await fs.mkdtemp(path.join(os.tmpdir(),'office-erp-restored-'));t.after(()=>fs.rm(restoredDir,{recursive:true,force:true}));await fs.mkdir(path.join(restoredDir,'erp'));await fs.copyFile(dest,path.join(restoredDir,'erp','office-erp.sqlite'));const restored=await createErpStore({dataDir:restoredDir}).snapshot(users.admin);
 assert.deepEqual(restored.inventory,before.inventory);assert.deepEqual(restored.movements,before.movements);assert.deepEqual(restored.products,before.products);assert.deepEqual(restored.audit,before.audit);assert(restored.audit.some(a=>a.id==='WAL-AUDIT'));assert(restored.products.some(p=>p.id==='WAL-PRODUCT'));
 await assert.rejects(()=>f.store.backup(dest,{actor:users.admin}),e=>e.code==='BACKUP_EXISTS');assert.equal(crypto.createHash('sha256').update(await fs.readFile(dest)).digest('hex'),backup.sha256);
});

test('ERP备份权限、目录穿越、文件名和符号链接限制',async t=>{
 const f=await fixture(t);const dataDir=path.dirname(path.dirname(f.store.databasePath));
 await assert.rejects(()=>f.store.backup(path.join(dataDir,'outside.sqlite')),/backups/);
 await assert.rejects(()=>f.store.backup(path.join(dataDir,'backups','..','outside.sqlite')),/backups/);
 await assert.rejects(()=>f.store.backup(path.join(dataDir,'backups','invalid.zip')),/sqlite/);
 await assert.rejects(()=>f.store.backup(path.join(dataDir,'backups','unauthorized.sqlite'),{actor:users.employee}),e=>e.code==='FORBIDDEN');
 assert.equal(await fs.stat(path.join(dataDir,'backups','unauthorized.sqlite')).then(()=>true,()=>false),false);
 await fs.rm(path.join(dataDir,'backups'),{recursive:true,force:true});const outside=await fs.mkdtemp(path.join(os.tmpdir(),'office-erp-outside-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));await fs.symlink(outside,path.join(dataDir,'backups'));
 await assert.rejects(()=>f.store.backup(path.join(dataDir,'backups','symlink.sqlite'),{actor:users.admin}),e=>e.code==='FORBIDDEN');assert.equal((await fs.readdir(outside)).length,0);
});

test('ERP项目负责人可调整本项目成员与负责人，越权和越项目新负责人被拒绝',async t=>{
 const f=await fixture(t);const before=await f.store.snapshot(users.admin);
 await assert.rejects(()=>f.cmd(users.employee,'project.update',{id:f.project.id,name:'普通成员越权改名'}),e=>e.code==='FORBIDDEN');
 await assert.rejects(()=>f.cmd(users.other,'project.update',{id:f.project.id,name:'跨项目改名'}),e=>e.code==='FORBIDDEN');
 await assert.rejects(()=>f.cmd(users.project_manager,'project.update',{id:f.project.id,ownerId:'outsider'}),/项目成员/);
 await assert.rejects(()=>f.cmd(users.project_manager,'project.update',{id:f.project.id,department:'其他部门'}),e=>e.code==='FORBIDDEN');
 const updated=await f.cmd(users.project_manager,'project.update',{id:f.project.id,name:'负责人更正后的项目',customer:'客户B',ownerId:users.manager.id,members:f.project.members});
 assert.equal(updated.ownerId,'manager');assert.equal(updated.name,'负责人更正后的项目');assert.equal(updated.customer,'客户B');assert.equal(updated.status,'active');
 const current=await f.store.snapshot(users.admin),event=current.audit.find(a=>a.action==='project.update');assert.equal(event.detail.before.ownerId,'pm');assert.equal(event.detail.after.ownerId,'manager');assert.equal(event.detail.before.name,before.projects[0].name);
 const moved=await f.cmd(users.admin,'project.update',{id:f.project.id,department:'公司级项目部'});assert.equal(moved.department,'公司级项目部');
});

test('ERP待办任务转交需原因及本项目新负责人，保留旧负责人审计且不可继承交付',async t=>{
 const f=await fixture(t);let task=await f.cmd(users.project_manager,'task.create',{projectId:f.project.id,title:'转交设备清单',assigneeId:'employee'});
 await assert.rejects(()=>f.cmd(users.employee,'task.reassign',{id:task.id,assigneeId:'finance',note:'自行转给同事'}),e=>e.code==='FORBIDDEN');
 await assert.rejects(()=>f.cmd(users.project_manager,'task.reassign',{id:task.id,assigneeId:'outsider',note:'越项目'}),e=>e.code==='FORBIDDEN');
 await assert.rejects(()=>f.cmd(users.project_manager,'task.reassign',{id:task.id,assigneeId:'finance'}),/转交原因/);
 await assert.rejects(()=>f.cmd(users.project_manager,'project.update',{id:f.project.id,members:f.project.members.filter(id=>id!=='employee')}),e=>e.code==='OPEN_TASKS');
 task=await f.cmd(users.employee,'task.complete',{id:task.id,result:'旧负责人提交初稿',evidence:[{reference:'ORIGINAL-1'}]});
 await assert.rejects(()=>f.cmd(users.project_manager,'task.reassign',{id:task.id,assigneeId:'finance',note:'待验收时转交'}),e=>e.code==='STATE_CONFLICT');
 await f.cmd(users.project_manager,'task.return',{id:task.id,note:'人员离岗，退回后转交'});
 task=await f.cmd(users.project_manager,'task.reassign',{id:task.id,assigneeId:'finance',note:'原负责人离岗，由财务接续整理'});assert.equal(task.assigneeId,'finance');assert.equal(task.status,'pending');assert.equal(task.result,'');assert.deepEqual(task.evidence,[]);assert.equal(task.submittedAt,null);assert.equal(task.history.at(-1).action,'reassigned');assert.equal(task.history.at(-1).evidence[0].before.result,'旧负责人提交初稿');
 await assert.rejects(()=>f.cmd(users.employee,'task.complete',{id:task.id,result:'旧负责人再次提交',evidence:[{reference:'OLD-2'}]}),e=>e.code==='FORBIDDEN');
 const project=await f.cmd(users.project_manager,'project.update',{id:f.project.id,members:f.project.members.filter(id=>id!=='employee')});assert.equal(project.members.includes('employee'),false);
 task=await f.cmd(users.finance,'task.complete',{id:task.id,result:'接手后重新交付',evidence:[{reference:'NEW-1'}]});task=await f.cmd(users.project_manager,'task.accept',{id:task.id});assert.equal(task.status,'completed');
 await assert.rejects(()=>f.cmd(users.admin,'task.reassign',{id:task.id,assigneeId:'warehouse',note:'改写已验收归属'}),e=>e.code==='STATE_CONFLICT');
 const event=(await f.store.snapshot(users.admin)).audit.find(a=>a.action==='task.reassign');assert.equal(event.detail.before.assigneeId,'employee');assert.equal(event.detail.after.assigneeId,'finance');
});

test('ERP盘点必须提交原因与依据，创建和修订均不能遗漏',async t=>{
 const f=await fixture(t);await assert.rejects(()=>f.create('stocktake',{input:{},lines:[{productId:f.product.id,countedQuantity:0}]},users.warehouse),/盘点原因/);
 const d=await f.create('stocktake',{input:{note:'季度实物复核'},lines:[{productId:f.product.id,countedQuantity:0}]},users.warehouse);
 await assert.rejects(()=>f.cmd(users.warehouse,'document.revise',{id:d.id,input:{note:'  '}}),/盘点原因/);
 const unchanged=(await f.store.snapshot(users.admin)).documents.find(doc=>doc.id===d.id);assert.equal(unchanged.input.note,'季度实物复核');assert.equal(unchanged.version,d.version);
});

test('ERP领用用途必填，岗位准备来源只允许可见的同员工已完成准备单',async t=>{
 const f=await fixture(t);const raw={type:'resource',projectId:f.project.id,input:{operation:'issue',employeeId:'employee'},lines:[{productId:f.product.id,quantity:1}]};
 await assert.rejects(()=>f.cmd(users.employee,'document.create',raw),/物品用途/);
 let source=await f.create('onboarding',{input:{employeeId:'employee',position:'项目专员',resourceRequirements:'项目设备与资料权限准备'}},users.hr);
 await assert.rejects(()=>f.create('resource',{input:{operation:'issue',employeeId:'employee',sourceOnboardingDocumentId:source.id},lines:raw.lines}),e=>e.code==='INVALID_SOURCE');
 source=await f.approve(source,users.hr);source=await f.cmd(users.hr,'document.post',{id:source.id});
 const issue=await f.create('resource',{input:{operation:'issue',employeeId:'employee',purpose:'客户项目联调使用',sourceOnboardingDocumentId:source.id},lines:raw.lines});assert.equal(issue.input.purpose,'客户项目联调使用');assert.equal(issue.input.sourceOnboardingDocumentId,source.id);
 await assert.rejects(()=>f.create('resource',{input:{operation:'issue',employeeId:'finance',sourceOnboardingDocumentId:source.id},lines:raw.lines}),e=>e.code==='INVALID_SOURCE');
 await assert.rejects(()=>f.create('resource',{input:{operation:'issue',employeeId:'employee',sourceOnboardingDocumentId:'missing'},lines:raw.lines}),e=>e.code==='NOT_FOUND');
 await assert.rejects(()=>f.cmd(users.employee,'document.revise',{id:issue.id,input:{operation:'issue',employeeId:'employee',purpose:'  '}}),/物品用途/);
});

test('ERP贡献记录分配提交验收和期末待办，重复提交去重，确认交付与业务参与可回溯',async t=>{
 const f=await fixture(t);const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());const tomorrow=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date(Date.parse(today+'T00:00:00+08:00')+86400000));
 const a=await f.cmd(users.project_manager,'task.create',{projectId:f.project.id,title:'已验收任务',assigneeId:'employee',dueDate:today});
 await f.cmd(users.employee,'task.complete',{id:a.id,result:'提交已验收资料',evidence:[{reference:'ACCEPTED'}]});await f.cmd(users.project_manager,'task.accept',{id:a.id});
 const b=await f.cmd(users.project_manager,'task.create',{projectId:f.project.id,title:'重复提交待验收任务',assigneeId:'employee',dueDate:today});
 await f.cmd(users.employee,'task.complete',{id:b.id,result:'第一版',evidence:[{reference:'B-1'}]});await f.cmd(users.project_manager,'task.return',{id:b.id,note:'补充资料'});await f.cmd(users.employee,'task.complete',{id:b.id,result:'第二版',evidence:[{reference:'B-2'}]});
 const c=await f.cmd(users.project_manager,'task.create',{projectId:f.project.id,title:'未到期任务',assigneeId:'finance',dueDate:tomorrow});
 let delivery=await f.approve(await f.create('project_delivery',{input:{acceptanceCriteria:'已确认交付资料与设备清单一致',deliveryNote:'资料引用 ACCEPTED'}}));delivery=await f.cmd(users.project_manager,'document.post',{id:delivery.id});
 const unconfirmed=await f.approve(await f.create('sales',{input:{partner:'尚未实际发货客户'},lines:[{productId:f.product.id,quantity:1}]}));
 const weekly=await f.create('weekly_report',{input:{periodStart:today,periodEnd:today}}),facts=weekly.input.facts;
 assert.equal(facts.assignedTasks,3);assert.equal(facts.submittedTasks,2);assert.equal(facts.completedTasks,1);assert.equal(facts.pendingTasks,2);assert.equal(facts.overdueTasks,1);assert.equal(facts.acceptedDeliveries,1);
 const employee=facts.employees.find(e=>e.employeeId==='employee');assert.equal(employee.assignedTasks,2);assert.equal(employee.submittedTasks,2);assert.equal(employee.completedTasks,1);assert.deepEqual(employee.pendingTaskIds,[b.id]);assert.deepEqual(employee.overdueTaskIds,[b.id]);assert.deepEqual(employee.acceptedDeliveryIds,[delivery.id]);assert(employee.businessDocumentIds.includes(delivery.id));assert(!employee.businessDocumentIds.includes(unconfirmed.id));assert(facts.taskFacts.some(t=>t.id===c.id&&!t.overdueAtPeriodEnd));assert.equal(facts.scoresAssigned,false);assert.equal(Object.hasOwn(facts,'workHours'),false);
});

test('ERP历史期末事实保留当时待办与逾期，后一天才验收不会倒填前一天业绩',async t=>{
 const f=await fixture(t);let task=await f.cmd(users.project_manager,'task.create',{projectId:f.project.id,title:'跨期验收任务',assigneeId:'employee',dueDate:'2026-10-20'});
 await f.cmd(users.employee,'task.complete',{id:task.id,result:'跨期交付',evidence:[{reference:'CROSS-PERIOD'}]});task=await f.cmd(users.project_manager,'task.accept',{id:task.id});
 const changed=spawnSync(process.env.OFFICE_PYTHON||'/usr/bin/python3',['-c','import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("UPDATE tasks SET created_at=?,submitted_at=?,completed_at=? WHERE id=?",("2026-10-19T16:00:00.000Z","2026-10-20T15:59:00.000Z","2026-10-20T16:00:00.000Z",sys.argv[2])); c.execute("UPDATE task_events SET created_at=? WHERE task_id=? AND action=\'submitted\'",("2026-10-20T15:59:00.000Z",sys.argv[2])); c.execute("UPDATE task_events SET created_at=? WHERE task_id=? AND action=\'accepted\'",("2026-10-20T16:00:00.000Z",sys.argv[2])); c.commit()',f.store.databasePath,task.id],{encoding:'utf8'});assert.equal(changed.status,0,changed.stderr);
 const before=(await f.create('weekly_report',{input:{periodStart:'2026-10-20',periodEnd:'2026-10-20'}})).input.facts;assert.equal(before.completedTasks,0);assert.equal(before.pendingTasks,1);assert.equal(before.overdueTasks,1);assert.equal(before.submittedTasks,1);
 const after=(await f.create('weekly_report',{input:{periodStart:'2026-10-21',periodEnd:'2026-10-21'}})).input.facts;assert.equal(after.completedTasks,1);assert.equal(after.pendingTasks,0);assert.equal(after.overdueTasks,0);assert.equal(after.submittedTasks,0);
});

test('ERP采购保留真人供应商报价凭证与条件，修订后重核且不冒充已抓取报价',async t=>{
 const f=await fixture(t);let doc=await f.create('purchase',{input:{partner:'正式供应商',quotationReference:'SUPPLIER-20261020-001',quotationNotes:'含税；运费到付；三年保修，正式文件待审批人核对'},lines:[{productId:f.product.id,quantity:2,unitPriceCents:198000}]});
 assert.equal(doc.input.quotationReference,'SUPPLIER-20261020-001');assert.match(doc.input.quotationNotes,/含税/);assert.equal(doc.lines[0].unitPriceCents,198000);assert.equal(doc.agentRunId,null);assert.deepEqual(doc.evidence,[]);
 doc=await f.cmd(users.employee,'document.revise',{id:doc.id,input:{partner:'正式供应商',quotationReference:'https://supplier.example.test/quotation?id=001',quotationNotes:'更新为含税包运费，仍需核对原件'}});assert.equal(doc.input.quotationReference,'https://supplier.example.test/quotation?id=001');assert.match(doc.input.quotationNotes,/包运费/);assert.equal(doc.proposal,null);
 await assert.rejects(()=>f.create('purchase',{input:{partner:'供应商',quotationReference:'x'.repeat(1001)},lines:[{productId:f.product.id,quantity:1}]}),/报价凭证/);
 await assert.rejects(()=>f.create('purchase',{input:{partner:'供应商',quotationNotes:'x'.repeat(4001)},lines:[{productId:f.product.id,quantity:1}]}),/报价依据/);
});

test('ERP真实台账响应可直接驱动任务工作台，不依赖伪造allowedActions的UI数据',async t=>{
 const f=await fixture(t);let task=await f.cmd(users.project_manager,'task.create',{projectId:f.project.id,title:'真实响应任务',assigneeId:'employee'});assert.deepEqual(task.allowedActions,['reassign']);
 async function renderAs(actor,section='projects'){
  const previous=globalThis.document;let root;
  class Element{constructor(){this.children=[];this.dataset={};this.hidden=false;this.inert=false;this.innerHTML='';}setAttribute(){}append(child){this.children.push(child);}querySelector(){return null;}querySelectorAll(){return [];}addEventListener(){}removeEventListener(){}remove(){}}
  const container=new Element();globalThis.document={body:container,activeElement:{focus(){}},visibilityState:'visible',createElement(){root=new Element();return root;},addEventListener(){},removeEventListener(){}};
  const actual=await f.store.snapshot(actor);const response={...actual,currentUser:actor,users:Object.values(users).map(user=>({...user,name:user.displayName,active:true}))};
  const app=mountErp({container,session:{actor},request:async path=>path==='/api/erp/snapshot'?response:path==='/api/erp/users'?{users:response.users}:path==='/api/erp/catalog'?{roles:['admin','manager','employee','project_manager']}:{} });
  try{await app.open(section);return{html:root.innerHTML,response};}finally{app.destroy();globalThis.document=previous;}
 }
 const employee=await renderAs(users.employee);const actualTask=employee.response.tasks.find(t=>t.id===task.id);assert.deepEqual(actualTask.allowedActions,['complete']);assert.equal(actualTask.projectId,f.project.id);assert.equal(actualTask.assigneeId,'employee');assert.match(employee.html,/提交交付/);assert.match(employee.html,new RegExp('data-erp-action="task-complete" data-id="'+task.id+'"'));assert.deepEqual(pendingTasks(normalizeSnapshot(employee.response),'employee').tasks.map(t=>t.id),[task.id]);
 task=await f.cmd(users.employee,'task.complete',{id:task.id,result:'真实响应的交付内容',evidence:[{name:'交付单',reference:'REAL-RESPONSE-1'}]});assert.deepEqual(task.allowedActions,[]);
 const manager=await renderAs(users.project_manager);assert.deepEqual(manager.response.tasks.find(t=>t.id===task.id).allowedActions,['accept','return']);assert.match(manager.html,/验收通过/);assert.match(manager.html,/退回补正/);assert.doesNotMatch(manager.html,/data-erp-action="task-complete"/);
 task=await f.cmd(users.project_manager,'task.accept',{id:task.id});assert.deepEqual(task.allowedActions,[]);const done=await renderAs(users.employee);assert.equal(done.response.tasks[0].acceptedBy,'pm');assert.doesNotMatch(done.html,/data-erp-action="task-complete"|data-operation="accept"/);
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());let weekly=await f.approve(await f.create('weekly_report',{input:{periodStart:today,periodEnd:today}}));await f.cmd(users.manager,'document.post',{id:weekly.id});const reports=await renderAs(users.employee,'reports');const facts=reports.response.performance[0].facts;assert(Array.isArray(facts.employees));assert(facts.employees.some(p=>p.employeeId==='employee'&&p.completedTasks===1));assert.match(reports.html,/员工工作记录/);assert.match(reports.html,/1 项/);
});
