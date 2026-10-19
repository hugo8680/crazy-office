// Business acceptance is derived from tool receipts, never from model prose or
// the orchestration status alone. This module deliberately performs no I/O.
const list = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const text = (value, max = 300) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const lower = value => text(value).toLowerCase();
const count = value => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const unique = values => [...new Set(values.filter(Boolean))];
const fileName = value => text(value, 600).replace(/\\/g, '/').split('/').at(-1) || '';
const validId = value => typeof value === 'string' && /^[a-z0-9_-]{1,120}$/i.test(value);
const known = value => typeof value === 'string' && !!value.trim() && !/未知|未核|待|请核|不明|unknown|unverified|pending|n\/a|tbd/i.test(value);
const labels = {
  verified:'已通过本次检查', needs_review:'需要复核', incomplete:'结果不完整',
  awaiting_approval:'等待真人审批', failed:'执行中断', cancelled:'已取消', running:'协作进行中',
};

function receipts(run) {
  const rows = [];
  for (const [taskIndex, task] of list(run.tasks).entries()) {
    for (const [index, entry] of list(task?.toolResults).entries()) {
      const result = object(entry?.result);
      if (!result || !text(entry?.tool)) continue;
      rows.push({tool:lower(entry.tool), result, evidence:object(result.evidence) || result,
        taskId:text(task.id) || String(taskIndex), taskIndex, index,
        time:Date.parse(entry.createdAt || entry.finishedAt || task.finishedAt || task.startedAt || '') || 0});
    }
  }
  // Tasks can run in parallel. An entry's timestamp, when available, takes
  // precedence over the catalogue order; retries within one task retain order.
  rows.sort((a, b) => a.taskId === b.taskId ? a.index - b.index :
    a.time && b.time && a.time !== b.time ? a.time - b.time : a.taskIndex - b.taskIndex);
  const latest = new Map(), perTask = new Map();
  for (const row of rows) { latest.set(row.tool, row); perTask.set(row.taskId + ':' + row.tool, row); }
  return {rows, latest, perTask};
}

function artifactGroups(run, rows) {
  const declared = new Map();
  for (const row of rows) for (const item of list(row.result.artifacts)) {
    if (!validId(item?.id)) continue;
    const match = list(row.result.files).find(path => lower(fileName(path)) === lower(item.name));
    if (match) declared.set(item.id, text(match, 600));
  }
  const groups = new Map([
    ['deliverables',{id:'deliverables', label:'交付文件', artifacts:[]}],
    ['checks',{id:'checks', label:'检查与审批回执', artifacts:[]}],
    ['sources',{id:'sources', label:'原始资料与工作底稿', artifacts:[]}],
    ['records',{id:'records', label:'执行记录', artifacts:[]}],
  ]), seen = new Set();
  for (const item of list(run.artifacts)) {
    if (!object(item) || !validId(item.id) || seen.has(item.id)) continue;
    const name = fileName(item.name || item.path);
    if (!name || name === '.' || name === '..') continue;
    seen.add(item.id);
    const path = lower(declared.get(item.id) || item.path || name);
    let group = 'sources';
    if (item.id === 'execution-evidence' || /execution-evidence|transcript/.test(path)) group = 'records';
    else if (/\.(?:sqlite|db|sql)$|annual-report\.(?:xlsx|html)$|annual\.csv$|(?:decision-memo|material-request-list|employee-registration|onboarding-checklist)\.|(?:^|\/)reports\/|(?:^|\/)plan\.(?:json|csv)$|comparison-.*\.(?:json|csv)$|acceptance-checklist\.csv$|nginx-defense\.conf$/i.test(path)) group = 'deliverables';
    else if (/audit|verification|(?:^|\/)tests\.|design-checks|review-|risk-review|registration-review|registration-receipt|human-decision|owner-decision|(?:^|\/)defense\.json$/i.test(path)) group = 'checks';
    const artifact = {id:item.id, name};
    if (text(item.mimeType)) artifact.mimeType = text(item.mimeType, 120);
    if (number(item.bytes) !== null && item.bytes >= 0) artifact.bytes = item.bytes;
    // Never forward a model-provided URL or local filesystem path.
    if (validId(run.id)) artifact.url = `/api/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(item.id)}`;
    groups.get(group).artifacts.push(artifact);
  }
  return [...groups.values()].filter(group => group.artifacts.length);
}

