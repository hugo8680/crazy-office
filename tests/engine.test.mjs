import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OfficeEngine,modelInput} from '../server/engine.mjs';
import {ProviderError} from '../server/provider.mjs';
import {AGENTS,SCENARIOS} from '../server/catalog.mjs';

const allNames=[...new Set(AGENTS.flatMap(a=>a.tools))];
const providerStatus=async()=>({provider:'test-double',ready:true,model:'unit-test-only'});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=3000){const begin=Date.now();while(Date.now()-begin<timeout){const value=await check();if(value)return value;await wait(10);}throw new Error('test timeout');}
function model({messages,tools,signal}){if(signal?.aborted)throw signal.reason;return Promise.resolve(messages.some(m=>m.role==='tool')?{action:'finish',summary:'测试工具返回已核对',output:'测试产物已实际写入临时工作区。',model:'unit-test-only'}:{action:'tool',tool:tools[0].name,args:{},summary:'执行测试工具',output:'',model:'unit-test-only'});}
async function setup(options={}){
 const dataDir=await mkdtemp(path.join(tmpdir(),'office-engine-test-'));
 const toolboxFactory=async({runDir,approval})=>{
   const artifacts=[];
   return {definitions:allNames.map(name=>({name,description:name,parameters:{type:'object',properties:{}}})),publicState:()=>({}),artifacts:()=>artifacts,
    async execute(name){await wait(15);if(name==='apply_defense')await approval({title:'隔离测试变更',description:'unit-test-only'});if(name==='write_report'){const p=path.join(runDir,'test-report.txt');await writeFile(p,'unit-test report');artifacts.push({id:'report',name:'test-report.txt',path:p,mimeType:'text/plain',bytes:16});}return {summary:'unit-test tool observed',value:42};}};
 };
 const engine=new OfficeEngine({dataDir,modelCall:model,providerStatus,toolboxFactory,...options});await engine.ready;return {engine,dataDir,clean:async()=>{await engine.shutdown();await rm(dataDir,{recursive:true,force:true});}};
}
function receiptToolbox({beforeExecute=async()=>{},evidenceByTool={},summaryByTool={}}={}){
 return async({runDir,approval,emit})=>{
  const artifacts=[];
  return {definitions:allNames.map(name=>({name})),publicState:()=>({}),artifacts:()=>artifacts,
   execute:async(name,args)=>{
    await beforeExecute(name,args);let decision=null;
    if(name==='apply_defense')decision=await approval({title:'真实审批测试',description:'仅测试隔离工具等待人工选择'});
    const filename=name+'-receipt.txt',artifact={id:'receipt-'+name,name:filename,path:filename,mimeType:'text/plain',bytes:0};
    const summary=Object.hasOwn(summaryByTool,name)?summaryByTool[name]:'工具测试回执：'+name;
    const content=JSON.stringify({tool:name,args,decision,summary});await writeFile(path.join(runDir,filename),content);artifact.bytes=Buffer.byteLength(content);artifacts.push(artifact);emit({type:'artifact',text:'实际写入测试回执',artifact});
    return {summary,evidence:{...(evidenceByTool[name]||{}),...(decision?{approved:decision.approved}:{})},artifacts:[artifact]};
   }};
 };
}

test('回执交接开关默认关闭；启用后每岗位仍先请求模型选工具且不再冗余请求finish',async()=>{
 for(const enabled of [false,true]){
  const calls=[];const {engine,clean}=await setup({...(enabled?{receiptHandoff:true}:{}),toolboxFactory:receiptToolbox(),modelCall:async request=>{calls.push({role:request.role.id,context:structuredClone(request.context)});return model(request);}});
  try{
   const started=await engine.create({scenarioId:'finance',input:{company:'receipt-mode test',year:2025,data:'explicit test source'}});await until(()=>engine.runs.get(started.id).status==='completed');const run=await engine.get(started.id);
   assert.equal(calls.length,enabled?4:8);for(const role of ['ops','finance','liu','lead'])assert.equal(calls.filter(call=>call.role===role).length,enabled?1:2);
   assert(run.tasks.every(task=>task.toolCalls===1&&task.toolResults.length===1&&task.artifactIds.length===1));assert(run.tasks.every(task=>task.summarySource===(enabled?'tool_receipt':'model')));
   if(enabled){assert(run.tasks.every(task=>task.output==='工具测试回执：'+task.toolResults[0].tool));assert(run.events.filter(event=>event.type==='result'&&event.taskId).every(event=>event.summarySource==='tool_receipt'));
    const received=calls.find(call=>call.role==='lead').context.evidence;assert.equal(received.length,2);assert(received.every(item=>item.toolResults.length===1&&item.toolResults[0].result.artifacts.length===1));
    const handoff=run.events.find(event=>event.deliveryKind==='evidence'&&event.sourceAgentId==='finance'&&event.targetAgentId==='lead');assert.deepEqual(handoff.artifactIds,['receipt-calculate_finance']);
   }
   assert(run.artifacts.some(artifact=>artifact.id==='receipt-write_report'));assert(run.events.some(event=>event.deliveryKind==='final_delivery'));
  }finally{await engine.shutdown();await clean();}
 }
});

test('回执交接仍把工具错误交还模型修正，成功后才完成该岗位',async()=>{
 const calls=[];let failed=false;
 const {engine,clean}=await setup({receiptHandoff:true,toolboxFactory:receiptToolbox({beforeExecute:async name=>{if(name==='import_finance'&&!failed){failed=true;throw new Error('unit-test source needs correction');}}}),modelCall:async request=>{calls.push({role:request.role.id,progress:structuredClone(request.context.taskProgress)});return {action:'tool',tool:request.context.taskProgress.remainingRequiredTools[0],args:{attempt:request.messages.length?2:1},summary:'模型根据实际反馈选择工具'};}});
 try{const started=await engine.create({scenarioId:'finance',input:{company:'correction test',year:2025,data:'explicit input'}});await until(()=>engine.runs.get(started.id).status==='completed');const run=await engine.get(started.id);assert.equal(calls.length,5);const ingest=calls.filter(call=>call.role==='ops');assert.equal(ingest.length,2);assert.match(ingest[1].progress.lastToolError,/needs correction/);assert.equal(run.tasks[0].toolCalls,2);assert.equal(run.tasks[0].toolResults.length,1);assert.equal(run.tasks[0].summarySource,'tool_receipt');assert.equal(run.tasks[0].toolResults[0].result.artifacts[0].id,'receipt-import_finance');}
 finally{await engine.shutdown();await clean();}
});

test('passed=false或没有真实summary的回执不能免去模型后续判断',async()=>{
 for(const options of [{evidenceByTool:{audit_finance:{passed:false}}},{summaryByTool:{audit_finance:''}}]){
  const calls=[];const {engine,clean}=await setup({receiptHandoff:true,toolboxFactory:receiptToolbox(options),modelCall:async request=>{calls.push(request.role.id);return model(request);}});
  try{const started=await engine.create({scenarioId:'finance',input:{company:'negative receipt',year:2025,data:'explicit source'}});await until(()=>engine.runs.get(started.id).status==='completed');const run=await engine.get(started.id);assert.equal(calls.length,5);assert.equal(calls.filter(role=>role==='liu').length,2);const audit=run.tasks.find(task=>task.id==='audit');assert.equal(audit.summarySource,'model');if(options.evidenceByTool)assert.equal(audit.toolResults[0].result.evidence.passed,false);assert(run.tasks.filter(task=>task.id!=='audit').every(task=>task.summarySource==='tool_receipt'));}
  finally{await engine.shutdown();await clean();}
 }
});

