// Explicitly opt-in: this script calls the configured real model and public
// procurement sources. All accounts, approvals, inventory and receipts below
// are isolated functional test fixtures, never company business facts.
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {createErpIdentity} from '../server/erp-identity.mjs';
import {createErpStore} from '../server/erp-store.mjs';
import {ErpService} from '../server/erp-service.mjs';

if(process.env.OFFICE_REAL_ERP_ACCEPTANCE!=='1')throw new Error('真实模型验收需要显式设置 OFFICE_REAL_ERP_ACCEPTANCE=1。');
const configArg=process.argv.find(a=>a.startsWith('--private-config='));
if(configArg){for(const line of (await readFile(resolve(configArg.split('=').slice(1).join('=')),'utf8')).split(/\r?\n/)){const match=line.match(/^([A-Z_]+)=(.*)$/);if(match&&['DASHSCOPE_API_KEY','OFFICE_DASHSCOPE_URL','OFFICE_MODEL'].includes(match[1]))process.env[match[1]]=match[2].trim().replace(/^(['"])(.*)\1$/,'$2');}process.env.OFFICE_PROVIDER='dashscope';}
const {getProviderStatus}=await import('../server/provider.mjs');
const dir=await mkdtemp(resolve('.office-data','erp-real-acceptance-'));
const identity=await createErpIdentity({filePath:join(dir,'identities.json'),legacyUsername:'isolated-admin'});
const admin={...identity.resolveLegacy('isolated-admin'),displayName:'隔离验收管理员'};
async function employee(username,roles){const invitation=await identity.createInvitation(admin.id,{username,name:'隔离验收 '+username,department:'隔离验收部门',title:'功能验收岗位',roles});const password=randomUUID()+'Aa7!';await identity.acceptInvitation({token:invitation.token,password});const e=await identity.authenticate({username,password});return {...e,displayName:e.name};}
const requester=await employee('qa-requester',['employee','warehouse','hr']);
const first=await employee('qa-reviewer',['project_manager','manager','hr']);
const second=await employee('qa-controller',['manager','finance','warehouse']);
const store=createErpStore({dataDir:dir});
const service=new ErpService({store,identity,dataDir:dir});
const checks=[];let count=0;
const command=(actor,action,payload)=>store.command(actor,action,payload,{idempotencyKey:'acceptance-'+(++count)+'-'+randomUUID()});
const project=await command(admin,'project.create',{name:'隔离验收客户服务器交付',customer:'虚构客户 仅功能验收',ownerId:first.id,members:[requester.id,first.id,second.id]});
const product=await command(admin,'product.create',{sku:'QA-SERVER-01',name:'Dell PowerEdge T350 32GB内存 1TB SSD 塔式服务器',unit:'台',priceCents:1200000});
const status=await getProviderStatus({refresh:true});if(!status.ready)throw new Error(status.message);
console.log(JSON.stringify({phase:'start',directory:dir,model:status.model,scope:'isolated functional test only'}));
async function business(type,input,lines=[],post='post'){
 console.log(JSON.stringify({phase:'running',type}));
 const made=await service.create(requester,{type,title:'隔离验收 '+type,projectId:project.id,input,lines},'acceptance-create-'+randomUUID());
 const run=await service.wait(made.document.id);
 await writeFile(join(dir,'last-run.json'),JSON.stringify(run,null,2),{mode:0o600});
 assert.equal(run.status,'completed',run.error);assert.equal(run.tasks.length,2);assert.ok(run.tasks.every(t=>t.status==='done'&&t.toolCalls>=2));
 let doc=await service.document(requester,made.document.id);assert.equal(doc.status,'awaiting_approval');
 for(const actor of [first,second]){const detail=await service.document(actor,doc.id);doc=(await service.action(actor,doc.id,'approve',{expectedVersion:detail.version,note:'隔离功能验收审批，不代表真实公司业务'},'acceptance-approve-'+randomUUID())).document;}
 assert.equal(doc.status,'approved');
 if(post==='post')doc=(await service.action(second,doc.id,'post',{expectedVersion:doc.version,reference:'隔离验收-'+type},'acceptance-post-'+randomUUID())).document;
 const report=await service.report(requester,doc.id);assert.ok(report.includes(Buffer.from('report-header')));
 checks.push({type,documentId:doc.id,agentRunId:run.id,model:run.model,tasks:run.tasks.map(t=>({name:t.name,agentId:t.agentId,toolCalls:t.toolCalls,status:t.status})),status:doc.status,approvalActors:doc.approvals.map(a=>a.actorId),reportBytes:report.length,quoteCandidates:run.quoteEvidence?.quotes?.length||0});
 console.log(JSON.stringify({phase:'passed',type,documentId:doc.id,status:doc.status,toolCalls:run.tasks.reduce((n,t)=>n+t.toolCalls,0)}));return doc;
}
try{
 await business('project_setup',{objective:'仅隔离验收：采购服务器、入库、发货、借还、盘点和任务验收，核对每项真实工具结果。',expectedDate:'2026-12-01'});
 let purchase=await business('purchase',{partner:'公开供应商 仅查报价不采购'},[{productId:product.id,quantity:8,unitPriceCents:1200000}],'receive');
 for(const [i,n]of [3,5].entries()){purchase=(await service.action(second,purchase.id,'receive',{expectedVersion:purchase.version,lines:[{lineId:purchase.lines[0].id,quantity:n}],reference:'隔离验收收货-'+i},'acceptance-receive-'+i)).document;}
 assert.equal(purchase.status,'completed');
 let sale=await business('sales',{partner:'虚构客户 仅功能验收'},[{productId:product.id,quantity:3,unitPriceCents:1300000}],'ship');
 for(const [i,n]of [1,2].entries()){sale=(await service.action(second,sale.id,'ship',{expectedVersion:sale.version,lines:[{lineId:sale.lines[0].id,quantity:n}],reference:'隔离验收发货-'+i},'acceptance-ship-'+i)).document;}
 assert.equal(sale.status,'completed');
 const issue=await business('resource',{operation:'issue',employeeId:requester.id,purpose:'隔离功能验收领用'},[{productId:product.id,quantity:2}]);
 await business('resource',{operation:'return',employeeId:requester.id,purpose:'隔离功能验收归还',originalDocumentId:issue.id},[{productId:product.id,quantity:1}]);
 await business('stocktake',{note:'隔离验收账实差异调整，实盘样本6台'},[{productId:product.id,countedQuantity:6}]);
 const task=await command(first,'task.create',{projectId:project.id,title:'隔离验收设备交付资料',assigneeId:requester.id});
 await command(requester,'task.complete',{id:task.id,result:'已提交隔离测试交付清单',evidence:[{name:'隔离验收凭证',reference:'QA-DELIVERY-001'}]});
 await command(first,'task.accept',{id:task.id,note:'已核对隔离测试凭证，确认交付'});
 await business('project_delivery',{acceptanceCriteria:'核对8台收货、3台发货、2台领用与1台归还；本案例只验证软件功能。',deliveryNote:'隔离测试记录已保存并可从单据和库存流水复核，不能用作真实客户交付凭证。'});
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 await business('weekly_report',{periodStart:today,periodEnd:today,summary:'仅汇总本次隔离验收中真实完成并由另一账号验收的1项任务。'});
 await business('onboarding',{employeeId:requester.id,position:'功能验收测试岗位',resourceRequirements:'整理本系统使用方法和已批准物品领用记录，不创建外部账号或权限。'});
 const snapshot=await store.snapshot(admin);assert.equal(snapshot.inventory[0].quantity,6);assert.equal(snapshot.loans[0].quantity-snapshot.loans[0].returnedQuantity,1);assert.equal(snapshot.performance.length,1);
 assert.equal(new Set(checks.map(c=>c.type)).size,8);
 const results={version:'1.0',scope:'全部业务为隔离功能验收，审批与收发凭证均为测试数据',model:status.model,createdAt:new Date().toISOString(),checks,inventory:snapshot.inventory,loans:snapshot.loans,performance:snapshot.performance,documents:snapshot.documents.map(d=>({id:d.id,type:d.type,status:d.status})),passed:true};
 await writeFile(join(dir,'acceptance.json'),JSON.stringify(results,null,2),{mode:0o600});console.log(JSON.stringify({phase:'complete',passed:true,workflows:8,runs:checks.length,report:join(dir,'acceptance.json')}));
}catch(error){await writeFile(join(dir,'acceptance.json'),JSON.stringify({passed:false,error:String(error.message),checks},null,2),{mode:0o600});console.error(JSON.stringify({phase:'failed',message:error.message,directory:dir}));process.exitCode=1;}finally{await service.shutdown();}
