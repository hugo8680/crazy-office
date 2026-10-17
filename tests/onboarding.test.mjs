import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import {ONBOARDING_TOOL_DEFINITIONS,createOnboardingFunctions} from '../server/onboarding.mjs';

const original=()=>({employeeNumber:'NEW-PRIVATE-001',employeeName:'登记验收专用姓名',department:'登记验收专用部门',position:'登记验收专用岗位',startDate:'2026-10-19',workEmail:'Private.New.Hire@example.test',manager:'登记验收专用负责人',resourceRequirements:'一台笔记本电脑\n工作邮箱账号\n代码库只读权限',employmentConfirmed:true});
const exists=async p=>fs.access(p).then(()=>true,()=>false);
async function fixture(t,input={},options={}){
 const base=options.base||await fs.mkdtemp(path.join(os.tmpdir(),'office-onboarding-'));if(!options.base)t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const runDir=path.join(base,options.runId||crypto.randomUUID());await fs.mkdir(runDir,{recursive:true});
 const actual={...original(),...input},outputs={},approvals=[],controller=new AbortController();
 const functions=createOnboardingFunctions({input:actual,runDir,outputs,signal:controller.signal,approval:async request=>{approvals.push(request);return options.answer||{approved:options.approved===true,note:'审批备注_本地私密数据',targetHumanId:'hr_owner',approvalId:'approval-test'};},put:async(name,body)=>{if(options.failPut?.(name))throw new Error('模拟本地文件瞬时写入失败');const dest=path.join(runDir,name);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,typeof body==='string'?body:JSON.stringify(body,null,2));return name;}});
 const execute=async(name,args={})=>{const answer=await functions[name](args);outputs[name]=answer.evidence;return answer;};
 const prepare=async()=>{await execute('prepare_onboarding');await execute('review_onboarding');await execute('plan_onboarding_resources');};
 const approved=async()=>{await prepare();await execute('request_onboarding_approval');};
 return {base,runDir,input:actual,execute,prepare,approved,outputs,approvals,controller,master:path.join(base,'hr',actual.example===true||actual.isExample===true?'example-registry.sqlite':'employee-registry.sqlite')};
}
function query(file,sql){const p=spawnSync(process.env.OFFICE_PYTHON||'/usr/bin/python3',['-c','import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps(c.execute(sys.argv[2]).fetchall(),ensure_ascii=False))',file,sql],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);}

test('onboarding tools accept no model-written personal fields and persist only after human approval',async t=>{
 assert.equal(ONBOARDING_TOOL_DEFINITIONS.length,5);for(const d of ONBOARDING_TOOL_DEFINITIONS)assert.deepEqual(d.parameters.properties,{});
 const f=await fixture(t,{}, {approved:true});await assert.rejects(()=>f.execute('register_onboarding'),/先冻结/);await f.prepare();assert.equal(await exists(f.master),false);await assert.rejects(()=>f.execute('register_onboarding',{approved:true}),/真实人事.*审批/);assert.equal(await exists(f.master),false);
 await f.execute('request_onboarding_approval',{employeeName:'模型不得改写的名字'});assert.equal(await exists(f.master),false);const result=await f.execute('register_onboarding');assert.equal(result.evidence.registered,true);assert.equal(result.evidence.externalAccountsCreated,false);assert.equal(result.evidence.equipmentAssigned,false);assert.equal(query(f.master,'SELECT COUNT(*) FROM employees')[0][0],1);const stored=JSON.parse(query(f.master,'SELECT record_json FROM employees')[0][0]);assert.equal(stored.employeeName,original().employeeName);assert.equal(stored.workEmail,original().workEmail.toLowerCase());for(const file of result.files)assert.equal(await exists(path.join(f.runDir,file)),true);
 const plan=JSON.parse(await fs.readFile(path.join(f.runDir,'onboarding/resource-requests.json'),'utf8'));assert.equal(plan.items.length,3);assert.deepEqual(plan.items.map(x=>x.category),['equipment','account','access']);for(const item of plan.items){assert.equal(item.status,'pending_manual');assert(item.suggestedOwner.includes('待公司确认'));assert(item.verification);assert.equal(item.externalActionExecuted,false);}
});

