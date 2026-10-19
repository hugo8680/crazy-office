import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createToolbox,isPublicAddress,validatePublicUrl} from '../server/tools.mjs';
import {companyTaskInput,COMPANY_NAME} from '../server/company.mjs';
import {parseDecision} from '../server/provider.mjs';
const tmp=()=>fs.mkdtemp(path.join(os.tmpdir(),'office-tools-test-'));
const example=async id=>(JSON.parse(await fs.readFile(new URL('../data/examples/'+id+'.json',import.meta.url),'utf8'))).input;
async function withBox(input,fn,approved=true){const runDir=await tmp();try{const box=await createToolbox({runDir,input,approval:async()=>({approved,note:'测试审批'})});await fn(box,runDir);}finally{await fs.rm(runDir,{recursive:true,force:true});}}

test('finance imports exact cents into SQLite, computes real XLSX/CSV/HTML and independent audit',async()=>{
 const input=await example('finance');await withBox(input,async(box,dir)=>{const imported=await box.execute('import_finance',{},'ops');assert.equal(imported.evidence.rows,24);const [calc,audit]=await Promise.all([box.execute('calculate_finance',{},'finance'),box.execute('audit_finance',{},'liu')]);const current=calc.evidence.years['2025'];assert.equal(current.gross_profit,current.revenue-current.cost);assert.equal(current.net_cash_flow,Math.round((current.cash_in-current.cash_out)*100)/100);assert.equal(audit.evidence.passed,true);assert.deepEqual(audit.evidence.recalculated.years,calc.evidence.years);const bytes=await fs.readFile(path.join(dir,'finance/annual-report.xlsx'));assert.equal(bytes.subarray(0,2).toString(),'PK');assert(box.artifacts().some(a=>a.name==='finance.sqlite'));});
});

test('finance rejects missing months, duplicates and broken cash rather than fabricating',async()=>{
 const original=await example('finance');const lines=original.data.text.trim().split(/\r?\n/);
 for(const [name,text,pattern] of [['missing',lines.slice(0,-1).join('\n'),/缺少月份/],['duplicate',lines.concat(lines[1]).join('\n'),/重复月份/],['balance',lines.map((l,i)=>i===1?l.replace(/,[^,]+$/,',0'):l).join('\n'),/现金不平衡/]])await withBox({...original,data:{name:name+'.csv',text}},async box=>{await assert.rejects(()=>box.execute('import_finance',{},'ops'),pattern);assert.equal(box.artifacts().length,0);});
});

test('tool role permissions are enforced server side',async()=>{await withBox({},async box=>{await assert.rejects(()=>box.execute('import_finance',{},'business'),/没有.*权限/);await assert.rejects(()=>box.execute('list_artifacts',{}, {id:'ops',tools:[]}),/没有.*权限/);});});

test('public web tools reject localhost, private IP, alternative IPv4 encodings and dangerous schemes',async()=>{
 for(const address of ['127.0.0.1','10.0.0.2','172.16.0.1','192.168.0.1','169.254.169.254','::1','::ffff:127.0.0.1','fc00::1','198.18.0.1'])assert.equal(isPublicAddress(address),false,address);
 for(const address of ['8.8.8.8','23.14.134.75','2606:4700:4700::1111'])assert.equal(isPublicAddress(address),true,address);
 for(const url of ['http://127.0.0.1','http://2130706433','http://0x7f000001','http://[::1]','http://localhost','http://192.168.1.1','file:///etc/passwd','https://user:pass@example.com','https://example.com:8080'])await assert.rejects(()=>validatePublicUrl(url));
});