test('回执交接等待真实审批；verifiedRestored=false保留模型判断且不被当成恢复',async()=>{
 const calls=[];const {engine,clean}=await setup({receiptHandoff:true,toolboxFactory:receiptToolbox({evidenceByTool:{verify_network:{verifiedRestored:false}}}),modelCall:async request=>{calls.push(request.tools[0].name);return model(request);}});
 try{const started=await engine.create({scenarioId:'ddos',input:{requirements:'isolated actual approval test',logs:'explicit logs'}});const pending=await until(()=>{const run=engine.runs.get(started.id);return run.status==='awaiting_approval'&&run;});
  assert.equal(calls.length,3);await wait(25);assert.equal(calls.length,3);const defense=pending.tasks.find(task=>task.id==='defense');assert.equal(defense.status,'running');assert.equal(defense.summarySource,undefined);assert.equal(defense.toolResults?.length||0,0);assert.equal(calls.includes('verify_network'),false);
  await engine.approve(started.id,{approved:true,approvalId:pending.approval.id});await until(()=>engine.runs.get(started.id).status==='completed');const run=await engine.get(started.id);assert.equal(calls.length,6);assert.equal(calls.filter(tool=>tool==='verify_network').length,2);assert.equal(run.tasks.find(task=>task.id==='defense').summarySource,'tool_receipt');const verified=run.tasks.find(task=>task.id==='verify');assert.equal(verified.summarySource,'model');assert.equal(verified.toolResults[0].result.evidence.verifiedRestored,false);assert.equal(run.nodes.server.status,'warning');assert(run.events.some(event=>event.actor==='human'&&event.data.approved===true));
 }finally{await engine.shutdown();await clean();}
});
test('真实执行引擎按依赖交接，不同角色并行，同角色互斥，并登记实际文件',async()=>{
 const {engine,clean}=await setup();try{
 let parallel=false;engine.on('newListener',()=>{});
 const run=await engine.create({scenarioId:'finance',input:{company:'test',year:2025,data:'actual provided CSV'}});
 engine.on('run:'+run.id,r=>{const active=r.tasks.filter(t=>t.status==='running');if(active.length>1)parallel=true;assert.equal(new Set(active.map(t=>t.agentId)).size,active.length);for(const t of active)for(const d of t.dependencies)assert.equal(r.tasks.find(x=>x.id===d).status,'done');});
 await until(()=>engine.runs.get(run.id).status==='completed');const result=await engine.get(run.id);
 assert.equal(parallel,true);assert.ok(result.events.some(e=>e.type==='handoff'));assert.equal(result.tasks.length,4);assert.ok(result.tasks.every(t=>t.toolCalls>0));assert.ok(result.artifacts.some(a=>a.id==='report'));assert.ok(result.artifacts.some(a=>a.id==='execution-evidence'));assert.equal(engine.publicRun(result).input,undefined);assert.equal(engine.publicRun(result).runDir,undefined);
 }finally{await wait(30);await clean();}
});
test('未连接模型、缺必要权限、未提供输入时不能创建仿真假完成任务',async()=>{
 const {engine,clean}=await setup({providerStatus:async()=>({ready:false,message:'not connected'})});try{
 await assert.rejects(engine.create({scenarioId:'finance',input:{company:'test',year:2025,data:'csv'}}),/not connected/);
 await assert.rejects(engine.create({scenarioId:'finance',input:{company:'test',year:2025}}),/财务数据/);
 await assert.rejects(engine.create({scenarioId:'finance',input:{company:'test',year:2025,data:'csv'},agentConfigs:[{id:'finance',tools:[]}]}),/需要授权/);
 assert.equal((await engine.list()).length,0);
 }finally{await clean();}
});
test('审批必须由当前真人决策，旧ID与重复审批无效',async()=>{
 const {engine,clean}=await setup();try{
 const run=await engine.create({scenarioId:'ddos',input:{requirements:'test isolated replay',logs:'provided input'}});
 const pending=await until(()=>{const r=engine.runs.get(run.id);return r.status==='awaiting_approval'&&r;});
 await assert.rejects(engine.approve(run.id,{approved:true,approvalId:'old'}),/失效/);
 await engine.approve(run.id,{approved:false,approvalId:pending.approval.id});
 await assert.rejects(engine.approve(run.id,{approved:true,approvalId:'old'}),/失效/);
 await until(()=>engine.runs.get(run.id).status==='completed');assert.ok(pending.events.some(e=>e.actor==='human'&&e.data.approved===false));
 }finally{await wait(30);await clean();}
});
test('取消会阻止剩余任务，失败保留可下载证据，不能执行未授权工具',async()=>{
 const {engine,clean}=await setup({modelCall:async({signal})=>{await wait(100);if(signal.aborted)throw signal.reason;return {action:'tool',tool:'invented_admin_shell',summary:'bad',args:{}};}});try{
 const run=await engine.create({scenarioId:'finance',input:{company:'test',year:2025,data:'csv'}});await engine.cancel(run.id);await wait(150);const current=await engine.get(run.id);assert.equal(current.status,'cancelled');assert.equal(current.tasks.some(t=>t.status==='done'),false);
 }finally{await clean();}
});
test('全部场景的任务权限、依赖和角色定义一致',()=>{
 for(const s of SCENARIOS){const ids=new Set(s.tasks.map(t=>t.id));for(const t of s.tasks){const role=AGENTS.find(a=>a.id===t.agentId);assert.ok(role);for(const tool of t.tools)assert.ok(role.tools.includes(tool),`${s.id}/${t.id}/${tool}`);for(const d of t.dependencies)assert.ok(ids.has(d)&&d!==t.id);}}
});
test('两个同时派工请求不会在异步模型状态检查间创建重复活跃任务',async()=>{
 const {engine,clean}=await setup({providerStatus:async()=>{await wait(30);return providerStatus();},modelCall:async({signal})=>{await wait(200);if(signal.aborted)throw signal.reason;return {action:'finish',summary:'still waiting'};}});
 try{
  const request={scenarioId:'finance',input:{company:'test',year:2025,data:'csv'}};
  const results=await Promise.allSettled([engine.create(request),engine.create(request)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.match(results.find(r=>r.status==='rejected').reason.message,/已有任务/);
  const run=results.find(r=>r.status==='fulfilled').value;await engine.cancel(run.id);await wait(250);
 }finally{await clean();}
});
test('交付记录写入期间取消，不能随后被覆盖成完成',async()=>{
 const {engine,clean}=await setup();const original=engine.saveTranscript.bind(engine);let atFinal,release;
 const entered=new Promise(resolve=>{atFinal=resolve;});const held=new Promise(resolve=>{release=resolve;});
 engine.saveTranscript=async(run,status)=>{if(status==='completed'){atFinal(run.id);await held;}return original(run,status);};
 try{
  const run=await engine.create({scenarioId:'finance',input:{company:'test',year:2025,data:'csv'}});
  await entered;assert.equal((await engine.get(run.id)).events.some(e=>e.deliveryKind==='final_delivery'),false);await engine.cancel(run.id);release();await wait(80);
  const current=await engine.get(run.id);assert.equal(current.status,'cancelled');
  assert.ok(!current.events.some(e=>e.text==='协作任务已结束，交付文件与过程记录已保存。'||e.deliveryKind==='final_delivery'));
  const record=JSON.parse(await readFile((await engine.artifact(run.id,'execution-evidence')).path,'utf8'));assert.equal(record.status,'cancelled');assert.equal(record.events.some(e=>e.deliveryKind==='final_delivery'),false);
 }finally{release();await wait(30);await clean();}
});
test('取消后晚到的工具文件登记不会丢失可下载执行记录',async()=>{
 let entered;const active=new Promise(resolve=>{entered=resolve;});
 const {engine,clean}=await setup({toolboxFactory:async({runDir,emit})=>{
  const artifacts=[];return {definitions:allNames.map(name=>({name})),artifacts:()=>artifacts,publicState:()=>({}),execute:async()=>{entered();await wait(70);const name='late.txt';await writeFile(path.join(runDir,name),'partial output');artifacts.push({id:'late',name,path:name,bytes:14});emit({type:'artifact',text:'late partial file'});return {summary:'late result'};}};
 }});
 try{const run=await engine.create({scenarioId:'finance',input:{company:'test',year:2025,data:'csv'}});await active;await engine.cancel(run.id);await wait(110);const current=await engine.get(run.id);assert.equal(current.status,'cancelled');assert.ok(current.artifacts.some(a=>a.id==='execution-evidence'));assert.ok((await engine.artifact(run.id,'execution-evidence')).path.endsWith('协作执行记录.json'));}finally{await clean();}
});
test('采购检索不能只抓一个页面就遗漏其他用户指定供应商',async()=>{
 const urls=['https://vendor-one.example/server','https://vendor-two.example/server'];let prevented=false;
 const {engine,clean}=await setup({receiptHandoff:true,modelCall:async input=>{
  if(!input.tools.some(t=>t.name==='fetch_quote'))return model(input);
  const calls=input.messages.filter(m=>m.role==='assistant').map(m=>JSON.parse(m.content));
  if(!calls.some(c=>c.tool==='search_web'))return {action:'tool',tool:'search_web',args:{},summary:'search'};
  if(!calls.some(c=>c.tool==='fetch_quote'))return {action:'tool',tool:'fetch_quote',args:{url:urls[0]},summary:'first URL'};
  if(input.messages.at(-1)?.content.startsWith('尚未抓取')){prevented=true;return {action:'tool',tool:'fetch_quote',args:{url:urls[1]},summary:'remaining URL'};}
  return {action:'finish',summary:'actual receipts checked',output:'quotes checked'};
 },toolboxFactory:async({runDir})=>{const artifacts=[];return {definitions:allNames.map(name=>({name})),artifacts:()=>artifacts,publicState:()=>({}),execute:async(name,args)=>{if(name==='write_report'){await writeFile(path.join(runDir,'report.txt'),'actual test report');artifacts.push({id:'report',name:'report.txt',path:'report.txt',bytes:18});}return name==='fetch_quote'?{evidence:{quotes:[{requestedUrl:args.url,status:'pending_inquiry'}]}}:{summary:'test receipt'};}};}});
 try{const run=await engine.create({scenarioId:'procurement',input:{requirements:'test hardware',budget:1000,currency:'USD',urls:urls.join('\n')}});await until(()=>engine.runs.get(run.id).status==='completed');assert.equal(prevented,true);assert.equal(engine.runs.get(run.id).tasks[0].toolCalls,3);}finally{await engine.shutdown();await clean();}
});
test('长交付需求明确拒绝，受支持的补充文本完整交给模型',async()=>{
 let seen='';const {engine,clean}=await setup({modelCall:input=>{if(input.context.input.data?.preview)seen=input.context.input.data.preview;return model(input);}});
 try{await assert.rejects(engine.create({scenarioId:'delivery',input:{company:'test',requirements:'x'.repeat(24001)}}),/24000/);const text='x'.repeat(2300)+'尾部验收条件';const run=await engine.create({scenarioId:'delivery',input:{company:'test',requirements:'brief',data:{name:'brief.txt',text}}});await until(()=>engine.runs.get(run.id).status==='completed');assert.equal(seen,text);}finally{await wait(20);await clean();}
});

test('模型真实失败后执行记录持久化，第二个引擎重载仍可下载并保留错误',async()=>{
 const {engine,dataDir,clean}=await setup({modelCall:async()=>{throw new Error('unit-test explicit model failure');}});
 const originalFail=engine.fail.bind(engine);let failed;const settled=new Promise(resolve=>{failed=resolve;});
 engine.fail=async(...args)=>{await originalFail(...args);failed();};
 try{
  const started=await engine.create({scenarioId:'finance',input:{company:'restart test',year:2025,data:'explicit test data'}});
  await settled;await engine.persistChains.get(started.id);
  const saved=JSON.parse(await readFile(path.join(dataDir,started.id,'run.json'),'utf8'));
  assert.equal(saved.status,'failed');assert.match(saved.error,/explicit model failure/);
  assert.ok(saved.artifacts.some(a=>a.id==='execution-evidence'));
  const recovered=new OfficeEngine({dataDir,providerStatus,modelCall:async()=>{throw new Error('recovery must not invoke model');}});
  await recovered.ready;const run=await recovered.get(started.id);
  assert.equal(run.status,'failed');assert.match(run.error,/explicit model failure/);
  const artifact=await recovered.artifact(started.id,'execution-evidence');
  const record=JSON.parse(await readFile(artifact.path,'utf8'));
  assert.equal(record.id,started.id);assert.equal(record.status,'failed');assert.match(record.error,/explicit model failure/);
  assert.equal(record.events.some(e=>e.deliveryKind==='final_delivery'),false);assert.equal(run.events.some(e=>e.deliveryKind==='final_delivery'),false);
  assert.ok(run.tasks.every(t=>t.status==='failed'));
 }finally{await clean();}
});

test('冷恢复中断审批时冻结计时、废除审批并持久化失败执行记录',async()=>{
 const {dataDir,clean}=await setup();let modelCalls=0;
 try{
  const id='interrupted-approval-recovery',runDir=path.join(dataDir,id);await mkdir(runDir);
  const scenario=SCENARIOS.find(s=>s.id==='ddos'),createdAt=new Date(Date.now()-60000).toISOString();
  const snapshot={id,scenarioId:scenario.id,title:scenario.title,status:'awaiting_approval',createdAt,updatedAt:createdAt,provider:'test-double',model:'unit-test-only',input:{requirements:'isolated recovery test',logs:'provided test logs'},configs:Object.fromEntries(AGENTS.map(a=>[a.id,{instructions:a.instructions,tools:[...a.tools]}])),runDir,tasks:scenario.tasks.map((t,i)=>({...t,status:i<2?'done':i===2?'running':'pending',action:'',result:'',output:'',toolCalls:i<3?1:0,startedAt:i<3?createdAt:null,finishedAt:i<2?createdAt:null})),events:[],artifacts:[],approval:{id:'stale-approval',title:'interrupted approval'},summary:'',error:null,nodes:{}};
  await writeFile(path.join(runDir,'run.json'),JSON.stringify(snapshot));
  const options={dataDir,providerStatus:async()=>({ready:false,message:'unit-test offline'}),modelCall:async()=>{modelCalls++;throw new Error('must not invoke model while recovering');}};
  const recovered=new OfficeEngine(options);await recovered.ready;const run=await recovered.get(id);
  assert.equal(run.status,'failed');assert.equal(run.approval,null);assert.ok(run.finishedAt);
  assert.ok(run.tasks.filter(t=>t.id!=='inspect'&&t.id!=='security').every(t=>t.status==='failed'&&t.finishedAt===run.finishedAt));
  const expectedElapsed=Math.round((Date.parse(run.finishedAt)-Date.parse(createdAt))/1000);
  assert.equal(recovered.publicRun(run).elapsedSeconds,expectedElapsed);
  const saved=JSON.parse(await readFile(path.join(runDir,'run.json'),'utf8'));
  assert.equal(saved.status,'failed');assert.equal(saved.approval,null);assert.equal(saved.finishedAt,run.finishedAt);
  const record=JSON.parse(await readFile((await recovered.artifact(id,'execution-evidence')).path,'utf8'));
  assert.equal(record.status,'failed');assert.equal(record.finishedAt,run.finishedAt);
  await assert.rejects(recovered.approve(id,{approved:true,approvalId:'stale-approval'}),/失效/);
  await assert.rejects(recovered.retry(id),/offline/);
  const again=new OfficeEngine(options);await again.ready;
  assert.equal((await again.get(id)).finishedAt,run.finishedAt);assert.equal(modelCalls,0);
 }finally{await clean();}
});

test('任务进度仅依据成功回执更新，失败反馈保留，成功后提示模型交接而非强制完成',async()=>{
 let firstImport=true;const snapshots=[];
 const {engine,clean}=await setup({modelCall:async request=>{
  const progress=structuredClone(request.context.taskProgress);snapshots.push({agent:request.role.id,...progress});
  if(progress.remainingRequiredTools.length)return {action:'tool',tool:progress.remainingRequiredTools[0],args:{},summary:'unit-test dispatch'};
  return {action:'finish',summary:'unit-test evidence checked',output:'Actual test tool receipts reviewed.'};
 },toolboxFactory:async({runDir})=>{const artifacts=[];return {definitions:allNames.map(name=>({name})),artifacts:()=>artifacts,publicState:()=>({}),execute:async name=>{
  if(name==='import_finance'&&firstImport){firstImport=false;throw new Error('unit-test bad source format');}
  if(name==='write_report'){await writeFile(path.join(runDir,'report.txt'),'actual test report');artifacts.push({id:'report',name:'report.txt',path:'report.txt',bytes:18});}
  return {summary:'actual test receipt'};
 }};}});
 try{
  const started=await engine.create({scenarioId:'finance',input:{company:'progress test',year:2025,data:'explicit input'}});
  await until(()=>engine.runs.get(started.id).status==='completed');
  const ingest=snapshots.filter(s=>s.agent==='ops');assert.equal(ingest.length,3);
  assert.deepEqual(ingest[0].successfulTools,[]);assert.deepEqual(ingest[0].remainingRequiredTools,['import_finance']);assert.equal(ingest[0].lastToolError,null);
  assert.deepEqual(ingest[1].successfulTools,[]);assert.deepEqual(ingest[1].remainingRequiredTools,['import_finance']);assert.match(ingest[1].lastToolError,/bad source format/);
  assert.deepEqual(ingest[2].successfulTools,['import_finance']);assert.deepEqual(ingest[2].remainingRequiredTools,[]);assert.equal(ingest[2].lastToolError,null);assert.match(ingest[2].nextStepHint,/无需重复/);
  assert.ok((await engine.get(started.id)).tasks.every(t=>t.toolCalls>0));
 }finally{await engine.shutdown();await clean();}
});

test('有序停机会取消模型、冻结记录、拒绝新任务并等待持久化后允许冷加载',async()=>{
 let entered;const active=new Promise(resolve=>{entered=resolve;});let aborted=false;
 const {engine,dataDir,clean}=await setup({modelCall:async({signal})=>new Promise((resolve,reject)=>{entered();const cancel=()=>{aborted=true;reject(signal.reason);};if(signal.aborted)cancel();else signal.addEventListener('abort',cancel,{once:true});})});
 try{
  const started=await engine.create({scenarioId:'finance',input:{company:'shutdown test',year:2025,data:'explicit data'}});await active;
  const stopping=engine.shutdown();assert.equal(engine.shutdown(),stopping);await stopping;
  const run=await engine.get(started.id);assert.equal(aborted,true);assert.equal(run.status,'cancelled');assert.ok(run.finishedAt);assert.equal(engine.controls.size,0);assert.equal(engine.executions.size,0);
  assert.ok(run.events.some(event=>event.text.includes('服务正在停止')));
  await assert.rejects(engine.create({scenarioId:'finance',input:{company:'new',year:2025,data:'data'}}),/服务正在停止/);
  const persisted=JSON.parse(await readFile(path.join(dataDir,started.id,'run.json'),'utf8'));assert.equal(persisted.status,'cancelled');assert.ok(persisted.artifacts.some(a=>a.id==='execution-evidence'));
  const recovered=new OfficeEngine({dataDir,providerStatus});await recovered.ready;assert.equal((await recovered.get(started.id)).status,'cancelled');
  assert.equal(JSON.parse(await readFile((await recovered.artifact(started.id,'execution-evidence')).path,'utf8')).status,'cancelled');
 }finally{await clean();}
});

test('模型格式错误最多纠正两次，仍由模型返回合法工具请求后实际执行',async()=>{
 let malformed=0;const feedback=[];
 const {engine,clean}=await setup({modelCall:async request=>{
  if(request.role.id==='ops'&&malformed<2){malformed++;throw new ProviderError(malformed===1?'MALFORMED_ARGUMENTS':'MALFORMED_OUTPUT','unit-test schema mismatch',{toolName:'import_finance'});}
  if(request.role.id==='ops')feedback.push(...request.messages.filter(m=>m.role==='tool'&&m.content.includes('格式校验失败')).map(m=>m.content));
  const remaining=request.context.taskProgress.remainingRequiredTools;
  return remaining.length?{action:'tool',tool:remaining[0],args:{},summary:'corrected actual tool request'}:{action:'finish',summary:'actual receipts checked',output:'unit-test evidence complete'};
 }});
 try{const run=await engine.create({scenarioId:'finance',input:{company:'format correction',year:2025,data:'explicit input'}});await until(()=>engine.runs.get(run.id).status==='completed');const done=await engine.get(run.id);assert.equal(malformed,2);assert.equal(done.tasks[0].toolCalls,1);assert.equal(done.events.filter(e=>e.formatCorrection).length,2);assert.ok(feedback.some(text=>text.includes('未执行任何工具')&&text.includes('不要擅自传null')));}
 finally{await engine.shutdown();await clean();}
});

test('Ollama格式纠正只要求原生args对象，不要求args_json字符串',async()=>{
 let malformed=false;const corrections=[];
 const {engine,clean}=await setup({receiptHandoff:true,providerStatus:async()=>({provider:'ollama',ready:true,model:'unit-test-only'}),modelCall:async request=>{
  if(request.role.id==='ops'&&!malformed){malformed=true;throw new ProviderError('MALFORMED_ARGUMENTS','unit-test native args shape',{toolName:'import_finance'});}
  corrections.push(...request.messages.filter(message=>message.role==='tool'&&message.content.includes('格式校验失败')).map(message=>message.content));
  return {action:'tool',tool:request.context.taskProgress.remainingRequiredTools[0],args:{},summary:'原生参数格式纠正后选择工具'};
 }});
 try{const started=await engine.create({scenarioId:'finance',input:{company:'native args test',year:2025,data:'explicit input'}});await until(()=>engine.runs.get(started.id).status==='completed');assert.equal(corrections.length,1);assert.match(corrections[0],/args必须是原生JSON对象，不能生成args_json字段/);assert.equal(corrections[0].includes('args_json必须是JSON对象字符串'),false);assert.equal((await engine.get(started.id)).tasks[0].summarySource,'tool_receipt');}
 finally{await engine.shutdown();await clean();}
});

test('DashScope岗位目标和格式纠正使用原生Function Calling且仍真实执行工具',async()=>{
 let malformed=false;const corrections=[];
 const {engine,clean}=await setup({receiptHandoff:true,providerStatus:async()=>({provider:'dashscope',ready:true,model:'unit-test-only'}),modelCall:async request=>{
  assert.match(request.goal,/原生Function Calling请求本轮授权工具/);assert.equal(request.goal.includes('本轮只生成外部办公服务器的JSON调用请求'),false);
  if(request.role.id==='ops'&&!malformed){malformed=true;throw new ProviderError('MALFORMED_ARGUMENTS','unit-test native args shape',{toolName:'import_finance'});}
  corrections.push(...request.messages.filter(message=>message.role==='tool'&&message.content.includes('格式校验失败')).map(message=>message.content));
  return {action:'tool',tool:request.context.taskProgress.remainingRequiredTools[0],args:{},summary:'原生参数格式纠正后选择工具'};
 }});
 try{const started=await engine.create({scenarioId:'finance',input:{company:'native args test',year:2025,data:'explicit input'}});await until(()=>engine.runs.get(started.id).status==='completed');assert.equal(corrections.length,1);assert.match(corrections[0],/原生Function Calling.*function.arguments.*不输出action\/args_json调度包/);assert.equal(corrections[0].includes('args_json必须是JSON对象字符串'),false);assert.equal((await engine.get(started.id)).tasks[0].summarySource,'tool_receipt');}
 finally{await engine.shutdown();await clean();}
});

test('持续模型格式错误第三次硬失败，不执行任何业务工具',async()=>{
 let calls=0,executions=0;
 const {engine,clean}=await setup({modelCall:async()=>{calls++;throw new ProviderError('MALFORMED_ARGUMENTS','unit-test invalid schema',{toolName:'import_finance'});},toolboxFactory:async()=>({definitions:allNames.map(name=>({name})),artifacts:()=>[],publicState:()=>({}),execute:async()=>{executions++;return {};}})});
 try{const started=await engine.create({scenarioId:'finance',input:{company:'persistent invalid format',year:2025,data:'explicit input'}});await until(()=>engine.runs.get(started.id).status==='failed'&&engine.runs.get(started.id).artifacts.some(a=>a.id==='execution-evidence'));const run=await engine.get(started.id);assert.equal(calls,3);assert.equal(executions,0);assert.equal(run.tasks[0].toolCalls,0);assert.equal(run.events.filter(e=>e.formatCorrection).length,2);assert.match(run.error,/invalid schema/);}
 finally{await engine.shutdown();await clean();}
});

test('账号、网络、越权与原生工具错误不进入格式纠正流程',async()=>{
 for(const code of ['AUTH_REQUIRED','NETWORK_ERROR','UNAUTHORIZED_TOOL','NATIVE_TOOL_BLOCKED']){
  let calls=0;const {engine,clean}=await setup({modelCall:async()=>{calls++;throw new ProviderError(code,'unit-test hard failure');}});
  try{const started=await engine.create({scenarioId:'finance',input:{company:'hard failure',year:2025,data:'explicit input'}});await until(()=>engine.runs.get(started.id).status==='failed'&&engine.runs.get(started.id).artifacts.some(a=>a.id==='execution-evidence'));const run=await engine.get(started.id);assert.equal(calls,1);assert.equal(run.tasks[0].toolCalls,0);assert.equal(run.events.filter(e=>e.formatCorrection).length,0);}
  finally{await engine.shutdown();await clean();}
 }
});

test('投资资料限制明确，补充文本完整交接而大财务文本仅给模型预览',async()=>{
 const {engine,clean}=await setup();const scenario={id:'investment',fields:[]};
 try{
  const supplementary='x'.repeat(2300)+'补充材料末尾事实',financials='year,revenue\n'+'1,100\n'.repeat(500);
  const input={projectName:'投资测试项目',projectBrief:'项目原始简介',data:{name:'brief.txt',text:supplementary},financials:{name:'finance.csv',text:financials}};
  engine.validateInput(scenario,input);const visible=modelInput(input,'investment');
  assert.equal(visible.data.preview,supplementary);assert.equal(visible.financials.preview,financials.slice(0,1800));assert.equal(visible.financials.characters,financials.length);assert.equal(input.financials.text,financials);
  assert.throws(()=>engine.validateInput(scenario,{...input,data:'x'.repeat(24000)}),/合计最多24000/);
  assert.throws(()=>engine.validateInput(scenario,{...input,financials:'x'.repeat(240001)}),/240000/);
  for(const key of ['data','financials'])assert.throws(()=>engine.validateInput(scenario,{...input,[key]:{name:'input.xlsx',base64:'AAAA'}}),/不支持二进制/);
  assert.throws(()=>engine.validateInput(scenario,{...input,financials:{rows:[]}}),/仅支持文本/);
 }finally{await clean();}
});

test('投资审批保留标题与kind，明确老板继续尽调或暂缓，不使用隔离变更文案',async()=>{
 let entered;const active=new Promise(resolve=>{entered=resolve;});
 const {engine,clean}=await setup({modelCall:async({signal})=>new Promise((resolve,reject)=>{entered();const stop=()=>reject(signal.reason);if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});})});
 try{
  const started=await engine.create({scenarioId:'finance',input:{company:'approval routing test',year:2025,data:'explicit input'}});await active;const run=await engine.get(started.id);
  assert.equal(run.nodes.investment.status,'online');
  const declined=engine.requestApproval(run,{kind:'investment',agentId:'invest_risk',title:'示例项目尽调审批',description:'not an investment order'});const firstId=run.approval.id;
  assert.equal(run.approval.kind,'investment');assert.equal(run.events.at(-1).agentId,'invest_risk');
  await engine.approve(run.id,{approved:false,approvalId:firstId});assert.equal((await declined).approved,false);
  const decision=run.events.findLast(e=>e.actor==='human');assert.match(decision.text,/示例项目尽调审批.*老板决定暂缓项目/);assert.equal(decision.data.kind,'investment');assert.equal(decision.data.title,'示例项目尽调审批');assert.ok(!decision.text.includes('隔离'));
  const accepted=engine.requestApproval(run,{kind:'investment',title:'第二次尽调审批'});assert.equal(run.approval.agentId,'ops');
  await engine.approve(run.id,{approved:true,approvalId:run.approval.id});assert.equal((await accepted).approved,true);assert.match(run.events.findLast(e=>e.actor==='human').text,/老板决定继续尽调/);
  await assert.rejects(engine.approve(run.id,{approved:true,approvalId:firstId}),/失效/);
 }finally{await engine.shutdown();await clean();}
});