test('rejection returns an unregistered receipt and never creates the shared employee registry',async t=>{
 const f=await fixture(t);await f.approved();const result=await f.execute('register_onboarding');assert.equal(result.evidence.registered,false);assert.equal(result.evidence.status,'not_registered');assert.equal(await exists(f.master),false);const receipt=JSON.parse(await fs.readFile(path.join(f.runDir,'onboarding/registration-receipt.json'),'utf8'));assert.equal(receipt.registryWritten,false);assert.equal(JSON.stringify(receipt).includes('审批备注_本地私密数据'),false);assert.equal(JSON.stringify(receipt).includes(f.input.employeeName),false);assert.equal(f.approvals[0].targetHumanId,'hr_owner');assert.equal(f.approvals[0].details.employeeRecord.employeeName,f.input.employeeName);
});

test('model-facing results contain no raw employee identifier, date, manager, resource text or approval note',async t=>{
 const f=await fixture(t,{}, {approved:true});const results=[];for(const name of ['prepare_onboarding','review_onboarding','plan_onboarding_resources','request_onboarding_approval','register_onboarding'])results.push(await f.execute(name));const body=JSON.stringify(results.map(r=>({summary:r.summary,evidence:r.evidence,files:r.files})));
 for(const secret of [f.input.employeeName,f.input.employeeNumber,f.input.startDate,f.input.workEmail,f.input.workEmail.toLowerCase(),f.input.manager,f.input.department,f.input.position,'一台笔记本电脑','审批备注_本地私密数据'])assert.equal(body.includes(secret),false,secret);assert.equal(results[0].evidence.personalDataSharedWithModel,false);
});

test('identical payload across runs is idempotent with the same opaque receipt and one employee row',async t=>{
 const a=await fixture(t,{}, {approved:true});await a.approved();const first=await a.execute('register_onboarding');const firstReceipt=JSON.parse(await fs.readFile(path.join(a.runDir,'onboarding/registration-receipt.json'),'utf8'));
 const b=await fixture(t,{}, {base:a.base,approved:true});await b.approved();assert.equal(b.outputs.review_onboarding.duplicateStatus,'existing_identical');const second=await b.execute('register_onboarding');const secondReceipt=JSON.parse(await fs.readFile(path.join(b.runDir,'onboarding/registration-receipt.json'),'utf8'));assert.equal(second.evidence.idempotent,true);assert.equal(second.evidence.employeeRef,first.evidence.employeeRef);assert.equal(secondReceipt.receiptId,firstReceipt.receiptId);assert.equal(query(a.master,'SELECT COUNT(*) FROM employees')[0][0],1);
});

test('changed employee number or case-insensitive email collision cannot overwrite the old employee',async t=>{
 const a=await fixture(t,{}, {approved:true});await a.approved();await a.execute('register_onboarding');const before=query(a.master,'SELECT record_json FROM employees');
 for(const changes of [{employeeName:'不同姓名'},{employeeNumber:'OTHER-002',workEmail:original().workEmail.toUpperCase()}]){const b=await fixture(t,changes,{base:a.base,approved:true});await b.prepare();assert.equal(b.outputs.review_onboarding.passed,false);await assert.rejects(()=>b.execute('request_onboarding_approval'),/校验尚未通过/);assert.equal(b.approvals.length,0);await assert.rejects(()=>b.execute('register_onboarding'),/校验尚未通过/);}
 assert.deepEqual(query(a.master,'SELECT record_json FROM employees'),before);
});

