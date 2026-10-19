import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {buildRunOutcome} from '../server/outcomes.mjs';
import {createToolbox} from '../server/tools.mjs';
import {createInvestmentFunctions} from '../server/investment.mjs';

const example = async id => (JSON.parse(await fs.readFile(new URL('../data/examples/' + id + '.json', import.meta.url), 'utf8'))).input;
const report = {title:'本次任务交付',content:'本报告仅整理本次工具实际形成的资料与检查回执。数据、检查范围与未完成事项均以保留的底稿为准，不把生成文件说成生产部署、外部开户、采购付款或正式投资授权。'.repeat(3)};
const clone = value => structuredClone(value);
const valueOf = (outcome,label) => outcome.findings.find(item => item.label === label)?.value;

function record(run, tool, result, taskId = tool) {
  let task = run.tasks.find(item => item.id === taskId);
  if (!task) { task = {id:taskId,status:'done',toolResults:[]}; run.tasks.push(task); }
  task.toolResults.push({tool,result});
  return result;
}
async function actual(t, scenarioId, input = {}, approved = true) {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-outcome-'));
  t.after(() => fs.rm(runDir,{recursive:true,force:true}));
  const run = {id:crypto.randomUUID(),scenarioId,status:'completed',input,tasks:[],artifacts:[],events:[]};
  const box = await createToolbox({runDir,input,approval:async request => ({approved,targetHumanId:request.targetHumanId || 'owner',approvalId:'test-approval'})});
  const execute = async (tool,args,role,taskId) => { const result = await box.execute(tool,args,role);record(run,tool,result,taskId);run.artifacts=box.artifacts();return result; };
  return {run,box,runDir,execute,finish:() => execute('write_report',report,'lead')};
}

test('finance outcome uses actual arithmetic, independent audit and registered report files', async t => {
  const f = await actual(t,'finance',await example('finance'));
  await f.execute('import_finance',{},'ops');
  const metrics = await f.execute('calculate_finance',{},'finance');
  await f.execute('audit_finance',{},'liu');await f.finish();
  const result=buildRunOutcome(f.run);
  assert.equal(result.status,'verified');assert.equal(result.executionStatus,'completed');
  assert.match(valueOf(result,'营业收入'),new RegExp(String(metrics.evidence.years[String(metrics.evidence.year)].revenue)));
  assert.match(result.summary,/不|仍由/);assert(result.artifactGroups.some(group=>group.artifacts.some(file=>file.name==='annual-report.xlsx')));
  const bad=clone(f.run);record(bad,'audit_finance',{evidence:{passed:false,independentRecalculation:true,integrityCheck:'ok',errors:['现金不平衡']}});
  assert.equal(buildRunOutcome(bad).status,'needs_review');
  const mismatch=clone(f.run);const audit=mismatch.tasks.find(item=>item.id==='audit_finance').toolResults[0].result.evidence;
  audit.recalculated.years[String(metrics.evidence.year)].revenue+=1;
  assert.equal(buildRunOutcome(mismatch).status,'needs_review');
  const corrected=clone(f.run);corrected.tasks.find(item=>item.id==='audit_finance').toolResults.unshift({tool:'audit_finance',result:{evidence:{passed:false,errors:['旧审校差异']}}});
  corrected.events=[{type:'error',tool:'audit_finance',text:'历史错误'}];assert.equal(buildRunOutcome(corrected).status,'verified');
  const contradictory=clone(f.run);contradictory.tasks.find(item=>item.id==='audit_finance').toolResults[0].result.passed=false;
  assert.equal(buildRunOutcome(contradictory).status,'needs_review');
  const emptyMetrics=clone(f.run);emptyMetrics.tasks.find(item=>item.id==='calculate_finance').toolResults[0].result.evidence.years[String(metrics.evidence.year)]={};
  assert.equal(buildRunOutcome(emptyMetrics).status,'incomplete');
  const noReport=clone(f.run);noReport.artifacts=noReport.artifacts.filter(file=>!file.path.startsWith('reports/'));
  assert.equal(buildRunOutcome(noReport).status,'incomplete');
});

