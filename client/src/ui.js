import { AGENTS } from './simulation.js';


const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = (name, className = '') => `<svg class="icon ${className}" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}"/></svg>`;
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


export { $, esc, icon, time, numeric, phaseList, statusNames, agentStatusNames, logTypes, scenarios, nodeDetails, portrait };
