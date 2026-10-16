/**
 * A deterministic, local incident-response simulation.
 * Agents cooperate through task dependencies and shared network state. No LLM,
 * production network, payment service, or remote infrastructure is connected.
 */
export const AGENTS = [
  { id: 'zhang', name: '小张', role: '网络工程师', color: '#168CFF', initial: '张' },
  { id: 'liu', name: '小刘', role: '安全工程师', color: '#9574EB', initial: '刘' },
  { id: 'lead', name: '陈工', role: '技术组长', color: '#28AA9F', initial: '陈' },
  { id: 'business', name: '林悦', role: '业务组长', color: '#EF9264', initial: '林' },
  { id: 'finance', name: '许姐', role: '财务', color: '#DFA626', initial: '许' },
  { id: 'boss', name: '周总', role: '总经理', color: '#DD709E', initial: '周' },
  { id: 'ops', name: '阿杰', role: '机房运维', color: '#6A9A50', initial: '杰' },
];

export const SCENARIOS = [
  { id: 'ddos', title: '流量风暴', subtitle: 'DDoS 流量攻击', description: '异常连接挤满出口，客户访问超时。安全、网络与业务需要一起恢复服务。', severity: 'P1', affected: '客户访问 / 办公网络', icon: 'storm', budget: 800 },
  { id: 'power', title: '机房停电', subtitle: 'UPS 供电故障', description: 'UPS 故障导致核心设备掉电。先确认供电与数据安全，再按顺序启动业务。', severity: 'P1', affected: '核心机房 / 全体办公区', icon: 'power', budget: 1600 },
  { id: 'switch', title: '核心失联', subtitle: '核心交换机故障', description: '核心交换机失联，业务网络中断。排除攻击与供电问题后，更换设备并核验配置。', severity: 'P1', affected: '办公终端 / 会议 / 客户接待', icon: 'switch', budget: 480 },
];

export const NODES = [
  { id: 'internet', label: '互联网出口', type: 'internet', description: '运营商外网连接', users: 0 },
  { id: 'firewall', label: '边界防火墙', type: 'firewall', description: '出口访问控制与流量防护', users: 0 },
  { id: 'core', label: '核心交换机', type: 'switch', description: '机房与各办公网段的汇聚节点', users: 0 },
  { id: 'server', label: '业务服务器', type: 'server', description: '客户服务与内部业务应用', users: 0 },
  { id: 'storage', label: '数据存储', type: 'storage', description: '业务数据与恢复日志', users: 0 },
  { id: 'ups', label: 'UPS 电源', type: 'power', description: '机房设备供电', users: 0 },
  { id: 'access', label: '接入交换机', type: 'switch', description: '连接办公终端与无线接入点', users: 0 },
  { id: 'workstations', label: '员工工位', type: 'workstation', description: '员工办公网络', users: 48 },
  { id: 'meeting', label: '会议室', type: 'meeting', description: '视频会议与无线网络', users: 10 },
  { id: 'executive', label: '领导办公室', type: 'executive', description: '管理办公终端', users: 2 },
  { id: 'reception', label: '客户会见厅', type: 'reception', description: '客户演示与接待终端', users: 12 },
  { id: 'finance', label: '财务室', type: 'finance', description: '财务业务终端', users: 8 },
];

const DEPENDENCIES = {
  internet: [], ups: [], firewall: ['internet', 'ups'], core: ['firewall', 'ups'],
  storage: ['core', 'ups'], server: ['core', 'storage', 'ups'], access: ['core', 'ups'],
  workstations: ['access', 'server'], meeting: ['access'], executive: ['access', 'server'],
  reception: ['access', 'server'], finance: ['access', 'server'],
};
const PHASES = ['detect', 'diagnose', 'recover', 'verify', 'complete'];
const WEIGHT = { online: 0, warning: 1, recovering: 2, offline: 3 };
const clone = (value) => JSON.parse(JSON.stringify(value));

function task(id, title, ownerId, duration, dependencies, action, result, options = {}) {
  return { id, title, ownerId, duration, dependencies, action, result, phase: 'diagnose', ...options };
}