function buildContext(run) {
  const receipt = receipts(run), findings = [], nextActions = [];
  const get = tool => receipt.latest.get(tool);
  const evidence = tool => get(tool)?.evidence || null;
  const valid = tool => {
    const row = get(tool);
    return !!row && row.result.ok !== false && !row.result.error && row.evidence.ok !== false && !row.evidence.error;
  };
  const add = (label, value, status = 'verified', detail) => {
    const item = {label, status};
    if (value !== undefined && value !== null) item.value = String(value).slice(0, 400);
    if (detail) item.detail = text(detail, 650);
    findings.push(item);
  };
  const registered = new Set(list(run.artifacts).filter(item => validId(item?.id)).map(item => item.id));
  const hasFile = (tool, pattern) => {
    const row = get(tool); if (!row || !valid(tool)) return false;
    const explicit = list(row.result.artifacts).filter(item => validId(item?.id) && registered.has(item.id));
    if (explicit.some(item => pattern.test(text(item.name, 600)))) return true;
    const files = list(row.result.files).filter(file => pattern.test(fileName(file)));
    return files.some(file => list(run.artifacts).some(item =>
      validId(item?.id) && (lower(item.path) === lower(file) || lower(item.name) === lower(fileName(file)))));
  };
  const missing = tools => tools.filter(tool => !valid(tool));
  const reportMissing = () => !hasFile('write_report', /\.(?:html|md)$/i);
  const finish = (status, label, summary) => ({status, label, summary, findings, nextActions});
  const incomplete = (detail = '尚缺必要的工具回执或交付文件。') => {
    nextActions.push('补齐缺失步骤与交付文件后重新核查。');
    return finish('incomplete', '交付证据不完整', detail);
  };
  return {run, ...receipt, get, evidence, valid, hasFile, missing, reportMissing, add, findings, nextActions, finish, incomplete};
}

function finance(c) {
  const imported = c.evidence('import_finance'), metrics = c.evidence('calculate_finance'), audit = c.evidence('audit_finance');
  if (count(imported?.rows) !== null) c.add('数据底稿', `${imported.rows}个月度记录`);
  const year = count(metrics?.year), current = year === null ? null : object(metrics?.years?.[String(year)]);
  const currency = text(metrics?.currency, 8).toUpperCase();
  if (current) for (const [key, label] of [['revenue','营业收入'],['net_profit','净利润'],['closing_cash','期末现金']]) {
    if (number(current[key]) !== null) c.add(label, `${current[key]}${currency ? ' ' + currency : ''}`);
  }
  const passed = audit?.passed === true && c.get('audit_finance')?.result.passed !== false && audit.independentRecalculation === true && lower(audit.integrityCheck) === 'ok' && !list(audit.errors).length;
  if (audit) c.add('独立财务审校', passed ? '底稿重算通过' : '存在问题或验证依据不足', passed ? 'verified' : 'needs_review', list(audit.errors).slice(0, 3).join('；'));
  if (c.missing(['import_finance','calculate_finance','audit_finance','write_report']).length || !current || !['revenue','net_profit','closing_cash'].every(key => number(current[key]) !== null) || c.reportMissing()) return c.incomplete();
  let mismatch = false;
  const checked = audit.recalculated?.years?.[String(year)];
  if (checked) mismatch = ['revenue','net_profit','closing_cash'].some(key => number(checked[key]) !== null && checked[key] !== current[key]);
  c.add('结果范围', '管理口径损益与现金收支；不构成财务审计');
  if (!passed || mismatch || imported.rows !== 24 || audit.rowCount !== 24 || !currency) {
    if (mismatch) c.add('指标一致性', '计算与独立重算不一致', 'needs_review');
    c.nextActions.push('核对财务底稿及审校差异，修正后重新生成报表。');
    return c.finish('needs_review', '财务报表需复核', '报表已生成，独立审校尚未通过。');
  }
  c.nextActions.push('由财务负责人确认口径与原始资料。');
  return c.finish('verified', '财务底稿审校通过', '年度指标与报表已生成，通过本次独立重算；资料真实性仍由财务负责人确认。');
}

