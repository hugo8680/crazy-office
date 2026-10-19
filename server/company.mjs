import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const DEFAULT_COMPANY_FILE=fileURLToPath(new URL('../data/company/profile.json',import.meta.url));
export const COMPANY_NAME='吉林云投莱森购数字科技有限公司';

function prototypeDatabaseChecks(){
  const clear='DELETE FROM quotes; DELETE FROM candidates; DELETE FROM suppliers;';
  const supplier="INSERT INTO suppliers(id,name) VALUES(910001,'sample-contract-supplier');";
  const candidate="INSERT INTO candidates(id,supplier_id,model,memory_gb,ssd_gb) VALUES(920001,910001,'sample-contract-server',32,1024);";
  const setup=clear+supplier+candidate;
  const quote=(id,currency,price,candidateId=920001)=>"INSERT INTO quotes(id,candidate_id,source_url,fetched_at,currency,price,tax_known) VALUES("+id+","+candidateId+",'https://example.invalid/sample-quote','2000-01-01T00:00:00Z',"+currency+","+price+",0);";
  return [
    {name:'CNY与USD及税费标记0或1合法，零价格和NULL价格合法',setupSql:setup,sql:quote(930001,"'CNY'",0)+quote(930002,"'USD'",20)+quote(930003,"'CNY'",'NULL')+'UPDATE quotes SET tax_known=1 WHERE id=930002; SELECT id,currency,price FROM quotes ORDER BY id;',expectedRows:3},
    {name:'供应商内部编号唯一',setupSql:clear+supplier,sql:"INSERT INTO suppliers(id,name) VALUES(910001,'sample-duplicate-supplier');",expectError:true},
    {name:'供应商名称不能为NULL',setupSql:clear,sql:'INSERT INTO suppliers(id,name) VALUES(910002,NULL);',expectError:true},
    {name:'报价拒绝CNY和USD之外的币种',setupSql:setup,sql:quote(930004,"'EUR'",100),expectError:true},
    {name:'报价币种不能为NULL',setupSql:setup,sql:quote(930005,'NULL',100),expectError:true},
    {name:'报价已知价格必须非负',setupSql:setup,sql:quote(930006,"'CNY'",-1),expectError:true},
    {name:'税费是否已知只接受0或1',setupSql:setup,sql:quote(930009,"'CNY'",0).replace(',0);',',2);'),expectError:true},
    {name:'税费是否已知不能为NULL',setupSql:setup,sql:quote(930010,"'CNY'",0).replace(',0);',',NULL);'),expectError:true},
    {name:'服务器候选拒绝悬空供应商',setupSql:clear+supplier,sql:"INSERT INTO candidates(id,supplier_id,model,memory_gb,ssd_gb) VALUES(920002,919999,'sample-orphan-server',32,1024);",expectError:true},
    {name:'报价拒绝悬空服务器候选',setupSql:setup,sql:quote(930007,"'CNY'",100,929999),expectError:true},
    {name:'能查询候选关联报价的来源与抓取时间',setupSql:setup+quote(930008,"'CNY'",'NULL'),sql:"SELECT c.model,q.source_url,q.fetched_at FROM candidates c JOIN quotes q ON q.candidate_id=c.id WHERE c.id=920001 AND q.source_url='https://example.invalid/sample-quote' AND q.fetched_at='2000-01-01T00:00:00Z';",expectedRows:1},
  ];
}

function prototypeDatabaseData(){
  return {name:'sample-validation-data.json',text:JSON.stringify({
    suppliers:[{id:1,name:'sample-validation-supplier'}],
    candidates:[{id:1,supplier_id:1,model:'sample-validation-server',memory_gb:32,ssd_gb:1024}],
    quotes:[{id:1,candidate_id:1,source_url:'https://example.invalid/sample-quote',fetched_at:'2000-01-01T00:00:00Z',currency:'CNY',price:null,tax_known:0}],
  })};
}

