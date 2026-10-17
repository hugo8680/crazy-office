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
 const engine=new OfficeEngine({dataDir,modelCall:model,providerStatus,toolboxFactory,...options});await engine.ready;return {engine,dataDir,clean:()=>rm(dataDir,{recursive:true,force:true})};
}
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
test('五个场景的任务权限、依赖和角色定义一致',()=>{
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
  await entered;await engine.cancel(run.id);release();await wait(80);
  assert.equal((await engine.get(run.id)).status,'cancelled');
  assert.ok(!(await engine.get(run.id)).events.some(e=>e.text==='协作任务已结束，交付文件与过程记录已保存。'));
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
 const {engine,clean}=await setup({modelCall:async input=>{
  if(!input.tools.some(t=>t.name==='fetch_quote'))return model(input);
  const calls=input.messages.filter(m=>m.role==='assistant').map(m=>JSON.parse(m.content));
  if(!calls.some(c=>c.tool==='search_web'))return {action:'tool',tool:'search_web',args:{},summary:'search'};
  if(!calls.some(c=>c.tool==='fetch_quote'))return {action:'tool',tool:'fetch_quote',args:{url:urls[0]},summary:'first URL'};
  if(input.messages.at(-1)?.content.startsWith('尚未抓取')){prevented=true;return {action:'tool',tool:'fetch_quote',args:{url:urls[1]},summary:'remaining URL'};}
  return {action:'finish',summary:'actual receipts checked',output:'quotes checked'};
 },toolboxFactory:async({runDir})=>{const artifacts=[];return {definitions:allNames.map(name=>({name})),artifacts:()=>artifacts,publicState:()=>({}),execute:async(name,args)=>{if(name==='write_report'){await writeFile(path.join(runDir,'report.txt'),'actual test report');artifacts.push({id:'report',name:'report.txt',path:'report.txt',bytes:18});}return name==='fetch_quote'?{evidence:{quotes:[{requestedUrl:args.url,status:'pending_inquiry'}]}}:{summary:'test receipt'};}};}});
 try{const run=await engine.create({scenarioId:'procurement',input:{requirements:'test hardware',budget:1000,currency:'USD',urls:urls.join('\n')}});await until(()=>engine.runs.get(run.id).status==='completed');assert.equal(prevented,true);assert.equal(engine.runs.get(run.id).tasks[0].toolCalls,3);}finally{await wait(20);await clean();}
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