test('六个场景在真实任务入口交接真人资料，模型开始前不产生审批决定或最终交付',async()=>{
 const sources={finance:'finance_owner',procurement:'purchasing_owner',ddos:'it_owner',database:'it_owner',delivery:'business_owner',investment:'investment_owner'};
 const inputs={finance:{company:'input handoff',year:2025,data:'provided test data'},procurement:{requirements:'provided server requirements',budget:1000},ddos:{requirements:'provided isolated replay',logs:'provided test logs'},database:{requirements:'provided schema requirements'},delivery:{company:'provided customer',requirements:'provided acceptance criteria'},investment:{projectName:'provided legal name',projectBrief:'provided project brief'}};
 for(const [scenarioId,sourceHumanId] of Object.entries(sources)){
  let entered;const active=new Promise(resolve=>{entered=resolve;});const {engine,clean}=await setup({modelCall:async({signal})=>new Promise((resolve,reject)=>{entered();const stop=()=>reject(signal.reason);if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});})});
  try{
   const started=await engine.create({scenarioId,input:inputs[scenarioId]});await active;const run=await engine.get(started.id),first=run.tasks[0],handoffs=run.events.filter(e=>e.deliveryKind==='task_input');
   assert.equal(handoffs.length,1);const entry=handoffs[0];assert.equal(entry.runId,run.id);assert.equal(entry.sourceHumanId,sourceHumanId);assert.equal(entry.targetAgentId,first.agentId);assert.equal(entry.targetNodeId,first.nodeId);assert.equal(entry.taskId,first.id);assert.deepEqual(entry.artifactIds,[]);assert.ok(entry.deliveryTitle&&entry.summary);assert.equal(entry.actor,undefined);assert.equal(first.status,'running');
   assert.ok(run.events.indexOf(entry)<run.events.findIndex(e=>e.type==='model'));assert.equal(run.events.some(e=>e.deliveryKind==='approval_decision'||e.deliveryKind==='final_delivery'),false);
   await engine.cancel(run.id);await engine.shutdown();assert.equal(run.events.some(e=>e.deliveryKind==='final_delivery'),false);
  }finally{await engine.shutdown();await clean();}
 }
});

