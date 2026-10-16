import { AGENTS, SCENARIOS, NODES, Simulation } from './simulation.js';
import { mountScene } from './scene.js';

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = (name, className = '') => `<svg class="icon ${className}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const time = (seconds = 0) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const numeric = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const phaseList = [['detect', '发现'], ['diagnose', '诊断'], ['recover', '处置'], ['verify', '验收']];
const statusNames = { online: '正常运行', warning: '异常告警', offline: '服务不可达', recovering: '正在恢复' };
const agentStatusNames = { idle: '待命', working: '执行中', waiting: '等待中', done: '已完成' };
const logTypes = { task: '任务分派', action: '执行动作', result: '工具结果', handoff: '协作交接', approval: '审批决策', system: '系统事件' };
const scenarios = {
  ddos: { name: '流量风暴', en: 'DDoS', icon: 'shield', intro: '公网流量暴增，业务访问拥堵', goal: '恢复公网访问，保障客户业务可用。', scope: '公网入口 / 客户业务', checks: '可用率 ≥ 99% · 丢包率 ≤ 1%', badge: 'P1' },
  power: { name: '机房断电', en: 'POWER', icon: 'plug', intro: 'UPS 输出故障，机柜失去供电', goal: '恢复关键设备供电，按依赖启动服务。', scope: '机房供电 / 核心服务', checks: '供电稳定 · 服务探测通过', badge: 'P1' },
  switch: { name: '核心失联', en: 'SWITCH', icon: 'server', intro: '核心交换机故障，办公网络离线', goal: '切换可用链路，恢复各部门网络。', scope: '核心交换机 / 办公网', checks: '各部门连通 · 业务验收通过', badge: 'P1' },
};
const nodeDetails = {
  internet: { ip: '203.0.113.1', zone: '公网出口', service: '对外访问 / 运营商链路' },
  firewall: { ip: '10.0.0.1', zone: '安全边界', service: '访问控制 / 流量防护' },
  core: { ip: '10.0.0.2', zone: '网络机房', service: '跨 VLAN 路由 / 核心交换' },
  server: { ip: '10.0.10.10', zone: '网络机房', service: '客户门户 / 内部业务' },
  storage: { ip: '10.0.10.20', zone: '网络机房', service: '业务数据 / 配置备份' },
  ups: { ip: '10.0.0.100', zone: '网络机房', service: '供电保障 / 电池监测' },
  access: { ip: '10.0.20.1', zone: '员工工区', service: '终端接入 / VLAN 转发' },
  workstations: { ip: '10.0.20.0/24', zone: '员工工区', service: '办公终端 / 研发工作台' },
  meeting: { ip: '10.0.30.10', zone: '会议室', service: '视频会议 / 会议屏幕' },
  executive: { ip: '10.0.40.10', zone: '领导办公室', service: '管理终端 / 经营看板' },
  reception: { ip: '10.0.50.10', zone: '客户会见厅', service: '客户演示 / 访客接待' },
  finance: { ip: '10.0.60.10', zone: '财务室', service: '财务终端 / 内部审批' },
};
const portraitColors = {
  zhang: ['#e1ecd5', '#6e965e', '#364236', '#e8ba91'],
  liu: ['#e3e6f1', '#8392b6', '#3b3d48', '#e9bd98'],
  lead: ['#f4e7cf', '#b6a37b', '#4c4d44', '#e7be98'],
  business: ['#f2dfd7', '#c89886', '#55423e', '#edc7aa'],
  finance: ['#ece2f1', '#a18caf', '#4d3d4d', '#edc5a6'],
  boss: ['#e2e9df', '#7d9279', '#8d8b79', '#dbb798'],
  ops: ['#e3edf0', '#7a9ba7', '#3e4848', '#dcb28f'],
};

function portrait(id, className = '') {
  const [bg, shirt, hair, skin] = portraitColors[id] || portraitColors.zhang;
  const isWoman = ['business', 'finance'].includes(id);
  const glasses = ['lead', 'finance', 'boss'].includes(id);
  return `<svg class="portrait ${className}" viewBox="0 0 60 60" role="img" aria-label="${esc(AGENTS.find(a => a.id === id)?.name || '系统')}"><rect width="60" height="60" rx="14" fill="${bg}"/>${isWoman ? `<path d="M16 25q0-16 15-16t15 16v19H16z" fill="${hair}"/>` : ''}<path d="M11 61v-8q1-17 19-17t19 17v8" fill="${shirt}"/><path d="M26 35v8q4 5 8 0v-8" fill="${skin}"/><ellipse cx="30" cy="26" rx="13" ry="15" fill="${skin}"/><ellipse cx="17" cy="27" rx="2.5" ry="4" fill="${skin}"/><ellipse cx="43" cy="27" rx="2.5" ry="4" fill="${skin}"/><path d="M17 24q-3-13 8-16 14-4 18 7l1 10-5-8q-11 4-19-1z" fill="${hair}"/>${isWoman ? `<path d="M18 19q2 15-2 25l6-4V20M40 17q7 5 5 27l-5-4" fill="${hair}"/>` : ''}<circle cx="25" cy="27" r="1.1" fill="#3f4840"/><circle cx="35" cy="27" r="1.1" fill="#3f4840"/><path d="M27 33q3 3 6 0" stroke="#a67964" fill="none" stroke-width="1.2" stroke-linecap="round"/>${glasses ? '<g stroke="#586253" fill="none" stroke-width="1.1"><rect x="19.5" y="23" width="9" height="7" rx="2"/><rect x="31.5" y="23" width="9" height="7" rx="2"/><path d="M28.5 25h3M17 24l3 1M40 25l3-1"/></g>' : ''}${id === 'liu' ? '<path d="M15 26v-4a15 15 0 0130 0v6M15 25v7M45 25v8l-6 3" fill="none" stroke="#72819b" stroke-width="3" stroke-linecap="round"/>' : ''}${id === 'ops' ? '<path d="M15 19q2-13 15-13t15 13z" fill="#e6b96b" stroke="#bc9a5c" stroke-width="1"/><path d="M12 20h36M30 7v11" stroke="#bc9a5c" stroke-width="2" stroke-linecap="round"/>' : ''}${id === 'boss' ? '<path d="M24 41l6 8 6-8-5 19h-2z" fill="#f5f5e9"/><path d="M30 46l-3 4 3 9 3-9z" fill="#617b65"/>' : ''}${id === 'lead' ? '<path d="M20 44l10 5 10-5M30 49v11" stroke="#efeadb" stroke-width="2" fill="none"/>' : ''}</svg>`;
}

const sim = new Simulation('ddos');
let state = sim.getState();
let panelTab = 'mission';
let currentView = 'lab';
let selectedNode = null;
let topologyVisible = true;
let soundEnabled = false;
let audioContext;
let sessionId = null;
let savedSession = null;
let peakConcurrent = 0;
let lastStatus = state.status;
let controlSignature = '';
let agentSignature = '';
let taskSignature = '';
let nodeSignature = '';
let toastTimer;
let history = [];
try { const saved = JSON.parse(localStorage.getItem('net-rescue-archive-v1') || '[]'); if (Array.isArray(saved)) history = saved.filter(r => r && r.report && typeof r.id === 'string').slice(0, 12); } catch { /* Storage can be unavailable in private browsing. */ }

const scene = mountScene($('#office-scene'), { onSelectNode(id) { selectedNode = selectedNode === id ? null : id; scene.setSelectedNode(selectedNode); nodeSignature = ''; renderNode(); } });

function showToast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 2600);
}

function beep(kind = 'normal') {
  if (!soundEnabled) return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') audioContext.resume();
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.connect(gain); gain.connect(audioContext.destination);
    osc.type = 'sine';
    osc.frequency.value = kind === 'complete' ? 740 : kind === 'approval' ? 440 : 580;
    gain.gain.setValueAtTime(.045, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + .16);
    osc.start(); osc.stop(audioContext.currentTime + .17);
  } catch { /* Sound is optional. */ }
}

function renderMetrics() {
  const m = state.metrics || {};
  const metrics = [
    { label: '网络可用率', icon: 'activity', value: numeric(m.availability, 100).toFixed(1), unit: '%', bad: m.availability < 99, note: m.availability < 99 ? '业务访问受影响' : '关键业务运行正常', chart: null },
    { label: '平均延迟', icon: 'clock', value: Math.round(numeric(m.latency, 12)), unit: 'ms', bad: m.latency > 80, note: m.latency > 80 ? '响应时间升高' : '链路响应稳定', chart: null },
    { label: '丢包率', icon: 'layers', value: numeric(m.packetLoss, 0).toFixed(1), unit: '%', bad: m.packetLoss > 1, note: m.packetLoss > 1 ? '数据传输异常' : '数据传输正常', chart: null },
    { label: '受影响用户', icon: 'users', value: numeric(m.affectedUsers), unit: `/ ${NODES.reduce((sum, node) => sum + numeric(node.users), 0)}`, bad: m.affectedUsers > 0, note: m.affectedUsers > 0 ? state.status === 'completed' ? '非核心业务仍受限制' : '抢修小队正在处理' : '所有部门正常在线', chart: null },
  ];
  $('#network-metrics').innerHTML = metrics.map(m => `<div class="metric"><div class="metric-label">${icon(m.icon)}${m.label}</div><div class="metric-value ${m.bad ? 'bad' : ''}">${m.value}<span>${m.unit}</span></div><div class="metric-change ${m.bad ? 'bad' : ''}">${m.note}</div>${m.chart ? `<svg class="metric-chart" viewBox="0 0 46 23" aria-hidden="true"><path d="${m.chart}" stroke="${m.bad ? '#d4a078' : '#a6bf87'}" stroke-width="1.5" fill="none"/></svg>` : ''}</div>`).join('');
  const online = Object.values(state.nodes || {}).filter(n => n.status === 'online').length;
  const all = Object.keys(state.nodes || {}).length || 12;
  $('#online-count').textContent = `${online} / ${all} 节点可用`;
  const normal = Object.values(state.nodes || {}).every(n => n.status === 'online');
  $('#network-status').className = `live-pill ${normal ? '' : 'danger'}`;
  $('#network-status').innerHTML = `<span class="status-dot"></span>${normal ? '网络正常' : state.status === 'completed' ? '降级运行' : '抢修进行中'}`;
  const active = ['running', 'paused', 'awaiting_approval'].includes(state.status);
  $('#scene-alert').hidden = !active;
  if (active) $('#scene-alert').innerHTML = `${icon(state.status === 'awaiting_approval' ? 'clock' : 'zap')}<span>${state.status === 'awaiting_approval' ? '处置方案待审批，抢修已挂起' : state.status === 'paused' ? '演练已暂停，可单步推进' : `${esc(scenarios[state.scenarioId]?.name)} · ${esc(phaseList.find(p => p[0] === state.phase)?.[1] || '协同处理中')}`}</span>`;
}

function renderScenarioControl() {
  const selected = scenarios[state.scenarioId] || scenarios.ddos;
  return `<div class="mission-content"><div class="small-heading">选择一个突发事件<span>INJECT AN INCIDENT</span></div><div class="scenario-list">${SCENARIOS.map(s => { const d = scenarios[s.id]; return `<button class="scenario-option ${s.id === state.scenarioId ? 'selected' : ''}" data-scenario="${esc(s.id)}" aria-pressed="${s.id === state.scenarioId}"><span class="scenario-icon ${esc(s.id)}">${icon(d.icon)}</span><span class="scenario-copy"><span class="scenario-name">${d.name}<small>${d.en}</small></span><small>${d.intro}</small></span><span class="radio-dot"></span></button>`; }).join('')}</div><div class="mission-target"><div class="small-heading">本次任务<span>MISSION BRIEF</span></div><div class="target-line">${icon('target')}<span>${selected.goal}</span></div><dl class="mission-facts"><div><dt>影响范围</dt><dd>${selected.scope}</dd></div><div><dt>协作小队</dt><dd>7 位 Agent · 按职责分工</dd></div><div><dt>验收标准</dt><dd>${selected.checks}</dd></div></dl></div><div class="start-area"><button class="button button-primary button-wide" data-action="start">${icon('zap')}注入故障，开始抢修${icon('arrow')}</button><p class="safe-note">${icon('shield')}故障仅作用于模拟网络</p></div></div>`;
}

function renderPhases() {
  const idx = state.phase === 'complete' ? 4 : phaseList.findIndex(p => p[0] === state.phase);
  return `<div class="phase-steps">${phaseList.map(([id, name], i) => `<div class="phase-step ${i < idx ? 'done' : i === idx ? 'active' : ''}"><i>${i < idx ? '✓' : i + 1}</i><span>${name}</span></div>`).join('')}</div>`;
}

function renderApproval() {
  const a = state.approval;
  if (!a) return '';
  return `<div class="approval-box"><div class="approval-title">${icon('clock')}指挥官决策 · 等待确认</div><h4>${esc(a.title)}</h4><p>${esc(a.description)}${a.amount ? `<br>申请额度：¥${numeric(a.amount).toLocaleString('zh-CN')}` : ''}</p><div class="approval-actions"><button class="button button-orange" data-action="approve">${icon('check')}批准方案</button><button class="button button-light" data-action="reject">采用本地方案</button></div></div>`;
}

function renderRunningControl() {
  const s = scenarios[state.scenarioId];
  const working = (state.agents || []).filter(a => a.status === 'working');
  const isPaused = state.status === 'paused';
  return `<div class="mission-content"><div class="incident-heading"><span class="scenario-icon ${state.scenarioId}">${icon(s.icon)}</span><div><h3>${s.name}</h3><small>INCIDENT #${String(history.length + 1).padStart(3, '0')}</small></div><span class="severity">${s.badge}</span></div><div class="run-timer" id="run-timer">${time(state.elapsed)}</div><div class="run-timer-label">${state.status === 'awaiting_approval' ? '等待审批 · 仿真计时暂停' : isPaused ? '演练已暂停' : '仿真抢修用时'}</div><div class="run-controls"><button class="button button-light" data-action="pause" ${state.status === 'awaiting_approval' ? 'disabled' : ''}>${icon(isPaused ? 'play' : 'pause')}${isPaused ? '继续' : '暂停'}</button><button class="button button-light" data-action="step" ${state.status === 'awaiting_approval' ? 'disabled' : ''}>${icon('step')}推进 5 秒</button><select class="speed-select" id="speed" aria-label="演练速度">${[1, 2, 4].map(n => `<option value="${n}" ${state.speed === n ? 'selected' : ''}>${n}× 速度</option>`).join('')}</select></div>${renderPhases()}${state.approval ? renderApproval() : `<div class="run-goal">${icon('target')}<span>${s.goal}</span></div><div class="small-heading">${working.length ? '正在执行' : '等待前置结果'}<span>${working.length} AGENTS ACTIVE</span></div><div class="active-task-list">${(working.length ? working : (state.agents || []).filter(a => a.status === 'waiting').slice(0, 3)).slice(0, 4).map(a => `<button class="active-task-item" data-agent="${esc(a.id)}">${portrait(a.id)}<span><strong>${esc(a.task || a.action || '等待协作结果')}</strong><small>${esc(a.name)} · ${esc(a.role)}</small></span><i class="task-dot"></i></button>`).join('')}</div>`}<div class="run-bottom"><span>已完成 <strong id="run-tasks">${(state.tasks || []).filter(t => t.status === 'done').length} / ${(state.tasks || []).length}</strong> 项任务</span><span>峰值 <strong>${Math.max(peakConcurrent, numeric(state.maxConcurrent))}</strong> 位并行</span></div></div>`;
}