function database(c) {
  const built = c.evidence('build_database'), tested = c.evidence('test_database');
  if (built) {
    const tableCount = object(built.tables) ? Object.keys(built.tables).length : null;
    if (tableCount !== null) c.add('数据库文件', `${tableCount}张表`);
    if (count(built.importedBusinessRows) !== null) c.add('用户业务记录', `${built.importedBusinessRows}条`);
    if (built.validationSamplesOnly === true) c.add('数据性质', `仅示例或验收记录${count(built.validationSampleRows) !== null ? '，' + built.validationSampleRows + '条' : ''}`);
    else if (built.emptyDatabase === true) c.add('数据性质', '空库；未导入业务记录');
  }
  const checks = [...list(tested?.tests), ...list(tested?.contractTests)];
  const designFailed = c.evidence('design_database')?.designChecks?.passed === false;
  const passed = tested?.passed === true && c.get('test_database')?.result.passed !== false && !designFailed && lower(tested.integrity) === 'ok' && !list(tested.foreignKeyViolations).length && checks.every(check => check?.passed === true);
  if (tested) c.add('独立数据库检查', passed ? `${checks.length}项SQL用例通过` : '存在失败或未确认项', passed ? 'verified' : 'needs_review');
  if (c.missing(['design_database','build_database','test_database','write_report']).length || !c.hasFile('build_database', /\.sqlite$/i) || c.reportMissing()) return c.incomplete();
  c.add('部署范围', '本次工作区中的SQLite文件；未部署生产');
  if (!passed) {
    c.nextActions.push('修复完整性、外键或失败SQL用例，并重新验收。');
    return c.finish('needs_review', '数据库验收未通过', '数据库文件已生成，仍有检查项未通过。');
  }
  if (!checks.length) {
    c.nextActions.push('补充业务约束和查询的正反SQL验收用例。');
    return c.finish('needs_review', '结构检查通过，业务用例待补充', 'SQLite结构与完整性检查通过，尚无实际业务SQL用例，不能认定业务验收通过。');
  }
  c.nextActions.push('由IT负责人检查交付文件，另行安排部署与业务验证。');
  return c.finish('verified', '数据库通过已执行用例', `SQLite文件已交付，${checks.length}项SQL用例通过；检查范围以回执为准。`);
}

function ddos(c) {
  const defense = c.evidence('apply_defense'), verify = c.evidence('verify_network');
  if (defense) c.add('真人变更审批', defense.approved === true ? '已批准隔离策略' : '未批准', defense.approved === true ? 'verified' : 'needs_review');
  if (verify) {
    if (number(verify.normalPassRate) !== null) c.add('正常请求放行', `${Math.round(verify.normalPassRate * 10000) / 100}%`, verify.normalPassRate === 1 ? 'verified' : 'needs_review');
    if (number(verify.maliciousBlockRate) !== null) c.add('恶意请求拦截', `${Math.round(verify.maliciousBlockRate * 10000) / 100}%`, verify.maliciousBlockRate === 1 ? 'verified' : 'needs_review');
    if (count(verify.unknownLabelRequests) !== null && verify.unknownLabelRequests > 0) c.add('缺少验收标签', `${verify.unknownLabelRequests}条`, 'needs_review');
  }
  if (c.missing(['inspect_network','analyze_traffic','apply_defense','verify_network','write_report']).length || c.reportMissing()) return c.incomplete();
  const passed = verify.verifiedRestored === true && c.get('verify_network')?.result.verifiedRestored !== false && verify.approved === true && defense.approved === true &&
    number(verify.normalRequests) > 0 && number(verify.maliciousRequests) > 0 && verify.normalPassRate === 1 && verify.maliciousBlockRate === 1 &&
    verify.normalPassed === verify.normalRequests && verify.maliciousBlocked === verify.maliciousRequests && verify.falsePositives === 0 && verify.unknownLabelRequests === 0;
  c.add('验证范围', '本次带标签日志的隔离重放；未验证生产网络恢复');
  if (!passed) {
    c.nextActions.push(defense.approved !== true ? '由真实负责人重新评审隔离方案。' : '修正误伤、漏拦或日志标签后重新重放。');
    return c.finish('needs_review', '隔离重放未通过', '诊断与策略文件已保存，尚不能确认本次日志的恢复条件成立。');
  }
  c.nextActions.push('生产变更须另行审批，并以实际业务访问验证恢复。');
  return c.finish('verified', '隔离重放通过', '本次带标签日志满足正常放行与恶意拦截条件；此结果不代表生产网络已恢复。');
}

