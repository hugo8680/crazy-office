import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { publicCatalog } from '../server/catalog.mjs';
import { HUMAN_EMPLOYEES, humanForScenario } from '../dist/people.js';

// Execute production office.js in a small DOM adapter. No browser, server or model
// is started; deferred files and event streams reproduce user interaction races.
const source=(await readFile(new URL('../dist/office.js',import.meta.url),'utf8')).replace(/^import [^\n]*\n/gm,'').replace(/\nboot\(\);\s*$/,'');
function makeElement(){const attrs=new Map(),classes=new Set();return {hidden:false,innerHTML:'',textContent:'',scrollTop:0,style:{},dataset:{},classList:{toggle(name,on){if(on)classes.add(name);else classes.delete(name);},contains:name=>classes.has(name)},setAttribute:(key,value)=>attrs.set(key,value),getAttribute:key=>attrs.get(key),querySelectorAll:()=>[],querySelector:()=>null,getBoundingClientRect:()=>({width:600,height:400,left:0,top:0}),addEventListener(){},append(){},focus(){},scrollIntoView(){},remove(){},click(){}};}
function makeRun(overrides={}){return {id:'run-a',scenarioId:'finance',title:'年度财务汇报',status:'running',createdAt:'2026-10-17T00:00:00Z',updatedAt:'2026-10-17T00:00:01Z',elapsedSeconds:1,provider:'codex',model:'real-test-model',tasks:[],agents:[],events:[],artifacts:[],nodes:{},approval:null,...overrides};}
function harness(){
 const elements=new Map(),handlers=new Map(),requests=[],streams=[],timers=new Map(),delays=new Map(),downloads=[],blobs=[];let form=null,sequence=0;
 const element=selector=>{if(selector==='#task-form')return form;if(!elements.has(selector))elements.set(selector,makeElement());return elements.get(selector);};
 const scene={updates:[],focused:[],resets:0,update(s){this.updates.push(s);},setSelectedAgent(){},setSelectedNode(){},getAgentAnchor:()=>({x:500,y:300}),getNodeAnchor:()=>({x:500,y:300}),getHumanAnchor:()=>({x:650,y:300}),focusHuman(id){this.focused.push(id);},focusAgent(){},focusNode(id){this.focused.push(id);},resetView(){this.resets++;},zoom(){},setTopology(){}};
 class Events{constructor(url){this.url=url;this.handlers={};streams.push(this);}addEventListener(type,fn){this.handlers[type]=fn;}close(){this.closed=true;}deliver(run){this.handlers.state({data:JSON.stringify({run})});}}
 class OfficeURL extends URL{static createObjectURL(blob){blobs.push(blob);return 'blob:office-test-'+blobs.length;}static revokeObjectURL(){}}
 const scope={console,HUMAN_EMPLOYEES,humanForScenario,URL:OfficeURL,Blob,TextDecoder,Uint8Array,Symbol,performance:{now:()=>100},innerWidth:1440,innerHeight:900,location:{origin:'http://192.168.1.20:4173'},localStorage:{getItem:()=>null,setItem(){}},document:{querySelector:element,createElement(tag){const el=makeElement();if(tag==='a')el.click=()=>downloads.push({url:el.href,name:el.download});return el;},body:{append(){}},addEventListener(type,fn){handlers.set(type,fn);}},window:{addEventListener(){}},mountScene:(container,callbacks)=>{scene.callbacks=callbacks;return scene;},EventSource:Events,btoa:value=>Buffer.from(value,'binary').toString('base64'),setInterval:()=>0,setTimeout(fn,delay){const id=++sequence;timers.set(id,fn);delays.set(id,delay);return id;},clearTimeout:id=>timers.delete(id),requestAnimationFrame:()=>0};
 let responder=async()=>({run:makeRun({status:'queued'})});scope.fetch=async(url,options={})=>{const request={url,method:options.method||'GET',body:options.body?JSON.parse(options.body):undefined};requests.push(request);const data=await responder(request);return {ok:true,json:async()=>data};};
 vm.createContext(scope);vm.runInContext(source,scope,{filename:'office.js'});scope.fixture=publicCatalog();vm.runInContext('catalog=fixture;health={provider:{ready:true,model:"test"}};',scope);
 return {scope,elements,handlers,requests,streams,timers,delays,scene,element,downloads,blobs,eval:code=>vm.runInContext(code,scope),setResponder(fn){responder=fn;},setForm(id,values={}){form={dataset:{scenarioId:id},elements:{namedItem:name=>Object.hasOwn(values,name)?{value:String(values[name])}:null}};return form;},async click(dataset){const button={dataset,hasAttribute:name=>name==='data-close'&&dataset.close!==undefined};return handlers.get('click')({target:{closest:()=>button}});}};
}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function seedExample(h){h.eval('drafts.finance={company:"原公司",year:2025,requirements:"原需求",data:{name:"旧示例.csv",text:"OLD"}};setInputSource("finance","example");panel={type:"task",id:"finance"};');}