test('并行产物按实际工具归属交接，完成事件及真实文件引用写入下载记录',async()=>{
 let markBoth,started=0;const both=new Promise(resolve=>{markBoth=resolve;});
 const {engine,clean}=await setup({toolboxFactory:async({runDir,emit})=>{
  const artifacts=[];return {definitions:allNames.map(name=>({name})),artifacts:()=>artifacts,publicState:()=>({}),execute:async name=>{
   if(['calculate_finance','audit_finance'].includes(name)){if(++started===2)markBoth();await both;if(name==='audit_finance')await wait(8);}
   const item={id:name,name:name+'.txt',path:name+'.txt',bytes:Buffer.byteLength(name),mimeType:'text/plain'};await writeFile(path.join(runDir,item.path),name);artifacts.push(item);emit({type:'artifact',text:'实际写入测试产物',artifact:item});
   if(name==='calculate_finance')await wait(20);
   // Receipt IDs that are not in the registry must never become delivered files.
   return {summary:'actual receipt for '+name,artifacts:[{id:'not-registered'}]};
  }};
 }});
 try{
  const started=await engine.create({scenarioId:'finance',input:{company:'parallel provenance',year:2025,data:'explicit provided data'}});await until(()=>engine.runs.get(started.id).status==='completed');const run=await engine.get(started.id);
  const analysis=run.tasks.find(t=>t.id==='analysis'),audit=run.tasks.find(t=>t.id==='audit');assert.deepEqual(analysis.artifactIds,['calculate_finance']);assert.deepEqual(audit.artifactIds,['audit_finance']);
  const transfers=run.events.filter(e=>e.deliveryKind==='evidence');
  for(const e of transfers){const source=run.tasks.find(t=>t.id===e.sourceTaskId),target=run.tasks.find(t=>t.id===e.taskId);assert.equal(e.runId,run.id);assert.equal(e.agentId,source.agentId);assert.equal(e.sourceAgentId,source.agentId);assert.equal(e.targetAgentId,target.agentId);assert.equal(e.sourceNodeId,source.nodeId);assert.equal(e.targetNodeId,target.nodeId);assert.equal(e.deliveryTitle,source.title);assert.equal(e.summary,source.output);assert.deepEqual(e.artifactIds,source.artifactIds);assert.ok(Date.parse(e.createdAt)>=Date.parse(source.finishedAt));}
  assert.deepEqual(transfers.find(e=>e.sourceTaskId==='analysis').artifactIds,['calculate_finance']);assert.deepEqual(transfers.find(e=>e.sourceTaskId==='audit').artifactIds,['audit_finance']);
  const final=run.events.filter(e=>e.deliveryKind==='final_delivery');assert.equal(final.length,1);assert.equal(final[0].targetHumanId,'finance_owner');assert.equal(final[0].sourceAgentId,'lead');assert.equal(final[0].sourceTaskId,'report');assert.equal(final[0].summary,run.summary);assert.deepEqual(new Set(final[0].artifactIds),new Set(['import_finance','calculate_finance','audit_finance','write_report']));assert.ok(!final[0].artifactIds.includes('execution-evidence'));
  for(const id of final[0].artifactIds)assert.ok((await readFile((await engine.artifact(run.id,id)).path,'utf8')).length>0);
  const record=JSON.parse(await readFile((await engine.artifact(run.id,'execution-evidence')).path,'utf8'));assert.equal(record.status,'completed');assert.ok(record.events.some(e=>e.id===final[0].id&&e.deliveryKind==='final_delivery'));assert.equal(record.events.some(e=>e.artifactIds?.includes('not-registered')),false);
 }finally{await engine.shutdown();await clean();}
});

