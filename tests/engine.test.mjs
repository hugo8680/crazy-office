import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OfficeEngine} from '../server/engine.mjs';
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
