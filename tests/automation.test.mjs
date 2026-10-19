import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationController } from '../server/automation.mjs';
import { companyTaskInput, loadCompanyProfile, COMPANY_NAME } from '../server/company.mjs';
import { OfficeEngine } from '../server/engine.mjs';
import { getScenario } from '../server/catalog.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

async function harness(t,options={}){
  const dir=await mkdtemp(join(tmpdir(),'office-automation-'));let clock=Date.parse('2026-10-19T03:00:00Z'),sequence=0;
  const timers=new Map(),runs=[],calls=[];const provider={ready:true};
  const engine={
    ready:Promise.resolve(),
    list:async()=>[...runs].reverse(),
    validateInput:(scenario,input)=>OfficeEngine.prototype.validateInput.call({},scenario,input),
    create:async args=>{calls.push(args);if(runs.some(r=>['queued','running','awaiting_approval'].includes(r.status)))throw Object.assign(new Error('已有任务正在执行。'),{status:409});const run={id:'run-'+calls.length,scenarioId:args.scenarioId,title:getScenario(args.scenarioId).title,status:'queued',createdAt:new Date(clock).toISOString(),source:args.source,automation:args.automation};runs.push(run);return run;},
  };
  const controller=new AutomationController({engine,stateFile:join(dir,'automation.json'),providerStatus:async()=>provider,now:()=>clock,random:()=>0,setTimer:(callback,delay)=>{const id=++sequence;timers.set(id,{callback,delay});return id;},clearTimer:id=>timers.delete(id),...options});
  await controller.ready;
  t.after(async()=>{await controller.shutdown();await rm(dir,{recursive:true,force:true});});
  return {controller,engine,provider,runs,calls,timers,dir,advance:ms=>{clock+=ms;},fire:async()=>{assert.equal(timers.size,1);const [id,timer]=[...timers][0];timers.delete(id);clock+=timer.delay;timer.callback();await controller.queue;},clock:()=>clock};
}

test('默认停用，三个内部任务资料符合现有验证且不包含虚构公司事实',async t=>{
  const {controller,calls,timers}=await harness(t);const status=await controller.publicStatus();
  assert.equal(status.enabled,false);assert.equal(status.status,'disabled');assert.equal(status.nextRunAt,null);assert.equal(timers.size,0);assert.equal(calls.length,0);
  assert.equal(status.companyName,COMPANY_NAME);assert.deepEqual(status.scenarioIds,['database','delivery','procurement']);
  for(const id of status.scenarioIds){const task=companyTaskInput(id,status.companyProfile);assert.equal(task.available,true);OfficeEngine.prototype.validateInput.call({},getScenario(id),task.input);assert.match(task.input.requirements,/草案/);assert.equal(task.input.example,undefined);assert.equal(task.input.databaseTestMode,id==='database'?'contract-only':undefined);}
  assert.equal('taskInputs' in status,false);
});

test('真实员工提供的数据库任务不会被默认模板添加合同范围限制',()=>{
 const supplied={requirements:'用户自定义业务数据库',databaseChecks:[{name:'用户合同',sql:'SELECT 1;'}]};
 const task=companyTaskInput('database',{name:COMPANY_NAME,verifiedFacts:[]},{database:supplied});
 assert.equal(task.available,true);assert.equal(task.input.databaseTestMode,undefined);assert.deepEqual(task.input,supplied);
});

test('随机3至5分钟派发，带来源元数据并保存受限权限配置',async t=>{
  const {controller,calls,timers,fire,dir}=await harness(t);let status=await controller.start();
  assert.equal([...timers.values()][0].delay,180000);assert.equal(status.status,'scheduled');
  await fire();assert.equal(calls.length,1);assert.equal(calls[0].scenarioId,'database');assert.equal(calls[0].source,'automation');assert.equal(calls[0].automation.companyName,COMPANY_NAME);assert.equal(calls[0].automation.templateId,'procurement-registry-prototype');
  status=await controller.publicStatus();assert.equal(status.lastRunId,'run-1');assert.equal(status.status,'running');assert.equal(status.history.length,1);
  const saved=JSON.parse(await readFile(join(dir,'automation.json'),'utf8'));assert.equal(saved.enabled,true);assert.equal(saved.lastRunId,'run-1');assert.equal((await stat(join(dir,'automation.json'))).mode&0o777,0o600);
});