test('并行审批准确找到请求员工，先交方案而仅真人有效选择后交回审批结果',async()=>{
 let releaseAnalysis;const analysisHold=new Promise(resolve=>{releaseAnalysis=resolve;});
 const {engine,clean}=await setup({toolboxFactory:async({runDir,emit,approval})=>{
  const artifacts=[];return {definitions:allNames.map(name=>({name})),artifacts:()=>artifacts,publicState:()=>({}),execute:async name=>{
   const id=name==='audit_finance'?'audit-proposal':name,item={id,name:id+'.txt',path:id+'.txt',bytes:2,mimeType:'text/plain'};await writeFile(path.join(runDir,item.path),'ok');artifacts.push(item);emit({type:'artifact',text:'actual test artifact',artifact:item});
   if(name==='calculate_finance')await analysisHold;
   if(name==='audit_finance'){await wait(10);const answer=await approval({agentId:'liu',kind:'investment',title:'并行岗位真实审批请求',description:'等待真人选择，不代替决定'});releaseAnalysis();return {summary:'actual human choice '+answer.approved,artifacts:[item]};}
   return {summary:'actual test receipt',artifacts:[item]};
  }};
 }});
 try{
  const started=await engine.create({scenarioId:'finance',input:{company:'parallel approval',year:2025,data:'explicit provided data'}});const run=await until(()=>{const r=engine.runs.get(started.id);return r.status==='awaiting_approval'&&r;});const approvalId=run.approval.id;
  assert.equal(run.tasks.filter(t=>t.status==='running').length,2);assert.equal(run.approval.agentId,'liu');assert.equal(run.approval.taskId,'audit');
  const request=run.events.find(e=>e.deliveryKind==='approval_request');assert.equal(request.approvalId,approvalId);assert.equal(request.taskId,'audit');assert.equal(request.sourceAgentId,'liu');assert.equal(request.targetHumanId,'owner');assert.equal(request.targetNodeId,'general_office');assert.equal(request.sourceNodeId,'finance');assert.ok(request.artifactIds.includes('audit-proposal'));assert.ok(!request.artifactIds.includes('calculate_finance'));assert.equal(request.approved,undefined);assert.equal(request.decision,undefined);assert.equal(run.events.some(e=>e.deliveryKind==='approval_decision'||e.deliveryKind==='final_delivery'),false);
  await assert.rejects(engine.approve(run.id,{approved:true,approvalId:'stale'}),/失效/);assert.equal(run.events.some(e=>e.deliveryKind==='approval_decision'),false);
  await assert.rejects(engine.approve(run.id,{approved:'true',approvalId}),/批准或拒绝/);assert.equal(run.events.some(e=>e.deliveryKind==='approval_decision'),false);
  await engine.approve(run.id,{approved:false,approvalId,note:'真人暂缓'});const decisions=run.events.filter(e=>e.deliveryKind==='approval_decision');assert.equal(decisions.length,1);assert.equal(decisions[0].sourceHumanId,'owner');assert.equal(decisions[0].targetAgentId,'liu');assert.equal(decisions[0].taskId,'audit');assert.equal(decisions[0].approvalId,approvalId);assert.equal(decisions[0].approved,false);assert.equal(decisions[0].decision,'declined');assert.match(decisions[0].summary,/真人暂缓/);
  await until(()=>run.status==='completed');await assert.rejects(engine.approve(run.id,{approved:true,approvalId}),/失效/);assert.equal(run.events.filter(e=>e.deliveryKind==='approval_decision').length,1);
 }finally{releaseAnalysis();await engine.shutdown();await clean();}
});