function procurement(c) {
  const quotes = new Map();
  const putQuote = (quote, source) => {
    if (!object(quote)) return;
    const key = lower(quote.id || quote.requestedUrl || quote.sourceUrl);
    if (key) quotes.set(key, {...(quotes.get(key) || {}), ...quote, ...(source === 'fetch_quote' ? {comparable:false} : {})});
  };
  // fetch_quote is intentionally additive: different calls can cover different
  // URLs. For one quote ID the last actual receipt supersedes older evidence.
  const latestComparisons = [...c.perTask.values()].filter(row => row.tool === 'compare_quotes');
  const comparisons = latestComparisons.filter(row => row.result.ok !== false && !row.result.error && row.evidence.ok !== false && !row.evidence.error);
  for (const row of c.rows) {
    if (row.result.ok === false || row.result.error || row.evidence.ok === false || row.evidence.error) continue;
    if (row.tool === 'fetch_quote' || (row.tool === 'compare_quotes' && comparisons.includes(row))) {
      for (const quote of list(row.evidence.quotes)) putQuote(quote,row.tool);
    }
  }
  const rows = [...quotes.values()], budgetCurrency = text(comparisons.at(-1)?.evidence.budgetCurrency || c.run.input?.currency, 8).toUpperCase();
  const hardware = rows.filter(quote => lower(quote.productType) === 'server_hardware');
  const priced = hardware.filter(quote => lower(quote.status) === 'priced' && number(quote.price) > 0 && /^[A-Z]{3}$/.test(text(quote.currency).toUpperCase()) && lower(quote.priceKind) !== 'starting_price' && list(quote.priceCandidates).length <= 1);
  const comparable = priced.filter(quote => quote.comparable === true && (!budgetCurrency || text(quote.currency).toUpperCase() === budgetCurrency));
  const pending = rows.filter(quote => lower(quote.status) === 'pending_inquiry').length;
  const ambiguous = rows.filter(quote => lower(quote.status) === 'multiple_price_candidates' || list(quote.priceCandidates).length > 1 || lower(quote.priceKind) === 'starting_price').length;
  const unknown = comparable.filter(quote => !known(quote.tax) || !known(quote.shipping) || !known(quote.warranty));
  const currencyUnknown = hardware.filter(quote => !/^[A-Z]{3}$/.test(text(quote.currency).toUpperCase()) || (budgetCurrency && text(quote.currency).toUpperCase() !== budgetCurrency)).length;
  c.add('本次抓取范围', `${rows.length}个候选；非全网穷尽检索`);
  c.add('整机公开标价', `${priced.length}个；${comparable.length}个通过内存/SSD容量初核`, comparable.length ? 'verified' : 'needs_review');
  if (pending) c.add('待询价', `${pending}个候选`, 'needs_review');
  if (ambiguous) c.add('价格歧义', `${ambiguous}个候选含多价或起售价`, 'needs_review');
  if (currencyUnknown) c.add('币种可比性', `${currencyUnknown}个整机候选币种缺失或与预算不同`, 'needs_review');
  if (unknown.length) c.add('采购总成本', `${unknown.length}个可比候选的税费、运输或保修仍需核实`, 'needs_review');
  if (rows.length - hardware.length) c.add('整机比较排除项', `${rows.length - hardware.length}个配件、服务或类型未确认候选`);
  if (c.missing(['search_web','fetch_quote','compare_quotes','write_report']).length || comparisons.length !== latestComparisons.length || c.reportMissing()) return c.incomplete();
  if (comparisons.length < 2) return c.incomplete('缺少技术与财务两份独立的报价核对回执。');
  c.add('采购执行', '未下单、未付款；公开展示价不是最终书面报价');
  if (!comparable.length) {
    c.nextActions.push('向供应商索取满足配置要求、含币种与税费的整机书面报价。');
    return c.finish('needs_review', '待询价', '采购资料已整理，尚无可用于本次需求比较的有效整机报价。');
  }
  const overBudget = comparable.some(quote => quote.listedPriceWithinBudget === false);
  if (overBudget) c.add('预算初核', '存在公开标价高于预算的候选', 'needs_review');
  const failedReview = comparisons.some(row => row.result.passed === false || row.evidence.passed === false);
  if (failedReview) c.add('岗位审查', '至少一份最新配置或成本审查未通过', 'needs_review');
  if (pending || ambiguous || currencyUnknown || unknown.length || overBudget || !budgetCurrency || failedReview) {
    c.nextActions.push('核实报价歧义、完整配置与含税总成本后，再提交真实采购负责人。');
    return c.finish('needs_review', '报价与采购条件需核实', '已有整机标价依据，仍有影响比价或采购决策的未确认项。');
  }
  c.nextActions.push('由采购负责人确认供应商书面报价、CPU配置与采购申请。');
  return c.finish('verified', '公开报价初核完成', '本次候选的公开标价与容量初核已整理，尚未执行采购。');
}

