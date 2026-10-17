import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const pythonFile=fileURLToPath(new URL('../tools/onboarding_registry.py',import.meta.url));
const empty={type:'object',properties:{},additionalProperties:false};
export const ONBOARDING_TOOL_DEFINITIONS=[
 ['prepare_onboarding','读取已录用员工的原始登记表，在本地冻结资料并检查基础格式。模型不可填写或改写员工姓名、工号、邮箱等原始字段；返回不含个人资料。'],
 ['review_onboarding','独立核验已冻结资料的完整性、日期格式、录用确认及本地登记册的工号/邮箱重复情况。不会写入主册；格式校验不等于身份真实性核验。'],
 ['plan_onboarding_resources','从原始资源申请逐行生成设备、账号、权限等待办，固定为待人工处理。没有申请则保留待负责人确认，不创建任何外部账号或领取设备。'],
 ['request_onboarding_approval','向真实人事负责人展示原始员工资料、登记校验及待办清单，请求确认本地行政登记。AI不能代批，也不能作录用决定。'],
 ['register_onboarding','仅在真人批准、资料校验完成和原始录用确认均有效时，原子复查唯一性并写入本地SQLite员工册。重复同资料幂等，冲突不覆盖；拒绝时仅生成未登记回执。'],
].map(([name,description])=>({name,description,parameters:empty}));

const csvCell=value=>{let s=String(value??'');if(/^[\s]*[=+\-@]|^[\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
const csv=rows=>'\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields={employeeNumber:'工号',employeeName:'员工姓名',department:'部门',position:'岗位',startDate:'入职日期',workEmail:'工作邮箱',manager:'直属负责人',resourceRequirements:'资源申请'};
const limits={employeeNumber:40,employeeName:80,department:80,position:80,startDate:10,workEmail:254,manager:80,resourceRequirements:3000};
function validate(input){
 const record={};
 for(const [key,label]of Object.entries(fields)){
  const value=input[key];if(value!==undefined&&value!==null&&typeof value!=='string')throw new Error(label+'必须为文本');
  const s=String(value??'').trim();if(s.length>limits[key])throw new Error(label+'超过'+limits[key]+'字符上限');
  if((key!=='resourceRequirements'&&/[\x00-\x1f\x7f]/.test(s))||(key==='resourceRequirements'&&/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)))throw new Error(label+'含不支持的控制字符');
  record[key]=s;
 }
 for(const key of ['employeeNumber','employeeName','department','position','startDate'])if(!record[key])throw new Error(fields[key]+'为必填项，请由真实员工补充原始资料');
 if(!/^[A-Za-z0-9_-]+$/.test(record.employeeNumber))throw new Error('工号仅支持英文字母、数字、下划线和短横线');
 const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(record.startDate);
 if(!match||Number(match[1])<1)throw new Error('入职日期须为有效YYYY-MM-DD日期');
 const date=new Date(record.startDate+'T00:00:00Z');if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==record.startDate)throw new Error('入职日期须为有效YYYY-MM-DD日期');
 if(record.workEmail&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.workEmail))throw new Error('工作邮箱格式无效');
 record.workEmail=record.workEmail.toLowerCase();
 if(input.employmentConfirmed!==true)throw new Error('请由真实员工明确勾选“已完成录用决定”，本流程只做行政登记');
 record.employmentConfirmed=true;
 return record;
}