function resultCheckText(check) {
  if (typeof check === 'string') return check;
  return check?.description || check?.label || check?.name || check?.title || JSON.stringify(check);
}

function renderResultControl() {
  const result = state.result || {};
  const checks = Array.isArray(result.verifiedChecks) ? result.verifiedChecks : [ '核心设备已恢复在线', '关键业务验收通过', '处置过程与任务结果已归档' ];
  return `<div class="mission-content"><div class="small-heading">演练完成<span>INCIDENT RESOLVED</span></div><div class="result-banner ${result.fullyRestored === false ? 'degraded' : ''}"><span class="result-icon">${icon(result.fullyRestored === false ? 'shield' : 'check')}</span><h3>${esc(result.title || '业务恢复，小队收工！')}</h3><p>${esc(scenarios[state.scenarioId].name)} · ${esc(result.mode === 'local_fallback' ? '本地方案完成' : '协同处置完成')}</p><div class="result-numbers"><div class="result-number"><strong>${time(result.duration ?? state.elapsed)}</strong><span>仿真抢修用时</span></div><div class="result-number"><strong>${numeric(state.metrics?.availability).toFixed(1)}<small>%</small></strong><span>业务可用率</span></div><div class="result-number"><strong>${Math.max(peakConcurrent, numeric(state.maxConcurrent))}<small> 人</small></strong><span>同时协作峰值</span></div><div class="result-number"><strong>${(state.logs || []).filter(l => l.type === 'handoff').length}<small> 次</small></strong><span>任务与结果交接</span></div></div></div><div class="result-checks">${checks.slice(0, 4).map(c => `<div class="result-check">${icon('check')}<span>${esc(resultCheckText(c))}</span></div>`).join('')}${result.remainingRisk ? `<div class="result-check">${icon('info')}<span>${esc(result.remainingRisk)}</span></div>` : ''}</div><div class="result-buttons"><button class="button button-primary" data-action="report">${icon('download')}导出抢修报告</button><button class="button button-light" data-action="reset">${icon('reset')}再开一局</button></div></div>`;
}