function createTasks(scenarioId) {
  const common = [
    task('detect', '接警并建立事故工单', 'lead', 3, [], '关联告警，建立 P1 事故工单并分派排障任务。', '抢修工单已建立；网络、安全、运维和业务并行排查。', { phase: 'detect' }),
    task('impact', '确认业务影响与恢复顺序', 'business', 5, ['detect'], '收集办公、会议和客户服务的失败请求，标注关键业务。', '已确认影响范围；优先恢复客户服务、办公与财务。'),
    task('priority', '确认业务恢复优先级', 'boss', 3, ['impact'], '核对关键客户任务，确认可暂停的非核心业务。', '批准优先恢复核心业务；会议服务可临时降级。'),
  ];
  if (scenarioId === 'ddos') return [
    ...common,
    task('network', '测量出口与连接拥塞', 'zhang', 7, ['detect'], '读取出口利用率、连接表与丢包采样。', '出口饱和，异常连接占用带宽；已定位边界防火墙。', { nodeId: 'firewall' }),
    task('security', '识别攻击流量特征', 'liu', 8, ['detect'], '比对来源分布、SYN 速率与正常业务流量基线。', '确认模拟 SYN Flood；已生成可回滚的过滤规则。', { nodeId: 'internet' }),
    task('rack', '排除供电与硬件故障', 'ops', 6, ['detect'], '检查 UPS、设备温度和物理端口状态。', '供电与硬件正常，排除物理设备故障。', { nodeId: 'ups' }),
    task('quote', '核对临时清洗费用', 'finance', 4, ['security'], '核对模拟清洗服务报价与预算余额。', '临时流量清洗报价 ¥800，提交审批。'),
    task('plan', '合并证据并选择恢复路径', 'lead', 4, ['network', 'security', 'rack', 'impact'], '交叉核验流量、设备与业务证据，安排防护和应用恢复并行执行。', '根因已确认；防护生效与连接清理完成后进行业务复测。'),
    task('approval', '审批临时流量清洗', 'boss', 0, ['quote', 'plan', 'priority'], '审批 ¥800 临时清洗服务，或采用本地限流降级方案。', '', { phase: 'recover', kind: 'approval' }),
    task('repair', '启用临时流量清洗', 'liu', 8, ['approval'], '启用模拟清洗策略并验证正常流量白名单。', '攻击流量已隔离，出口恢复正常。', { phase: 'recover', nodeId: 'firewall', effect: 'ddosDefense' }),
    task('application', '清理连接并恢复应用', 'zhang', 6, ['approval'], '清理异常连接，重建应用连接池并检查服务探针。', '异常连接已释放，业务服务探针通过。', { phase: 'recover', nodeId: 'server', effect: 'ddosApplication' }),
    task('technicalCheck', '复测链路与正常流量', 'ops', 5, ['repair', 'application'], '重跑出口、核心和办公端口的可达性采样。', '链路采样完成，未发现新的掉线节点。', { phase: 'verify', nodeId: 'core' }),
    task('businessCheck', '验证客户与办公业务', 'business', 5, ['repair', 'application'], '复跑客户查询、员工登录和财务访问测试。', '客户查询、员工登录与财务访问通过。', { phase: 'verify', nodeId: 'workstations' }),
    task('reconcile', '登记实际应急费用', 'finance', 4, ['repair'], '对照审批与实际执行路径登记费用。', '应急费用已登记。', { phase: 'verify', effect: 'reconcile' }),
    task('verify', '核验恢复证据与剩余风险', 'lead', 4, ['technicalCheck', 'businessCheck', 'reconcile'], '交叉核验节点状态、业务测试和支出记录。', '恢复证据一致，业务可用，已记录剩余风险。', { phase: 'verify' }),
    task('close', '确认恢复并关闭抢修工单', 'boss', 2, ['verify'], '确认业务复测结果和成本记录，关闭本次事故。', '抢修工单关闭，事故报告已生成。', { phase: 'verify' }),
  ];
  if (scenarioId === 'power') return [
    ...common,
    task('powerCheck', '定位 UPS 供电故障', 'ops', 8, ['detect'], '检查市电、UPS 输出与机柜供电回路。', '确认 UPS 输出模块故障，已隔离故障回路。', { nodeId: 'ups' }),
    task('network', '记录掉电设备与启动顺序', 'zhang', 6, ['detect'], '核对核心、存储和服务器的掉电范围与依赖。', '启动顺序已确认：供电 → 核心与存储 → 业务服务器。', { nodeId: 'core' }),
    task('security', '核对存储恢复点', 'liu', 7, ['detect'], '读取模拟备份目录和上次写入日志，确认可用恢复点。', '恢复点可用；上电后仍需执行日志一致性检查。', { nodeId: 'storage' }),
    task('quote', '核对 UPS 应急模块费用', 'finance', 4, ['powerCheck'], '核对备用模块调拨报价和应急预算。', 'UPS 应急模块调拨报价 ¥1,600，提交审批。'),
    task('plan', '安排分阶段上电与数据检查', 'lead', 3, ['powerCheck', 'network', 'security', 'impact'], '按依赖拆分供电、核心启动、存储检查和业务验收任务。', '禁止同时全负载上电；存储校验通过后启动业务。'),
    task('approval', '审批 UPS 应急模块', 'boss', 0, ['quote', 'plan', 'priority'], '审批 ¥1,600 应急模块，或采用备用电池并切除非核心负载。', '', { phase: 'recover', kind: 'approval' }),
    task('repair', '更换模块并恢复供电', 'ops', 9, ['approval'], '更换模拟应急模块，检测输出后恢复机柜供电。', 'UPS 输出稳定，机柜供电恢复。', { phase: 'recover', nodeId: 'ups', effect: 'powerSupply' }),
    task('coreBoot', '启动核心交换设备', 'zhang', 7, ['repair'], '按序上电并校验端口、路由和配置摘要。', '核心交换设备启动，配置摘要一致。', { phase: 'recover', nodeId: 'core', effect: 'coreBoot' }),
    task('storageCheck', '恢复存储并校验日志', 'liu', 6, ['repair'], '挂载模拟存储，核验日志和文件校验值。', '存储日志和校验值通过，可启动业务。', { phase: 'recover', nodeId: 'storage', effect: 'storageBoot' }),
    task('application', '按依赖启动业务服务', 'ops', 5, ['coreBoot', 'storageCheck'], '确认核心和存储就绪，启动业务服务器并检查探针。', '业务服务器启动，读写探针通过。', { phase: 'recover', nodeId: 'server', effect: 'serverBoot' }),
    task('businessCheck', '验证恢复后的核心业务', 'business', 5, ['application'], '复跑客户查询、员工登录和财务访问测试。', '核心业务通过；已核对暂停的非核心服务。', { phase: 'verify', nodeId: 'workstations' }),
    task('reconcile', '核对调拨成本与供电余量', 'finance', 4, ['repair'], '登记实际支出，核对恢复路径和供电余量。', '应急费用与供电恢复路径已记录。', { phase: 'verify', effect: 'reconcile' }),
    task('verify', '交叉核验供电与数据恢复', 'lead', 4, ['businessCheck', 'reconcile', 'storageCheck'], '核验设备依赖、数据检查和业务探针的完整证据。', '核心业务恢复证据完整，已登记供电剩余风险。', { phase: 'verify' }),
    task('close', '确认恢复并关闭抢修工单', 'boss', 2, ['verify'], '确认核心业务恢复范围和供电后续处理事项。', '抢修工单关闭，事故报告已生成。', { phase: 'verify' }),
  ];
  return [
    ...common,
    task('network', '定位核心转发故障', 'zhang', 7, ['detect'], '检查管理口、上下联链路和转发表快照。', '上下联同时失联，确认核心交换机转发故障。', { nodeId: 'core' }),
    task('security', '排除攻击与配置入侵', 'liu', 5, ['detect'], '检查边界流量与最近配置变更记录。', '未发现异常流量和未授权配置修改。', { nodeId: 'firewall' }),
    task('rack', '检查核心硬件与备用端口', 'ops', 6, ['detect'], '检测供电、光模块和备用交换设备。', '供电正常，核心硬件故障；可调拨备机或使用有限备用端口。', { nodeId: 'core' }),
    task('quote', '核对备机调拨费用', 'finance', 4, ['network', 'rack'], '核对备机调拨与运输报价。', '备机调拨报价 ¥480，提交审批。'),
    task('plan', '编排更换与配置复核', 'lead', 3, ['network', 'security', 'rack', 'impact'], '协调硬件替换、配置恢复和网段隔离检查。', '替换完成后并行恢复配置与检查 VLAN 隔离。'),
    task('approval', '审批核心备机调拨', 'boss', 0, ['quote', 'plan', 'priority'], '审批 ¥480 备机调拨，或临时使用有限备用端口。', '', { phase: 'recover', kind: 'approval' }),
    task('repair', '更换核心交换设备', 'ops', 8, ['approval'], '安装模拟备机并确认上下联物理链路。', '备用核心交换设备已就绪。', { phase: 'recover', nodeId: 'core', effect: 'switchRepair' }),
    task('configuration', '恢复路由与接入配置', 'zhang', 6, ['repair'], '恢复签名配置快照，校验路由和接入 VLAN。', '路由与接入配置一致，办公网络恢复。', { phase: 'recover', nodeId: 'access', effect: 'accessConfig' }),
    task('segmentation', '复核网段隔离与访问策略', 'liu', 5, ['repair'], '检查员工、访客和财务网段的访问矩阵。', '网段隔离与访问策略检查通过。', { phase: 'recover', nodeId: 'firewall' }),
    task('businessCheck', '验证办公与客户接待业务', 'business', 5, ['configuration', 'segmentation'], '复跑办公登录、客户演示和财务访问测试。', '核心业务通过；已核对会议服务容量。', { phase: 'verify', nodeId: 'workstations' }),
    task('reconcile', '登记备机调拨费用', 'finance', 4, ['repair'], '核对审批路径与设备调拨实际支出。', '设备恢复路径与应急费用已登记。', { phase: 'verify', effect: 'reconcile' }),
    task('verify', '核验设备与业务恢复结果', 'lead', 4, ['businessCheck', 'reconcile'], '核对配置摘要、隔离测试和用户复测证据。', '设备与业务恢复证据一致，已登记剩余风险。', { phase: 'verify' }),
    task('close', '确认恢复并关闭抢修工单', 'boss', 2, ['verify'], '确认恢复范围和硬件后续处理事项。', '抢修工单关闭，事故报告已生成。', { phase: 'verify' }),
  ];
}