test('database is actually built; unique/check/fk constraints and tests rollback',async()=>{
 const ddl='CREATE TABLE customers(id INTEGER PRIMARY KEY,email TEXT NOT NULL UNIQUE); CREATE TABLE orders(id INTEGER PRIMARY KEY,customer_id INTEGER NOT NULL REFERENCES customers(id),amount INTEGER NOT NULL CHECK(amount>=0)); CREATE INDEX customer_orders ON orders(customer_id);';
 await withBox({requirements:'唯一邮箱，订单金额非负且关联存在的客户。'},async(box,dir)=>{await box.execute('design_database',{ddl,description:'真实约束'},'zhang');await box.execute('build_database',{sampleSql:"INSERT INTO customers VALUES(1,'sample@example.test'); INSERT INTO orders VALUES(1,1,100);"},'ops');const r=await box.execute('test_database',{tests:[{name:'拒绝重复邮箱',sql:"INSERT INTO customers VALUES(2,'sample@example.test');",expectError:true},{name:'拒绝负金额',sql:'INSERT INTO orders VALUES(2,1,-1);',expectError:true},{name:'拒绝悬空外键',sql:'INSERT INTO orders VALUES(2,999,1);',expectError:true},{name:'有效数据可插入后回滚',sql:'INSERT INTO orders VALUES(2,1,10);',expectError:false}],queries:['SELECT COUNT(*) AS n FROM orders;']},'liu');assert.equal(r.evidence.passed,true);assert.equal(r.evidence.tests.length,4);assert.equal(r.evidence.queries[0].rows[0].n,1);assert((await fs.stat(path.join(dir,'database/company.sqlite'))).size>0);await assert.rejects(()=>box.execute('design_database',{ddl:"ATTACH '/tmp/leak.db' AS evil;"},'zhang'),/不允许|禁止/);await assert.rejects(()=>box.execute('test_database',{queries:["SELECT load_extension('evil');"]},'liu'),/禁止/);});
});

const procurementPrototypeDdl=`
CREATE TABLE suppliers(id INTEGER PRIMARY KEY,name TEXT NOT NULL);
CREATE TABLE candidates(id INTEGER PRIMARY KEY,supplier_id INTEGER NOT NULL REFERENCES suppliers(id),model TEXT NOT NULL,memory_gb INTEGER NOT NULL,ssd_gb INTEGER NOT NULL);
CREATE TABLE quotes(id INTEGER PRIMARY KEY,candidate_id INTEGER NOT NULL REFERENCES candidates(id),source_url TEXT NOT NULL,fetched_at TEXT NOT NULL,currency TEXT NOT NULL CHECK(currency IN ('CNY','USD')),price REAL CHECK(price IS NULL OR price>=0),tax_known INTEGER NOT NULL CHECK(tax_known IN (0,1)));
CREATE INDEX candidate_quotes ON quotes(candidate_id,fetched_at);`;

test('SQL that was double escaped gets an actionable error and never becomes a successful design',async()=>{
 await withBox({},async(box,dir)=>{await assert.rejects(()=>box.execute('design_database',{ddl:procurementPrototypeDdl.replaceAll('\n','\\n')},'zhang'),/实际换行或分号.*不要对JSON字符串中的SQL再次转义/);assert.equal(box.artifacts().length,0);await assert.rejects(fs.stat(path.join(dir,'database/schema.sql')),error=>error.code==='ENOENT');});
});

test('the model can submit isolated setup SQL through the real test tool contract',async()=>{
 await withBox({},async box=>{await box.execute('design_database',{ddl:'CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(id INTEGER PRIMARY KEY,p_id INTEGER NOT NULL REFERENCES p(id));'},'zhang');await box.execute('build_database',{},'ops');const definition=box.definitions.find(tool=>tool.name==='test_database');const args={tests:[{name:'合法外键插入',setupSql:'INSERT INTO p VALUES(910001);',sql:'INSERT INTO c VALUES(1,910001);',expectError:false},{name:'拒绝悬空外键',setupSql:'INSERT INTO p VALUES(910001);',sql:'INSERT INTO c VALUES(1,999999);',expectError:true}],queries:['SELECT COUNT(*) AS n FROM p;']};const decision=parseDecision(JSON.stringify({action:'tool',tool:'test_database',args_json:JSON.stringify(args),summary:'独立验收',output:''}),[definition],'unit-test-only');const result=await box.execute(decision.tool,decision.args,'liu');assert.equal(result.evidence.passed,true);assert.equal(result.evidence.tests.length,2);assert.equal(result.evidence.queries[0].rows[0].n,0);});
});