/** Personal input stays in local files and the browser approval payload. Tool evidence is deliberately aggregate-only. */
export function createOnboardingFunctions({input,runDir,put,outputs={},approval,signal}){
 let snapshot=null,snapshotHash=null,review=null,plan=null,decision=null,registration=null;
 let employeeRef='EMP-'+crypto.randomUUID();
 const isExample=input.example===true||input.isExample===true;
 const registryPath=path.join(path.dirname(path.resolve(runDir)),'hr',isExample?'example-registry.sqlite':'employee-registry.sqlite');
 const active=()=>{if(signal?.aborted)throw new Error('任务已取消，未继续入职登记');};
 const frozen=()=>{active();if(!snapshot)throw new Error('请先冻结已录用员工的原始登记资料');if(hash(validate(input))!==snapshotHash)throw new Error('登记原始资料已变化，请重新发起流程；不会使用过期审批登记');return snapshot;};
 const evidence=extra=>({employeeRef,isExample,...extra});
 const registry=(operation,record)=>new Promise((resolve,reject)=>{
  active();let stdout='',stderr='',done=false,aborted=false;
  const child=spawn(process.env.OFFICE_PYTHON||'/usr/bin/python3',[pythonFile],{stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  const abort=()=>{aborted=true;child.kill('SIGTERM');};
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new Error('员工登记工具超时，请先查阅本地回执再重试'));},15000);
  signal?.addEventListener('abort',abort,{once:true});
  child.stdout.on('data',chunk=>{stdout+=chunk.toString();if(stdout.length>300000){child.kill('SIGKILL');finish(new Error('员工登记工具输出超过上限'));}});
  child.stderr.on('data',chunk=>stderr=(stderr+chunk.toString()).slice(-1000));
  child.on('error',()=>finish(new Error('本地员工登记Python工具启动失败')));
  child.on('close',()=>{if(done)return;try{const response=JSON.parse(stdout);if(!response.ok)finish(new Error(response.error||'员工登记失败'));else finish(null,response.result);}catch{finish(new Error(aborted?'任务已取消，登记事务已中止；可在重试时核对幂等回执':'员工登记工具返回无效结果'));}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({operation,registryPath,record,payloadHash:snapshotHash,employeeRef,isExample}));
 });
 const ensureReviewed=()=>{frozen();if(!review||!review.passed)throw new Error('登记校验尚未通过，不能请求审批或登记');if(!plan)throw new Error('尚未完成资源待办整理');};
 const functions={
  async prepare_onboarding(){
   active();if(snapshot)frozen();else{snapshot=validate(input);snapshotHash=hash(snapshot);}
   const material={employeeRef,isExample,record:snapshot,source:'真实员工提交的已录用员工行政资料；字段未由模型补全',frozenAt:new Date().toISOString(),payloadHash:snapshotHash};
   await put('onboarding/employee-material.json',material);
   return {summary:'已在本地冻结员工行政资料；个人字段未提供给模型',evidence:evidence({prepared:true,employmentConfirmed:true,requiredFieldsComplete:true,resourceRequestsProvided:!!snapshot.resourceRequirements,personalDataSharedWithModel:false}),files:['onboarding/employee-material.json']};
  },
  async review_onboarding(){
   const record=frozen();const duplicate=await registry('check',record);active();
   const checks=[{name:'必填行政字段完整',passed:true},{name:'工号、日期和邮箱格式',passed:true},{name:'真实员工已确认录用决定完成',passed:true},{name:'本地工号与邮箱唯一性预检',passed:duplicate.status!=='conflict',status:duplicate.status}];
   review={employeeRef,isExample,passed:checks.every(c=>c.passed),checks,duplicateStatus:duplicate.status,checkedAt:new Date().toISOString(),identityVerified:false,limitations:['仅校验资料格式与本地重复情况，未核验身份证明或录用决定真实性。','登记时会在事务内再次核对唯一性，预检不会写入员工册。']};
   await put('onboarding/registration-review.json',review);
   return {summary:review.passed?'行政资料校验与本地重复预检通过，仍需真人审批':'本地登记存在工号或邮箱冲突，未写入员工册',evidence:evidence({passed:review.passed,checks,duplicateStatus:duplicate.status,identityVerified:false,registryWritten:false}),files:['onboarding/registration-review.json']};
  },
  async plan_onboarding_resources(){
   const record=frozen();const requests=record.resourceRequirements.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
   if(requests.length>60)throw new Error('资源申请最多60行，请合并重复待办');
   const items=requests.map((request,index)=>{
    const category=/权限|授权|门禁|access/i.test(request)?'access':/账号|帐号|邮箱|账户|account|email/i.test(request)?'account':/电脑|笔记本|显示器|设备|键盘|鼠标|工位|equipment|laptop/i.test(request)?'equipment':'other';
    const owner=category==='other'?'人事负责人':'IT负责人';
    const verification={equipment:'设备序列号与领用交付确认',account:'按公司流程开通后由本人确认可登录',access:'核对岗位所需最小权限范围并由负责人确认',other:'按原始申请逐项确认交付结果'}[category];
    return {id:'R'+(index+1),request,category,status:'pending_manual',suggestedOwner:owner+'（建议岗位，待公司确认）',verification,action:'待真实员工按公司流程分配、执行并验证',externalActionExecuted:false};
   });
   plan={employeeRef,isExample,items,requestCount:items.length,unprovidedRequirements:!items.length,status:'pending_manual',externalActionExecuted:false,limitation:items.length?'仅登记原始资源请求，尚未采购、分配设备或开通任何账号。':'未提供资源申请，待真实负责人确认；不默认全部办妥。'};
   await put('onboarding/resource-requests.json',plan);
   await put('onboarding/resource-requests.csv',csv([['待办编号','原始申请','类别','状态','建议负责人（待公司确认）','验收项','后续动作'],...items.map(item=>[item.id,item.request,item.category,'待人工处理',item.suggestedOwner,item.verification,item.action])]));
   return {summary:'整理'+items.length+'项资源申请，全部待人工处理；没有执行外部开通或分配',evidence:evidence({requestCount:items.length,unprovidedRequirements:!items.length,status:'pending_manual',externalActionExecuted:false}),files:['onboarding/resource-requests.json','onboarding/resource-requests.csv']};
  },
  async request_onboarding_approval(){
   ensureReviewed();if(decision){await put('onboarding/human-decision.json',decision);return {summary:decision.approved?'真实人事负责人已批准本地行政登记':'真实人事负责人未批准登记，流程保留未登记结果',evidence:evidence({approved:decision.approved,status:decision.approved?'approved':'rejected',registryWritten:false}),files:['onboarding/human-decision.json']};}
   if(typeof approval!=='function')throw new Error('没有可用的真实员工审批入口');
   const answer=await approval({kind:'onboarding',agentId:'hr',targetHumanId:'hr_owner',title:'请人事负责人确认入职行政登记',description:'请核对本机保存的员工资料。批准仅允许写入本地员工登记册；资源请求仍待处理。',details:{summary:'已录用员工资料校验通过，待人事负责人确认本地登记。',employeeRecord:{...snapshot},checks:review.checks,resourcePlan:plan.items,environment:'仅写入本地员工登记册，不作录用决定、不签合同、不创建外部账号、不发薪。',isExample}});
   active();frozen();if(answer?.targetHumanId&&answer.targetHumanId!=='hr_owner')throw new Error('审批处理人与人事负责人不符，未写入员工册');decision={employeeRef,isExample,approved:answer?.approved===true,note:String(answer?.note||''),approvalId:answer?.approvalId||null,recordedAt:new Date().toISOString(),authorization:'仅本地行政登记，不作录用或资源开通授权'};
   await put('onboarding/human-decision.json',decision);
   return {summary:decision.approved?'真实人事负责人已批准本地行政登记':'真实人事负责人未批准登记，未写入员工册',evidence:evidence({approved:decision.approved,status:decision.approved?'approved':'rejected',registryWritten:false,personalDataSharedWithModel:false}),files:['onboarding/human-decision.json']};
  },
  async register_onboarding(){
   ensureReviewed();if(!decision)throw new Error('必须先取得真实人事负责人的审批，未写入员工册');
   if(registration)return {summary:registration.registered?'本地员工登记已完成，重复调用返回同一回执':'本次未获批准，员工未登记',evidence:registration,files:['onboarding/registration-receipt.json','onboarding/onboarding-checklist.csv','onboarding/employee-registration.json','onboarding/employee-registration.csv','onboarding/employee-registration.html']};
   let stored=null;if(decision.approved){stored=await registry('register',snapshot);employeeRef=stored.employeeRef;}
   // Finish writing an actual commit receipt even if cancellation arrives just after SQLite committed.
   const registered=!!stored;const completed=evidence({registered,status:registered?'registered':'not_registered',registryWritten:registered,idempotent:stored?.status==='existing_identical',resourceRequestCount:plan.items.length,resourceStatus:'pending_manual',externalAccountsCreated:false,equipmentAssigned:false,employmentDecisionMade:false,personalDataSharedWithModel:false});
   const createdAt=stored?.createdAt||null;
   const receipt={...completed,receiptId:stored?.receiptId||crypto.randomUUID(),recordedAt:new Date().toISOString(),createdAt,authorization:decision.approved?'人事负责人批准本地行政登记':'未获批准，未写入员工册',isExample};
   const localRecord={...receipt,record:snapshot};
   const checklist=[['项目','状态','说明'],['已录用确认','已由提交者确认','本流程不决定是否录用'],['行政字段与本地重复校验','已完成','身份及外部材料尚未核验'],['真实人事负责人审批',decision.approved?'批准':'未批准','审批备注保存在本地审批记录'],['本地员工登记',registered?'已登记':'未登记',stored?.status==='existing_identical'?'同资料重复请求返回已有登记':registered?'已原子写入本地SQLite员工册':'未写入员工册'],['设备、账号和权限',plan.items.length?'待人工处理':'待负责人确认','没有执行外部账号开通、设备分配或合同签署'],...plan.items.map(item=>[item.id+' '+item.request,'待人工处理',item.suggestedOwner+'；验收：'+item.verification])];
   await put('onboarding/registration-receipt.json',receipt);await put('onboarding/employee-registration.json',localRecord);
   await put('onboarding/employee-registration.csv',csv([['登记状态',...Object.values(fields),'录用已确认','示例资料'],[registered?'已登记':'未登记',...Object.keys(fields).map(key=>snapshot[key]),'是',isExample?'是':'否']]));
   await put('onboarding/onboarding-checklist.csv',csv(checklist));
   await put('onboarding/employee-registration.html','<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>员工入职行政登记回执</title><style>body{font:16px system-ui;max-width:900px;margin:40px auto;padding:20px;color:#233e3c}td,th{border:1px solid #ccd5cd;padding:10px;text-align:left}table{border-collapse:collapse;width:100%}p{line-height:1.8}pre{white-space:pre-wrap}</style><h1>员工入职行政登记回执</h1><p>'+escape(isExample?'明确标记的示例登记 · 与真实员工册隔离':'本地行政登记资料')+' · '+escape(registered?'已登记':'未登记')+'</p><table>'+Object.entries(fields).map(([key,label])=>'<tr><th>'+escape(label)+'</th><td>'+escape(snapshot[key])+'</td></tr>').join('')+'</table><h2>办理清单</h2><table>'+checklist.map((row,i)=>'<tr>'+row.map(cell=>'<'+(i?'td':'th')+'>'+escape(cell)+'</'+(i?'td':'th')+'>').join('')+'</tr>').join('')+'</table><p>此回执只证明本地行政登记状态。设备、账号、权限申请仍待真实负责人处理。本流程未作录用决定、签合同或发薪。</p></html>');
   registration=completed;
   return {summary:registered?(registration.idempotent?'同一份资料已登记，返回原有记录；资源待办仍未执行':'已批准的资料写入本地员工登记册；资源待办仍需人工处理'):'本次未获批准，已生成未登记回执，没有写入员工册',evidence:registration,files:['onboarding/registration-receipt.json','onboarding/employee-registration.json','onboarding/employee-registration.csv','onboarding/employee-registration.html','onboarding/onboarding-checklist.csv']};
  },
 };
 return functions;
}