test('等待审批时取消不会伪造真人决定或最终成果交付',async()=>{
 const {engine,clean}=await setup();
 try{
  const started=await engine.create({scenarioId:'ddos',input:{requirements:'isolated cancellation test',logs:'provided test logs'}});const run=await until(()=>{const r=engine.runs.get(started.id);return r.status==='awaiting_approval'&&r;}),approvalId=run.approval.id;
  assert.ok(run.events.some(e=>e.deliveryKind==='approval_request'&&e.approvalId===approvalId));await engine.cancel(run.id);await until(()=>!engine.controls.has(run.id));
  assert.equal(run.status,'cancelled');assert.equal(run.events.some(e=>e.deliveryKind==='approval_decision'||e.deliveryKind==='final_delivery'||e.actor==='human'),false);await assert.rejects(engine.approve(run.id,{approved:true,approvalId}),/失效/);
  const record=JSON.parse(await readFile((await engine.artifact(run.id,'execution-evidence')).path,'utf8'));assert.equal(record.status,'cancelled');assert.equal(record.events.some(e=>e.deliveryKind==='approval_decision'||e.deliveryKind==='final_delivery'),false);
 }finally{await engine.shutdown();await clean();}
});

test('最终记录写入失败不发布最终交付，仍保留真实产物与失败证据',async()=>{
 const {engine,clean}=await setup(),save=engine.saveTranscript.bind(engine);engine.saveTranscript=async(run,status)=>{if(status==='completed')throw new Error('unit-test final transcript write failure');return save(run,status);};
 try{
  const started=await engine.create({scenarioId:'finance',input:{company:'completion failure',year:2025,data:'provided test data'}});await until(()=>{const r=engine.runs.get(started.id);return r.status==='failed'&&r.artifacts.some(a=>a.id==='execution-evidence');});const run=await engine.get(started.id);
  assert.match(run.error,/final transcript write failure/);assert.ok(run.artifacts.some(a=>a.id==='report'));assert.equal(run.events.some(e=>e.deliveryKind==='final_delivery'),false);
  const record=JSON.parse(await readFile((await engine.artifact(run.id,'execution-evidence')).path,'utf8'));assert.equal(record.status,'failed');assert.equal(record.events.some(e=>e.deliveryKind==='final_delivery'),false);
 }finally{await engine.shutdown();await clean();}
});


