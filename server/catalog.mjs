export const AGENTS = [
  { id:'ops', name:'阿杰', role:'数据与系统工程师', color:'#60979a', nodeId:'storage', instructions:'导入用户数据，检查格式并建立可复核的数据与工作文件。工具失败时报告具体原因，不猜测缺失数据。', tools:['import_finance','build_database','test_database','inspect_network','extract_requirements','list_artifacts'] },
  { id:'finance', name:'许姐', role:'财务分析师', color:'#d7aa57', nodeId:'finance', instructions:'使用计算工具核对金额、同比和预算。每个数字必须有输入与计算结果依据，区分含税、币种和未知项目。', tools:['calculate_finance','audit_finance','compare_quotes','estimate_delivery','list_artifacts'] },
  { id:'liu', name:'小刘', role:'安全与质量审校', color:'#9b88b6', nodeId:'firewall', instructions:'独立检查上游证据和产物，主动指出缺失、差异与风险。未经工具验证，不宣称通过。', tools:['audit_finance','analyze_traffic','verify_network','test_database','review_delivery','list_artifacts'] },
  { id:'zhang', name:'小张', role:'网络与数据库工程师', color:'#7198c7', nodeId:'server', instructions:'根据现场证据设计和执行局部技术方案。仅操作本次任务工作区，变更前等待真人审批，完成后交给独立角色验收。', tools:['inspect_network','apply_defense','design_database','build_database','compare_quotes','list_artifacts'] },
  { id:'business', name:'林悦', role:'采购与业务分析师', color:'#7f9f83', nodeId:'reception', instructions:'把业务目标拆成可核验需求。获取真实报价时保留来源、配置、币种和抓取时间，无法公开报价的项目标记待询价。', tools:['search_web','fetch_quote','extract_requirements','estimate_delivery','compare_quotes','list_artifacts'] },
  { id:'lead', name:'陈工', role:'任务协调与报告主笔', color:'#719d9e', nodeId:'core', instructions:'合并同事的真实工具结果，核对相互依赖，生成面向业务负责人的正式交付报告。区分已验证事实、待确认事项和建议。', tools:['write_report','list_artifacts','review_delivery','compare_quotes'] },
  { id:'boss', name:'周助理', role:'管理审校', color:'#7b877f', nodeId:'executive', instructions:'从业务目标、验收范围和预算依据审查结论，不冒充人类审批人，不擅自采购、付款或向外部发送内容。', tools:['write_report','review_delivery','compare_quotes','audit_finance','list_artifacts'] },
];