test('explicit database contracts reject missing currency/price CHECK before saving DDL, then corrected design builds and independently passes',async()=>{
 const input=companyTaskInput('database',{name:COMPANY_NAME,verifiedFacts:[]}).input;
 assert.equal(input.example,undefined);assert.equal(input.isExample,true);assert.equal(input.databaseTestMode,'contract-only');assert.equal(input.databaseChecks.length,11);assert.match(input.requirements,/不代表公司既有生产表结构/);
 const samples=JSON.parse(input.data.text);assert.deepEqual(Object.values(samples).map(rows=>rows.length),[1,1,1]);assert.match(samples.suppliers[0].name,/sample/);assert.match(samples.candidates[0].model,/sample/);assert.equal(samples.quotes[0].source_url,'https://example.invalid/sample-quote');assert.equal(samples.quotes[0].fetched_at,'2000-01-01T00:00:00Z');assert.equal(samples.quotes[0].price,null);
 await withBox(input,async(box,dir)=>{
  const omitted=procurementPrototypeDdl.replace(" CHECK(currency IN ('CNY','USD'))",'').replace(' CHECK(price IS NULL OR price>=0)','');
  await assert.rejects(()=>box.execute('design_database',{ddl:omitted,description:'故意遗漏两个CHECK的回归设计'},'zhang'),error=>/报价拒绝CNY和USD之外的币种/.test(error.message)&&/报价已知价格必须非负/.test(error.message));
  assert.equal(box.artifacts().length,0);for(const name of ['schema.sql','design.json','design-checks.json'])await assert.rejects(fs.stat(path.join(dir,'database',name)),error=>error.code==='ENOENT');
  const designed=await box.execute('design_database',{ddl:procurementPrototypeDdl,description:'依据显式合同修正DDL'},'zhang');
  assert.equal(designed.evidence.designChecks.passed,true);assert.equal(designed.evidence.designChecks.testCount,11);assert(designed.evidence.designChecks.tests.every(row=>row.passed));assert(designed.artifacts.some(file=>file.name==='design-checks.json'));
  const receipt=JSON.parse(await fs.readFile(path.join(dir,'database/design-checks.json'),'utf8'));assert.equal(receipt.allChangesRolledBack,true);assert.equal(receipt.tests.filter(row=>row.constraintError).length,9);
  const built=await box.execute('build_database',{},'ops');assert.equal(built.evidence.importedRows,3);assert.equal(built.evidence.importedBusinessRows,0);assert.equal(built.evidence.validationSampleRows,3);assert.equal(built.evidence.validationSamplesOnly,true);assert.equal(built.evidence.sampleSource,'explicit_example_input');
  const verified=await box.execute('test_database',{tests:[],queries:['SELECT (SELECT COUNT(*) FROM suppliers) AS suppliers,(SELECT COUNT(*) FROM candidates) AS candidates,(SELECT COUNT(*) FROM quotes) AS quotes,price,source_url FROM quotes;']},'liu');assert.equal(verified.evidence.passed,true);assert.equal(verified.evidence.contractTests.length,11);assert(verified.evidence.contractTests.every(row=>row.passed));const row=verified.evidence.queries[0].rows[0];assert.deepEqual([row.suppliers,row.candidates,row.quotes],[1,1,1]);assert.equal(row.price,null);
  assert.equal(verified.evidence.additionalTestsNotRequested,true);assert.equal(verified.evidence.verificationScope,'explicit_database_contracts');assert.equal(verified.evidence.contractCount,11);assert.deepEqual(verified.evidence.tests,[]);assert.match(verified.evidence.testCoverage,/不代表业务或测试全覆盖/);assert.match(verified.summary,/合同范围验收通过/);
  const testReceipt=JSON.parse(await fs.readFile(path.join(dir,'database/tests.json'),'utf8'));assert.equal(testReceipt.contractCount,11);assert.equal(testReceipt.allChangesRolledBack,true);assert.deepEqual(testReceipt.contractTests,verified.evidence.contractTests);
 });
});

test('contract-only database tests reject extra cases and excess queries without writing a success receipt',async()=>{
 const input=companyTaskInput('database',{name:COMPANY_NAME,verifiedFacts:[]}).input;
 await withBox(input,async(box,dir)=>{
  await box.execute('design_database',{ddl:procurementPrototypeDdl},'zhang');await box.execute('build_database',{},'ops');
  await assert.rejects(()=>box.execute('test_database',{tests:[{name:'重复合同',sql:'SELECT 1;',expectError:false}]},'liu'),/tests须为\[\]/);
  for(const queries of [['SELECT 1;','SELECT 2;'],['SELECT 1; SELECT 2;']])await assert.rejects(()=>box.execute('test_database',{tests:[],queries},'liu'),/最多接受一条SELECT查询/);
  await assert.rejects(fs.stat(path.join(dir,'database/tests.json')),error=>error.code==='ENOENT');
  const verified=await box.execute('test_database',{tests:[]},'liu');assert.equal(verified.evidence.contractCount,11);assert.equal(verified.evidence.passed,true);assert.deepEqual(verified.evidence.queries,[]);
 });
});