test('slow real upload cannot submit stale example, and flags become user before file read finishes',async()=>{
 const h=harness(),d=deferred();seedExample(h);h.setForm('finance',{company:'真实公司',year:2025,requirements:'真实需求'});
 h.scope.file={name:'真实.csv',size:10,text:()=>d.promise};const pending=h.eval('handleUpload("finance","data",file)');
 assert.equal(h.eval('drafts.finance.data'),undefined);assert.equal(h.eval('drafts.finance.isExample'),false);assert.equal(h.eval('drafts.finance.example'),false);assert.equal(h.eval('uploadPending("finance")'),true);
 assert.match(h.eval('renderTask()'),/type="submit"[^>]*disabled/);await assert.rejects(h.eval('startTask(document.querySelector("#task-form"))'),/仍在读取/);assert.equal(h.requests.length,0);
 d.resolve('USER DATA');await pending;assert.equal(h.eval('drafts.finance.data.text'),'USER DATA');assert.equal(h.eval('uploadPending("finance")'),false);
 await h.eval('startTask(document.querySelector("#task-form"))');const post=h.requests.find(r=>r.method==='POST');assert.equal(post.body.input.data.text,'USER DATA');assert.equal(post.body.input.company,'真实公司');assert.equal(post.body.input.isExample,false);assert.equal(post.body.input.example,false);assert.equal(post.body.input._source,'user');assert.equal(post.body.agentConfigs.length,publicCatalog().agents.length);
});

test('file read failure clears former data, unlocks upload, and never falls back to sample',async()=>{
 const h=harness();seedExample(h);h.setForm('finance',{company:'真实公司',year:2025});h.scope.file={name:'bad.csv',size:12,text:async()=>{throw new Error('磁盘读取失败');}};
 await assert.rejects(h.eval('handleUpload("finance","data",file)'),/磁盘读取失败/);assert.equal(h.eval('drafts.finance.data'),undefined);assert.equal(h.eval('drafts.finance.isExample'),false);assert.equal(h.eval('uploadPending("finance")'),false);assert.equal(h.eval('busy'),false);await assert.rejects(h.eval('startTask(document.querySelector("#task-form"))'),/财务数据/);assert.equal(h.requests.length,0);
});

test('newer file selection wins even when earlier file resolves last',async()=>{
 const h=harness(),first=deferred(),second=deferred();seedExample(h);h.scope.first={name:'first.csv',size:1,text:()=>first.promise};h.scope.second={name:'second.csv',size:1,text:()=>second.promise};
 const a=h.eval('handleUpload("finance","data",first)'),b=h.eval('handleUpload("finance","data",second)');second.resolve('SECOND');await b;first.resolve('FIRST');await a;assert.equal(h.eval('drafts.finance.data.text'),'SECOND');assert.equal(h.eval('uploadPending("finance")'),false);
});