function renderLogPanel() {
  const logs = state.logs || [];
  return `<div class="log-panel"><div class="log-panel-header"><span>共享任务板 · 实时信息交接</span><span class="status-label"><span class="status-dot"></span>${state.status === 'completed' ? '已归档' : state.status === 'idle' ? '等待事件' : '演练中'}</span></div><div class="log-scroll" id="log-scroll">${logs.length ? logs.map(logMarkup).join('') : `<div class="empty-logs">${icon('terminal')}<div>小队已就位，等待突发事件。<br>注入故障后，在这里查看任务、行动和结果。</div></div>`}</div><div class="log-bottom"><span>${logs.length} 条可追溯记录</span><button class="button-text" data-action="report">导出 JSON ${icon('download')}</button></div></div>`;
}

function logMarkup(log) {
  const agent = AGENTS.find(a => a.id === log.agentId);
  return `<div class="log-entry">${portrait(agent?.id || 'lead')}<div class="log-body"><div class="log-meta"><strong>${esc(agent?.name || '实验室系统')}${log.targetAgentId ? ` → ${esc(AGENTS.find(a => a.id === log.targetAgentId)?.name || log.targetAgentId)}` : ''}</strong><time class="log-time">${time(log.time)}</time></div><div class="log-type ${esc(log.type)}">${esc(logTypes[log.type] || log.type)}</div><p>${esc(log.text)}</p></div></div>`;
}