test('contract-only mode requires valid contracts and preserves actual failed contract outcomes',async()=>{
 await withBox({},async(box,dir)=>{
  await box.execute('design_database',{ddl:'CREATE TABLE items(id INTEGER PRIMARY KEY);'},'zhang');await box.execute('build_database',{},'ops');
  for(const databaseChecks of [undefined,[],[{name:'无SQL'}]]){
   const strict=await createToolbox({runDir:dir,input:{databaseTestMode:'contract-only',databaseChecks}});
   await assert.rejects(()=>strict.execute('test_database',{tests:[]},'liu'),/有效的databaseChecks|SQL为空/);
  }
  const strict=await createToolbox({runDir:dir,input:{databaseTestMode:'contract-only',databaseChecks:[{name:'未实现的负数限制',sql:'INSERT INTO items(id) VALUES(-1);',expectError:true}]}});
  const tested=await strict.execute('test_database',{tests:[],queries:['SELECT COUNT(*) AS n FROM items;']},'liu');
  assert.equal(tested.evidence.passed,false);assert.equal(tested.evidence.contractCount,1);assert.equal(tested.evidence.contractTests[0].passed,false);assert.match(tested.evidence.contractTests[0].reason,/未触发预期约束拒绝/);assert.equal(tested.evidence.queries[0].rows[0].n,0);assert.match(tested.summary,/有失败项/);
 });
});

test('ordinary database requests retain additional tests and multiple SELECT queries',async()=>{
 await withBox({databaseChecks:[{name:'原始合同',sql:'SELECT id FROM items;',expectedRows:0}]},async box=>{
  await box.execute('design_database',{ddl:'CREATE TABLE items(id INTEGER PRIMARY KEY);'},'zhang');await box.execute('build_database',{},'ops');
  const tested=await box.execute('test_database',{tests:[{name:'手工附加插入',sql:'INSERT INTO items VALUES(1);',expectError:false}],queries:['SELECT COUNT(*) AS n FROM items;','SELECT 2 AS n;']},'liu');
  assert.equal(tested.evidence.passed,true);assert.equal(tested.evidence.tests.length,1);assert.equal(tested.evidence.contractTests.length,1);assert.equal(tested.evidence.queries.length,2);assert.equal(tested.evidence.additionalTestsNotRequested,undefined);
 });
});

test('expected database constraint failures do not accept SQL syntax errors, missing tables or missing columns',async()=>{
 for(const sql of ['INSERT INTO nonexistent(id) VALUES(1);','INSERT INTO suppliers(unknown_column) VALUES(1);','INSERT INTO suppliers(id,name) VALUES(1,);'])await withBox({databaseChecks:[{name:'必须真实触发约束',sql,expectError:true}]},async(box,dir)=>{await assert.rejects(()=>box.execute('design_database',{ddl:procurementPrototypeDdl},'zhang'),/SQL执行错误不能作为约束拒绝/);assert.equal(box.artifacts().length,0);await assert.rejects(fs.stat(path.join(dir,'database/schema.sql')),error=>error.code==='ENOENT');});
});