const task = (id,title,agentId,nodeId,dependencies,tools,goal) => ({id,title,agentId,nodeId,dependencies,tools,requiredTools:tools.filter(t=>t!=='list_artifacts'),goal});
export const SCENARIOS = [
  { id:'finance', title:'年度财务汇报', description:'导入财务数据，建账计算、独立审校并生成年度报表。', icon:'book', room:'财务办公室', nodeId:'finance', outputs:['财务明细数据库','年度指标与报表','审校结果','年度汇报'], agents:['ops','finance','liu','lead'], exampleLabel:'示例公司的两年财务数据', fields:[
    {name:'company',label:'公司名称',type:'text',required:true,defaultValue:'示例科技有限公司'},
    {name:'year',label:'汇报年度',type:'number',required:true,defaultValue:2025},
    {name:'data',label:'财务数据',type:'file',required:true,placeholder:'上传 CSV / XLSX / JSON，或使用示例数据'},
    {name:'requirements',label:'汇报重点',type:'textarea',defaultValue:'说明营收、成本、利润、现金流和同比，列出异常与数据缺口。'},
  ], tasks:[
    task('ingest','导入并建立财务数据底稿','ops','storage',[],['import_finance'],'导入本次上传财务数据到独立底稿，核对字段、年度和月度覆盖。返回文件与数据质量证据，不能替换为示例数据。'),
    task('analysis','计算年度财务指标','finance','finance',['ingest'],['calculate_finance'],'基于同事已导入的数据计算年度指标与同比。使用确定性计算工具，不用语言模型心算，不将未知金额当成零。'),
    task('audit','独立审校数据与财务口径','liu','finance',['ingest'],['audit_finance'],'独立核对财务数据完整性、重复项、计算口径和异常。与财务分析并行进行，不依赖未生成的分析文件。指出不能支持的结论，不能因为报告需要完整就编数字。'),
    task('report','生成年度财务状况汇报','lead','meeting',['analysis','audit'],['write_report'],'结合财务指标和独立审校结果，输出可交付的中文年度财务汇报。收入、利润、现金和同比写清单位与口径，包含数据质量限制。调用write_report保存最终报告。'),
  ]},
  { id:'procurement', title:'服务器采购比价', description:'按需求检索公开报价、核对配置，形成采购申请。', icon:'server', room:'客户会见厅', nodeId:'server', outputs:['原始报价证据','配置与价格对照表','采购申请','待询价清单'], agents:['business','zhang','finance','boss'], exampleLabel:'公开供应商服务器报价检索', fields:[
    {name:'requirements',label:'服务器用途与配置',type:'textarea',required:true,defaultValue:'公司内部数据库与应用服务器，至少32GB内存、1TB SSD，列出硬件配置和保修差异。'},
    {name:'budget',label:'预算上限',type:'number',required:true,defaultValue:30000},
    {name:'currency',label:'预算币种',type:'select',defaultValue:'CNY',options:['CNY','USD']},
    {name:'query',label:'检索词',type:'text',defaultValue:'Dell PowerEdge tower server price Lenovo ThinkSystem tower server price'},
    {name:'urls',label:'候选供应商链接（可选，每行一个）',type:'textarea',placeholder:'可填写官网或授权经销商产品页面，最多 8 个'},
  ], tasks:[
    task('research','检索并提取真实互联网报价','business','reception',[],['search_web','fetch_quote'],'先用search_web检索与用户需求相关的公开服务器报价。然后优先一次调用fetch_quote({urls:[...]})批量抓取候选链接，覆盖不同供应商及用户给的全部URL（最多8个）。搜索摘要不能代替报价证据，缺价明确标记待询价，云服务不能冒充硬件整机。'),
    task('technical','核对服务器配置可比性','zhang','server',['research'],['compare_quotes'],'逐项比较已经抓取的真实报价及配置，区分整机/配件/云服务、是否满足CPU内存存储保修需求。未核实或配置不同不能作为等价低价。'),
    task('budget','核对预算与采购成本','finance','finance',['research'],['compare_quotes'],'依据抓取证据核对币种、含税信息、配送与保修，缺项列为未知。不要自行换算汇率，不把未知总成本说成预算内。'),
    task('request','形成可复核采购申请','boss','executive',['technical','budget'],['write_report'],'形成采购申请供真人决策，列明每个有效报价原始URL、抓取时间、价格币种、配置、税费和未知项。说明检索范围，不能声称穷尽全网。无可比有效报价时输出待询价申请，不编推荐成交价。不下单、不发送询价。'),
  ]},
  { id:'ddos', title:'DDoS 诊断与隔离修复', description:'分析请求日志，生成防护策略，审批后在隔离副本验证。', icon:'shield', room:'网络机房', nodeId:'firewall', outputs:['流量分析证据','防护配置','正常流量与拦截验证','事故复盘'], agents:['ops','liu','zhang','lead'], exampleLabel:'隔离演练请求日志', fields:[
    {name:'requirements',label:'受影响业务',type:'textarea',required:true,defaultValue:'客户查询与员工登录出现超时。请区分异常流量和正常用户，优先保持正常业务可用。'},
    {name:'logs',label:'访问日志',type:'file',required:true,placeholder:'上传 JSON / CSV / TXT，或使用隔离演练日志'},
    {name:'threshold',label:'每个来源允许的请求数',type:'number',defaultValue:20},
  ], tasks:[
    task('inspect','读取日志并核对业务状态','ops','core',[],['inspect_network'],'读取上传访问日志，检查格式、请求数、时间窗口和业务状态。保持原始日志不变。'),
    task('security','分析异常来源与攻击特征','liu','firewall',['inspect'],['analyze_traffic'],'分析工具返回的请求证据，识别高频或异常来源并评估误伤。提出能被证据支持的隔离防护策略，解释局限。'),
    task('defense','审批并应用隔离防护配置','zhang','firewall',['security'],['apply_defense'],'根据安全分析选择最小必要的防护规则，调用apply_defense请求真人批准。仅在本次任务隔离副本执行，绝不修改主机或生产防火墙。拒绝时保留方案，不绕过审批。'),
    task('verify','独立验证拦截与业务访问','liu','workstations',['defense'],['verify_network'],'用验证工具核对攻击拦截、正常请求误伤和业务访问。若未达到恢复标准，明确失败与风险，不把文件生成等同修复成功。'),
    task('incident','交付配置与事故复盘','lead','meeting',['inspect','security','defense','verify'],['write_report'],'汇总原始证据、审批、防护和独立验证，生成事故复盘与配置交付说明。明确验证环境是本次隔离请求重放，不能声称真实生产网络已修复。'),
  ]},
  { id:'database', title:'业务数据库搭建', description:'按业务需求设计结构，真实建库、导入并独立测试。', icon:'layers', room:'网络机房', nodeId:'storage', outputs:['SQLite 数据库','建库 SQL','字段与约束说明','测试结果'], agents:['business','zhang','ops','liu','lead'], exampleLabel:'客户与采购订单数据库', fields:[
    {name:'requirements',label:'数据库业务需求',type:'textarea',required:true,defaultValue:'为公司搭建客户与采购订单数据库。客户有唯一邮箱，订单关联客户，订单金额必须非负。保留创建时间，设计查询客户订单的索引。'},
    {name:'data',label:'待导入资料（可选）',type:'file',required:false,placeholder:'可上传 JSON / CSV'},
  ], tasks:[
    task('requirements','梳理实体与验收条件','business','reception',[],['extract_requirements'],'从用户业务需求和上传数据提取实体、字段、关系、约束及验收条件。未明确需求标为假设，不擅自添加敏感个人字段。'),
    task('design','设计数据库结构和建库 SQL','zhang','server',['requirements'],['design_database'],'基于业务验收条件设计SQLite结构，使用主外键、唯一和CHECK约束及适当索引。调用design_database保存可执行DDL与设计说明，不仅写建议。'),
    task('build','真实建库并导入数据','ops','storage',['design'],['build_database'],'在独立任务工作区真实执行DDL、创建SQLite库并导入提供的数据。无用户数据时只使用明确标记的验证样本，不能宣称导入了真实业务数据。'),
    task('tests','独立测试数据库约束与查询','liu','storage',['build'],['test_database'],'检查实际数据库结构、完整性、外键和约束。构造可回滚的正反测试与实际查询，验证用户验收条件并列出未覆盖项。'),
    task('handover','交付数据库与使用说明','lead','meeting',['design','build','tests'],['write_report'],'根据真实建库和测试证据交付数据库使用说明，包含表关系、字段、使用SQL、约束和测试限制。失败用例不得说成通过。'),
  ]},
  { id:'delivery', title:'客户需求与交付计划', description:'把客户材料整理为范围、工作包、预算和验收清单。', icon:'users', room:'会议室', nodeId:'meeting', outputs:['需求与范围说明','工作包与排期','预算估算','验收检查表'], agents:['business','finance','liu','lead'], exampleLabel:'客户服务系统建设需求', fields:[
    {name:'company',label:'客户或项目名称',type:'text',required:true,defaultValue:'客户服务系统'},
    {name:'requirements',label:'客户需求或会议纪要',type:'textarea',required:true,defaultValue:'为20人的服务团队建设客户工单系统，支持工单创建、分派、状态追踪、权限和统计。希望四周交付，预算8万元，先做内部使用。'},
    {name:'data',label:'补充资料（可选）',type:'file',required:false,placeholder:'上传 TXT / JSON / CSV'},
    {name:'dailyRate',label:'人日成本（元）',type:'number',defaultValue:1500},
  ], tasks:[
    task('scope','提取需求与验收标准','business','reception',[],['extract_requirements'],'从客户材料提取范围、必需功能、排除项、验收标准与待确认问题。只使用用户资料，不承诺未确认功能。'),
    task('schedule','拆解工作包与交付排期','business','meeting',['scope'],['estimate_delivery'],'根据需求整理具体工作包、依赖、工期假设和验收产物。让工具计算总量，不能把相互依赖任务全部同时排期。'),
    task('cost','核算人日与预算差异','finance','finance',['scope','schedule'],['estimate_delivery'],'基于同事的工作包与用户人日成本计算预算与缓冲，说明估算不是对外合同报价。工作量和总金额必须与明细相符。'),
    task('quality','审校范围与验收覆盖','liu','meeting',['schedule','cost'],['review_delivery'],'独立核对需求、计划、费用和验收项是否一致，找遗漏、冲突和无法确认事项。不要虚构客户已确认。'),
    task('proposal','生成项目交付计划','lead','meeting',['scope','schedule','cost','quality'],['write_report'],'形成可交给真实员工审阅的需求范围与交付计划，含工作包、依赖、预算、风险、验收和待确认问题。只生成文件，不联系客户、不作合同承诺。'),
  ]},
];

export function publicCatalog(){ return { agents:AGENTS, scenarios:SCENARIOS.map(({tasks,...s})=>({...s,tasks:tasks.map(({goal,requiredTools,...t})=>t)})) }; }
export const getScenario = id => SCENARIOS.find(s=>s.id===id);