function renderControl() {
  const signature = [panelTab, state.status, state.scenarioId, state.phase, state.speed, state.approval?.id || '', (state.tasks || []).map(t => `${t.id}:${t.status}`).join('|'), state.logs?.length || 0].join('/');
  if (signature !== controlSignature) {
    controlSignature = signature;
    const oldScroll = $('#log-scroll');
    const scrollPosition = oldScroll?.scrollTop || 0;
    const atEnd = !oldScroll || oldScroll.scrollHeight - oldScroll.clientHeight - oldScroll.scrollTop < 50;
    const focusedAction = document.activeElement?.dataset?.action;
    $('#control-content').innerHTML = panelTab === 'activity' ? renderLogPanel() : state.status === 'idle' ? renderScenarioControl() : state.status === 'completed' ? renderResultControl() : renderRunningControl();
    const newScroll = $('#log-scroll');
    if (newScroll) newScroll.scrollTop = atEnd ? newScroll.scrollHeight : scrollPosition;
    if (focusedAction) $('#control-content').querySelector(`[data-action="${focusedAction}"]`)?.focus({ preventScroll: true });
  }
  if ($('#run-timer')) $('#run-timer').textContent = time(state.elapsed);
  $('#log-count').textContent = state.logs?.length || 0;
}

function renderAgents() {
  const agents = state.agents?.length ? state.agents : AGENTS.map(a => ({ ...a, status: 'idle' }));
  const signature = agents.map(a => `${a.id}/${a.status}/${a.task}/${a.action}/${a.result}`).join('|');
  if (signature !== agentSignature) {
    agentSignature = signature;
    $('#agent-grid').innerHTML = agents.map((a, idx) => {
      const tasks = (state.tasks || []).filter(t => t.ownerId === a.id);
      const done = tasks.filter(t => t.status === 'done').length;
      const working = tasks.find(t => t.status === 'running');
      return `<button class="agent-card ${esc(a.status || 'idle')}" data-agent="${esc(a.id)}" aria-label="查看${esc(a.name)}的任务"><span class="agent-state"><span class="status-dot"></span>${agentStatusNames[a.status] || '待命'}</span><div class="agent-head">${portrait(a.id)}<div><div class="agent-name">${esc(a.name)}</div><div class="agent-role">${esc(a.role)}</div></div></div><div class="agent-current ${a.status === 'working' ? 'active' : ''}" title="${esc(a.task || a.result || '')}">${esc(a.status === 'idle' ? idleTask(a.id) : a.task || a.result || '等待下一项任务')}</div><div class="agent-foot"><span>AGENT ${String(idx + 1).padStart(2, '0')}</span><span>${tasks.length ? `${done}/${tasks.length} 任务` : icon('chevron')}</span></div>${a.status === 'working' ? `<i class="agent-progress" style="width:${Math.max(8, numeric(working?.progress) <= 1 ? numeric(working?.progress) * 100 : numeric(working?.progress))}%"></i>` : ''}</button>`;
    }).join('');
  }
  // Keep progress live without replacing focused cards or restarting their SVG animation.
  for (const task of state.tasks || []) {
    if (task.status !== 'running') continue;
    const bar = $('#agent-grid').querySelector(`[data-agent="${task.ownerId}"] .agent-progress`);
    if (bar) bar.style.width = `${Math.max(8, Math.min(100, numeric(task.progress) * 100))}%`;
  }
  const active = agents.filter(a => a.status === 'working').length;
  const waiting = state.status === 'awaiting_approval';
  $('#team-status').innerHTML = `<span class="status-dot"></span>${state.status === 'idle' ? '7 位 Agent 待命' : state.status === 'completed' ? state.result?.fullyRestored === false ? '核心业务恢复，后续事项已记录' : '任务完成，全员收工' : waiting ? '方案就绪，等待审批' : `${active} 位执行中 · ${Math.max(peakConcurrent, numeric(state.maxConcurrent))} 位并行峰值`}`;
  $('#team-caption').textContent = state.status === 'idle' ? '分工明确，各显身手。点击成员查看任务与交接。' : state.status === 'completed' ? '每个动作都有结果，每次交接都有记录。' : '工程师处理设备，业务确认影响，财务与管理层协调资源。';
}