test('rejected design feedback includes executable NULL-currency and negative-price cases with SQLite constraint guidance',async()=>{
 const input=companyTaskInput('database',{name:COMPANY_NAME,verifiedFacts:[]}).input;
 const ddl=procurementPrototypeDdl.replace("currency TEXT NOT NULL CHECK(currency IN ('CNY','USD'))","currency TEXT CHECK(currency IN ('CNY','USD'))").replace(' CHECK(price IS NULL OR price>=0)','');
 await withBox(input,async(box,dir)=>{
  await assert.rejects(()=>box.execute('design_database',{ddl},'zhang'),error=>{
   assert.match(error.message,/CHECK结果为NULL不会拒绝/);assert.match(error.message,/必填列需NOT NULL/);assert.match(error.message,/非负限制必须落到DDL CHECK而非说明文字/);
   assert.match(error.message,/报价币种不能为NULL/);assert.match(error.message,/报价已知价格必须非负/);assert.match(error.message,/实际未被拒绝的SQL：INSERT INTO quotes/);
   assert(error.message.includes("VALUES(930005,920001,'https://example.invalid/sample-quote','2000-01-01T00:00:00Z',NULL,100,0)"));
   assert(error.message.includes("VALUES(930006,920001,'https://example.invalid/sample-quote','2000-01-01T00:00:00Z','CNY',-1,0)"));
   return true;
  });
  assert.equal(box.artifacts().length,0);await assert.rejects(fs.stat(path.join(dir,'database/schema.sql')),error=>error.code==='ENOENT');
 });
});

test('contract setup IntegrityError cannot masquerade as expected failure of the tested SQL',async()=>{
 const check={name:'种子准备必须独立成功',setupSql:"INSERT INTO suppliers(id,name) VALUES(1,'sample'); INSERT INTO suppliers(id,name) VALUES(1,'sample-duplicate');",sql:"INSERT INTO suppliers(id,name) VALUES(2,'sample-valid');",expectError:true};
 await withBox({databaseChecks:[check]},async box=>{await assert.rejects(()=>box.execute('design_database',{ddl:procurementPrototypeDdl},'zhang'),/样本准备失败，不能作为约束验收通过/);assert.equal(box.artifacts().length,0);});
});

test('design SQL contracts enforce query row counts and roll back every individual sample',async()=>{
 const check={name:'本用例只有自己的sample',setupSql:"INSERT INTO suppliers(id,name) VALUES(1,'sample');",sql:'SELECT id FROM suppliers;',expectedRows:1};
 await withBox({databaseChecks:[check,{...check,name:'第二用例可重用相同编号'}]},async box=>{const result=await box.execute('design_database',{ddl:procurementPrototypeDdl},'zhang');assert.equal(result.evidence.designChecks.testCount,2);assert(result.evidence.designChecks.tests.every(row=>row.rows.length===1&&row.passed));});
 await withBox({databaseChecks:[{...check,name:'错误行数必须失败',expectedRows:2}]},async box=>{await assert.rejects(()=>box.execute('design_database',{ddl:procurementPrototypeDdl},'zhang'),/查询预期2行，实际1行/);});
});

test('explicit SQL contract cannot disable foreign keys or attach files',async()=>{
 for(const check of [{name:'禁止关闭外键',sql:'PRAGMA foreign_keys=OFF;'},{name:'禁止种子跨文件',setupSql:"ATTACH '/tmp/forbidden.sqlite' AS other;",sql:'SELECT 1;'}])await withBox({databaseChecks:[check]},async box=>{await assert.rejects(()=>box.execute('design_database',{ddl:procurementPrototypeDdl},'zhang'),/不允许|禁止/);assert.equal(box.artifacts().length,0);});
});

test('DDoS uses actual varying log input; approval controls apply and replay computes exact rates',async()=>{
 const input=await example('ddos');for(const approved of [false,true])await withBox(input,async(box,dir)=>{await box.execute('inspect_network',{},'ops');const a=await box.execute('analyze_traffic',{threshold:20,windowSeconds:60},'liu');assert.deepEqual(a.evidence.suspectedSources.sort(),['203.0.113.201','203.0.113.202']);const d=await box.execute('apply_defense',{blockedIps:a.evidence.suspectedSources,rateLimit:null,reason:'证据显示两来源各130条高频请求；放行其余正常来源'},'zhang');assert.equal(d.evidence.approved,approved);const v=await box.execute('verify_network',{},'liu');assert.equal(v.evidence.normalRequests,60);assert.equal(v.evidence.maliciousRequests,260);assert.equal(v.evidence.normalPassRate,1);assert.equal(v.evidence.maliciousBlockRate,approved?1:0);assert.equal(v.evidence.verifiedRestored,approved);const conf=await fs.stat(path.join(dir,'network/nginx-defense.conf')).then(()=>true,()=>false);assert.equal(conf,approved);},approved);
});