function delivery(c) {
  const requirements = c.evidence('extract_requirements'), plan = c.evidence('estimate_delivery'), review = c.evidence('review_delivery');
  if (requirements) c.add('需求底稿', `${list(requirements.requirements).length}项来源可追溯需求`);
  if (plan) {
    if (number(plan.personDays) !== null) c.add('预计工作量', `${plan.personDays}人日`);
    if (number(plan.elapsedWorkingDays) !== null) c.add('预计排期', `${plan.elapsedWorkingDays}个工作日`);
    if (number(plan.totalCost) !== null) c.add('成本估算', `${plan.totalCost} ${text(plan.currency, 8).toUpperCase()}`.trim());
  }
  const passed = review?.passed === true && c.get('review_delivery')?.result.passed !== false && object(review.checks) &&
    ['sourceQuotesMatch','uniqueRequirementIds','planExists','coverageComplete','calculationConsistent','dependencyScheduleValid'].every(key => review.checks[key] === true) &&
    Object.values(review.checks).every(value => value === true) && !list(review.issues).length && !list(review.missingRequirementIds).length;
  if (review) c.add('计划一致性审校', passed ? '本次底稿检查通过' : '有缺失或不一致项', passed ? 'verified' : 'needs_review', list(review.issues).slice(0, 3).join('；'));
  if (c.missing(['extract_requirements','estimate_delivery','review_delivery','write_report']).length || !list(requirements.requirements).length || !list(plan.packages).length || number(plan.personDays) === null || number(plan.totalCost) === null || c.reportMissing()) return c.incomplete();
  const estimates = [...c.perTask.values()].filter(row => row.tool === 'estimate_delivery');
  if (estimates.length < 2 || estimates.some(row => row.result.ok === false || row.result.error || row.evidence.ok === false || row.evidence.error)) return c.incomplete('缺少业务排期与财务复核两份有效的估算回执。');
  c.add('客户确认', review.customerApproved === true ? '回执记录已确认' : '尚未确认范围、报价或最终交付验收', review.customerApproved === true ? 'verified' : 'needs_review');
  const questions = unique([...list(requirements.questions), ...list(review.openQuestions)]);
  if (questions.length) c.add('待确认问题', `${questions.length}项`, 'needs_review');
  const overBudget = number(plan.budgetDifference) !== null && plan.budgetDifference > 0;
  if (overBudget) c.add('预算差异', `估算高于原始预算 ${plan.budgetDifference} ${text(plan.currency, 8).toUpperCase()}`, 'needs_review');
  c.nextActions.push('由业务负责人确认范围、排期假设与估算，再提交客户审阅。');
  if (!passed || questions.length || overBudget) return c.finish('needs_review', '交付计划需复核', '需求与计划文件已生成，仍有遗漏、预算差异或待确认事项；未完成客户验收。');
  return c.finish('verified', '计划底稿一致性检查通过', '范围、工作包与成本底稿通过本次审校；这是交付计划，不是项目已交付或客户已验收。');
}