function idleTask(id) {
  return { zhang: '链路诊断 · 连通性检查', liu: '流量分析 · 安全防护', lead: '制定方案 · 调度分工', business: '业务影响 · 恢复验收', finance: '预算核算 · 资源采购', boss: '方案决策 · 资源授权', ops: '供电巡检 · 设备操作' }[id] || '等待任务';
}

function renderTasks() {
  const tasks = state.tasks || [];
  $('#task-section').hidden = state.status === 'idle' || !tasks.length;
  if (!tasks.length) return;
  const signature = tasks.map(t => `${t.id}:${t.status}:${Math.floor(numeric(t.progress) * (numeric(t.progress) <= 1 ? 20 : .2))}`).join('/');
  if (signature !== taskSignature) {
    taskSignature = signature;
    $('#task-board').innerHTML = phaseList.map(([id, label], index) => {
      const list = tasks.filter(t => t.phase === id);
      return `<div class="task-column"><div class="task-column-title">0${index + 1} ${label}<span>${list.filter(t => t.status === 'done').length}/${list.length}</span></div>${list.map(t => `<div class="task-card ${esc(t.status)}"><div class="task-card-title">${t.status === 'done' ? icon('check') : '<i></i>'}<span>${esc(t.title)}</span></div><div class="task-card-meta"><span>${esc(AGENTS.find(a => a.id === t.ownerId)?.name || t.ownerId)}</span><span>${t.status === 'done' ? '已完成' : t.status === 'running' ? '执行中' : '等待前置'}</span></div>${t.dependencies?.length ? `<div class="task-deps" title="${esc(t.dependencies.map(dep => tasks.find(d => d.id === dep)?.title || dep).join(' → '))}">接收 ${[...new Set(t.dependencies.map(dep => AGENTS.find(a => a.id === tasks.find(d => d.id === dep)?.ownerId)?.name || '上游成员'))].map(esc).join(' / ')} 的结果</div>` : ''}${t.status === 'running' ? `<div class="task-progress"><i style="width:${Math.min(100, Math.max(4, numeric(t.progress) * (numeric(t.progress) <= 1 ? 100 : 1)))}%"></i></div>` : ''}</div>`).join('')}</div>`;
    }).join('');
  }
  $('#task-counter').textContent = `${tasks.filter(t => t.status === 'done').length} / ${tasks.length} 已完成`;
}