test('delivery requires original quotes, computes dependency/cost deterministically and reuses packages',async()=>{
 const input={company:'服务系统',requirements:'需要工单创建和统计报表，第一期不做支付。',dailyRate:1500};await withBox(input,async box=>{await assert.rejects(()=>box.execute('extract_requirements',{requirements:[{id:'R1',description:'支付',source:'需要微信支付',acceptance:'支付通过'}]},'business'),/逐字引用/);await box.execute('extract_requirements',{requirements:[{id:'R1',description:'工单创建',source:'工单创建',acceptance:'可保存工单并查询'},{id:'R2',description:'统计报表',source:'统计报表',acceptance:'统计与实际工单数量一致'}]},'business');const first=await box.execute('estimate_delivery',{packages:[{id:'P1',name:'工单功能',days:4,dependsOn:[],requirementIds:['R1'],deliverable:'可用工单'},{id:'P2',name:'报表',days:2,dependsOn:['P1'],requirementIds:['R2'],deliverable:'统计报表'}],bufferPct:10},'business');const verify=await box.execute('estimate_delivery',{},'finance');assert.equal(first.evidence.totalCost,9900);assert.deepEqual(first.evidence,verify.evidence);assert.equal(first.evidence.packages[1].startDay,4);assert.equal((await box.execute('review_delivery',{},'liu')).evidence.passed,true);await assert.rejects(()=>box.execute('write_report',{title:'空报告',content:'完成'},'lead'),/至少100/);});
});

const numberedInput={company:'编号需求验收',requirements:'工作主体：用户提供的公司名称，业务情况待核实。\nR1：供应商有唯一内部编号和名称。R2: 服务器候选关联存在的供应商，记录型号。\nR3：报价关联存在的候选，已知价格非负，未知价格保留NULL。\nR4：能查询每个候选的报价来源与时间。\n共同交付说明：交付SQLite、DDL和约束测试回执。'};
const numberedRows=()=>[
 {id:'R1',description:'登记供应商',source:'供应商有唯一内部编号和名称。',acceptance:'唯一编号约束可执行'},
 {id:'R2',description:'关联服务器候选',source:'服务器候选关联存在的供应商，记录型号。',acceptance:'不存在的供应商无法被关联'},
 {id:'R3',description:'保存候选报价',source:'报价关联存在的候选，已知价格非负，未知价格保留NULL。',acceptance:'负价被拒绝，空价格可保存'},
 {id:'R4',description:'查询报价依据',source:'能查询每个候选的报价来源与时间。',acceptance:'查询返回候选对应的来源和时间'},
];

test('explicit numbered requirements reject omitted R4 without saving a successful specification',async()=>{
 await withBox(numberedInput,async(box,dir)=>{await assert.rejects(()=>box.execute('extract_requirements',{requirements:numberedRows().slice(0,3)},'business'),/缺少需求ID：R4/);assert.equal(box.artifacts().length,0);await assert.rejects(fs.stat(path.join(dir,'delivery/requirements.json')),error=>error.code==='ENOENT');});
});

test('explicit requirement sources must quote their own clauses rather than background or another ID',async()=>{
 for(const [id,source] of [['R1','工作主体：用户提供的公司名称，业务情况待核实。'],['R4','供应商有唯一内部编号和名称。'],['R4','交付SQLite、DDL和约束测试回执。']])await withBox(numberedInput,async box=>{const rows=numberedRows();rows.find(row=>row.id===id).source=source;await assert.rejects(()=>box.execute('extract_requirements',{requirements:rows},'business'),new RegExp('需求'+id+'.*对应的业务条款'));assert.equal(box.artifacts().length,0);});
});

test('all original numbered requirements pass with exact same-ID quotes and remain unapproved',async()=>{
 await withBox(numberedInput,async(box,dir)=>{const rows=numberedRows();rows[1].source='R2: 服务器候选关联存在的供应商，记录型号。';const result=await box.execute('extract_requirements',{requirements:rows},'business');assert.deepEqual(result.evidence.requirements.map(row=>row.id),['R1','R2','R3','R4']);assert(result.evidence.requirements.every(row=>row.confirmedByCustomer===false));assert.equal(result.artifacts.length,2);const saved=JSON.parse(await fs.readFile(path.join(dir,'delivery/requirements.json'),'utf8'));assert.equal(saved.requirements[3].source,'能查询每个候选的报价来源与时间。');});
});