const onboardingInput=()=>({employeeNumber:'UNIT-ONBOARDING-001',employeeName:'测试姓名勿发模型',department:'产品研发部',position:'应用开发工程师',startDate:'2026-10-19',workEmail:'private-unit@example.test',manager:'测试负责人勿发模型',resourceRequirements:'笔记本电脑；工作邮箱与代码库只读权限待办理。',employmentConfirmed:true});

test('入职登记严格核验工号、日期、文本长度、邮箱和已确认录用，不接受多余隐私字段',async()=>{
 const {engine,clean}=await setup();const scenario=SCENARIOS.find(s=>s.id==='onboarding'),base=onboardingInput();
 try{
  engine.validateInput(scenario,base);
  engine.validateInput(scenario,{...base,startDate:'2028-02-29',workEmail:'',manager:'',resourceRequirements:''});
  const invalid=[
   ['employeeNumber','有中文'],['employeeNumber','x'.repeat(41)],['employeeNumber',' bad-space'],['employeeNumber',123],
   ['employeeName',' '],['employeeName','x'.repeat(81)],['employeeName',{text:'wrong type'}],
   ['department','x'.repeat(81)],['position','x'.repeat(81)],['manager','x'.repeat(81)],['manager','hidden\nline'],
   ['resourceRequirements','x'.repeat(3001)],['workEmail','x'.repeat(255)],['workEmail','not-an-email'],['workEmail','a b@example.test'],
   ['startDate','0000-01-01'],['startDate','2026-02-29'],['startDate','2026-04-31'],['startDate','2026-13-01'],['startDate','2026-10-00'],['startDate','2026-1-09'],['startDate',20261019],
   ['employmentConfirmed',false],['employmentConfirmed','true'],['employmentConfirmed',1],['employmentConfirmed',null],
   ['nationalId','123'],['salary',1234],['bankAccount','123'],['health','anything'],
  ];
  for(const [key,value]of invalid)assert.throws(()=>engine.validateInput(scenario,{...base,[key]:value}),undefined,`${key}=${value}`);
  for(const key of ['employeeNumber','employeeName','department','position','startDate','employmentConfirmed']){const missing={...base};delete missing[key];assert.throws(()=>engine.validateInput(scenario,missing),undefined,key);}
 }finally{await clean();}
});

test('入职模型输入只保留匿名员工引用、岗位与准备需求，不泄露本地个人字段或额外字段',()=>{
 const input={...onboardingInput(),nationalId:'should-not-leak',privateNote:'do-not-forward'};
 const visible=modelInput(input,'onboarding'),serialized=JSON.stringify(visible);
 for(const key of ['employeeNumber','employeeName','startDate','workEmail','manager'])assert.ok(!serialized.includes(input[key]),key);
 assert.ok(!serialized.includes('should-not-leak'));assert.ok(!serialized.includes('do-not-forward'));
 assert.equal(visible.employeeRef,'本次待登记员工');assert.equal(visible.department,input.department);assert.equal(visible.position,input.position);assert.equal(visible.resourceRequirements,input.resourceRequirements);assert.equal(visible.employmentConfirmed,true);
 assert.deepEqual(visible.providedFields,{employeeNumber:true,employeeName:true,startDate:true,workEmail:true,manager:true});
 assert.equal(modelInput({...input,workEmail:'',manager:''},'onboarding').providedFields.workEmail,false);
});