test('database outcome distinguishes tested SQLite delivery from production and samples from business records', async t => {
  const f=await actual(t,'database',{requirements:'名称唯一且不可为空。'});
  await f.execute('design_database',{ddl:'CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE);'},'zhang');
  await f.execute('build_database',{sampleSql:"INSERT INTO items VALUES(1,'sample');"},'ops');
  await f.execute('test_database',{tests:[{name:'拒绝重复名称',sql:"INSERT INTO items VALUES(2,'sample');",expectError:true},{name:'可以查询',sql:'SELECT * FROM items;',expectError:false,expectedRows:1}]},'liu');
  await f.finish();
  const result=buildRunOutcome(f.run);assert.equal(result.status,'verified');
  assert.equal(valueOf(result,'用户业务记录'),'0条');assert.match(valueOf(result,'数据性质'),/示例或验收/);
  assert.match(valueOf(result,'部署范围'),/未部署生产/);assert.match(valueOf(result,'独立数据库检查'),/2项SQL/);
  // An expected constraint error is a passing test, not a broken task.
  assert(f.run.tasks.find(item=>item.id==='test_database').toolResults[0].result.evidence.tests[0].error);
  const bad=clone(f.run);record(bad,'test_database',{evidence:{passed:false,integrity:'ok',foreignKeyViolations:[],tests:[{passed:false}],contractTests:[]}});
  assert.equal(buildRunOutcome(bad).status,'needs_review');
  const structural=clone(f.run);record(structural,'test_database',{evidence:{passed:true,integrity:'OK',foreignKeyViolations:[],tests:[],contractTests:[]}});
  assert.equal(buildRunOutcome(structural).status,'needs_review');assert.match(buildRunOutcome(structural).summary,/尚无实际业务SQL/);
});

test('DDoS outcome reports actual isolated replay and never claims production restoration', async t => {
  for(const approved of [false,true]) {
    const f=await actual(t,'ddos',await example('ddos'),approved);
    await f.execute('inspect_network',{},'ops');const analysis=await f.execute('analyze_traffic',{threshold:20,windowSeconds:60},'liu');
    await f.execute('apply_defense',{blockedIps:analysis.evidence.suspectedSources,reason:'仅隔离重放中拦截证据支持的高频来源。'},'zhang');
    await f.execute('verify_network',{},'liu');await f.finish();
    const result=buildRunOutcome(f.run);assert.equal(result.status,approved?'verified':'needs_review');
    assert.match(valueOf(result,'验证范围'),/未验证生产网络恢复/);
    if(approved) {
      assert.match(result.summary,/不代表生产网络已恢复/);
      const unknown=clone(f.run);const verify=unknown.tasks.find(item=>item.id==='verify_network').toolResults[0].result.evidence;
      verify.verifiedRestored=false;verify.unknownLabelRequests=1;
      assert.equal(buildRunOutcome(unknown).status,'needs_review');assert.equal(valueOf(buildRunOutcome(unknown),'缺少验收标签'),'1条');
      const contradictory=clone(f.run);contradictory.tasks.find(item=>item.id==='verify_network').toolResults[0].result.evidence.falsePositives=2;
      assert.equal(buildRunOutcome(contradictory).status,'needs_review');
    }
  }
});