test('common handover notes can be separate requirements but cannot replace the final numbered clause',async()=>{
 const input={requirements:'R1：记录名称。R2：记录来源URL。交付SQLite和测试回执。'};
 await withBox(input,async box=>{const rows=[{id:'R1',description:'名称',source:'记录名称。',acceptance:'名称可保存'},{id:'R2',description:'来源',source:'记录来源URL。',acceptance:'来源可查询'},{id:'R3',description:'交付物',source:'交付SQLite和测试回执。',acceptance:'文件可下载'}];assert.equal((await box.execute('extract_requirements',{requirements:rows},'business')).evidence.requirements.length,3);rows[1].source='交付SQLite和测试回执。';await assert.rejects(()=>box.execute('extract_requirements',{requirements:rows},'business'),/需求R2.*共同交付说明/);});
});

test('a numbered business clause may itself start with delivery wording',async()=>{
 await withBox({requirements:'R1：交付文件需要记录来源URL。R2：\n交付报告可以按任务编号查询。\n共同交付说明：保留验收清单。'},async box=>{const rows=[{id:'R1',description:'文件来源',source:'交付文件需要记录来源URL。',acceptance:'来源可查'},{id:'R2',description:'报告查询',source:'交付报告可以按任务编号查询。',acceptance:'编号可查'}];assert.equal((await box.execute('extract_requirements',{requirements:rows},'business')).evidence.requirements.length,2);});
});

test('unnumbered input keeps existing quote extraction behavior; one R label does not enable coverage rules',async()=>{
 for(const requirements of ['需要工单创建和统计报表，第一期不做支付。','背景备注R9：讨论工单创建，另外需要统计报表。'])await withBox({requirements},async box=>{const result=await box.execute('extract_requirements',{requirements:[{id:'R1',description:'工单',source:'工单创建',acceptance:'可创建工单'},{id:'R2',description:'统计',source:'统计报表',acceptance:'与数据一致'}]},'business');assert.equal(result.evidence.requirements.length,2);});
});

test('repeated original labels need unique coverage once, and arbitrary renumbering is rejected',async()=>{
 await withBox({requirements:'R1：保存订单。R2：查询订单。共同交付说明：包含R1：保存订单的测试记录。'},async box=>{const rows=[{id:'R1',description:'保存订单',source:'保存订单。',acceptance:'可保存'},{id:'R2',description:'查询订单',source:'查询订单。',acceptance:'可查询'}];assert.equal((await box.execute('extract_requirements',{requirements:rows},'business')).evidence.requirements.length,2);await assert.rejects(()=>box.execute('extract_requirements',{requirements:[...rows,{id:'R3',description:'重复拆分',source:'保存订单。',acceptance:'可保存'}]},'business'),/不是原文编号/);});
});

test('DDoS mixed unknown labels cannot be declared fully verified',async()=>{
 const original=await example('ddos');const logs=JSON.parse(original.logs.text);logs.push({ip:'192.0.2.200',timestamp:'2026-10-17T09:00:45+08:00',method:'GET',path:'/unknown',status:200,label:'unknown'});
 await withBox({...original,logs:{name:'mixed.json',text:JSON.stringify(logs)}},async box=>{await box.execute('inspect_network',{},'ops');await box.execute('analyze_traffic',{},'liu');await box.execute('apply_defense',{blockedIps:['203.0.113.201','203.0.113.202'],reason:'依据高频来源，仅隔离副本'},'zhang');const result=await box.execute('verify_network',{},'liu');assert.equal(result.evidence.normalPassRate,1);assert.equal(result.evidence.maliciousBlockRate,1);assert.equal(result.evidence.unknownLabelRequests,1);assert.equal(result.evidence.verifiedRestored,false);});
});