test('scenario upload formats match actual tools; binary input is restricted to finance',async()=>{
 const h=harness();for(const [id,accept] of [['finance','.csv,.json,.xlsx'],['ddos','.json,.csv,.txt'],['database','.json,.csv'],['delivery','.txt,.json,.csv']]){h.scope.id=id;const html=h.eval('fieldMarkup({name:"data",label:"资料",type:"file",required:true},null,id)');assert.ok(html.includes(`accept="${accept}"`));}
 h.scope.xlsx={name:'data.xlsx',size:2,arrayBuffer:async()=>new Uint8Array([80,75]).buffer};await assert.rejects(h.eval('readUpload(xlsx,"delivery")'),/此任务支持/);const accepted=await h.eval('readUpload(xlsx,"finance")');assert.equal(accepted.base64,'UEs=');h.scope.large={name:'a.csv',size:9*1024*1024};await assert.rejects(h.eval('readUpload(large,"finance")'),/最大 8 MB/);
});

test('already loaded file removes native required trap, and chip cannot submit parent form',()=>{
 const h=harness();assert.match(h.eval('fieldMarkup({name:"data",label:"资料",type:"file",required:true},null,"finance")'),/name="data"\s+required/);assert.doesNotMatch(h.eval('fieldMarkup({name:"data",label:"资料",type:"file",required:true},{name:"ready.csv",text:"data"},"finance")'),/name="data"\s+required/);assert.match(h.eval('agentChip("ops")'),/type="button"/);
});

test('large human approval exposes plan, requester and real decisions without hiding them in JSON',async()=>{
 const h=harness();h.scope.next=makeRun({scenarioId:'ddos',title:'DDoS',status:'awaiting_approval',tasks:[{id:'defense',agentId:'zhang',title:'应用隔离防护',status:'running',dependencies:[]}],events:[{id:'approval-event',type:'approval',agentId:'zhang',text:'审批'}],approval:{id:'approval-1',title:'批准隔离方案',description:'应用后独立验证',details:{blockedIps:['203.0.113.10'],rateLimit:15,windowSeconds:60,reason:'高频来源，保留正常流量',environment:'仅本次隔离副本'}}});h.eval('receive(next,{initial:true})');const html=h.element('#popover-content').innerHTML;
 assert.match(html,/真人负责人/);assert.match(html,/小张/);assert.match(html,/203\.0\.113\.10/);assert.match(html,/60 秒内允许 15 次/);assert.match(html,/仅本次隔离副本/);assert.match(html,/高频来源/);assert.match(html,/data-approval="false"/);assert.match(html,/data-approval="true"/);const reviewStart=html.indexOf('<div class="approval-review"'),reviewEnd=html.indexOf('</div><label class="office-field approval-comment"',reviewStart);assert.ok(reviewStart>=0&&reviewEnd>reviewStart);assert.ok(html.indexOf('203.0.113.10')<reviewEnd);assert.ok(html.indexOf('id="approval-note"')>reviewEnd);assert.ok(html.indexOf('data-approval="true"')>reviewEnd);assert.ok(html.indexOf('data-approval="false"')>reviewEnd);assert.equal(h.element('#approval-request').hidden,false);assert.equal(h.element('#approval-backdrop').hidden,false);assert.equal(h.scene.updates.at(-1).humanApproval,true);assert.equal(h.scene.focused.at(-1),'owner');
 h.eval('closePanel()');assert.equal(h.element('#approval-backdrop').hidden,true);assert.equal(h.element('#approval-request').hidden,false);await h.click({open:'approval'});assert.equal(h.element('#approval-backdrop').hidden,false);
 h.setResponder(request=>({run:makeRun({scenarioId:'ddos',title:'DDoS',status:'running'})}));h.element('#approval-note').value='暂不执行';await h.click({approval:'false'});const sent=h.requests.find(r=>r.url.endsWith('/approval'));assert.equal(sent.body.approved,false);assert.equal(sent.body.approvalId,'approval-1');assert.equal(sent.body.note,'暂不执行');assert.equal(h.element('#approval-request').hidden,true);
});