test('调度器尊重正在执行的手工任务和人工审批，不审批也不重叠',async t=>{
  const {controller,runs,calls,fire,timers}=await harness(t);runs.push({id:'manual-task',scenarioId:'ddos',title:'真人派发',status:'awaiting_approval',createdAt:'2026-10-19T02:00:00Z'});
  await controller.start();await fire();assert.equal(calls.length,0);assert.equal([...timers.values()][0].delay,60000);
  let status=await controller.publicStatus();assert.equal(status.status,'awaiting_approval');assert.equal(status.activeRun.id,'manual-task');assert.match(status.pauseReason,/真实员工审批/);
  const result=await controller.dispatchNow();assert.equal(result.skipped,true);assert.equal(result.activeRunId,'manual-task');assert.equal(calls.length,0);
  runs[0].status='running';status=await controller.publicStatus();assert.equal(status.status,'waiting_task');
  runs[0].status='completed';await fire();assert.equal(calls.length,1);
});

test('模型未连接时退避，恢复后自动派发且不制造失败任务',async t=>{
  const {controller,provider,calls,fire,timers}=await harness(t);provider.ready=false;await controller.start();await fire();
  assert.equal(calls.length,0);assert.equal((await controller.publicStatus()).status,'waiting_model');assert.equal([...timers.values()][0].delay,60000);
  provider.ready=true;await fire();assert.equal(calls.length,1);
});

test('模型状态探测异常作为未连接处理，状态接口仍可读取',async t=>{
  const {controller,calls,fire,timers}=await harness(t,{providerStatus:async()=>{throw new Error('connection unavailable');}});await controller.start();await fire();
  assert.equal(calls.length,0);assert.equal((await controller.publicStatus()).status,'waiting_model');assert.equal([...timers.values()][0].delay,60000);
});

test('停用阻止之后定时派发，明确的单次派发仍可运行且不启用计划',async t=>{
  const {controller,calls,timers}=await harness(t);await controller.start();const stale=[...timers.values()][0].callback;await controller.stop();assert.equal(timers.size,0);
  stale();await controller.queue;assert.equal(calls.length,0);
  const result=await controller.dispatchNow();assert.equal(result.run.id,'run-1');assert.equal(result.automation.enabled,false);assert.equal(result.automation.nextRunAt,null);assert.equal(timers.size,0);
});

test('模型状态检查期间关闭计划会使尚未提交的派发失效',async t=>{
  const wait=deferred(),started=deferred();let pause=false;
  const {controller,calls}=await harness(t,{providerStatus:async()=>{if(pause){started.resolve();await wait.promise;}return {ready:true};}});
  await controller.start();pause=true;const dispatch=controller.dispatchNow();await started.promise;const stopped=controller.stop();wait.resolve();
  const result=await dispatch;await stopped;assert.equal(result.skipped,true);assert.equal(calls.length,0);assert.equal((await controller.publicStatus()).enabled,false);
});

test('财务、入职、投资及网络日志缺失时不可自动运行，不回退示例',async t=>{
  const {controller,calls}=await harness(t);await controller.update({scenarioIds:['finance','onboarding','investment','ddos']});await controller.start();
  const result=await controller.dispatchNow();assert.equal(result.skipped,true);assert.match(result.reason,/缺少真实任务资料/);assert.equal(calls.length,0);
  for(const id of ['finance','onboarding','investment','ddos'])assert.equal(result.automation.scenarioAvailability.find(s=>s.id===id).available,false);
  await controller.update({taskInputs:{onboarding:{example:true,employeeName:'虚构'}}});assert.equal((await controller.publicStatus()).scenarioAvailability.find(s=>s.id==='onboarding').available,false);
});

test('员工真实资料可本地配置，但公开状态与历史不披露资料',async t=>{
  const {controller,calls}=await harness(t);const privateInput={employeeNumber:'PRIVATE-NO-17',employeeName:'PRIVATE-NAME',department:'研发部',position:'工程师',startDate:'2026-10-20',workEmail:'private@example.test',employmentConfirmed:true};
  await controller.update({scenarioIds:['onboarding'],taskInputs:{onboarding:privateInput}});
  const result=await controller.dispatchNow();assert.equal(result.run.scenarioId,'onboarding');assert.deepEqual(calls[0].input,privateInput);
  assert.equal(JSON.stringify(result.automation).includes('PRIVATE-NAME'),false);assert.equal(JSON.stringify(result.automation).includes('private@example.test'),false);assert.equal(JSON.stringify(result.automation).includes('PRIVATE-NO'),false);
});

test('配置拒绝无效间隔与场景且保持既有状态',async t=>{
  const {controller}=await harness(t);
  for(const patch of [{minIntervalMinutes:0},{maxIntervalMinutes:61},{minIntervalMinutes:2.5},{minIntervalMinutes:6,maxIntervalMinutes:5},{scenarioIds:[]},{scenarioIds:['unknown']},{enabled:'yes'},{unknown:true}])await assert.rejects(controller.update(patch),error=>error.status===400);
  assert.equal((await controller.publicStatus()).enabled,false);assert.deepEqual((await controller.publicStatus()).scenarioIds,['database','delivery','procurement']);
});