export class Simulation {
  constructor(scenarioId = 'ddos') {
    this.listeners = new Set();
    this._initialize(scenarioId);
  }

  _initialize(scenarioId) {
    if (!SCENARIOS.some((s) => s.id === scenarioId)) throw new Error(`Unknown scenario: ${scenarioId}`);
    const speed = this.state?.speed || 1;
    this.faults = {};
    this.choice = null;
    this.spent = 0;
    this.sequence = 0;
    this.definitions = createTasks(scenarioId);
    this.state = {
      status: 'idle', scenarioId, elapsed: 0, speed, phase: 'detect',
      simulationMode: 'local_rule_based',
      metrics: {}, nodes: {},
      agents: AGENTS.map((a) => ({ ...a, status: 'idle', task: '待命', action: '', result: '', nodeId: null })),
      tasks: this.definitions.map((t) => ({ id: t.id, title: t.title, ownerId: t.ownerId, phase: t.phase, status: 'pending', dependencies: [...t.dependencies], action: t.action, result: '', progress: 0, duration: t.duration, nodeId: t.nodeId || null })),
      logs: [], approval: null, result: null, maxConcurrent: 0, handoffs: 0,
    };
    this._refreshNetwork();
  }

  getState() { return clone(this.state); }
  subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('A listener function is required.');
    this.listeners.add(fn);
    fn(this.getState());
    return () => this.listeners.delete(fn);
  }
  _emit() { for (const fn of this.listeners) fn(this.getState()); }
  selectScenario(id) { this._initialize(id); this._emit(); return this.getState(); }
  reset() { this._initialize(this.state.scenarioId); this._emit(); return this.getState(); }
  setSpeed(n) {
    if (![1, 2, 4].includes(n)) throw new RangeError('Simulation speed must be 1, 2, or 4.');
    this.state.speed = n; this._emit(); return this.getState();
  }
  start() {
    if (this.state.status === 'paused') return this.resume();
    if (this.state.status === 'completed') this._initialize(this.state.scenarioId);
    if (this.state.status !== 'idle') return this.getState();
    this.state.status = 'running';
    this._injectIncident();
    this._log('lead', 'task', `${SCENARIOS.find((s) => s.id === this.state.scenarioId).subtitle}：P1 抢修启动。`);
    this._schedule(); this._refreshNetwork(); this._emit(); return this.getState();
  }
  pause() {
    if (this.state.status === 'running') { this.state.status = 'paused'; this._emit(); }
    return this.getState();
  }
  resume() {
    if (this.state.status === 'paused') { this.state.status = 'running'; this._emit(); }
    return this.getState();
  }

  /** Seconds are simulation seconds; the caller applies state.speed once. */
  advance(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError('advance requires non-negative finite seconds.');
    if (this.state.status !== 'running' || seconds === 0) return this.getState();
    let remaining = seconds;
    while (remaining > 1e-8 && this.state.status === 'running') {
      this._schedule();
      if (this.state.status !== 'running') break;
      const active = this.state.tasks.filter((t) => t.status === 'running');
      if (!active.length) throw new Error('Task dependency graph has stalled.');
      const step = Math.min(remaining, 0.25, ...active.map((t) => Math.max(0, t.duration * (1 - t.progress))));
      this.state.elapsed = Math.round((this.state.elapsed + step) * 1e6) / 1e6;
      remaining -= step;
      for (const t of active) t.progress = Math.min(1, t.progress + step / t.duration);
      for (const t of active) if (t.progress >= 1 - 1e-8) this._finish(t);
      this._schedule();
      this._refreshNetwork();
      if (this.state.tasks.every((t) => t.status === 'done')) this._complete();
    }
    this._emit(); return this.getState();
  }

  approve(approved = true) {
    if (this.state.status !== 'awaiting_approval') return this.getState();
    const t = this.state.tasks.find((t) => t.id === 'approval');
    this.choice = Boolean(approved);
    this._configureRecovery();
    t.status = 'done'; t.progress = 1; t.finishedAt = this.state.elapsed;
    t.result = approved ? '应急支出已批准，执行完整恢复方案。' : '支出未获批准，执行零新增支出的本地降级方案。';
    const agent = this._agent('boss');
    Object.assign(agent, { status: 'done', task: t.title, action: t.action, result: t.result, nodeId: null });
    this._log('boss', 'approval', t.result, { targetAgentId: 'lead' });
    this._log('lead', 'handoff', approved ? '按批准方案执行；恢复后同时进行业务、链路和费用核验。' : '切换本地降级路径；保留核心业务，并在验收时明确剩余风险。', { targetAgentId: 'ops' });
    this.state.approval = null; this.state.status = 'running';
    this._schedule(); this._refreshNetwork(); this._emit(); return this.getState();
  }

  _agent(id) { return this.state.agents.find((a) => a.id === id); }
  _log(agentId, type, text, extra = {}) {
    if (type === 'handoff') this.state.handoffs += 1;
    this.state.logs.push({ id: `event-${++this.sequence}`, time: this.state.elapsed, agentId, type, text, ...extra });
  }
  _setFault(id, status, reason, propagate = true) { this.faults[id] = { status, reason, propagate }; }
  _clearFault(id) { delete this.faults[id]; }

  _injectIncident() {
    if (this.state.scenarioId === 'ddos') {
      this._setFault('internet', 'warning', '异常流量占满出口带宽');
      this._setFault('firewall', 'warning', '连接表接近容量上限');
      this._setFault('server', 'offline', '连接池耗尽，业务请求超时');
    } else if (this.state.scenarioId === 'power') {
      this._setFault('ups', 'offline', 'UPS 输出模块故障，机柜失电');
      this._setFault('core', 'offline', '掉电后等待按序启动');
      this._setFault('storage', 'offline', '掉电后等待日志一致性检查');
      this._setFault('server', 'offline', '等待供电、核心和存储恢复');
    } else this._setFault('core', 'offline', '核心交换机硬件故障，转发中断');
  }

  _schedule() {
    if (this.state.status !== 'running') return;
    let changed = true;
    while (changed && this.state.status === 'running') {
      changed = false;
      for (const t of this.state.tasks) {
        if (t.status !== 'pending' || !t.dependencies.every((id) => this.state.tasks.find((p) => p.id === id)?.status === 'done')) continue;
        if (this.state.tasks.some((other) => other.status === 'running' && other.ownerId === t.ownerId)) continue;
        const d = this.definitions.find((d) => d.id === t.id);
        const agent = this._agent(t.ownerId);
        t.status = 'running'; t.startedAt = this.state.elapsed;
        if (PHASES.indexOf(t.phase) > PHASES.indexOf(this.state.phase)) this.state.phase = t.phase;
        Object.assign(agent, { status: 'working', task: t.title, action: t.action, result: '', nodeId: t.nodeId });
        const predecessor = t.dependencies.map((id) => this.state.tasks.find((p) => p.id === id)).find((p) => p.ownerId !== t.ownerId);
        if (predecessor) this._log(predecessor.ownerId, 'handoff', `交接「${predecessor.title}」结果，启动「${t.title}」。`, { targetAgentId: t.ownerId, nodeId: t.nodeId });
        this._log(t.ownerId, 'task', t.title, { nodeId: t.nodeId });
        this._log(t.ownerId, 'action', t.action, { nodeId: t.nodeId });
        changed = true;
        if (d.kind === 'approval') {
          const scenario = SCENARIOS.find((s) => s.id === this.state.scenarioId);
          this.state.status = 'awaiting_approval';
          agent.status = 'waiting';
          this.state.approval = { id: 'emergency-budget', title: t.title, description: t.action, amount: scenario.budget, fromAgentId: 'finance', approverId: 'boss', fallback: this.state.scenarioId === 'ddos' ? '本地过滤与限流，保留外网拥塞风险' : this.state.scenarioId === 'power' ? '备用电池供电，暂停会议室负载' : '备用端口绕行，会议服务降级' };
          this._log('finance', 'approval', `${t.title}，申请 ¥${scenario.budget.toLocaleString('zh-CN')}。`, { targetAgentId: 'boss' });
          return;
        }
        this._startEffect(d);
        this.state.maxConcurrent = Math.max(this.state.maxConcurrent, this.state.tasks.filter((item) => item.status === 'running').length);
      }
    }
    const activePhases = this.state.tasks.filter((t) => t.status === 'running').map((t) => PHASES.indexOf(t.phase));
    if (activePhases.length) this.state.phase = PHASES[Math.min(...activePhases)];
  }

  _startEffect(d) {
    const effect = d.effect;
    if (effect === 'ddosDefense') this._setFault('firewall', 'recovering', '正在应用流量防护策略');
    if (effect === 'ddosApplication') this._setFault('server', 'recovering', '正在清理连接并重建连接池');
    if (effect === 'powerSupply') this._setFault('ups', 'recovering', '已隔离故障回路，正在恢复供电');
    if (effect === 'coreBoot' || effect === 'switchRepair') this._setFault('core', 'recovering', '正在恢复核心设备与链路');
    if (effect === 'storageBoot') this._setFault('storage', 'recovering', '正在校验存储日志');
    if (effect === 'serverBoot') this._setFault('server', 'recovering', '正在启动业务服务');
    if (effect === 'accessConfig') this._setFault('access', 'recovering', '正在恢复接入配置');
  }

  _finish(t) {
    const d = this.definitions.find((d) => d.id === t.id);
    t.status = 'done'; t.progress = 1; t.finishedAt = this.state.elapsed; t.result = d.result;
    if (d.effect === 'ddosDefense') {
      this._clearFault('firewall'); this._clearFault('internet');
      if (!this.choice) this._setFault('internet', 'warning', '本地限流生效，外部链路仍有拥塞风险', false);
      this.spent = this.choice ? 800 : 0;
    }
    if (d.effect === 'ddosApplication') this._clearFault('server');
    if (d.effect === 'powerSupply') {
      this._clearFault('ups'); this.spent = this.choice ? 1600 : 0;
      if (!this.choice) {
        this._setFault('ups', 'warning', '备用电池供电：模拟剩余续航 20 分钟', false);
        this._setFault('meeting', 'offline', '非核心负载已切除，等待正式供电');
      }
    }
    if (d.effect === 'coreBoot') this._clearFault('core');
    if (d.effect === 'storageBoot') this._clearFault('storage');
    if (d.effect === 'serverBoot') this._clearFault('server');
    if (d.effect === 'switchRepair') {
      this._clearFault('core'); this.spent = this.choice ? 480 : 0;
      if (!this.choice) {
        this._setFault('core', 'warning', '使用有限备用端口，等待正式换机', false);
        this._setFault('meeting', 'warning', '备用链路容量有限，视频会议限流', false);
      }
    }
    if (d.effect === 'accessConfig') this._clearFault('access');
    if (d.effect === 'reconcile') t.result = `实际模拟支出 ¥${this.spent.toLocaleString('zh-CN')}；${this.choice ? '与审批金额一致' : '采用本地降级方案，无新增支出'}。`;
    Object.assign(this._agent(t.ownerId), { status: 'done', task: t.title, action: t.action, result: t.result, nodeId: t.nodeId });
    this._log(t.ownerId, 'result', t.result, { nodeId: t.nodeId });
  }

  _configureRecovery() {
    const repair = this.definitions.find((t) => t.id === 'repair');
    if (!this.choice) {
      const fallback = {
        ddos: ['执行本地过滤与限流', 13, '应用本地过滤、连接限额和业务白名单，核验正常请求可达。', '本地过滤生效，核心业务恢复；外部链路仍有拥塞风险。'],
        power: ['切换备用电池并削减负载', 13, '切除会议室非核心负载，使用模拟备用电池恢复机柜供电。', '备用供电就绪，会议室暂停；模拟电池续航 20 分钟。'],
        switch: ['使用备用端口临时绕行', 12, '将核心业务迁至模拟备用端口，限制视频会议占用。', '核心业务临时绕行，会议服务限流；仍需正式换机。'],
      }[this.state.scenarioId];
      [repair.title, repair.duration, repair.action, repair.result] = fallback;
    }
    const publicTask = this.state.tasks.find((t) => t.id === 'repair');
    Object.assign(publicTask, { title: repair.title, duration: repair.duration, action: repair.action });
  }

  _refreshNetwork() {
    const nodes = {};
    const resolve = (id) => {
      if (nodes[id]) return nodes[id];
      const metadata = NODES.find((n) => n.id === id);
      let status = this.faults[id]?.status || 'online';
      let reason = this.faults[id]?.reason || '运行正常';
      let propagated = this.faults[id]?.propagate ?? true;
      for (const dep of DEPENDENCIES[id]) {
        const upstream = resolve(dep);
        const effective = upstream.propagate === false && upstream.status === 'warning' ? 'online' : upstream.status;
        if (WEIGHT[effective] > WEIGHT[status]) {
          status = effective; reason = `依赖「${upstream.label}」：${upstream.reason}`; propagated = true;
        }
      }
      nodes[id] = { ...metadata, status, reason, propagate: propagated, dependencies: [...DEPENDENCIES[id]] };
      return nodes[id];
    };
    for (const n of NODES) resolve(n.id);
    this.state.nodes = nodes;
    const endpoints = NODES.filter((n) => n.users > 0);
    const totalUsers = endpoints.reduce((sum, n) => sum + n.users, 0);
    const serviceQuality = { online: 1, warning: 0.65, recovering: 0.25, offline: 0 };
    const good = endpoints.reduce((sum, n) => sum + n.users * serviceQuality[nodes[n.id].status], 0) / totalUsers;
    const offline = endpoints.reduce((sum, n) => sum + (nodes[n.id].status === 'offline' ? n.users : 0), 0) / totalUsers;
    const impaired = 1 - good;
    this.state.metrics = {
      availability: Math.round(good * 1000) / 10,
      latency: Math.round(18 + impaired * 420 + offline * 1600),
      packetLoss: Math.round((impaired * 65 + offline * 30) * 10) / 10,
      affectedUsers: endpoints.reduce((sum, n) => sum + (nodes[n.id].status !== 'online' ? n.users : 0), 0),
      healthyNodes: Object.values(nodes).filter((n) => n.status === 'online').length,
      totalNodes: NODES.length,
    };
  }

  _complete() {
    this.state.status = 'completed'; this.state.phase = 'complete';
    const risk = this.choice ? '本次模拟范围内无未恢复节点；建议持续观察告警。' : {
      ddos: '本地过滤未消除上游链路再次饱和的风险，仍需申请正式清洗。',
      power: '会议室仍断电，备用电池模拟续航 20 分钟，必须尽快更换 UPS 输出模块。',
      switch: '核心使用临时备用端口，会议限流，仍需正式更换故障交换机。',
    }[this.state.scenarioId];
    this.state.result = {
      title: this.choice ? '全网恢复，抢修完成' : '核心业务恢复，降级方案生效',
      summary: this.choice ? '设备、链路与业务复测通过，应急费用已核验。' : '已恢复核心业务，保留的降级与后续处理事项已写入报告。',
      restored: true, fullyRestored: Object.values(this.state.nodes).every((n) => n.status === 'online'),
      mode: this.choice ? 'approved_recovery' : 'local_fallback', cost: this.spent, duration: this.state.elapsed,
      completedTasks: this.state.tasks.filter((t) => t.status === 'done').length,
      totalTasks: this.state.tasks.length,
      maxConcurrent: this.state.maxConcurrent, peakConcurrent: this.state.maxConcurrent, handoffs: this.state.handoffs,
      serialWorkSeconds: this.state.tasks.reduce((sum, t) => sum + t.duration, 0),
      verifiedChecks: this.state.tasks.filter((t) => t.phase === 'verify' && !['reconcile', 'close'].includes(t.id)).map((t) => t.result),
      remainingRisk: risk,
      availability: this.state.metrics.availability,
      disclaimer: '本地规则驱动仿真；Agent、网络探针、故障、审批和费用均为模拟，未调用真实 LLM 或生产网络。',
    };
  }

  exportReport() {
    const s = this.getState();
    return { version: 1, generatedAt: new Date().toISOString(), simulationMode: s.simulationMode,
      scenario: clone(SCENARIOS.find((item) => item.id === s.scenarioId)), status: s.status,
      elapsed: s.elapsed, decision: this.choice === null ? 'pending' : this.choice ? 'approved' : 'fallback',
      metrics: s.metrics, nodes: s.nodes, agents: s.agents, tasks: s.tasks,
      collaboration: { maxConcurrent: s.maxConcurrent, handoffs: s.handoffs, serialWorkSeconds: s.tasks.reduce((sum, t) => sum + t.duration, 0), comparisonNote: '串行工时为同组模拟任务时长之和，未计人工决策等待与真实网络执行耗时。' },
      timeline: s.logs, result: s.result,
      disclaimer: '本地规则驱动仿真；所有故障、操作、工具测量与费用均为模拟。' };
  }
}