test('approval resolved by another client cannot leave an actionable stale modal',()=>{
 const h=harness();h.scope.before=makeRun({status:'awaiting_approval',approval:{id:'approval-1',title:'审批',details:{}}});h.eval('receive(before,{initial:true})');assert.equal(h.eval('panel.type'),'approval');h.scope.after=makeRun({status:'cancelled'});h.eval('receive(after)');assert.equal(h.eval('panel.type'),'progress');assert.doesNotMatch(h.element('#popover-content').innerHTML,/data-approval=/);assert.equal(h.element('#approval-request').hidden,true);assert.equal(h.element('#approval-backdrop').hidden,true);assert.equal(h.scene.updates.at(-1).humanApproval,false);assert.ok(h.scene.resets>0);
});

test('readonly runtime employee config comes from run snapshot, future edits remain local',()=>{
 const h=harness();h.scope.snapshot=makeRun({agents:[{id:'zhang',instructions:'本次真实职责',tools:['inspect_network'],task:'本次任务'}]});h.eval('run=snapshot;configs.zhang={instructions:"下次职责",tools:["build_database"]};panel={type:"agent",id:"zhang",tab:"config"};');const active=h.eval('renderAgent()');assert.match(active,/本次真实职责/);assert.match(active,/disabled/);assert.doesNotMatch(active,/下次职责/);h.eval('panel.tab="work"');const work=h.eval('renderAgent()');assert.match(work,/skill-tag[^>]*>读取网络日志/);assert.doesNotMatch(work,/skill-tag[^>]*>真实创建 SQLite/);h.eval('run.status="completed";panel.tab="config"');assert.match(h.eval('renderAgent()'),/下次职责/);
});

test('cancel preserves delivered artifacts and retry follows backend new run without faking completion',async()=>{
 const h=harness();h.scope.active=makeRun({artifacts:[{id:'proof',name:'证据.json',url:'/api/runs/run-a/artifacts/proof',bytes:2}]});h.eval('receive(active)');h.setResponder(request=>request.url.endsWith('/cancel')?{run:makeRun({status:'cancelled',artifacts:h.scope.active.artifacts})}:{run:makeRun({id:'run-b',status:'queued'})});await h.eval('action("cancel")');assert.equal(h.eval('run.status'),'cancelled');assert.equal(h.eval('run.artifacts.length'),1);await h.eval('action("retry")');assert.equal(h.eval('run.id'),'run-b');assert.equal(h.eval('run.status'),'queued');assert.equal(h.streams.at(-1).url,'/api/runs/run-b/events');
});

test('SSE disconnect labels reconnecting; live state and reload restore backend result',async()=>{
 const h=harness();h.scope.active=makeRun();h.eval('receive(active);subscribe(run.id)');const stream=h.streams.at(-1);stream.onerror();assert.equal(h.eval('connectionState'),'reconnecting');stream.deliver(makeRun({status:'completed',artifacts:[{id:'report',name:'年度报告.html',url:'/api/runs/run-a/artifacts/report'}]}));assert.equal(h.eval('run.status'),'completed');assert.equal(stream.closed,true);assert.match(h.eval('renderArtifacts()'),/年度报告/);
 const restored=harness();restored.setResponder(request=>request.url==='/api/catalog'?publicCatalog():request.url==='/api/health'?{provider:{ready:true,model:'test'}}:{runs:[makeRun({status:'awaiting_approval',approval:{id:'restored-approval',title:'恢复审批',details:{}}})]});await restored.eval('boot()');assert.equal(restored.eval('run.approval.id'),'restored-approval');assert.equal(restored.eval('panel.type'),'approval');assert.equal(restored.streams.at(-1).url,'/api/runs/run-a/events');
});