// This offline fixture is the exact public receipt shape of search_web,
// fetch_quote and compare_quotes. It exercises result classification, not the
// separate HTTP fetcher, and deliberately makes no internet request.
function procurementFixture(quotePatch={}) {
  const run={id:'run-procurement',scenarioId:'procurement',status:'completed',input:{currency:'CNY'},tasks:[],artifacts:[]};
  const quote={id:'Q1',title:'候选整机',productType:'server_hardware',status:'priced',price:12000,currency:'CNY',priceKind:'fixed',sourceUrl:'https://supplier.example/server',fetchedAt:'2026-10-19T08:00:00Z',priceCandidates:[{amount:12000,currency:'CNY'}],selectedConfiguration:['32GB RAM','1TB SSD'],comparable:true,tax:'已确认含税',shipping:'已确认免运费',warranty:'已确认三年保修',listedPriceWithinBudget:true,...quotePatch};
  record(run,'search_web',{evidence:{candidates:[{url:quote.sourceUrl}],scope:'仅本次实际检索范围'}});
  record(run,'fetch_quote',{evidence:{quotes:[quote]}});
  for(const task of ['technical','budget'])record(run,'compare_quotes',{evidence:{purpose:task,budgetCurrency:'CNY',quotes:[quote],comparableQuoteCount:quote.comparable?1:0,purchaseExecuted:false}},task);
  const artifact={id:'report-1',name:'采购申请-1.HTML',path:'reports/采购申请-1.HTML',mimeType:'text/html',bytes:100};run.artifacts.push(artifact);
  record(run,'write_report',{summary:'所有候选均已通过，采购已完成。（故意不可信的模型文字）',evidence:{sentExternally:false},files:['reports/采购申请-1.HTML'],artifacts:[artifact]});
  return run;
}

test('procurement labels valid scoped comparison and retains no-order/no-payment boundary',()=>{
  const result=buildRunOutcome(procurementFixture());assert.equal(result.status,'verified');
  assert.equal(result.label,'公开报价初核完成');assert.match(result.summary,/尚未执行采购/);
  assert.match(valueOf(result,'本次抓取范围'),/1个候选；非全网/);assert(!JSON.stringify(result).includes('采购已完成'));
  const noFinance=procurementFixture();noFinance.tasks=noFinance.tasks.filter(task=>task.id!=='budget');
  assert.equal(buildRunOutcome(noFinance).status,'incomplete');assert.match(buildRunOutcome(noFinance).summary,/技术与财务/);
});

test('procurement missing, ambiguous, component, currency and total-cost evidence cannot pass',()=>{
  for(const [patch,label] of [
    [{status:'pending_inquiry',price:null,currency:null,comparable:false},'待询价'],
    [{status:'multiple_price_candidates',priceCandidates:[{amount:12000},{amount:15000}],comparable:false},'待询价'],
    [{productType:'component',comparable:false},'待询价'],
    [{priceKind:'starting_price'},'待询价'],
    [{currency:'USD'},'待询价'],
    [{currency:null},'待询价'],
    [{tax:'未核实'},'报价与采购条件需核实'],
    [{shipping:'unknown'},'报价与采购条件需核实'],
    [{warranty:'请核对配置证据；未获确认'},'报价与采购条件需核实'],
    [{listedPriceWithinBudget:false},'报价与采购条件需核实'],
  ]) {
    const result=buildRunOutcome(procurementFixture(patch));assert.equal(result.status,'needs_review',JSON.stringify(patch));assert.equal(result.label,label);
  }
});

test('quote fetching stays additive and case-normalized without forgetting an earlier pending quote',()=>{
  const run=procurementFixture();record(run,'fetch_quote',{evidence:{quotes:[{id:'Q2',productType:'SERVER_HARDWARE',status:'PENDING_INQUIRY',sourceUrl:'https://supplier.example/other',price:null,currency:null}]}});
  const result=buildRunOutcome(run);assert.equal(result.status,'needs_review');assert.match(valueOf(result,'本次抓取范围'),/2个候选/);assert.equal(valueOf(result,'待询价'),'1个候选');
  const normalized=procurementFixture({productType:'SERVER_HARDWARE',status:'PRICED',currency:'cny'});normalized.scenarioId='PROCUREMENT';normalized.status='COMPLETED';
  assert.equal(buildRunOutcome(normalized).status,'verified');
});