test('与手工派发竞争产生409时仅退避，不重试连发或自动取消任务',async t=>{
  const {controller,engine,calls,timers}=await harness(t);engine.create=async args=>{calls.push(args);throw Object.assign(new Error('已有任务正在执行。'),{status:409});};await controller.start();
  const result=await controller.dispatchNow();assert.equal(result.skipped,true);assert.equal(calls.length,1);assert.equal(result.automation.lastError,null);assert.equal([...timers.values()][0].delay,60000);
});

test('失败后保留错误和一分钟退避，下次成功清除错误',async t=>{
  const {controller,engine,calls,fire,timers}=await harness(t);const create=engine.create;let fail=true;engine.create=async args=>{if(fail)throw new Error('测试模型连接失败');return create(args);};await controller.start();await fire();
  assert.equal(calls.length,0);assert.equal([...timers.values()][0].delay,60000);assert.equal((await controller.publicStatus()).status,'error');
  fail=false;await fire();assert.equal(calls.length,1);assert.equal((await controller.publicStatus()).lastError,null);
});

test('调度回执写入失败会停止后续派发并保留实际任务，不静默丢失计时器',async t=>{
  const {controller,calls,dir,fire,timers}=await harness(t);await controller.start();const stateFile=join(dir,'automation.json');await rm(stateFile);await mkdir(stateFile);
  await fire();const status=await controller.publicStatus();assert.equal(calls.length,1);assert.equal(status.lastRunId,'run-1');assert.equal(status.enabled,false);assert.equal(status.status,'error');assert.match(status.pauseReason,/保存失败/);assert.equal(timers.size,0);
});

test('关闭计划时配置写盘失败仍在内存停用，旧计时器不会重新派发',async t=>{
  const {controller,calls,dir,timers}=await harness(t);await controller.start();const stale=[...timers.values()][0].callback;
  const stateFile=join(dir,'automation.json');await rm(stateFile);await mkdir(stateFile);
  await assert.rejects(controller.stop());const status=await controller.publicStatus();assert.equal(status.enabled,false);assert.equal(status.nextRunAt,null);assert.equal(status.status,'error');assert.match(status.lastError,/配置保存失败/);assert.equal(timers.size,0);
  stale();await controller.queue;assert.equal(calls.length,0);
});

test('运行计划修改参数写盘失败同样停用，不保留过期计时器',async t=>{
  const {controller,dir,timers}=await harness(t);await controller.start();const stateFile=join(dir,'automation.json');await rm(stateFile);await mkdir(stateFile);
  await assert.rejects(controller.update({minIntervalMinutes:4,maxIntervalMinutes:6}));const status=await controller.publicStatus();assert.equal(status.enabled,false);assert.equal(status.nextRunAt,null);assert.equal(status.minIntervalMinutes,3);assert.equal(status.maxIntervalMinutes,5);assert.equal(timers.size,0);
});

test('重启从当前时间重新计时，保留历史且不补跑错过的周期',async t=>{
  const {controller,engine,dir,advance,calls,clock}=await harness(t);await controller.start();await controller.dispatchNow();await controller.shutdown();engine.list=async()=>[];advance(24*60*60000);
  const timers=new Map();const restarted=new AutomationController({engine,stateFile:join(dir,'automation.json'),providerStatus:async()=>({ready:true}),now:clock,random:()=>0.999999,setTimer:(callback,delay)=>{timers.set(1,{callback,delay});return 1;},clearTimer:id=>timers.delete(id)});t.after(()=>restarted.shutdown());await restarted.ready;
  const status=await restarted.publicStatus();assert.equal(status.enabled,true);assert.equal(status.history.length,1);assert.equal(calls.length,1);assert.equal([...timers.values()][0].delay,300000);assert.equal(Date.parse(status.nextRunAt)-clock(),300000);
});

test('模板不修改公司资料或用户输入，公开来源按配置读取',async t=>{
  const {dir}=await harness(t);const file=join(dir,'company.json');const profile={name:COMPANY_NAME,source:'user-provided-and-public',verifiedFacts:[{fact:'公司名称',value:COMPANY_NAME,source:'用户提供'}],sources:[{url:'https://example.test/company',title:'测试资料',verified:false}],updatedAt:'2026-10-19'};await writeFile(file,JSON.stringify(profile));
  const loaded=await loadCompanyProfile(file);assert.deepEqual(loaded,profile);const before=JSON.stringify(loaded);companyTaskInput('database',loaded);assert.equal(JSON.stringify(loaded),before);
});