test('LAN downloads stay same-origin, evidence escapes injection, narrow notices stay one at a time',()=>{
 const h=harness();assert.equal(h.eval('artifactUrl({url:"/api/runs/x/artifacts/y"})'),'http://192.168.1.20:4173/api/runs/x/artifacts/y');assert.equal(h.eval('artifactUrl({url:"http://other.test/file"})'),null);assert.equal(h.eval('safeUrl("javascript:alert(1)")'),null);assert.doesNotMatch(h.eval('evidenceMarkup({text:"<script>alert(1)</script>"})'),/<script>/);
 h.eval('notices.set("zhang",{agentId:"zhang",task:"A",action:"B",result:"C"});notices.set("liu",{agentId:"liu",task:"D",action:"E",result:"F"});innerWidth=375;renderNotices();');assert.equal(h.eval('notices.size'),1);assert.equal(h.eval('noticeQueue.length'),1);
});

test('investment uploads enforce distinct narrative and financial evidence limits',async()=>{
 const h=harness();assert.match(h.eval('fieldMarkup({name:"financials",label:"财务证据",type:"file"},null,"investment")'),/accept="\.json,\.csv"/);assert.match(h.eval('fieldMarkup({name:"data",label:"补充资料",type:"file"},null,"investment")'),/accept="\.txt,\.csv,\.json"/);
 h.scope.pdf={name:'pitch.pdf',size:20};await assert.rejects(h.eval('readUpload(pdf,"investment","data")'),/此任务支持/);h.scope.long={name:'brief.txt',size:25000,text:async()=>('x'.repeat(24001))};await assert.rejects(h.eval('readUpload(long,"investment","data")'),/24000/);h.scope.finance={name:'records.csv',size:25000,text:async()=>('x'.repeat(24001))};assert.equal((await h.eval('readUpload(finance,"investment","financials")')).text.length,24001);h.scope.empty={name:'empty.txt',size:0};await assert.rejects(h.eval('readUpload(empty,"investment","data")'),/文件为空/);
});

test('investment owner sees business findings and research-only choices, never DDoS controls',async()=>{
 const h=harness();if(!publicCatalog().agents.some(a=>a.id==='invest_risk'))h.eval('catalog.agents.push({id:"invest_risk",name:"何审",role:"独立风险审查",color:"#9c85a8",tools:["request_investment_review"],instructions:"审查证据"})');
 h.scope.invest=makeRun({id:'invest-run',scenarioId:'investment',title:'投前尽调',status:'awaiting_approval',tasks:[{id:'review',agentId:'invest_risk',title:'请求老板审阅',status:'running',dependencies:[]}],approval:{id:'invest-approval',kind:'investment',agentId:'invest_risk',title:'投前简报已提交',description:'请决定后续尽调方向',details:{summary:'现金流存在待核实项',keyFindings:['客户集中度较高（issuer_claim）','收入增长（source_supported）','市场空间（corroborated）','合作事实（conflict）','上市计划（unverified）'],criticalGaps:['尚缺银行流水'],environment:'仅记录研究决策，不签约投资、不打款'}}});h.eval('receive(invest,{initial:true})');const html=h.eval('renderApproval()');assert.match(html,/老板 · 真人审批人/);assert.match(html,/何审/);assert.match(html,/现金流存在待核实项/);assert.match(html,/客户集中度较高（项目方自述）/);for(const status of ['有来源支持','多来源说法','证据冲突','待核实'])assert.ok(html.includes(status));const visible=html.split('<details class="evidence"')[0];assert.doesNotMatch(visible,/issuer_claim|source_supported|corroborated|conflict|unverified/);assert.ok(html.includes('issuer_claim'));assert.match(html,/尚缺银行流水/);assert.match(html,/继续尽调/);assert.match(html,/暂缓项目/);assert.doesNotMatch(html,/限速规则|IP 封禁/);
 h.setResponder(()=>({run:makeRun({id:'invest-run',scenarioId:'investment',status:'running'})}));await h.click({approval:'true'});assert.equal(h.requests.at(-1).body.approved,true);assert.equal(h.requests.at(-1).body.approvalId,'invest-approval');
});