test('入职审批交给真实人事负责人，非法目标拒绝且旧场景仍默认为老板',async()=>{
 let entered;const startedModel=new Promise(resolve=>{entered=resolve;});
 const {engine,clean}=await setup({modelCall:async({signal})=>new Promise((resolve,reject)=>{entered();const stop=()=>reject(signal.reason);if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});})});
 try{
  const started=await engine.create({scenarioId:'onboarding',input:onboardingInput()});await startedModel;const run=await engine.get(started.id);
  await assert.rejects(engine.requestApproval(run,{targetHumanId:'unregistered_human',title:'invalid'}),/负责人无效/);
  assert.equal(run.approval,null);assert.equal(run.status,'running');
  const hrPromise=engine.requestApproval(run,{agentId:'hr',kind:'onboarding',targetHumanId:'hr_owner',title:'本次入职登记',description:'请真实人事负责人核查本地资料'});
  assert.equal(run.approval.targetHumanId,'hr_owner');assert.equal(run.approval.targetNodeId,'workstations');assert.equal(run.approval.taskId,'intake');
  const request=run.events.findLast(e=>e.deliveryKind==='approval_request');assert.equal(request.targetHumanId,'hr_owner');assert.equal(request.targetNodeId,'workstations');assert.equal(request.sourceAgentId,'hr');
  await engine.approve(run.id,{approved:true,approvalId:run.approval.id});const actual=await hrPromise;assert.equal(actual.targetHumanId,'hr_owner');assert.ok(actual.approvalId);
  const decision=run.events.findLast(e=>e.deliveryKind==='approval_decision');assert.equal(decision.sourceHumanId,'hr_owner');assert.equal(decision.sourceNodeId,'workstations');assert.match(decision.summary,/真实人事负责人批准本次入职登记/);assert.ok(!decision.summary.includes('隔离'));
  const oldPromise=engine.requestApproval(run,{kind:'ddos',title:'旧隔离审批'});assert.equal(run.approval.targetHumanId,'owner');assert.equal(run.approval.targetNodeId,'general_office');await engine.approve(run.id,{approved:false,approvalId:run.approval.id});await oldPromise;assert.equal(run.events.findLast(e=>e.deliveryKind==='approval_decision').sourceHumanId,'owner');assert.match(run.events.findLast(e=>e.actor==='human').text,/拒绝变更/);
 }finally{await engine.shutdown();await clean();}
});

test('入职六阶段依赖图真实等待人事审批后交付，独立核查与资源规划并行且模型上下文匿名',async()=>{
 for(const approved of [true,false]){
  const snapshots=[],calls=[];let markBoth,parallelCount=0;const both=new Promise(resolve=>{markBoth=resolve;});
  const {engine,clean}=await setup({modelCall:async request=>{snapshots.push(JSON.stringify({context:request.context,messages:request.messages}));return model(request);},toolboxFactory:async({runDir,approval})=>{
   const artifacts=[];return {definitions:allNames.map(name=>({name})),publicState:()=>({employeeRef:'本次待登记员工',privateInputStoredLocally:true}),artifacts:()=>artifacts,execute:async name=>{
    calls.push(name);
    if(['review_onboarding','plan_onboarding_resources'].includes(name)){if(++parallelCount===2)markBoth();await both;}
    let evidence={employeeRef:'本次待登记员工',action:name,accountsProvisioned:false,equipmentDelivered:false};
    if(name==='request_onboarding_approval'){const answer=await approval({agentId:'hr',kind:'onboarding',targetHumanId:'hr_owner',title:'本次入职登记审阅',description:'待真人审批；账号和设备仍待办理'});evidence={...evidence,approved:answer.approved};}
    if(name==='register_onboarding')evidence={...evidence,registered:approved};
    if(name==='write_report'){const filename='anonymous-onboarding-report.txt';await writeFile(path.join(runDir,filename),'本次待登记员工：本地登记及待办回执');artifacts.push({id:'onboarding-report',name:filename,path:filename,mimeType:'text/plain',bytes:Buffer.byteLength('本次待登记员工：本地登记及待办回执')});}
    return {summary:'本地工具已返回匿名登记证据',evidence};
   }};
  }});
  try{
   const input=onboardingInput(),started=await engine.create({scenarioId:'onboarding',input});const run=await until(()=>{const r=engine.runs.get(started.id);return r.status==='awaiting_approval'&&r;});
   assert.equal(run.tasks.length,6);assert.equal(parallelCount,2);assert.equal(run.approval.taskId,'approval');assert.equal(run.approval.agentId,'hr');assert.equal(run.approval.targetHumanId,'hr_owner');assert.ok(!calls.includes('register_onboarding'));assert.equal(run.events.filter(e=>e.deliveryKind==='task_input')[0].sourceHumanId,'hr_owner');
   await engine.approve(run.id,{approved,approvalId:run.approval.id});await until(()=>run.status==='completed');assert.ok(run.tasks.every(t=>t.status==='done'));assert.equal(calls.length,6);assert.equal(calls.filter(n=>n==='register_onboarding').length,1);
   const final=run.events.find(e=>e.deliveryKind==='final_delivery');assert.equal(final.targetHumanId,'hr_owner');assert.equal(final.targetNodeId,'workstations');assert.equal(final.sourceAgentId,'lead');assert.equal(run.events.find(e=>e.deliveryKind==='approval_decision').approved,approved);
   const sent=snapshots.join('\n');for(const key of ['employeeNumber','employeeName','startDate','workEmail','manager'])assert.ok(!sent.includes(input[key]),key);assert.ok(sent.includes(input.department));assert.ok((await engine.artifact(run.id,'onboarding-report')).bytes>0);
  }finally{await engine.shutdown();await clean();}
 }
});

test('采购的技术与财务成果真实交接至总经办，再向采购负责人交付',async()=>{
 const {engine,clean}=await setup({receiptHandoff:true,toolboxFactory:receiptToolbox(),modelCall:async request=>{
  const remaining=request.context.taskProgress.remainingRequiredTools;
  return remaining.length?{action:'tool',tool:remaining[0],args:{},summary:'unit-test authorized tool request'}:{action:'finish',summary:'unit-test tool receipts checked',output:'unit-test research receipts complete'};
 }});
 try{
  const started=await engine.create({scenarioId:'procurement',input:{requirements:'unit-test public quote workflow',budget:30000,currency:'CNY',urls:''}});await until(()=>engine.runs.get(started.id).status==='completed');const run=await engine.get(started.id),management=run.tasks.find(t=>t.id==='request');
  assert.equal(management.agentId,'boss');assert.equal(management.nodeId,'general_office');assert.equal(management.status,'done');assert.equal(run.nodes.general_office.status,'online');
  for(const source of ['zhang','finance']){const handoff=run.events.find(e=>e.deliveryKind==='evidence'&&e.sourceAgentId===source&&e.targetAgentId==='boss');assert(handoff);assert.equal(handoff.targetNodeId,'general_office');assert(handoff.artifactIds.length>0);}
  const final=run.events.find(e=>e.deliveryKind==='final_delivery');assert.equal(final.sourceAgentId,'boss');assert.equal(final.sourceNodeId,'general_office');assert.equal(final.targetHumanId,'purchasing_owner');assert.equal(run.events.some(e=>e.actor==='human'&&e.approved===true),false);
 }finally{await engine.shutdown();await clean();}
});