// Only supplied or independently checked facts belong in this profile. Planning
// inputs below are work requests, and must never be described as company history.
export async function loadCompanyProfile(file=DEFAULT_COMPANY_FILE){
  let value={};
  try{value=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  return {
    name:typeof value.name==='string'&&value.name.trim()?value.name.trim():COMPANY_NAME,
    source:typeof value.source==='string'?value.source:'user-provided',
    verifiedFacts:Array.isArray(value.verifiedFacts)?value.verifiedFacts:[],
    sources:Array.isArray(value.sources)?value.sources:[],
    updatedAt:typeof value.updatedAt==='string'?value.updatedAt:null,
  };
}

export function companyTaskInput(scenarioId,profile,provided={}){
  const explicit=provided?.[scenarioId];
  if(explicit&&typeof explicit==='object'&&!Array.isArray(explicit)){
    if(explicit.example===true||explicit.isExample===true)return {available:false,reason:'自动任务需要真实任务资料；示例数据请手动运行。'};
    return {available:true,input:structuredClone(explicit),templateId:'provided-'+scenarioId,inputBasis:'真实员工提供的任务资料'};
  }
  const name=profile.name;
  const facts=profile.verifiedFacts.length?'\n已核实公司资料：'+JSON.stringify(profile.verifiedFacts):'\n公司主体名称由用户提供，其他公司情况尚未核实；不能推测公司规模、营收、客户、人员或既有系统。';
  const context=`工作主体：${name}。本次由自动派工创建的内部准备任务，需求是待审草案，不能写成公司已发生的事实。${facts}`;
  const templates={
    database:{
      input:{requirements:context+'\n任务：搭建隔离的采购候选数据库原型，仅以下四项需求。R1：suppliers(id,name)，供应商内部编号id唯一，名称name不能为NULL。R2：candidates(id,supplier_id,model,memory_gb,ssd_gb)，supplier_id外键关联存在的suppliers.id，记录型号、内存GB和SSD容量GB。R3：quotes(id,candidate_id,source_url,fetched_at,currency,price,tax_known)，candidate_id外键关联存在的candidates.id；记录来源URL和抓取时间，currency必须非空且仅CNY或USD，price可空但已知价格非负，未知保留NULL，tax_known以0或1记录税费是否已知。R4：能查询每个候选关联报价的source_url与fetched_at。\n共同交付说明：以上英文表名及列名为本次内部原型接口合同，不代表公司既有生产表结构。由模型自行设计真实DDL、约束和索引，不新增影响样本导入的必填字段。input.databaseChecks是确定性验收合同，design_database会真实执行，失败须修正DDL后重试。input.data是唯一一组三表各1条的sample验证数据，来源example.invalid和2000年时间均为测试占位，不是公司真实供应商或真实报价；build_database直接读取data导入，不混入自造样本SQL。交付SQLite、DDL、design-checks及各约束独立测试回执；需求拆为四条即可。',databaseChecks:prototypeDatabaseChecks(),data:prototypeDatabaseData(),isExample:true},
      templateId:'procurement-registry-prototype',inputBasis:'内部数据库原型需求；无公司真实采购数据',
    },
    delivery:{
      input:{company:name+' · 内部需求草案',requirements:context+'\n任务：为内部任务登记工具编制交付计划草案，仅三项需求。R1：登记任务、负责人角色和执行状态。R2：记录真实员工的审批状态，虚拟员工不能代批。R3：验收记录关联可下载的交付文件。拆成不超过四个工作包，计算依赖、人日和费用，列待确认项。1500元/人日仅为可替换估算假设；工期、人员和预算均未获公司确认，不作合同承诺。',dailyRate:1500},
      templateId:'internal-delivery-draft',inputBasis:'内部需求草案；1500元/人日为估算假设',
    },
    procurement:{
      input:{requirements:context+'\n任务：开展一轮公开服务器报价调研，比较适合内部应用与数据库原型的塔式服务器候选，调研筛选条件暂定至少32GB内存和1TB SSD。30000元仅为本次比价筛选上限，不代表已批准的采购预算。必须真实抓取公开供应商页面并保留链接、时间、配置、价格币种、税费和保修差异。无法公开定价则列为待询价，不将云服务或配件当整机；不得声称已采购、已联系供应商或已批准预算。',budget:30000,currency:'CNY',query:'Dell PowerEdge Lenovo ThinkSystem 塔式服务器 32GB 1TB SSD 价格',urls:''},
      templateId:'public-server-price-research',inputBasis:'公开报价调研；配置和筛选上限为待审条件',
    },
  };
  if(templates[scenarioId])return {available:true,...templates[scenarioId]};
  const reasons={finance:'尚未提供公司真实财务数据。',onboarding:'尚未提供已确认录用员工的真实登记资料。',investment:'尚未提供拟投资项目及尽调资料。',ddos:'尚未提供访问日志与隔离演练范围。'};
  return {available:false,reason:reasons[scenarioId]||'尚未提供本场景任务资料。'};
}