test('delivery outcome uses real cost/schedule receipts but never calls the project delivered or customer-accepted',async t=>{
  const f=await actual(t,'delivery',{company:'验收项目',requirements:'需要工单创建与统计报表。',dailyRate:1500});
  await f.execute('extract_requirements',{requirements:[{id:'R1',description:'工单创建',source:'工单创建',acceptance:'可以保存并查询工单'},{id:'R2',description:'统计报表',source:'统计报表',acceptance:'数量与实际工单一致'}]},'business');
  await f.execute('estimate_delivery',{packages:[{id:'P1',name:'工单',days:4,dependsOn:[],requirementIds:['R1'],deliverable:'工单模块'},{id:'P2',name:'统计',days:2,dependsOn:['P1'],requirementIds:['R2'],deliverable:'统计页面'}],bufferPct:10},'business','schedule');
  await f.execute('estimate_delivery',{},'finance','cost');await f.execute('review_delivery',{},'liu');await f.finish();
  const result=buildRunOutcome(f.run);assert.equal(result.status,'verified');assert.equal(valueOf(result,'成本估算'),'9900 CNY');
  assert.match(result.summary,/不是项目已交付或客户已验收/);assert.match(valueOf(result,'客户确认'),/尚未确认/);
  const bad=clone(f.run);record(bad,'review_delivery',{evidence:{passed:false,checks:{coverageComplete:false},issues:['缺少R2'],missingRequirementIds:['R2'],customerApproved:false}});
  assert.equal(buildRunOutcome(bad).status,'needs_review');
  const question=clone(f.run);question.tasks.find(item=>item.id==='review_delivery').toolResults[0].result.evidence.openQuestions=['权限范围待客户确认'];
  assert.equal(buildRunOutcome(question).status,'needs_review');
  const noCost=clone(f.run);noCost.tasks=noCost.tasks.filter(task=>task.id!=='cost');assert.equal(buildRunOutcome(noCost).status,'incomplete');
});

async function investmentRun(t, completeMaterials) {
  const input={projectName:'验收项目',projectBrief:'验收项目称已有20家付费客户。',urls:['https://issuer.example/project'],currency:'CNY',...(completeMaterials?{financials:[{period:'2025',revenue:100,gross_profit:50,net_profit:10,cash:20,monthly_burn:2,debt:0}]}:{})};
  const f=await actual(t,'investment',input);const outputs={};
  const functions=createInvestmentFunctions({input,outputs,approval:async()=>({approved:true}),validatePublicUrl:async url=>new URL(url),
    publicFetch:async url=>{if(/bing\.com|duckduckgo\.com/.test(new URL(url).hostname))throw new Error('测试检索受阻');return {url,status:200,contentType:'text/html',fetchedAt:'2026-10-19T08:00:00Z',text:'<title>验收项目</title><p>验收项目称已有20家付费客户。</p>'};},
    put:async(name,body)=>{const file=path.join(f.runDir,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,typeof body==='string'?body:JSON.stringify(body));return name;}});
  const execute=async(tool,args={})=>{const result=await functions[tool](args);outputs[tool]=result.evidence;result.artifacts=[];for(const name of result.files||[]){const artifact={id:crypto.createHash('sha256').update(name).digest('hex').slice(0,18),name:path.basename(name),path:name,bytes:(await fs.stat(path.join(f.runDir,name))).size};result.artifacts.push(artifact);f.run.artifacts.push(artifact);}record(f.run,tool,result);return result;};
  await execute('prepare_investment',{claims:[{id:'C1',claim:'20家付费客户',sourceQuote:'已有20家付费客户',area:'业务'}]});
  await execute('research_investment');await execute('analyze_investment_financials');
  await execute('review_investment',{findings:[{claimId:'C1',verdict:completeMaterials?'source_supported':'issuer_claim',reason:'只审查实际来源说法，不作真实性认证',citations:[{sourceId:completeMaterials?'W1':'U1',quote:'已有20家付费客户'}]}]});
  await execute('build_investment_memo',{recommendation:'continue_diligence',rationale:'公开资料只支持来源说法，并不能代替主体、客户、财务、法律与股权的独立核验。即使资料格式和覆盖检查完整，仍需银行流水、合同、客户访谈和专业法律核查支持进一步判断。本次只建议后续尽调方向，不批准投资、不签约、不保证收益或执行付款。'.repeat(2)});
  await execute('request_investment_review');const artifacts=[...f.run.artifacts];await f.finish();f.run.artifacts=[...artifacts,...f.box.artifacts()];return f.run;
}