test('active run rejects configuration form submission even if disabled UI is bypassed',async()=>{
 const h=harness();h.scope.active=makeRun();h.eval('run=active;panel={type:"agent",id:"zhang",tab:"config"};');await h.handlers.get('submit')({target:{id:'agent-form'},preventDefault(){}});assert.equal(h.eval('configs.zhang'),undefined);assert.match(h.element('#agent-error').innerHTML,/配置已锁定/);
});

test('human approval portrait matches office illustration and has no AI badge',()=>{
 const h=harness(),avatar=h.eval('humanPortrait()');assert.match(avatar,/viewBox="0 0 120 120"/);assert.match(avatar,/真人负责人/);assert.match(avatar,/卡通人物/);assert.doesNotMatch(avatar,/AI|ai-tag|ai-badge/);
});

test('investment finance template downloads actual labelled JSON without replacing current user inputs',async()=>{
 const h=harness(),example=JSON.parse(await readFile(new URL('../data/examples/investment.json',import.meta.url),'utf8'));h.setResponder(()=>example);h.eval('drafts.investment={projectName:"真实项目",projectBrief:"真实资料",financials:{name:"自己的.csv",text:"REAL"}};setInputSource("investment","user")');const before=h.eval('JSON.stringify(drafts.investment)');await h.eval('downloadInvestmentTemplate()');assert.equal(h.eval('JSON.stringify(drafts.investment)'),before);assert.equal(h.eval('inputSource.investment'),'user');assert.equal(h.eval('drafts.investment.isExample'),false);assert.equal(h.requests.length,1);assert.equal(h.requests[0].url,'/api/examples/investment');assert.equal(h.requests[0].method,'GET');assert.match(h.downloads[0].name,/明确示例_虚构项目_财务模板\.json$/);assert.deepEqual(JSON.parse(await h.blobs[0].text()),JSON.parse(example.input.financials.text));const format=h.eval('investmentFinancialFormat()');for(const term of ['期间','营业收入','毛利','净利润','现金余额','每月净现金消耗','债务余额'])assert.ok(format.includes(term));assert.match(format,/虚构教学数据/);
});

test('investment finance template also preserves CSV source and explicit example filename',async()=>{
 const h=harness(),csv='period,revenue\r\n2025,12000\r\n';h.setResponder(()=>({input:{financials:{name:'明确示例.csv',text:csv}}}));await h.eval('downloadInvestmentTemplate()');assert.match(h.downloads[0].name,/明确示例_虚构项目_财务模板\.csv$/);assert.equal((await h.blobs[0].text()).replace(/^\uFEFF/,''),csv);assert.equal(h.blobs[0].type,'text/csv;charset=utf-8');assert.equal(h.eval('inputSource.investment'),undefined);
});

test('in-progress tool results show factual summary while preserving complete evidence and ordinary text',()=>{
 const h=harness(),tool={summary:'已核算两期经营数据，尚缺银行流水',evidence:{source:'本次用户财务资料',records:'原始证据'.repeat(900)},files:['investment/financial-analysis.json']},task={id:'financial',title:'核算财务',agentId:'invest_finance',status:'running',dependencies:[],action:{summary:'核对上传资料与金额口径'},result:JSON.stringify(tool).slice(0,1600),toolResults:[{tool:'analyze_investment_financials',result:tool}]};
 h.scope.task=task;const original=JSON.stringify(task),html=h.eval('taskMarkup(task)');assert.match(html,/<p><em>结果<\/em>已核算两期经营数据，尚缺银行流水<\/p>/);assert.match(html,/<p><em>行动<\/em>核对上传资料与金额口径<\/p>/);assert.match(html,/<summary>查看工具返回证据<\/summary>/);assert.match(html,/本次用户财务资料/);assert.match(html,/financial-analysis\.json/);assert.equal(JSON.stringify(task),original);
 h.scope.snapshot=makeRun({agents:[{id:'zhang',tools:['inspect_network'],task:'核算财务',action:JSON.stringify({summary:'读取真实工具回执'}),result:task.result}]});h.eval('run=snapshot;panel={type:"agent",id:"zhang",tab:"work"}');const role=h.eval('renderAgent()');assert.match(role,/<p class="work-result">已核算两期经营数据，尚缺银行流水<\/p>/);assert.match(role,/<p class="work-text">读取真实工具回执<\/p>/);assert.equal(h.eval('resultSummary("待补银行流水，当前不能确认现金余额。")'),'待补银行流水，当前不能确认现金余额。');assert.equal(h.eval('resultSummary({summary:"直接对象摘要",evidence:{raw:"完整原文"}})'),'直接对象摘要');
});