function renderNode() {
  const detail = $('#node-detail');
  detail.hidden = !selectedNode;
  if (!selectedNode) return;
  const n = state.nodes?.[selectedNode] || NODES.find(n => n.id === selectedNode);
  if (!n) { detail.hidden = true; return; }
  const d = nodeDetails[selectedNode];
  const signature = `${selectedNode}/${n.status}/${n.reason}/${state.logs?.length}`;
  if (nodeSignature === signature) return;
  nodeSignature = signature;
  const relevant = (state.logs || []).filter(l => l.nodeId === selectedNode).at(-1);
  detail.innerHTML = `<div class="node-detail-head"><strong>${esc(n.label || n.name || d.zone)}</strong><button class="icon-button" data-close-node aria-label="关闭设备详情">${icon('close')}</button></div><dl><div><dt>设备状态</dt><dd class="node-status ${esc(n.status)}"><span class="status-dot" style="background:${n.status === 'offline' ? '#d7856b' : n.status === 'warning' ? '#d8b371' : '#92ac78'}"></span>${statusNames[n.status] || '正常运行'}</dd></div><div><dt>网络地址</dt><dd>${d.ip}</dd></div><div><dt>所属区域</dt><dd>${d.zone}</dd></div><div><dt>设备用途</dt><dd>${d.service}</dd></div></dl><p class="node-note">${esc(relevant?.text || n.reason || n.description || '设备健康，等待巡检任务。')}</p>`;
}

function saveCompleted() {
  if (!sessionId || savedSession === sessionId) return;
  savedSession = sessionId;
  const report = sim.exportReport();
  report.uiMetrics = { peakConcurrent: Math.max(peakConcurrent, numeric(state.maxConcurrent)), handoffs: (state.logs || []).filter(l => l.type === 'handoff').length };
  history.unshift({ id: sessionId, date: new Date().toISOString(), scenarioId: state.scenarioId, duration: state.elapsed, report });
  history = history.slice(0, 12);
  try { localStorage.setItem('net-rescue-archive-v1', JSON.stringify(history)); } catch { showToast('本机存储不可用，仍可导出本次报告'); }
  $('#archive-count').textContent = history.length;
}

function render(next) {
  state = next;
  peakConcurrent = Math.max(peakConcurrent, (state.agents || []).filter(a => a.status === 'working').length);
  if (state.status !== lastStatus) {
    if (state.status === 'completed') { saveCompleted(); if (currentView === 'archive') renderArchive(); beep('complete'); }
    if (state.status === 'awaiting_approval') { panelTab = 'mission'; updateTabs(); beep('approval'); }
    lastStatus = state.status;
  }
  renderMetrics(); renderControl(); renderAgents(); renderTasks(); renderNode();
  const desks = { lead: 'core', business: 'reception', finance: 'finance', boss: 'executive', zhang: 'access', liu: 'firewall', ops: 'ups' };
  scene.update({ ...state, agents: (state.agents || []).map(agent => ({ ...agent, nodeId: agent.nodeId || desks[agent.id] })) });
}

function updateTabs() {
  document.querySelectorAll('[data-tab]').forEach(button => { button.classList.toggle('active', button.dataset.tab === panelTab); button.setAttribute('aria-selected', String(button.dataset.tab === panelTab)); });
}

function reset() {
  selectedNode = null; scene.setSelectedNode(null);
  sessionId = null; savedSession = null; peakConcurrent = 0;
  panelTab = 'mission'; controlSignature = ''; agentSignature = ''; taskSignature = ''; updateTabs();
  sim.reset();
}

function start() {
  sessionId = String(Date.now()); savedSession = null; peakConcurrent = 0;
  panelTab = 'mission'; updateTabs(); sim.start(); beep();
}

function pauseOrResume() {
  if (state.status === 'running') sim.pause();
  else if (state.status === 'paused') sim.resume();
}

function step() {
  if (state.status === 'paused') sim.resume();
  if (sim.getState().status === 'running') { sim.advance(5); if (sim.getState().status === 'running') sim.pause(); }
}

function downloadReport(report = sim.exportReport(), label = state.scenarioId) {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const localDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `net-rescue-${label}-${localDate}.json`;
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('抢修报告已导出，包含任务、动作与工具结果');
}

function showDialog(html) {
  $('#dialog-content').innerHTML = html;
  if (!$('#detail-dialog').open) $('#detail-dialog').showModal();
}

function dialogHeader(title, eyebrow = '') {
  return `${eyebrow ? `<div class="dialog-eyebrow">${eyebrow}</div>` : ''}<div class="dialog-top"><h2>${title}</h2><button class="icon-button" data-dialog-close aria-label="关闭弹窗">${icon('close')}</button></div>`;
}

