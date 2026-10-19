import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SCENARIOS, getScenario } from './catalog.mjs';
import { loadCompanyProfile, companyTaskInput } from './company.mjs';

const ACTIVE=new Set(['queued','running','awaiting_approval']);
const DEFAULTS={version:1,enabled:false,minIntervalMinutes:3,maxIntervalMinutes:5,scenarioIds:['database','delivery','procurement'],taskInputs:{},nextRunAt:null,lastRunId:null,lastDispatchedAt:null,lastError:null,history:[]};
const apiError=message=>Object.assign(new Error(message),{status:400});
const runSummary=run=>run?{id:run.id,title:run.title,status:run.status,scenarioId:run.scenarioId,createdAt:run.createdAt}:null;
const safeError=error=>String(error?.message||error||'自动派工失败。').replace(/\b(?:sk-|Bearer\s+)\S+/gi,'[redacted]').slice(0,500);

export class AutomationController {
  constructor({engine,providerStatus=async()=>({ready:false}),stateFile=resolve('.office-data/automation.json'),companyFile,now=Date.now,random=Math.random,setTimer=setTimeout,clearTimer=clearTimeout}={}){
    if(!engine?.create||!engine?.list)throw new TypeError('AutomationController requires an office engine.');
    Object.assign(this,{engine,providerStatus,stateFile:resolve(stateFile),companyFile,now,random,setTimer,clearTimer});
    this.state=structuredClone(DEFAULTS);this.timer=null;this.generation=0;this.closed=false;this.dispatching=false;this.queue=Promise.resolve();this.ready=this.load();
  }
  async load(){
    let saved;
    try{saved=JSON.parse(await readFile(this.stateFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw new Error('自动派工配置无法读取，请检查配置文件。');}
    if(saved){this.validatePatch(saved,true);this.state={...structuredClone(DEFAULTS),...saved,history:Array.isArray(saved.history)?saved.history.slice(-30):[]};}
    // A restart establishes a fresh interval; missed intervals are never replayed.
    this.state.nextRunAt=this.state.enabled?this.nextTime():null;
    if(this.state.enabled){await this.persist();this.arm();}
  }
  serial(action){const pending=this.queue.then(action);this.queue=pending.catch(()=>{});return pending;}
  validatePatch(value,loading=false){
    if(!value||typeof value!=='object'||Array.isArray(value))throw apiError('自动派工配置格式无效。');
    const allowed=new Set(['enabled','minIntervalMinutes','maxIntervalMinutes','scenarioIds','taskInputs']);
    if(!loading&&Object.keys(value).some(key=>!allowed.has(key)))throw apiError('自动派工配置包含未知字段。');
    if(value.enabled!==undefined&&typeof value.enabled!=='boolean')throw apiError('自动派工开关需要布尔值。');
    for(const key of ['minIntervalMinutes','maxIntervalMinutes'])if(value[key]!==undefined&&(!Number.isInteger(value[key])||value[key]<1||value[key]>60))throw apiError('随机间隔需要1到60之间的整数分钟。');
    const min=value.minIntervalMinutes??this.state.minIntervalMinutes,max=value.maxIntervalMinutes??this.state.maxIntervalMinutes;
    if(min>max)throw apiError('最短间隔不能大于最长间隔。');
    if(value.scenarioIds!==undefined&&(!Array.isArray(value.scenarioIds)||!value.scenarioIds.length||value.scenarioIds.length>SCENARIOS.length||value.scenarioIds.some(id=>typeof id!=='string'||!getScenario(id))))throw apiError('请选择至少一个有效任务场景。');
    if(value.taskInputs!==undefined){
      if(!value.taskInputs||typeof value.taskInputs!=='object'||Array.isArray(value.taskInputs)||Object.keys(value.taskInputs).some(id=>!getScenario(id))||JSON.stringify(value.taskInputs).length>8_000_000)throw apiError('任务资料配置无效或过大。');
    }
  }
  nextTime(delay){const minutes=this.state.minIntervalMinutes+Math.floor(Math.max(0,Math.min(0.999999999,this.random()))*(this.state.maxIntervalMinutes-this.state.minIntervalMinutes+1));return new Date(this.now()+(delay??minutes*60000)).toISOString();}
  async persist(state=this.state){
    await mkdir(dirname(this.stateFile),{recursive:true,mode:0o700});const temporary=this.stateFile+'.'+randomUUID()+'.tmp';
    try{await writeFile(temporary,JSON.stringify(state,null,2),{mode:0o600});await rename(temporary,this.stateFile);}finally{await rm(temporary,{force:true}).catch(()=>{});}
  }
  clear(){if(this.timer!==null){this.clearTimer(this.timer);this.timer=null;}}
  arm(){
    this.clear();if(this.closed||!this.state.enabled||!this.state.nextRunAt)return;
    const token=this.generation,delay=Math.max(1,Date.parse(this.state.nextRunAt)-this.now());
    this.timer=this.setTimer(()=>{this.timer=null;this.serial(()=>this.attempt({scheduled:true,token})).catch(()=>{});},delay);this.timer?.unref?.();
  }
  async environment(){
    await this.engine.ready;const runs=await this.engine.list();const active=runs.find(run=>ACTIVE.has(run.status));
    const companyProfile=await loadCompanyProfile(this.companyFile);
    const scenarios=SCENARIOS.map(s=>{const result=companyTaskInput(s.id,companyProfile,this.state.taskInputs);if(result.available){try{this.engine.validateInput?.(s,result.input);}catch(error){return {id:s.id,available:false,reason:safeError(error)};}}return {id:s.id,available:result.available,reason:result.reason||'',inputBasis:result.inputBasis||''};});
    let provider;
    try{provider=await this.providerStatus();}catch(error){provider={ready:false,message:safeError(error)};}
    return {runs,active,companyProfile,scenarios,provider};
  }
  async publicStatus(){
    await this.ready;const env=await this.environment();let status='scheduled',pauseReason='';
    if(!this.state.enabled){status=this.state.lastError?'error':'disabled';pauseReason=this.state.lastError||'';}
    else if(this.dispatching)status='dispatching';
    else if(env.active){status=env.active.status==='awaiting_approval'?'awaiting_approval':env.active.id===this.state.lastRunId?'running':'waiting_task';pauseReason=env.active.status==='awaiting_approval'?'等待真实员工审批，暂停派发新任务。':'已有任务执行中，完成后再派发。';}
    else if(!env.provider.ready){status='waiting_model';pauseReason='模型尚未连接，恢复后再派发。';}
    else if(!env.scenarios.some(s=>this.state.scenarioIds.includes(s.id)&&s.available)){status='waiting_task';pauseReason='所选场景缺少真实任务资料。';}
    else if(this.state.lastError){status='error';pauseReason=this.state.lastError;}
    const {taskInputs,version,...visible}=this.state;
    return {...visible,status,pauseReason,companyName:env.companyProfile.name,companyProfile:env.companyProfile,scenarioAvailability:env.scenarios,activeRun:runSummary(env.active),lastRun:runSummary(env.runs.find(run=>run.id===this.state.lastRunId)),updatedAt:new Date(this.now()).toISOString()};
  }
  async update(patch){
    this.validatePatch(patch);if(patch.enabled===false){this.generation++;this.clear();}
    return this.serial(async()=>{
      await this.ready;if(this.closed)throw apiError('自动派工已停止。');this.validatePatch(patch);
      const next={...this.state,...structuredClone(patch),scenarioIds:[...new Set(patch.scenarioIds??this.state.scenarioIds)],lastError:null};
      const previous=this.state;this.state=next;this.state.nextRunAt=this.state.enabled?this.nextTime():null;
      try{await this.persist();}catch(error){
        // stop() invalidates the outstanding timer before it waits for disk I/O.
        // Restoring an enabled snapshot here would advertise a live plan with no
        // timer. Fail closed for every configuration write failure instead.
        this.state={...previous,enabled:false,nextRunAt:null,lastError:'自动派工配置保存失败，已停止后续派发：'+safeError(error)};
        this.generation++;this.clear();throw error;
      }
      this.generation++;this.arm();return this.publicStatus();
    });
  }
  start(){return this.update({enabled:true});}
  stop(){return this.update({enabled:false});}
  dispatchNow(){const token=this.generation;return this.serial(async()=>{await this.ready;return this.attempt({scheduled:false,token});});}
  async attempt({scheduled,token}){
    if(this.closed||token!==this.generation||(scheduled&&!this.state.enabled))return {automation:await this.publicStatus(),run:null,skipped:true,reason:'自动派工已停止或计划已更新。'};
    this.dispatching=true;let run=null,reason='',activeRunId;
    try{
      const env=await this.environment();
      if(env.active){activeRunId=env.active.id;reason=env.active.status==='awaiting_approval'?'等待真实员工审批，未派发新任务。':'已有任务执行中，未派发新任务。';}
      else if(!env.provider.ready)reason='模型尚未连接，未派发任务。';
      else{
        const available=this.state.scenarioIds.map(id=>env.scenarios.find(s=>s.id===id)).filter(s=>s?.available);
        if(!available.length)reason='所选场景缺少真实任务资料，未使用示例代替。';
        else{
          const selected=available[Math.floor(Math.max(0,Math.min(0.999999999,this.random()))*available.length)];
          const task=companyTaskInput(selected.id,env.companyProfile,this.state.taskInputs);
          if(this.closed||token!==this.generation||(scheduled&&!this.state.enabled))reason='自动派工已停止或计划已更新。';
          else{
            const dispatchedAt=new Date(this.now()).toISOString();
            run=await this.engine.create({scenarioId:selected.id,input:task.input,source:'automation',automation:{companyName:env.companyProfile.name,templateId:task.templateId,inputBasis:task.inputBasis,dispatchedAt}});
            this.state.lastRunId=run.id;this.state.lastDispatchedAt=dispatchedAt;this.state.lastError=null;
            this.state.history=[...this.state.history,{runId:run.id,scenarioId:run.scenarioId,title:run.title,dispatchedAt}].slice(-30);
          }
        }
      }
    }catch(error){
      reason=safeError(error);if(error.status!==409)this.state.lastError=reason;
    }finally{
      this.dispatching=false;
      try{
        if(!this.closed&&this.state.enabled&&token===this.generation){this.state.nextRunAt=this.nextTime(reason?60000:undefined);await this.persist();this.arm();}
        else if(run)await this.persist();
      }catch(error){
        // A created run remains owned by the engine. Stop future dispatches when
        // its schedule receipt cannot be saved, rather than silently losing a timer.
        this.state.enabled=false;this.state.nextRunAt=null;this.state.lastError='自动派工记录保存失败，已停止后续派发：'+safeError(error);this.generation++;this.clear();
      }
    }
    return {automation:await this.publicStatus(),run,skipped:!run,...(reason?{reason}:{}),...(activeRunId?{activeRunId}:{})};
  }
  async shutdown(){this.closed=true;this.generation++;this.clear();await this.ready;await this.queue;}
}