function investment(c) {
  const research = c.evidence('research_investment'), financial = c.evidence('analyze_investment_financials'), review = c.evidence('review_investment'), memo = c.evidence('build_investment_memo'), decision = c.evidence('request_investment_review');
  if (count(research?.retrievedPageCount) !== null) c.add('公开资料', `取得${research.retrievedPageCount}份可读正文；仅本次检索范围`, research.retrievedPageCount > 0 ? 'verified' : 'needs_review');
  if (financial) c.add('项目方财务', count(financial.recordCount) !== null ? `${financial.recordCount}期资料；真实性未审计` : '资料期数未知', financial.recordCount > 0 ? 'verified' : 'needs_review');
  const gaps = unique([...list(review?.criticalGaps), ...list(memo?.criticalGaps)]);
  if (review) {
    const total = count(review.claimCoverage?.total), reviewed = count(review.claimCoverage?.reviewed);
    if (total !== null && reviewed !== null) c.add('说法审查覆盖', `${reviewed}/${total}项；覆盖不等于独立证实`, 'needs_review');
    c.add('关键材料缺口', `${gaps.length}项`, gaps.length ? 'needs_review' : 'verified', gaps.slice(0, 3).join('；'));
  }
  const recommendation = {continue_diligence:'进入下一轮尽调',request_information:'先补材料',pause:'暂缓推进'}[lower(memo?.recommendation)];
  if (recommendation) c.add('简报建议', recommendation, 'needs_review');
  if (decision) c.add('老板审阅', lower(decision.decision) === 'continue_diligence' ? '选择继续尽调' : lower(decision.decision) === 'pause' ? '选择暂缓项目' : '决定记录需核实', 'needs_review');
  c.add('决策边界', '未完成正式尽调；不构成投资可行结论、投资授权或付款');
  if (c.missing(['prepare_investment','research_investment','analyze_investment_financials','review_investment','build_investment_memo','request_investment_review','write_report']).length || !recommendation || c.reportMissing()) return c.incomplete();
  if (!['continue_diligence','pause'].includes(lower(decision.decision))) return c.incomplete('缺少可核对的老板后续尽调决定。');
  c.nextActions.push(gaps.length ? '补齐关键材料，并开展主体、财务、客户与法律事项的人工核验。' : '开展独立财务、法律与客户核验，再决定是否进入投资审议。');
  return c.finish('needs_review', gaps.length ? '初步尽调已交付，关键缺口待补' : '初步尽调已交付，仍需独立核验', gaps.length ? `投前简报与老板审阅记录已保存，保留${gaps.length}项关键缺口；尚不足以作出投资可行结论。` : '资料审查与财务核算已整理，仅支持下一步尽调方向，尚不能确认项目可投资。');
}

function onboarding(c) {
  const review = c.evidence('review_onboarding'), plan = c.evidence('plan_onboarding_resources'), approval = c.evidence('request_onboarding_approval'), registration = c.evidence('register_onboarding');
  if (review) c.add('行政资料核查', review.passed === true ? '格式与本地重复预检通过' : '校验未通过', review.passed === true ? 'verified' : 'needs_review');
  if (approval) c.add('真实人事审批', approval.approved === true ? '已批准本地行政登记' : '未批准登记', approval.approved === true ? 'verified' : 'needs_review');
  const registered = registration?.registered === true && lower(registration.status) === 'registered' && registration.registryWritten === true &&
    approval?.approved === true && lower(approval.status) !== 'rejected' && review?.passed === true && c.get('review_onboarding')?.result.passed !== false &&
    list(review.checks).length > 0 && review.checks.every(check => check?.passed === true);
  if (registration) c.add('本地员工台账', registered ? registration.idempotent === true ? '已登记，返回原有记录' : '已写入本地员工册' : '未确认写入', registered ? 'verified' : 'needs_review');
  const resourceCount = count(registration?.resourceRequestCount) ?? count(plan?.requestCount);
  c.add('设备、账号与权限', resourceCount === null || plan?.unprovidedRequirements === true ? '需求待真实负责人确认' : `${resourceCount}项资源申请待办理`, 'needs_review', '本流程未开通外部账号、授予权限或分配设备。');
  if (c.missing(['prepare_onboarding','review_onboarding','plan_onboarding_resources','request_onboarding_approval','register_onboarding','write_report']).length || c.reportMissing()) return c.incomplete();
  if (!registered) {
    c.nextActions.push(approval.approved === false ? '由人事负责人补充或调整资料后重新发起登记。' : '核对真实人事审批和员工册写入回执。');
    return c.finish('needs_review', approval.approved === false ? '登记未获批准' : '员工登记尚未确认', approval.approved === false ? '已保留未登记结果；未写入员工册，资源申请也未执行。' : '登记流程已结束，但批准与台账写入证据尚未同时满足。');
  }
  c.nextActions.push('由真实负责人办理并逐项验证设备、账号与权限待办。');
  return c.finish('needs_review', '本地登记完成，资源待办待处理', `真实人事负责人已批准，员工册已登记；${resourceCount === null || plan.unprovidedRequirements === true ? '资源需求仍待确认' : resourceCount + '项资源申请尚待办理'}。`);
}