function showHelp() {
  showDialog(`<div class="dialog-inner">${dialogHeader('欢迎来到疯狂网络实验室', 'HOW TO PLAY')}<div class="dialog-text">这里是一间用真实连接关系搭建的卡通办公室。选择一个事故，观察七位不同职责的模拟 Agent 如何共享证据、并行排障、交接任务并完成恢复验收。</div><div class="guide-steps"><div class="guide-step"><span>01</span><div><strong>选一个事故，注入故障</strong><p>DDoS 影响公网入口，断电影响供电依赖，交换机故障影响下游部门。点击设备可查看当前状态。</p></div></div><div class="guide-step"><span>02</span><div><strong>看小队分工，必要时做决策</strong><p>工程师执行诊断与修复；组长整合证据；业务确认影响；财务核算费用；管理层提出授权意见。遇到审批时，由你批准外部资源，或采用本地降级方案。</p></div></div><div class="guide-step"><span>03</span><div><strong>检查结果，留下证据</strong><p>在“协作记录”查看动作和工具结果，在任务板查看前置依赖。完成后导出 JSON 报告，或在“行动档案”复盘。</p></div></div></div><div class="engine-note"><strong>当前版本：本地策略 Agent 协作仿真</strong><br>7 个角色拥有独立任务状态，通过共享任务板、前置依赖和仿真工具协作。节点状态与指标由处置结果更新；没有连接真实办公网络，也没有调用真实大模型。费用和业务数据均为演练设定。</div><div style="margin-top:20px;display:flex;align-items:center;justify-content:space-between"><span class="dialog-text"><span class="keyboard-key">Space</span> 暂停 / 继续</span><button class="button button-primary" data-dialog-close>明白，开始实验 ${icon('arrow')}</button></div></div>`);
}

function showAgent(id) {
  const a = state.agents?.find(a => a.id === id) || AGENTS.find(a => a.id === id);
  if (!a) return;
  const logs = (state.logs || []).filter(l => l.agentId === id || l.targetAgentId === id);
  const tasks = (state.tasks || []).filter(t => t.ownerId === id);
  showDialog(`<div class="dialog-inner"><div class="dialog-eyebrow">AGENT PROFILE / SHARED CONTEXT</div><div class="dialog-top"><div class="dialog-agent">${portrait(id)}<div><h2>${esc(a.name)}</h2><p>${esc(a.role)} · ${agentStatusNames[a.status] || '待命'}</p></div></div><button class="icon-button" data-dialog-close aria-label="关闭成员详情">${icon('close')}</button></div><div class="agent-detail-grid"><div><small>明确任务</small><strong>${esc(state.status === 'idle' ? idleTask(id) : a.task || idleTask(id))}</strong></div><div><small>执行动作</small><strong>${esc(a.action || '等待事件与前置证据')}</strong></div><div><small>交付结果</small><strong>${esc(a.result || (state.status === 'idle' ? '演练开始后产生工具结果' : '当前任务尚未交付'))}</strong></div></div>${tasks.length ? `<h3 class="dialog-log-title">负责的任务 · ${tasks.filter(t => t.status === 'done').length}/${tasks.length}</h3>${tasks.map(t => `<div class="dialog-log"><time>${t.status === 'done' ? '✓ 完成' : t.status === 'running' ? '● 执行' : '○ 等待'}</time><span>${esc(t.title)}${t.result && t.status === 'done' ? `<br><small>${esc(t.result)}</small>` : ''}</span></div>`).join('')}` : ''}${logs.length ? `<h3 class="dialog-log-title">行动与协作交接</h3>${logs.slice(-10).map(l => `<div class="dialog-log"><time>${time(l.time)}</time><span><small>${esc(logTypes[l.type] || l.type)}</small>${esc(l.text)}</span></div>`).join('')}` : `<div class="engine-note">${esc(idleTask(id))}。事件发生后，相关证据与协作结果会进入这个角色的共享上下文。</div>`}</div>`);
}

function setView(view) {
  currentView = view;
  $('#lab-view').hidden = view !== 'lab'; $('#archive-view').hidden = view !== 'archive';
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'archive') renderArchive();
}

function renderArchive() {
  $('#archive-count').textContent = history.length;
  if (!history.length) {
    $('#archive-list').innerHTML = `<div class="archive-empty">${icon('book')}<h3>第一份抢修档案，等你来写。</h3><p>完成一次演练，任务、交接和恢复结果会保存在这里。</p><button class="button button-primary" data-return-lab>去实验室 ${icon('arrow')}</button></div>`;
    return;
  }
  const formatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', hour12: false, timeZone: 'Asia/Shanghai' });
  $('#archive-list').innerHTML = `<div class="archive-grid">${history.map(h => { const s = scenarios[h.scenarioId] || scenarios.ddos; const result = h.report.result || {}; return `<article class="archive-card"><div class="archive-card-head"><span class="scenario-icon ${esc(h.scenarioId)}">${icon(s.icon)}</span><div><h3>${s.name} · ${result.fullyRestored === false ? '降级恢复' : '抢修完成'}</h3><time>${esc(formatter.format(new Date(h.date)))}</time></div></div><div class="archive-card-numbers"><div><strong>${time(h.duration)}</strong><span>仿真耗时</span></div><div><strong>${numeric(h.report.uiMetrics?.peakConcurrent)} 人</strong><span>并行峰值</span></div><div><strong>${numeric(h.report.uiMetrics?.handoffs)} 次</strong><span>协作交接</span></div></div><div class="archive-card-actions"><button class="button button-light" data-archive-detail="${esc(h.id)}">${icon('book')}查看过程</button><button class="button button-primary" data-archive-export="${esc(h.id)}">${icon('download')}导出报告</button></div></article>`; }).join('')}</div>`;
}

