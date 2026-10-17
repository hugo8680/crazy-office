import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createToolbox,isPublicAddress,validatePublicUrl} from '../server/tools.mjs';
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

test('DDoS uses actual varying log input; approval controls apply and replay computes exact rates',async()=>{
 const input=await example('ddos');for(const approved of [false,true])await withBox(input,async(box,dir)=>{await box.execute('inspect_network',{},'ops');const a=await box.execute('analyze_traffic',{threshold:20,windowSeconds:60},'liu');assert.deepEqual(a.evidence.suspectedSources.sort(),['203.0.113.201','203.0.113.202']);const d=await box.execute('apply_defense',{blockedIps:a.evidence.suspectedSources,rateLimit:null,reason:'证据显示两来源各130条高频请求；放行其余正常来源'},'zhang');assert.equal(d.evidence.approved,approved);const v=await box.execute('verify_network',{},'liu');assert.equal(v.evidence.normalRequests,60);assert.equal(v.evidence.maliciousRequests,260);assert.equal(v.evidence.normalPassRate,1);assert.equal(v.evidence.maliciousBlockRate,approved?1:0);assert.equal(v.evidence.verifiedRestored,approved);const conf=await fs.stat(path.join(dir,'network/nginx-defense.conf')).then(()=>true,()=>false);assert.equal(conf,approved);},approved);
});

test('delivery requires original quotes, computes dependency/cost deterministically and reuses packages',async()=>{
 const input={company:'服务系统',requirements:'需要工单创建和统计报表，第一期不做支付。',dailyRate:1500};await withBox(input,async box=>{await assert.rejects(()=>box.execute('extract_requirements',{requirements:[{id:'R1',description:'支付',source:'需要微信支付',acceptance:'支付通过'}]},'business'),/逐字引用/);await box.execute('extract_requirements',{requirements:[{id:'R1',description:'工单创建',source:'工单创建',acceptance:'可保存工单并查询'},{id:'R2',description:'统计报表',source:'统计报表',acceptance:'统计与实际工单数量一致'}]},'business');const first=await box.execute('estimate_delivery',{packages:[{id:'P1',name:'工单功能',days:4,dependsOn:[],requirementIds:['R1'],deliverable:'可用工单'},{id:'P2',name:'报表',days:2,dependsOn:['P1'],requirementIds:['R2'],deliverable:'统计报表'}],bufferPct:10},'business');const verify=await box.execute('estimate_delivery',{},'finance');assert.equal(first.evidence.totalCost,9900);assert.deepEqual(first.evidence,verify.evidence);assert.equal(first.evidence.packages[1].startDay,4);assert.equal((await box.execute('review_delivery',{},'liu')).evidence.passed,true);await assert.rejects(()=>box.execute('write_report',{title:'空报告',content:'完成'},'lead'),/至少100/);});
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