test('investment with actual complete-source receipts still cannot claim investment viability',async t=>{
  const run=await investmentRun(t,true),result=buildRunOutcome(run);
  assert.equal(valueOf(result,'关键材料缺口'),'0项');assert.equal(result.status,'needs_review');
  assert.match(result.label,/仍需独立核验/);assert.match(result.summary,/尚不能确认项目可投资/);
  assert.equal(valueOf(result,'老板审阅'),'选择继续尽调');assert.match(valueOf(result,'说法审查覆盖'),/1\/1项；覆盖不等于独立证实/);
  const gaps=buildRunOutcome(await investmentRun(t,false));assert.equal(gaps.status,'needs_review');assert.match(gaps.label,/关键缺口待补/);assert(!gaps.findings.some(item=>item.value==='投资可行'));
});

test('onboarding actual approval, registry commit and manual resources remain separate and anonymous',async t=>{
  for(const approved of [true,false]) {
    const input=await example('onboarding');const f=await actual(t,'onboarding',input,approved);
    await f.execute('prepare_onboarding',{},'hr');await f.execute('review_onboarding',{},'liu');await f.execute('plan_onboarding_resources',{},'ops');
    await f.execute('request_onboarding_approval',{},'hr');await f.execute('register_onboarding',{},'hr');await f.finish();
    const result=buildRunOutcome(f.run);assert.equal(result.status,'needs_review');
    assert.match(result.label,approved?/本地登记完成/:/登记未获批准/);assert.match(valueOf(result,'设备、账号与权限'),/待办理|待真实负责人确认/);
    assert(!JSON.stringify(result).includes(input.employeeName));assert(!JSON.stringify(result).includes(input.workEmail));
    if(approved) {
      const noApproval=clone(f.run);noApproval.tasks=noApproval.tasks.filter(item=>item.id!=='request_onboarding_approval');
      assert.equal(buildRunOutcome(noApproval).status,'incomplete');assert.notEqual(valueOf(buildRunOutcome(noApproval),'本地员工台账'),'已写入本地员工册');
      const noCommit=clone(f.run);const registration=noCommit.tasks.find(item=>item.id==='register_onboarding').toolResults[0].result.evidence;registration.registryWritten=false;
      assert.equal(buildRunOutcome(noCommit).label,'员工登记尚未确认');
    }
  }
});

test('latest receipt supersedes historical failure, while a later failed check blocks verification',()=>{
  const run=procurementFixture();
  const task=run.tasks.find(item=>item.id==='technical');
  task.toolResults.unshift({tool:'compare_quotes',result:{ok:false,error:'旧工具错误'}});
  task.toolResults.unshift({tool:'compare_quotes',result:{evidence:{passed:false,quotes:[]}}});
  run.events=[{type:'error',tool:'compare_quotes',text:'历史失败，不应污染已更正的回执'}];
  assert.equal(buildRunOutcome(run).status,'verified');
  record(run,'compare_quotes',{ok:false,error:'最新核对失败'},'budget');
  assert.equal(buildRunOutcome(run).status,'incomplete');
  const earlyRoleFailure=procurementFixture();record(earlyRoleFailure,'compare_quotes',{ok:false,error:'技术岗位尚未更正'},'technical');
  assert.equal(buildRunOutcome(earlyRoleFailure).status,'incomplete');
});

test('new fetch evidence cannot inherit obsolete comparability from an older review',()=>{
  const run=procurementFixture();
  for(const [index,task] of run.tasks.entries())task.finishedAt=`2026-10-19T08:00:0${index}Z`;
  const fetchTask=run.tasks.find(task=>task.id==='fetch_quote');
  record(run,'fetch_quote',{evidence:{quotes:[{id:'Q1',productType:'server_hardware',status:'pending_inquiry',price:null,currency:null,sourceUrl:'https://supplier.example/server'}]}});
  fetchTask.finishedAt='2026-10-19T09:00:00Z';
  const result=buildRunOutcome(run);assert.equal(result.status,'needs_review');assert.equal(result.label,'待询价');
});