function showArchiveDetail(id) {
  const item = history.find(h => h.id === id); if (!item) return;
  const r = item.report; const s = scenarios[item.scenarioId] || scenarios.ddos;
  showDialog(`<div class="dialog-inner">${dialogHeader(`${s.name} · 行动复盘`, 'INCIDENT POSTMORTEM')}<div class="report-summary">${esc(r.result?.summary || '抢修任务完成，关键业务通过验收。')}<br>仿真用时 ${time(item.duration)} · 并行峰值 ${numeric(r.uiMetrics?.peakConcurrent)} 人 · 协作交接 ${numeric(r.uiMetrics?.handoffs)} 次${r.result?.cost !== undefined ? ` · 费用 ¥${numeric(r.result.cost).toLocaleString('zh-CN')}` : ''}${r.result?.remainingRisk ? `<br>后续事项：${esc(r.result.remainingRisk)}` : ''}</div><h3 class="dialog-log-title">完整行动时间线</h3>${(r.timeline || r.logs || []).map(l => `<div class="dialog-log"><time>${time(l.time)}</time><span><small>${esc(AGENTS.find(a => a.id === l.agentId)?.name || '系统')} / ${esc(logTypes[l.type] || l.type)}</small><br>${esc(l.text)}</span></div>`).join('')}</div>`);
}

$('#control-content').addEventListener('click', (event) => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.scenario) { sim.selectScenario(button.dataset.scenario); return; }
  if (button.dataset.agent) { showAgent(button.dataset.agent); return; }
  const actions = { start, pause: pauseOrResume, step, approve: () => sim.approve(true), reject: () => sim.approve(false), reset, report: () => downloadReport() };
  actions[button.dataset.action]?.();
});
$('#control-content').addEventListener('change', event => { if (event.target.id === 'speed') sim.setSpeed(Number(event.target.value)); });
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => { panelTab = button.dataset.tab; updateTabs(); renderControl(); }));
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
$('#agent-grid').addEventListener('click', event => { const id = event.target.closest('[data-agent]')?.dataset.agent; if (id) showAgent(id); });
$('#reset').addEventListener('click', reset);
$('#back-to-lab').addEventListener('click', () => setView('lab'));
$('#help-open').addEventListener('click', showHelp);
$('#node-detail').addEventListener('click', event => { if (event.target.closest('[data-close-node]')) { selectedNode = null; scene.setSelectedNode(null); renderNode(); } });
$('#topology-toggle').addEventListener('click', () => { topologyVisible = !topologyVisible; scene.setTopology(topologyVisible); $('#topology-toggle').classList.toggle('active', topologyVisible); $('#topology-toggle').setAttribute('aria-pressed', String(topologyVisible)); });
$('#zoom-in').addEventListener('click', () => scene.zoom(.15));
$('#zoom-out').addEventListener('click', () => scene.zoom(-.15));
$('#zoom-fit').addEventListener('click', () => scene.resetView());
$('#sound-toggle').addEventListener('click', () => { soundEnabled = !soundEnabled; $('#sound-toggle').innerHTML = icon(soundEnabled ? 'volume' : 'mute'); $('#sound-toggle').title = soundEnabled ? '关闭提示音' : '开启提示音'; $('#sound-toggle').setAttribute('aria-label', soundEnabled ? '关闭提示音' : '开启提示音'); if (soundEnabled) beep(); });
$('#detail-dialog').addEventListener('click', event => { if (event.target.closest('[data-dialog-close]') || event.target === $('#detail-dialog')) $('#detail-dialog').close(); });
$('#archive-list').addEventListener('click', event => { const b = event.target.closest('button'); if (!b) return; if (b.hasAttribute('data-return-lab')) setView('lab'); if (b.dataset.archiveDetail) showArchiveDetail(b.dataset.archiveDetail); if (b.dataset.archiveExport) { const h = history.find(h => h.id === b.dataset.archiveExport); if (h) downloadReport(h.report, h.scenarioId); } });
document.addEventListener('keydown', event => { if (event.code === 'Space' && !$('#detail-dialog').open && currentView === 'lab' && ['BODY', 'HTML'].includes(document.activeElement.tagName)) { event.preventDefault(); pauseOrResume(); } });

sim.subscribe(render);
$('#archive-count').textContent = history.length;
render(state);
let lastFrame = performance.now();
setInterval(() => { const now = performance.now(); const delta = Math.min(1, (now - lastFrame) / 1000); lastFrame = now; if (state.status === 'running') sim.advance(delta * numeric(state.speed, 1)); }, 250);

// Deliberately expose only a read-only snapshot for automated verification and demonstrations.
window.networkLab = Object.freeze({ getState: () => sim.getState(), getHistory: () => structuredClone(history) });