test('concurrent approved runs recheck conflicts atomically at insert time',async t=>{
 const a=await fixture(t,{}, {approved:true});const b=await fixture(t,{employeeName:'并发不同姓名'},{base:a.base,approved:true});await a.approved();await b.approved();assert.equal(a.outputs.review_onboarding.duplicateStatus,'new');assert.equal(b.outputs.review_onboarding.duplicateStatus,'new');const results=await Promise.allSettled([a.execute('register_onboarding'),b.execute('register_onboarding')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/冲突/);assert.equal(query(a.master,'SELECT COUNT(*) FROM employees')[0][0],1);
});

test('example and real registries are separate and empty emails can appear more than once',async t=>{
 const a=await fixture(t,{example:true,workEmail:''},{approved:true});await a.approved();await a.execute('register_onboarding');assert.equal(await exists(path.join(a.base,'hr/employee-registry.sqlite')),false);
 const b=await fixture(t,{workEmail:''},{base:a.base,approved:true});await b.approved();await b.execute('register_onboarding');const c=await fixture(t,{employeeNumber:'SECOND-003',workEmail:''},{base:a.base,approved:true});await c.approved();await c.execute('register_onboarding');assert.equal(query(a.master,'SELECT COUNT(*) FROM employees')[0][0],1);assert.equal(query(b.master,'SELECT COUNT(*) FROM employees')[0][0],2);
});

test('missing, invalid date, wrong types, unsafe employee number and unconfirmed hiring are refused without registry writes',async t=>{
 for(const changes of [{employeeName:''},{startDate:'2026-02-29'},{startDate:'2026-04-31'},{startDate:'26-10-19'},{employeeNumber:'../private'},{employmentConfirmed:'true'},{employmentConfirmed:false},{workEmail:'no-mail'},{manager:42}]){const f=await fixture(t,changes);await assert.rejects(()=>f.execute('prepare_onboarding'));assert.equal(await exists(f.master),false);}
 const leap=await fixture(t,{startDate:'2024-02-29'});await leap.execute('prepare_onboarding');assert.equal(leap.outputs.prepare_onboarding.prepared,true);
});

test('cancelled or changed source cannot proceed after approval, and approval from another role is refused',async t=>{
 const cancelled=await fixture(t,{}, {approved:true});await cancelled.approved();cancelled.controller.abort();await assert.rejects(()=>cancelled.execute('register_onboarding'),/取消/);assert.equal(await exists(cancelled.master),false);
 const changed=await fixture(t,{}, {approved:true});await changed.approved();changed.input.department='审批后修改';await assert.rejects(()=>changed.execute('register_onboarding'),/资料已变化/);assert.equal(await exists(changed.master),false);
 const mismatch=await fixture(t,{}, {answer:{approved:true,targetHumanId:'boss'}});await mismatch.prepare();await assert.rejects(()=>mismatch.execute('request_onboarding_approval'),/审批处理人与人事负责人不符/);assert.equal(await exists(mismatch.master),false);
});

test('CSV formula cells and HTML personal fields are escaped while the exact local JSON is preserved',async t=>{
 const name='=2+2<script>alert("x")</script>';const f=await fixture(t,{employeeName:name,resourceRequirements:'=HYPERLINK("https://example.test")\n@设备脚本'},{approved:true});await f.approved();await f.execute('register_onboarding');const json=JSON.parse(await fs.readFile(path.join(f.runDir,'onboarding/employee-registration.json'),'utf8'));assert.equal(json.record.employeeName,name);const csv=await fs.readFile(path.join(f.runDir,'onboarding/employee-registration.csv'),'utf8');assert(csv.includes('"\'=2+2<script>'));const resourceCSV=await fs.readFile(path.join(f.runDir,'onboarding/resource-requests.csv'),'utf8');assert(resourceCSV.includes('"\'=HYPERLINK'));assert(resourceCSV.includes('"\'@设备脚本"'));const html=await fs.readFile(path.join(f.runDir,'onboarding/employee-registration.html'),'utf8');assert.equal(html.includes('<script>'),false);assert(html.includes('&lt;script&gt;'));assert(html.includes('待人工处理'));
});

test('one-time approval and post-commit artifact write failures recover without duplicate registration or repeated approval',async t=>{
 const failures=new Set(['onboarding/human-decision.json','onboarding/employee-registration.html']);
 const f=await fixture(t,{}, {approved:true,failPut:name=>failures.delete(name)});await f.prepare();await assert.rejects(()=>f.execute('request_onboarding_approval'),/瞬时写入失败/);assert.equal(f.approvals.length,1);assert.equal(await exists(f.master),false);await f.execute('request_onboarding_approval');assert.equal(f.approvals.length,1);assert.equal(await exists(path.join(f.runDir,'onboarding/human-decision.json')),true);
 await assert.rejects(()=>f.execute('register_onboarding'),/瞬时写入失败/);assert.equal(query(f.master,'SELECT COUNT(*) FROM employees')[0][0],1);const storedReceipt=query(f.master,'SELECT receipt_id FROM employees')[0][0];const recovered=await f.execute('register_onboarding');assert.equal(recovered.evidence.registered,true);assert.equal(recovered.evidence.idempotent,true);assert.equal(query(f.master,'SELECT COUNT(*) FROM employees')[0][0],1);for(const name of recovered.files)assert.equal(await exists(path.join(f.runDir,name)),true);const receipt=JSON.parse(await fs.readFile(path.join(f.runDir,'onboarding/registration-receipt.json'),'utf8'));assert.equal(receipt.receiptId,storedReceipt);
});

test('an empty SQLite file left by an interrupted initial transaction does not block future registration',async t=>{
 const f=await fixture(t,{}, {approved:true});await fs.mkdir(path.dirname(f.master),{recursive:true});await fs.writeFile(f.master,'');await f.approved();assert.equal(f.outputs.review_onboarding.duplicateStatus,'new');await f.execute('register_onboarding');assert.equal(query(f.master,'SELECT COUNT(*) FROM employees')[0][0],1);
});