/**
 * A display-safe, evidence-based summary of one run. `executionStatus` reports
 * orchestration progress; `validationStatus` reports the business evidence.
 * `verified` always refers to the explicitly described tool/check scope.
 */
export function buildRunOutcome(value) {
  const run = object(value) || {}, c = buildContext(run), scenario = lower(run.scenarioId);
  const builders = {finance,database,ddos,procurement,delivery,investment,onboarding};
  let result = builders[scenario] ? builders[scenario](c) : c.incomplete('尚无本场景可核对的业务验收结果。');
  const executionStatus = lower(run.status);
  if (['completed','done'].includes(executionStatus) && list(run.tasks).some(task => text(task?.status) && !['done','completed'].includes(lower(task.status)))) {
    result = {...result,status:'incomplete',label:'任务记录需核对',summary:'流程已标记结束，仍有未完成的岗位步骤；不能确认完整交付。'};
  }
  const validationStatus = result.status;
  if (['cancelled','canceled','aborted'].includes(executionStatus)) result = {...result,status:'cancelled',label:labels.cancelled,summary:'流程已停止，已生成文件和工具回执仍保留；未完成步骤不计为交付。',nextActions:['如需继续，请核对保留回执后重新发起任务。']};
  else if (executionStatus === 'failed') {
    const failedTasks = list(run.tasks).filter(task => lower(task?.status) === 'failed').map(task => text(task.title,120)).filter(Boolean);
    if (failedTasks.length) result.findings.push({label:'中断步骤',value:failedTasks.slice(0,3).join('；'),status:'incomplete'});
    result = {...result,status:'failed',label:labels.failed,summary:'流程未完整结束；请核对已保留的工具回执与中断步骤。',nextActions:['核对中断步骤与工具错误，修正输入后重新发起任务。']};
  }
  else if (executionStatus === 'awaiting_approval' || (object(run.approval) && !['completed','done'].includes(executionStatus))) {
    result = {...result,status:'awaiting_approval',label:labels.awaiting_approval,summary:text(run.approval?.title, 180) || '待真实负责人审阅并决定，后续步骤尚未执行。'};
    result.nextActions = ['请指定的真实审批人审阅方案并提交决定。'];
  } else if (['queued','running','pending'].includes(executionStatus)) {
    const tasks = list(run.tasks), completed = tasks.filter(task => ['done','completed'].includes(lower(task?.status))).length;
    result = {...result,status:'running',label:executionStatus === 'queued' ? '等待派工' : labels.running,
      summary:tasks.length ? `已完成${completed}/${tasks.length}项岗位任务，结果仍在形成。` : '任务正在准备，尚无完整交付结果。'};
    result.nextActions = [];
  } else if (!['completed','done'].includes(executionStatus)) {
    result = {...result,status:'incomplete',label:'尚无完整执行记录',summary:'未取得完整任务记录，不能确认业务结果。'};
  }
  const example = run.input?.example === true || run.input?.isExample === true || c.rows.some(row => row.evidence.isExample === true || row.evidence.recalculated?.isExample === true);
  return {...result, executionStatus:executionStatus || 'unknown', validationStatus, example,
    nextActions:unique(result.nextActions).slice(0, 6), artifactGroups:artifactGroups(run,c.rows)};
}