test('employee roster separates model workers and user-operated human responsibility roles',async()=>{
 const h=harness(),html=h.eval('renderEmployees()');assert.match(html,/虚拟员工由模型执行/);assert.match(html,/真实员工（由你操作）/);assert.doesNotMatch(html,/AI 员工|AI员工|>AI</);for(const person of HUMAN_EMPLOYEES){assert.ok(html.includes(`data-human="${person.id}"`));assert.ok(html.includes(person.name));}
 h.scene.callbacks.onSelectHuman('finance_owner');assert.equal(h.eval('panel.type'),'human');assert.equal(h.eval('panel.id'),'finance_owner');assert.match(h.element('#popover-content').innerHTML,/真实员工（由你操作）/);assert.match(h.element('#popover-content').innerHTML,/data-scenario="finance"/);assert.equal(h.requests.length,0);await h.click({scenario:'finance'});assert.match(h.element('#popover-content').innerHTML,/data-human="finance_owner"/);assert.equal(h.requests.length,0);
});

test('historical handoffs remain readable without replay; only actual new deliveries reach scene',()=>{
 const h=harness(),input={id:'intake',runId:'run-a',type:'handoff',deliveryKind:'task_input',sourceHumanId:'finance_owner',targetAgentId:'ops',text:'提交月度财务资料',artifactIds:[]},delivery={id:'delivery',runId:'run-a',type:'handoff',deliveryKind:'final_delivery',sourceAgentId:'lead',agentId:'lead',targetHumanId:'finance_owner',text:'交付年度财务报告',artifactIds:['report']};h.scope.previous=makeRun({events:[input]});h.eval('receive(previous,{initial:true})');assert.equal(h.scene.updates.at(-1).logs.length,0);assert.equal(h.scene.updates.at(-1).animateEvents,false);assert.match(h.eval('renderLogs()'),/财务负责人 → 阿杰/);
 h.scope.next=makeRun({status:'completed',events:[input,delivery],artifacts:[{id:'report',name:'年度报告.html',url:'/api/runs/run-a/artifacts/report'}]});h.eval('receive(next)');const latest=h.scene.updates.at(-1);assert.equal(latest.runId,'run-a');assert.equal(latest.animateEvents,true);assert.equal(latest.logs.length,1);assert.equal(latest.logs[0].targetHumanId,'finance_owner');assert.equal(latest.logs[0].artifactIds[0],'report');assert.equal(h.eval('run.events.length'),2);h.eval('panel={type:"human",id:"finance_owner"}');const human=h.eval('renderHuman()');assert.match(human,/查阅交付文件/);assert.match(human,/交付年度财务报告/);assert.equal(h.requests.length,0);
 const fresh=harness();fresh.scope.created=makeRun({events:[input]});fresh.eval('receive(created)');assert.equal(fresh.scene.updates.at(-1).logs[0].sourceHumanId,'finance_owner');assert.equal(fresh.scene.updates.at(-1).animateEvents,true);
});