test('execution status never substitutes for acceptance or discards retained evidence',()=>{
  const run=procurementFixture({tax:'未核实'});
  for(const [status,expected] of [['running','running'],['queued','running'],['awaiting_approval','awaiting_approval'],['failed','failed'],['aborted','cancelled'],['CANCELLED','cancelled']]) {
    const result=buildRunOutcome({...run,status,approval:status==='awaiting_approval'?{title:'请采购负责人审阅'}:null});
    assert.equal(result.status,expected);assert.equal(result.validationStatus,'needs_review');assert(result.artifactGroups.length);
  }
  const pending=buildRunOutcome({...run,status:'awaiting_approval',approval:{title:'请真实负责人审阅采购申请'}});
  assert.equal(pending.summary,'请真实负责人审阅采购申请');assert.equal(pending.nextActions.length,1);
  for(const value of [null,undefined,{},[],{scenarioId:'finance',status:'completed',tasks:[],artifacts:[]},{scenarioId:'unknown',status:'completed'}])assert.equal(buildRunOutcome(value).status,'incomplete');
  assert.equal(buildRunOutcome({...procurementFixture(),status:'unrecognized'}).status,'incomplete');
  const inconsistent=procurementFixture();inconsistent.tasks[0].status='failed';assert.equal(buildRunOutcome(inconsistent).status,'incomplete');
});

test('artifact groups use registered metadata and safe download routes, never markdown URLs or local paths',()=>{
  const run=procurementFixture();run.summary='[报告](javascript:alert(1)) [凭据](/etc/passwd)';
  run.artifacts.push({id:'evil/id',name:'不应显示.html',url:'https://evil.example/exfil'});
  run.artifacts.push({id:'execution-evidence',name:'execution-evidence.JSON',path:'/private/data/run/execution-evidence.JSON',url:'javascript:alert(1)',bytes:123});
  run.artifacts.push({id:'receipt-file',name:'AUDIT.JSON',path:'finance/AUDIT.JSON',url:'file:///etc/passwd'});
  run.artifacts.push({id:'report-1',name:'重复条目.html'});
  const result=buildRunOutcome(run),serialized=JSON.stringify(result);
  assert(!serialized.includes('javascript:'));assert(!serialized.includes('/private/data'));assert(!serialized.includes('/etc/passwd'));assert(!serialized.includes('evil.example'));
  assert(result.artifactGroups.find(group=>group.id==='records').artifacts.some(item=>item.id==='execution-evidence'));
  assert(result.artifactGroups.find(group=>group.id==='checks').artifacts.some(item=>item.id==='receipt-file'));
  assert.equal(result.artifactGroups.flatMap(group=>group.artifacts).filter(item=>item.id==='report-1').length,1);
  for(const item of result.artifactGroups.flatMap(group=>group.artifacts))assert.equal(item.url,`/api/runs/${run.id}/artifacts/${item.id}`);
  const publicRun=clone(run);publicRun.artifacts=publicRun.artifacts.map(({path,...item})=>item);
  assert.equal(buildRunOutcome(publicRun).artifactGroups.find(group=>group.id==='deliverables').artifacts[0].name,'采购申请-1.HTML');
});

test('outcome projection is pure and handles malformed optional collections without false passes',()=>{
  const run=procurementFixture();const before=JSON.stringify(run);const first=buildRunOutcome(run),second=buildRunOutcome(run);
  assert.equal(JSON.stringify(run),before);assert.deepEqual(first,second);
  assert.doesNotThrow(()=>buildRunOutcome({status:'completed',scenarioId:'finance',tasks:[null,{}, {toolResults:[null,{tool:'audit_finance',result:'not an object'}]}],artifacts:[null]}));
});