test('finance supports real XLSX uploads and rejects uncalculated formulas',async()=>{
 const input=await example('finance');const dir=await tmp();
 try{
  const result=spawnSync('/usr/bin/python3',['-B','-c',`import sys,json,csv,io,importlib.util,pathlib
spec=importlib.util.spec_from_file_location('office',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);m.ROOT=pathlib.Path(sys.argv[2]).resolve()
rows=list(csv.reader(io.StringIO(sys.stdin.read())))
for row in rows[1:]:
 for i,x in enumerate(row):row[i]=float(x) if '.' in x else int(x)
m.xlsx_write('upload.xlsx',[('monthly',rows)])
import zipfile
with zipfile.ZipFile(m.path('upload.xlsx')) as z:
 with zipfile.ZipFile(m.path('formula.xlsx'),'w') as out:
  for name in z.namelist():
   data=z.read(name)
   if name=='xl/worksheets/sheet1.xml':data=data.replace(b'<c r="C2">',b'<c r="C2"><f>1+1</f>')
   out.writestr(name,data)`,path.resolve('tools/office_tools.py'),dir],{input:input.data.text,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  const base64=(await fs.readFile(path.join(dir,'upload.xlsx'))).toString('base64');await withBox({...input,data:{name:'monthly.xlsx',base64}},async box=>{const r=await box.execute('import_finance',{},'ops');assert.equal(r.evidence.rows,24);});
  const formula=(await fs.readFile(path.join(dir,'formula.xlsx'))).toString('base64');await withBox({...input,data:{name:'formula.xlsx',base64:formula}},async box=>{await assert.rejects(()=>box.execute('import_finance',{},'ops'),/不接受公式/);});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('downloadable reports format tables/code and escape untrusted active HTML',async()=>{
 await withBox({},async(box,dir)=>{const title='数据库交付';const content='# '+title+'\n\n## 验收结果\n\n| 规则 | 结果 |\n| --- | --- |\n| 外键 | 已验证 |\n\n```sql\nSELECT * FROM customers;\n```\n\n<script>alert("untrusted")</script>\n\n'+('本报告只使用本次工具返回的真实结果，不构成外部承诺。'.repeat(5));const r=await box.execute('write_report',{title,content},'lead');const html=await fs.readFile(path.join(dir,r.files.find(x=>x.endsWith('.html'))),'utf8');assert(html.includes('<table>'));assert(html.includes('<pre><code>SELECT'));assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));assert.equal((html.match(/<h1>/g)||[]).length,1);});
});

test('multi-table import is order independent and commit rejects missing parents without keeping bad DB',async()=>{
 const ddl='CREATE TABLE parents(id INTEGER PRIMARY KEY,name TEXT NOT NULL); CREATE TABLE children(id INTEGER PRIMARY KEY,parent_id INTEGER NOT NULL REFERENCES parents(id));';
 await withBox({data:{name:'child-first.json',text:JSON.stringify({children:[{id:1,parent_id:7}],parents:[{id:7,name:'parent'}]})}},async(box)=>{await box.execute('design_database',{ddl},'zhang');const built=await box.execute('build_database',{},'ops');assert.equal(built.evidence.importedRows,2);const tested=await box.execute('test_database',{queries:['SELECT p.name,c.id FROM children c JOIN parents p ON c.parent_id=p.id']},'liu');assert.equal(tested.evidence.passed,true);assert.equal(tested.evidence.queries[0].rows[0].name,'parent');});
 await withBox({data:{name:'missing-parent.json',text:JSON.stringify({children:[{id:1,parent_id:99}],parents:[]})}},async(box,dir)=>{await box.execute('design_database',{ddl},'zhang');await assert.rejects(()=>box.execute('build_database',{},'ops'),/FOREIGN KEY constraint failed/);assert.equal(await fs.stat(path.join(dir,'database/company.sqlite')).then(()=>true,()=>false),false);assert(!box.artifacts().some(a=>a.name==='company.sqlite'));});
});

test('uploaded explicit example data stays labelled sample rather than business records',async()=>{
 const data={name:'explicit-sample.json',text:JSON.stringify({items:[{id:1,name:'验收样本'},{id:2,name:'验收样本二'}]})};
 for(const exampleFlag of [true,false])await withBox({data,example:exampleFlag},async box=>{await box.execute('design_database',{ddl:'CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT NOT NULL);'},'zhang');const r=await box.execute('build_database',{},'ops');assert.equal(r.evidence.importedRows,2);assert.equal(r.evidence.validationSamplesOnly,exampleFlag);assert.equal(r.evidence.importedBusinessRows,exampleFlag?0:2);assert.equal(r.evidence.validationSampleRows,exampleFlag?2:0);assert.equal(r.evidence.sampleSource,exampleFlag?'explicit_example_input':'user_upload');assert(r.summary.includes(exampleFlag?'示例/验收记录':'用户提供的记录'));});
});