test('real-time approval waits for matching owner arrival while highlighting immediately',()=>{
 const h=harness();h.scope.pending=makeRun({status:'awaiting_approval',approval:{id:'walk-approval',title:'等待真人决定',details:{}},events:[{id:'walk-request',runId:'run-a',type:'handoff',deliveryKind:'approval_request',sourceAgentId:'zhang',targetHumanId:'owner',approvalId:'walk-approval',text:'交付待审批方案'}]});h.eval('receive(pending)');assert.equal(h.eval('panel'),null);assert.equal(h.element('#approval-request').hidden,false);assert.equal(h.scene.updates.at(-1).humanApproval,true);assert.equal(h.eval('pendingApprovalOpen.approvalId'),'walk-approval');assert.equal(h.delays.get(h.eval('pendingApprovalOpen.timer')),16000);assert.equal(h.scene.updates.at(-1).runStatus,'awaiting_approval');h.scene.callbacks.onDelivery({runId:'run-a',targetHumanId:'owner',approvalId:'old-id'});assert.equal(h.eval('panel'),null);h.scene.callbacks.onDelivery({runId:'run-a',targetHumanId:'owner',approvalId:'walk-approval'});assert.equal(h.eval('panel.type'),'approval');assert.equal(h.eval('pendingApprovalOpen'),null);assert.equal(h.eval('run.status'),'awaiting_approval');assert.equal(h.requests.length,0);
});

test('cancelled arrival cannot reopen approval, manual open wins, and restored approval needs no replay',async()=>{
 const h=harness();h.scope.pending=makeRun({status:'awaiting_approval',approval:{id:'approval-delay',title:'审批',details:{}}});h.eval('receive(pending)');const timer=h.timers.get(h.eval('pendingApprovalOpen.timer'));h.scope.cancelled=makeRun({status:'cancelled'});h.eval('receive(cancelled)');assert.equal(h.scene.updates.at(-1).runStatus,'cancelled');timer();h.scene.callbacks.onDelivery({runId:'run-a',targetHumanId:'owner',approvalId:'approval-delay'});assert.notEqual(h.eval('panel?.type'),'approval');assert.equal(h.eval('pendingApprovalOpen'),null);
 const manual=harness();manual.scope.pending=h.scope.pending;manual.eval('receive(pending)');await manual.click({open:'approval'});assert.equal(manual.eval('panel.type'),'approval');assert.equal(manual.eval('pendingApprovalOpen'),null);manual.eval('closePanel()');manual.scene.callbacks.onDelivery({runId:'run-a',targetHumanId:'owner',approvalId:'approval-delay'});assert.equal(manual.eval('panel'),null);
 const restored=harness();restored.scope.pending=h.scope.pending;restored.eval('receive(pending,{initial:true})');assert.equal(restored.eval('panel.type'),'approval');assert.equal(restored.eval('pendingApprovalOpen'),null);assert.equal(restored.scene.updates.at(-1).animateEvents,false);
});

test('human delivery state requires actual completed final handoff; partial evidence is only available',()=>{
 const h=harness(),artifact={id:'proof',name:'真实证据.json',url:'/api/runs/run-a/artifacts/proof'};for(const status of ['failed','cancelled','completed']){h.scope.partial=makeRun({status,artifacts:[artifact]});h.eval('receive(partial,{initial:true})');assert.equal(h.eval('humanWork("finance_owner").status'),'files_available');assert.match(h.eval('humanWork("finance_owner").action'),/查阅已保留文件/);assert.equal(h.scene.updates.at(-1).runStatus,status);}
 h.scope.delivered=makeRun({status:'completed',artifacts:[artifact],events:[{id:'actual-final',type:'handoff',deliveryKind:'final_delivery',sourceAgentId:'lead',targetHumanId:'finance_owner',artifactIds:['proof'],text:'实际成果交付'}]});h.eval('receive(delivered)');assert.equal(h.eval('humanWork("finance_owner").status'),'delivery');assert.match(h.eval('humanWork("finance_owner").result'),/等待使用者查阅/);assert.doesNotMatch(h.eval('humanWork("finance_owner").result'),/已验收|已确认/);
});
