/* The office is also the network: every visible endpoint is selectable. */
const NODE_META = {
  investment: { x:75, y:52, label:'投资资料台', w:70, ly:29 },
  internet: { x: 651, y: 65, label: '互联网', w: 59, ly: 26 },
  firewall: { x: 553, y: 213, label: '安全网关', w: 70, ly: 29 },
  core: { x: 645, y: 314, label: '核心交换机', w: 82, ly: 24 },
  server: { x: 719, y: 232, label: '应用服务器', w: 82, ly: 35 },
  storage: { x: 745, y: 351, label: 'NAS 存储', w: 76, ly: 22 },
  ups: { x: 544, y: 350, label: 'UPS 电源', w: 74, ly: 22 },
  access: { x: 459, y: 407, label: '接入交换机', w: 82, ly: 22 },
  workstations: { x: 268, y: 334, label: '员工终端', w: 70, ly: -37 },
  meeting: { x: 208, y: 516, label: '会议系统', w: 70, ly: 27 },
  executive: { x: 913, y: 250, label: '管理工作台', w: 70, ly: -37 },
  reception: { x: 529, y: 521, label: '访客网络', w: 70, ly: 27 },
  finance: { x: 845, y: 516, label: '财务终端', w: 70, ly: -36 },
};

const AGENT_META = {
  invest_research: { name:'沈研', role:'投资研究员', x:153, y:52, color:'#728eb4', hair:'#514333' },
  invest_finance: { name:'顾衡', role:'财务尽调师', x:293, y:52, color:'#b7a16a', hair:'#474b45' },
  invest_risk: { name:'何审', role:'独立风险审查', x:433, y:52, color:'#9c85a8', hair:'#493d50' },
  zhang: { name:'小张', role:'网络工程师', x:350, y:350, color:'#7299ba', hair:'#514333' },
  liu: { name:'小刘', role:'安全工程师', x:620, y:220, color:'#a692bb', hair:'#493d50' },
  lead: { name:'陈工', role:'技术组长', x:650, y:350, color:'#6fa79c', hair:'#474b45' },
  business: { name:'林悦', role:'业务组长', x:600, y:540, color:'#ce9676', hair:'#6b483d' },
  finance: { name:'许姐', role:'财务', x:870, y:540, color:'#bdac73', hair:'#5e443d' },
  boss: { name:'周助理', role:'管理审校', x:953, y:302, color:'#9f8298', hair:'#4d4440' },
  ops: { name:'阿杰', role:'机房运维', x:565, y:340, color:'#8eaa76', hair:'#484b3d' },
};
const WORK_POSITIONS = {
  investment:[[153,52],[293,52],[433,52]],
  internet:[[729,69],[801,69]], firewall:[[593,259],[525,269]],
  core:[[688,297],[627,271]], server:[[683,271],[762,289]],
  storage:[[778,327],[718,384]], ups:[[584,323],[582,276]],
  access:[[421,397],[492,397]], workstations:[[313,290],[387,290]],
  meeting:[[298,552],[123,560]], executive:[[951,313],[861,335]],
  reception:[[612,555],[447,557]], finance:[[909,551],[784,567]],
};

let sceneCounter = 0;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function mountScene(container, { onSelectNode = () => {}, onSelectAgent = () => {}, onSelectHuman = () => {}, onViewChange = () => {} } = {}) {
  const uid = `cnl-office-${++sceneCounter}`;
  const symbolBounds = { plant:[-20,-44,40,53], person:[-25,-25,50,71], desk:[-3,-3,114,65], server:[-3,-5,58,110], switch:[-40,-14,80,35], cup:[-6,-8,16,19], sofa:[-4,-4,99,50], chair:[-14,-12,28,35] };
  const use = (name, x, y, scale = 1, extra = '') => {
    const [sx,sy,width,height] = symbolBounds[name];
    return `<use href="#${uid}-${name}" x="${sx}" y="${sy}" width="${width}" height="${height}" overflow="visible" transform="translate(${x} ${y}) scale(${scale})" ${extra}/>`;
  };
  const person = (x, y, shirt, hair = '#3d393d', scale = 1, extra = '') => use('person', x, y, scale, `style="--shirt:${shirt};--hair:${hair}" ${extra}`);
  const desk = (x, y, shirt, options = {}) => `<g class="cnl-desk">${use('desk', x, y, options.scale || 1, `style="--screen:${options.screen || '#a7d5db'}"`)}${person(x + 51 * (options.scale || 1), y + 59 * (options.scale || 1), shirt, options.hair || '#3d393d', (options.scale || 1) * 0.84)}${options.cup ? use('cup', x + 90, y + 26, 0.8) : ''}</g>`;
  const plant = (x, y, scale = 1) => use('plant', x, y, scale);
  const title = (x, y, text, english, color) => `<g transform="translate(${x} ${y})"><rect x="0" y="-13" width="4" height="24" rx="2" fill="${color}"/><text x="13" y="-1" class="cnl-room-title">${text}</text><text x="13" y="12" class="cnl-room-en">${english}</text></g>`;
  const paths = [
    ['access', 'investment', 'M459 407H34V102H75V52'],
    ['internet', 'firewall', 'M651 78V120H553V213'],
    ['firewall', 'core', 'M553 213V274H645V314'],
    ['core', 'server', 'M645 314H675V232H719'],
    ['core', 'storage', 'M645 314H692V351H745'],
    ['core', 'access', 'M645 314V407H459'],
    ['access', 'workstations', 'M459 407H424V334H268'],
    ['access', 'meeting', 'M459 407H359V481H208V516'],
    ['access', 'executive', 'M459 407H913V250'],
    ['access', 'reception', 'M459 407H529V521'],
    ['access', 'finance', 'M459 407H845V516'],
  ];
  const linkMarkup = paths.map(([a,b,d],i) => `<g class="cnl-link" data-a="${a}" data-b="${b}"><path class="cnl-cable-under" d="${d}"/><path class="cnl-cable" d="${d}"/><path class="cnl-packet" d="${d}" style="animation-delay:-${i * .61}s"/></g>`).join('');
  const hotspots = Object.entries(NODE_META).map(([id, n]) => `<g class="cnl-node" data-node="${id}" data-status="online" tabindex="0" role="button" aria-label="查看${n.label}" transform="translate(${n.x} ${n.y})"><circle class="cnl-fault-halo" r="25"/><circle class="cnl-hit-ring" r="23"/><circle class="cnl-hit-area" r="25"/><g class="cnl-node-label" transform="translate(${-n.w / 2} ${n.ly})"><rect width="${n.w}" height="19" rx="7"/><circle class="cnl-status-dot" cx="9" cy="9.5" r="3"/><text x="17" y="12.6">${n.label}</text></g><g class="cnl-alert-mark" transform="translate(16 -23)"><circle r="8"/><text y="3.5" text-anchor="middle">!</text></g></g>`).join('');

  container.innerHTML = `<svg class="cnl-office-scene" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1060 650" role="group" aria-label="疯狂实验室办公室网络拓扑，设备与 AI 虚拟员工均可点击操作，空白区域可拖动，滚轮可缩放" preserveAspectRatio="xMidYMid meet">
  <defs>
    <pattern id="${uid}-grid" width="26" height="26" patternUnits="userSpaceOnUse"><path d="M26 0H0V26" fill="none" stroke="#48564e" stroke-opacity=".035" stroke-width="1"/></pattern>
    <pattern id="${uid}-floor" width="68" height="28" patternUnits="userSpaceOnUse"><path d="M0 28H68M34 0V28M0 0V14M68 14V28" stroke="#a79b81" stroke-opacity=".12" fill="none" stroke-width=".7"/></pattern>
    <linearGradient id="${uid}-glass" x2="0" y2="1"><stop stop-color="#cceae8"/><stop offset="1" stop-color="#e8f5ec"/></linearGradient>
    <linearGradient id="${uid}-screen" x2="1" y2="1"><stop stop-color="#306e70"/><stop offset="1" stop-color="#183c48"/></linearGradient>
    <filter id="${uid}-shadow" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="5" stdDeviation="5" flood-color="#273c35" flood-opacity=".09"/></filter>
    <filter id="${uid}-soft" x="-35%" y="-35%" width="170%" height="170%"><feDropShadow dx="0" dy="2" stdDeviation="1.3" flood-color="#344239" flood-opacity=".12"/></filter>
    <symbol id="${uid}-plant" viewBox="-20 -44 40 53"><ellipse cy="6" rx="15" ry="4" fill="#334e3a" opacity=".09"/><path d="M-11-9H11L8 6Q0 10-8 6Z" fill="#f6e0bd" stroke="#4f6052" stroke-width="1.1"/><ellipse cy="-9" rx="11" ry="3.5" fill="#afbd8d" stroke="#4f6052" stroke-width="1.1"/><path d="M0-9V-34M0-18Q-16-16-13-32Q1-33 0-18M0-24Q15-25 12-40Q-1-38 0-24M0-12Q13-10 16-24Q3-25 0-12M0-30Q-11-30-9-42Q3-41 0-30" fill="#75ae82" stroke="#4b7960" stroke-width="1.1" stroke-linecap="round"/></symbol>
    <symbol id="${uid}-person" viewBox="-25 -25 50 71"><ellipse cy="39" rx="21" ry="5" fill="#4d5b59" opacity=".1"/><rect x="-17" y="-1" width="34" height="35" rx="12" fill="#536773" stroke="#394f53" stroke-width="1.1"/><path d="M-10 23L-11 34M9 23L11 34" stroke="#34404c" stroke-width="8" stroke-linecap="round"/><path d="M-12 36H-5M9 36H15" stroke="#36434a" stroke-width="6" stroke-linecap="round"/><path d="M-10 3Q0-4 11 3L12 21Q0 27-12 21Z" fill="var(--shirt,#73aaa4)" stroke="#3b5556" stroke-width="1"/><path d="M-10 6L-18 13L-18 2M11 6L18 13L18 2" fill="none" stroke="var(--shirt,#73aaa4)" stroke-width="7" stroke-linecap="round"/><circle cx="-18" cy="1" r="3.6" fill="#edc3a2" stroke="#876f5d" stroke-width=".6"/><circle cx="18" cy="1" r="3.6" fill="#edc3a2" stroke="#876f5d" stroke-width=".6"/><rect x="-3" y="-2" width="6" height="7" rx="2" fill="#e8b690"/><ellipse cy="-10" rx="10.5" ry="11.3" fill="#f2ccad" stroke="#8a7665" stroke-width=".9"/><path d="M-10-8Q-14-23 1-23Q14-23 11-7L7-13Q0-10-4-16L-9-11Z" fill="var(--hair,#3d393d)"/><path d="M-3-6Q0-4 3-6" fill="none" stroke="#a86f60" stroke-width="1" stroke-linecap="round"/><circle cx="-4" cy="-10" r="1" fill="#3f4548"/><circle cx="4" cy="-10" r="1" fill="#3f4548"/><ellipse cx="-7" cy="-6" rx="2" ry="1" fill="#e9a994" opacity=".6"/><ellipse cx="7" cy="-6" rx="2" ry="1" fill="#e9a994" opacity=".6"/></symbol>
    <symbol id="${uid}-desk" viewBox="-3 -3 114 65"><ellipse cx="52" cy="54" rx="53" ry="9" fill="#4d5b59" opacity=".07"/><path d="M5 40V54M98 40V54" stroke="#7d8b83" stroke-width="5"/><path d="M0 5L7 0H104L108 6V44Q108 49 102 49H6Q0 49 0 43Z" fill="#bcbea7" stroke="#53655b" stroke-width="1.2"/><rect x="0" y="0" width="108" height="43" rx="6" fill="#f9f3dc" stroke="#53655b" stroke-width="1.2"/><rect x="28" y="3" width="48" height="28" rx="3" fill="#3f555d" stroke="#36494e" stroke-width="1.1"/><rect x="31" y="6" width="42" height="21" rx="1" fill="var(--screen,#a7d5db)"/><path d="M35 11H53M35 15H47M35 19H57" stroke="#fff" opacity=".66" stroke-width="1.5"/><path d="M62 10L69 17L62 24" fill="none" stroke="#fff" opacity=".45" stroke-width="2"/><path d="M52 31V34M44 35H60" stroke="#576566" stroke-width="2.5" stroke-linecap="round"/><rect x="34" y="36" width="36" height="5" rx="1.5" fill="#c6cfc4" stroke="#677b71" stroke-width=".7"/><path d="M39 38.5H64" stroke="#84958b" stroke-width=".7" stroke-dasharray="2 1"/><ellipse cx="78" cy="38" rx="3" ry="4" fill="#dce2d4" stroke="#7f8b80" stroke-width=".7"/><rect x="10" y="24" width="13" height="14" rx="1" fill="#f1d6ab" transform="rotate(-8 10 24)"/><path d="M12 29H20M12 32H19" stroke="#bdad8b" stroke-width=".8"/></symbol>
    <symbol id="${uid}-server" viewBox="-3 -5 58 110"><ellipse cx="26" cy="99" rx="28" ry="6" fill="#344b46" opacity=".1"/><path d="M0 3L8-2H50L45 5Z" fill="#829497" stroke="#354b51" stroke-width="1.2"/><path d="M45 5L50-2V87L45 95Z" fill="#344d55" stroke="#354b51" stroke-width="1.2"/><rect x="0" y="4" width="45" height="92" rx="3" fill="#496169" stroke="#354b51" stroke-width="1.3"/><rect x="4" y="9" width="37" height="80" rx="2" fill="#263e48"/><g fill="#3f555e" stroke="#1d3540" stroke-width=".6"><rect x="7" y="13" width="31" height="13" rx="1.5"/><rect x="7" y="30" width="31" height="13" rx="1.5"/><rect x="7" y="47" width="31" height="13" rx="1.5"/><rect x="7" y="64" width="31" height="13" rx="1.5"/></g><g stroke="#89aaa9" stroke-width="1.1"><path d="M11 18H26M11 21H26M11 35H26M11 38H26M11 52H26M11 55H26M11 69H26M11 72H26"/></g><g class="cnl-server-led" fill="#b6e79c"><circle cx="33" cy="19" r="1.6"/><circle cx="33" cy="36" r="1.6"/><circle cx="33" cy="53" r="1.6"/><circle cx="33" cy="70" r="1.6"/></g><rect x="9" y="82" width="27" height="3" rx="1.5" fill="#738e90"/><path d="M8 96V101M37 96V101" stroke="#465b5d" stroke-width="4" stroke-linecap="round"/></symbol>
    <symbol id="${uid}-switch" viewBox="-40 -14 80 35"><path d="M-35-7L-28-13H35L39-7V11L33 16H-35Z" fill="#91b1a9" stroke="#3f5c5b" stroke-width="1.2"/><rect x="-35" y="-7" width="70" height="20" rx="3" fill="#e0e9d9" stroke="#3f5c5b" stroke-width="1.2"/><g fill="#526c67"><rect x="-27" y="-1" width="6" height="5" rx=".7"/><rect x="-17" y="-1" width="6" height="5" rx=".7"/><rect x="-7" y="-1" width="6" height="5" rx=".7"/><rect x="3" y="-1" width="6" height="5" rx=".7"/><rect x="13" y="-1" width="6" height="5" rx=".7"/></g><circle cx="27" cy="1" r="2.2" fill="#81b774"/><path d="M-26 7H17" stroke="#96a991" stroke-width="1" stroke-dasharray="2 3"/></symbol>
    <symbol id="${uid}-cup" viewBox="-6 -8 16 19"><ellipse cy="8" rx="7" ry="2" fill="#717f72" opacity=".12"/><path d="M5-2Q13-3 10 4Q8 7 4 4" fill="none" stroke="#687f73" stroke-width="1.5"/><path d="M-5-4H6L5 7Q0 10-4 7Z" fill="#fff8e9" stroke="#687f73" stroke-width="1"/><ellipse cx=".5" cy="-4" rx="5.5" ry="2" fill="#9c7e60" stroke="#687f73" stroke-width="1"/><path d="M0-8Q3-11 1-14" fill="none" stroke="#87968b" stroke-width=".7" opacity=".6"/></symbol>
    <symbol id="${uid}-sofa" viewBox="-4 -4 99 50"><ellipse cx="45" cy="41" rx="47" ry="6" fill="#54695e" opacity=".1"/><rect x="3" y="0" width="84" height="34" rx="9" fill="#8aa9a6" stroke="#516f69" stroke-width="1.2"/><rect x="7" y="5" width="76" height="24" rx="6" fill="#b2c8b6" stroke="#6d9387" stroke-width="1"/><rect x="10" y="17" width="33" height="16" rx="4" fill="#ccdac2" stroke="#769687" stroke-width="1"/><rect x="46" y="17" width="33" height="16" rx="4" fill="#ccdac2" stroke="#769687" stroke-width="1"/><rect x="0" y="15" width="11" height="23" rx="4" fill="#a0bba9" stroke="#516f69" stroke-width="1.1"/><rect x="79" y="15" width="11" height="23" rx="4" fill="#a0bba9" stroke="#516f69" stroke-width="1.1"/><path d="M9 38V43M79 38V43" stroke="#6f7d6b" stroke-width="3"/></symbol>
    <symbol id="${uid}-chair" viewBox="-14 -12 28 35"><rect x="-11" y="-8" width="22" height="24" rx="7" fill="#b6b3cc" stroke="#7a7f96" stroke-width="1.1"/><rect x="-8" y="1" width="16" height="11" rx="4" fill="#d3cee1"/><path d="M-8 16V20M8 16V20" stroke="#7a7f96" stroke-width="2.2"/></symbol>
  </defs>
  <style>
    .cnl-office-scene{width:100%;height:100%;display:block;overflow:visible;font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif;user-select:none;touch-action:none;cursor:grab}.cnl-office-scene.is-panning{cursor:grabbing}
    .cnl-office-scene text{pointer-events:none}.cnl-room-title{font-size:14px;font-weight:750;fill:#34473f;letter-spacing:.5px}.cnl-room-en{font-size:7.5px;font-weight:600;fill:#8a9486;letter-spacing:1.1px}.cnl-small{font-size:8px;fill:#7c8b80;letter-spacing:.6px}.cnl-tiny{font-size:6px;fill:#60776f}
    .cnl-cable-under{fill:none;stroke:#fcfcf4;stroke-width:7;stroke-linecap:round;stroke-linejoin:round;opacity:.86}.cnl-cable{fill:none;stroke:#77b9b6;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;opacity:.7}.cnl-packet{fill:none;stroke:#e5fff4;stroke-width:3;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:4 130;animation:cnl-datastream 6s linear infinite}.cnl-power-wire{fill:none;stroke:#d0b164;stroke-width:1.7;stroke-dasharray:4 4;stroke-linecap:round;opacity:.75}
    .cnl-links{transition:opacity .25s}.cnl-topology-off .cnl-links{opacity:0}.cnl-link.is-offline .cnl-cable{stroke:#e78b80;stroke-dasharray:4 5;opacity:.85}.cnl-link.is-offline .cnl-packet{display:none}.cnl-link.is-warning .cnl-cable{stroke:#d6ad57}.cnl-link.is-recovering .cnl-cable{stroke:#67a58b}.cnl-link.is-recovering .cnl-packet{stroke:#c7ec9c;animation-duration:2.7s}
    .cnl-node{cursor:pointer;outline:none;--status:#71a78a}.cnl-hit-area{fill:transparent;stroke:none}.cnl-hit-ring{fill:transparent;stroke:#83bca3;stroke-width:1.8;opacity:0;transition:opacity .2s}.cnl-node:hover .cnl-hit-ring,.cnl-node:focus-visible .cnl-hit-ring,.cnl-node.is-selected .cnl-hit-ring{opacity:1}.cnl-node.is-selected .cnl-hit-ring{stroke:#3c7966;stroke-width:2.2;stroke-dasharray:3 3;animation:cnl-rotate 16s linear infinite}.cnl-node-label rect{fill:#fffef7;stroke:#abbba7;stroke-width:.65;opacity:.96}.cnl-node-label text{font-size:8.2px;fill:#52685d;font-weight:650}.cnl-status-dot{fill:var(--status);stroke:white;stroke-width:.8}.cnl-fault-halo{fill:var(--status);opacity:0;stroke:var(--status);stroke-width:1}.cnl-alert-mark{display:none}.cnl-alert-mark circle{fill:#e68c78;stroke:#fffaf0;stroke-width:1.5}.cnl-alert-mark text{fill:white;font-size:10px;font-weight:800}.cnl-node[data-status="warning"]{--status:#d4a450}.cnl-node[data-status="offline"]{--status:#df8076}.cnl-node[data-status="recovering"]{--status:#68a994}.cnl-node[data-status="offline"] .cnl-fault-halo,.cnl-node[data-status="warning"] .cnl-fault-halo{animation:cnl-faultpulse 1.8s ease-in-out infinite}.cnl-node[data-status="offline"] .cnl-alert-mark,.cnl-node[data-status="warning"] .cnl-alert-mark{display:block}.cnl-node[data-status="offline"] .cnl-node-label rect{stroke:#d68b7b;fill:#fff3e9}.cnl-node[data-status="recovering"] .cnl-hit-ring{opacity:.8;stroke:#66a38e;stroke-dasharray:3 3;animation:cnl-rotate 6s linear infinite}.cnl-device[data-status="offline"]{filter:saturate(.35)}.cnl-device[data-status="offline"] .cnl-server-led{fill:#dd8576}.cnl-device[data-status="warning"] .cnl-server-led{fill:#dfb461}.cnl-device[data-status="recovering"] .cnl-server-led{animation:cnl-ledblink .6s alternate infinite}
    .cnl-agent-badge{pointer-events:none;animation:cnl-agentpop .3s ease-out}.cnl-agent-badge .cnl-agent-face{fill:#f8e9cf;stroke:#3e6860;stroke-width:1.3}.cnl-agent-badge text{font-size:9px;fill:#3f6057;font-weight:800}.cnl-agent-badge .cnl-tool-ring{fill:#e9f1dd;stroke:#9bb39c;stroke-width:.8}.cnl-agent-badge .cnl-tool{fill:none;stroke:#547967;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.cnl-agent-badge.is-working .cnl-tool-ring{animation:cnl-toolpulse 1s ease-in-out infinite}.cnl-action-label{font-size:8px!important;font-weight:600!important;fill:#5c7568!important}.cnl-work-indicator{fill:#adcf94;animation:cnl-ledblink 1.3s alternate infinite}
    .cnl-ai-aura{fill:#8ee6d0;stroke:#47aa9b;stroke-width:.7;opacity:.24}.cnl-ai-badge rect{fill:#e5fffa;stroke:#2a9f8d;stroke-width:.6}.cnl-ai-badge text{fill:#176b60;font-size:3.8px;font-weight:900}.cnl-agent.is-working .cnl-ai-aura{opacity:.5;stroke:#28a08c}.cnl-agent{cursor:pointer;outline:none;transition:transform .65s cubic-bezier(.2,.8,.2,1),opacity .2s}.cnl-agent.is-unassigned{opacity:.55}.cnl-agent.is-unassigned:hover,.cnl-agent.is-unassigned:focus-visible{opacity:.85}.cnl-agent-hit{fill:transparent;stroke:none}.cnl-agent-ground{fill:#f7f6e9;stroke:#a8b8a0;stroke-width:.9;opacity:.9}.cnl-agent .cnl-agent-card{fill:#fffef6;stroke:#a5b69d;stroke-width:.7;stroke-dasharray:2 2}.cnl-agent.is-configured .cnl-agent-card{stroke-dasharray:none;stroke:#89a995}.cnl-agent:hover .cnl-agent-card,.cnl-agent:focus-visible .cnl-agent-card,.cnl-agent.is-selected .cnl-agent-card{stroke:#447e6a;stroke-width:1.6;fill:#f9fff4}.cnl-agent-name{fill:#38594b;font-size:8px;font-weight:800}.cnl-agent-type{fill:#248b79;font-size:5px;font-weight:700;letter-spacing:.6px}.cnl-agent-state{fill:#7c8b77;font-size:6px;font-weight:550}.cnl-agent.is-working .cnl-agent-state{fill:#46745c}.cnl-agent .cnl-config-dot{fill:#fffcf1;stroke:#a5b198;stroke-width:1}.cnl-agent.is-configured .cnl-config-dot{fill:#80aa87;stroke:#80aa87}.cnl-agent.is-configured .cnl-config-check{display:block}.cnl-config-check{display:none;fill:none;stroke:#fff;stroke-width:.9;stroke-linecap:round;stroke-linejoin:round}.cnl-agent.is-working .cnl-agent-ground{fill:#d9eacf;stroke:#8fae80;animation:cnl-toolpulse 1.5s ease-in-out infinite}.cnl-agent .cnl-tool-ring{fill:#edf4df;stroke:#95ad8e;stroke-width:.8}.cnl-agent .cnl-tool{fill:none;stroke:#507461;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}.cnl-agent .cnl-role-tool{display:none}.cnl-agent.is-working .cnl-role-tool{display:block;animation:cnl-agenttool 1.2s ease-in-out infinite}.cnl-handoff-layer{pointer-events:none}.cnl-handoff-line{fill:none;stroke:#bd9c65;stroke-width:1.4;stroke-dasharray:3 4;opacity:.7;animation:cnl-handofffade 2.8s both}.cnl-handoff-envelope rect{fill:#fff6d9;stroke:#aa8b55;stroke-width:.8}.cnl-handoff-envelope path{fill:none;stroke:#aa8b55;stroke-width:.7}.cnl-handoff-envelope{filter:url(#${uid}-soft)}
    .cnl-human-approval{display:none;cursor:pointer;outline:none}.cnl-human-approval.is-requesting{display:block}.cnl-human-halo{fill:#f0c165;stroke:#bd8536;stroke-width:1.2;opacity:.35;animation:cnl-humanpulse 1.8s ease-in-out infinite}.cnl-human-ring{fill:none;stroke:#e0a248;stroke-width:2.2;stroke-dasharray:3 3}.cnl-human-approval rect{fill:#fff4d2;stroke:#c79443;stroke-width:1}.cnl-human-approval text{fill:#996623;font-size:10px;font-weight:800}.cnl-human-approval .cnl-human-sub{font-size:6px;font-weight:600;fill:#b28a4b}.cnl-human-approval:hover rect,.cnl-human-approval:focus-visible rect{stroke:#9f6621;stroke-width:2}@keyframes cnl-humanpulse{50%{opacity:.62;r:39}}
    @keyframes cnl-agenttool{50%{transform:translateY(-2px) rotate(9deg)}}@keyframes cnl-handofffade{0%{opacity:0}12%,74%{opacity:.7}100%{opacity:0}}
    @keyframes cnl-datastream{to{stroke-dashoffset:-268}}@keyframes cnl-faultpulse{0%,100%{opacity:.03;r:24}50%{opacity:.16;r:30}}@keyframes cnl-rotate{to{transform:rotate(360deg)}}@keyframes cnl-ledblink{from{opacity:.4}to{opacity:1}}@keyframes cnl-agentpop{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}@keyframes cnl-toolpulse{50%{fill:#c7e2ad}}
    @media(prefers-reduced-motion:reduce){.cnl-office-scene *{animation:none!important}}
  </style>

  <g class="cnl-world">
    <rect x="0" y="0" width="1060" height="650" rx="20" fill="#eef1e7"/>
    <rect x="0" y="0" width="1060" height="650" fill="url(#${uid}-grid)"/>
    <g opacity=".55" stroke="#c9d4c2" stroke-width="1" fill="none"><path d="M24 66h16m-8-8v16M1017 68h16m-8-8v16M24 629h16m-8-8v16M1017 629h16m-8-8v16"/><circle cx="278" cy="66" r="2"/><circle cx="831" cy="52" r="2"/></g>

    <!-- Internet remains outside the office boundary. -->
    <g class="cnl-device" data-device="internet" transform="translate(651 62)">
      <ellipse cy="19" rx="49" ry="6" fill="#bacac0" opacity=".2"/>
      <path d="M-34 13C-54 10-52-13-34-16C-30-37 1-39 10-22C33-29 48-12 43 1C55 15 32 23 17 19H-31Z" fill="#fffef7" stroke="#90aca0" stroke-width="1.4"/>
      <path d="M-14-1Q0-14 14-1M-8 5Q0-2 8 5" fill="none" stroke="#6f9e94" stroke-width="2" stroke-linecap="round"/><circle cy="10" r="2" fill="#6f9e94"/>
    </g>
    <text x="705" y="58" class="cnl-small">外部网络</text><text x="705" y="71" class="cnl-tiny">WAN · INTERNET</text>

    <!-- A shallow dollhouse frame, tiled floors, and open doors. -->
    <g filter="url(#${uid}-shadow)">
      <path d="M43 124L55 108H1005L1017 124V610L1004 624H55L43 612Z" fill="#9ea99a" stroke="#566d5d" stroke-width="1.5"/>
      <path d="M43 122H1017V608H43Z" fill="#f8f3df" stroke="#6b7f69" stroke-width="1.4"/>
      <path d="M43 608H1017V621H43Z" fill="#c5c9af" stroke="#6b7f69" stroke-width="1.2"/>
      <rect x="53" y="130" width="954" height="474" fill="url(#${uid}-floor)"/>
      <rect x="57" y="137" width="427" height="249" rx="5" fill="#e8eddb"/>
      <rect x="500" y="137" width="302" height="249" rx="5" fill="#dfebe7"/>
      <rect x="817" y="137" width="189" height="249" rx="5" fill="#f2e4cc"/>
      <rect x="57" y="443" width="294" height="160" rx="5" fill="#e5e3ee"/>
      <rect x="368" y="443" width="310" height="160" rx="5" fill="#f3e3d0"/>
      <rect x="695" y="443" width="311" height="160" rx="5" fill="#e3eada"/>
      <rect x="57" y="137" width="427" height="249" rx="5" fill="url(#${uid}-floor)"/>
      <rect x="817" y="137" width="189" height="249" rx="5" fill="url(#${uid}-floor)"/>
      <rect x="368" y="443" width="310" height="160" rx="5" fill="url(#${uid}-floor)"/>
      <g fill="#eff3e5" stroke="#82937f" stroke-width="1.1">
        <path d="M44 115H1016V133H44Z"/>
        <path d="M43 131H56V606H43Z"/>
        <path d="M1005 132H1017V609H1005Z"/>
        <path d="M484 134H497V380H484Z"/>
        <path d="M803 134H816V380H803Z"/>
        <path d="M56 430H168V443H56ZM246 430H351V443H246Z"/>
        <path d="M367 430H490V443H367ZM565 430H677V443H565Z"/>
        <path d="M695 430H809V443H695ZM880 430H1005V443H880Z"/>
        <path d="M351 443H365V605H351ZM678 443H692V605H678Z"/>
      </g>
      <g fill="url(#${uid}-glass)" stroke="#9ab7ab" stroke-width=".8"><rect x="91" y="116" width="144" height="13" rx="2"/><rect x="267" y="116" width="144" height="13" rx="2"/><rect x="843" y="116" width="132" height="13" rx="2"/></g>
      <g stroke="#9ab7ab" stroke-width=".8"><path d="M163 117V128M339 117V128M909 117V128"/></g>
      <g stroke="#9bad95" stroke-width="1" stroke-dasharray="3 3" fill="none" opacity=".6"><path d="M169 431V442H245M491 431V442H564M810 431V442H879"/></g>
      <g fill="#e5dfc8"><rect x="168" y="430" width="78" height="13"/><rect x="490" y="430" width="75" height="13"/><rect x="809" y="430" width="71" height="13"/></g>
      <g stroke="#a2b29b" stroke-width=".8" fill="none"><path d="M169 430V396Q207 396 207 430M491 430V395Q528 395 528 430M810 430V395Q845 395 845 430" opacity=".5"/></g>
    </g>

    <!-- The actual topology lives on the office floor, below the furniture. -->
    <g class="cnl-links">${linkMarkup}<path class="cnl-power-wire" d="M544 350V375H780V351H745M645 375V314M719 375V232"/><g transform="translate(594 378)"><path d="M3-5L-2 1H3L0 7L8-1H3L7-5Z" fill="#bd9d52"/><text x="14" y="3" class="cnl-tiny" fill="#ac9257">供电</text></g></g>

    <!-- Open workspace: six complete workstations, six coworkers. -->
    ${title(77, 165, '开放办公区', 'TEAM WORKSPACE · 48 CLIENTS', '#8fa885')}
    <g opacity=".58"><rect x="85" y="196" width="347" height="180" rx="12" fill="#dce4cf"/><path d="M95 285H423" stroke="#c9d5bc" stroke-width="1" stroke-dasharray="4 5"/></g>
    ${desk(90, 207, '#d29878', {cup:true,screen:'#b2d9d2'})}
    ${desk(214, 207, '#91a9cd', {hair:'#6b4a37',screen:'#bad6df'})}
    ${desk(338, 207, '#7fa18c', {screen:'#bdd3b4'})}
    ${desk(90, 310, '#ae9aba', {hair:'#795544',screen:'#c4c2de'})}
    <g class="cnl-device" data-device="workstations">${desk(214, 310, '#e0b16f', {screen:'#bddfd3',cup:true})}</g>
    ${desk(338, 310, '#80a4b0', {hair:'#463d46',screen:'#a7d2dd'})}
    ${plant(68, 366, .74)}${plant(455, 185, .82)}
    <g transform="translate(405 153)"><rect width="50" height="24" rx="3" fill="#f9f7e9" stroke="#a5b49a" stroke-width="1"/><path d="M6 18L14 11L22 14L31 7L44 4" fill="none" stroke="#9eb28b" stroke-width="1.6"/><circle cx="44" cy="4" r="2" fill="#9eb28b"/></g>
    <g class="cnl-device" data-device="access">${use('switch',459,404,.68)}<path d="M461 394V385M457 386H466" stroke="#6c8a78" stroke-width="1.4" stroke-linecap="round"/></g>

    <!-- Server room: edge firewall, racks, aggregation, NAS and UPS. -->
    ${title(519, 165, '网络机房', 'NETWORK OPERATIONS', '#7fa7a0')}
    <g transform="translate(514 181)"><rect width="72" height="61" rx="5" fill="#d3e1dc" stroke="#a4b9ad" stroke-width=".9"/><path d="M5 8H67M5 53H67" stroke="#b6c9bf" stroke-width="1"/></g>
    <g class="cnl-device" data-device="firewall" transform="translate(553 209)"><path d="M-27-12L-20-17H26L30-12V15H-27Z" fill="#a9bfb4" stroke="#46655d" stroke-width="1.2"/><rect x="-27" y="-12" width="54" height="27" rx="3" fill="#f1ead1" stroke="#46655d" stroke-width="1.2"/><path d="M-16-5H-8V2H-16ZM-6-5H2V2H-6ZM4-5H12V2H4ZM-16 4H-8V9H-16ZM-6 4H2V9H-6ZM4 4H12V9H4Z" fill="#c4a681"/><circle cx="20" cy="3" r="2.2" fill="#84ac78"/><path d="M-23-14V-29M22-14V-29" stroke="#627e70" stroke-width="2.5" stroke-linecap="round"/></g>
    <g transform="translate(603 198)"><rect width="43" height="49" rx="4" fill="#edf2e4" stroke="#a0b6a5" stroke-width="1"/><rect x="6" y="7" width="31" height="19" rx="2" fill="url(#${uid}-screen)"/><path d="M10 20L15 15L20 18L25 11L32 15" fill="none" stroke="#a6d4b4" stroke-width="1.2"/><text x="8" y="38" class="cnl-tiny">NOC · 24/7</text><circle cx="33" cy="37" r="2" fill="#9ec98d"/></g>
    <g class="cnl-device" data-device="server">${use('server',690,186,.94)}${use('server',745,186,.94)}</g>
    <g class="cnl-device" data-device="core">${use('switch',645,310,.95)}</g>
    <g class="cnl-device" data-device="storage" transform="translate(745 343)"><path d="M-27-11L-22-16H25L30-10V13L25 18H-27Z" fill="#94aeb0" stroke="#466068" stroke-width="1.1"/><rect x="-27" y="-10" width="52" height="27" rx="3" fill="#c8d7d2" stroke="#466068" stroke-width="1.1"/><g fill="#627c7b"><rect x="-20" y="-5" width="8" height="18" rx="1.4"/><rect x="-9" y="-5" width="8" height="18" rx="1.4"/><rect x="2" y="-5" width="8" height="18" rx="1.4"/></g><g fill="#b3d69b"><circle cx="-16" cy="8" r="1"/><circle cx="-5" cy="8" r="1"/><circle cx="6" cy="8" r="1"/></g><circle cx="18" cy="3" r="2" fill="#88ac82"/></g>
    <g class="cnl-device" data-device="ups" transform="translate(544 344)"><path d="M-19-27L-12-32H20L23-26V15L18 20H-19Z" fill="#8d9b94" stroke="#4e655d" stroke-width="1.2"/><rect x="-19" y="-26" width="37" height="47" rx="3" fill="#f5e9c8" stroke="#4e655d" stroke-width="1.2"/><rect x="-12" y="-19" width="22" height="10" rx="2" fill="#5d7568"/><path d="M-8-14H5" stroke="#b6d29d" stroke-width="1.4"/><path d="M1-4L-6 5H0L-3 13L7 2H1L5-4Z" fill="#b69b5d"/><path d="M-13 17H12" stroke="#b4b79d" stroke-dasharray="1 2" stroke-width="2"/></g>
    <g transform="translate(601 351)"><circle r="10" fill="#e9eee2" stroke="#a4b8a8" stroke-width="1"/><path d="M-4 1V-4Q0-10 4-4V2Q8 7 0 8Q-8 7-4 1Z" fill="#b8cfb1"/><circle cy="4" r="3" fill="#95ae8d"/></g>
    <g transform="translate(756 153)" stroke="#9db6aa" stroke-width="1"><rect width="31" height="15" rx="2" fill="#eaf0e3"/><path d="M4 4H27M4 7H27M4 10H27"/></g>

    <!-- Executive office: a lived-in room, not an isolated computer icon. -->
    ${title(833, 165, '管理办公室', 'HUMAN APPROVAL', '#c5a579')}
    <rect x="840" y="206" width="144" height="111" rx="8" fill="#e8d8b9" opacity=".6"/>
    <g class="cnl-device" data-device="executive">${desk(857,226,'#c88f68',{scale:1.03,screen:'#b8d3d6',hair:'#4e4742',cup:true})}</g>
    <g transform="translate(840 327)">${use('sofa',0,0,.75)}<rect x="79" y="6" width="43" height="31" rx="7" fill="#ead1ab" stroke="#9b967e" stroke-width="1"/>${use('cup',98,18,.65)}</g>
    ${plant(980, 185, .77)}${plant(984, 366, .83)}
    <g transform="translate(842 180)"><rect width="33" height="20" rx="2" fill="#f8f4e5" stroke="#baa684" stroke-width="1"/><path d="M6 15L14 6L21 12L27 9" fill="none" stroke="#c3ae7d" stroke-width="1.4"/></g>

    <!-- Meeting room, complete with people and presentation screen. -->
    ${title(77, 466, '会议室', 'MEETING ROOM · A', '#aaa2bf')}
    <g transform="translate(75 493)"><path d="M0 0H29V39H0Z" fill="#e9e9ef" stroke="#9093a5" stroke-width="1"/><rect x="3" y="4" width="23" height="29" rx="1" fill="#c6d0df"/><path d="M7 27V20H11V27M15 27V13H19V27M23 27V8" fill="none" stroke="#879caf" stroke-width="2"/><path d="M14 39V46M6 47H23" stroke="#8e94a1" stroke-width="2"/></g>
    ${person(148,493,'#a69fc3','#654c44',.68)}${person(211,493,'#7eabb3','#3f454c',.68)}${person(274,493,'#d8ac82','#775c42',.68)}
    <g transform="translate(112 503)"><ellipse cx="99" cy="54" rx="99" ry="9" fill="#778375" opacity=".1"/><path d="M17 34V52M177 34V52" stroke="#9e9d9e" stroke-width="5"/><rect y="4" width="192" height="48" rx="19" fill="#b5b4c3" stroke="#7a8590" stroke-width="1.1"/><rect width="192" height="46" rx="19" fill="#f1eee6" stroke="#7a8590" stroke-width="1.2"/><path d="M92 3V42" stroke="#d7d5d0" stroke-width=".8"/><g fill="#c3d7d6" stroke="#728d8e" stroke-width=".8"><rect x="23" y="10" width="26" height="17" rx="2"/><rect x="145" y="10" width="26" height="17" rx="2"/></g><path d="M20 29H52M142 29H174" stroke="#70868a" stroke-width="2" stroke-linecap="round"/>${use('cup',69,19,.65)}${use('cup',119,18,.65)}</g>
    ${person(155,566,'#8faa91','#453b3d',.72)}${person(264,566,'#c39591','#6f4a36',.72)}
    <g class="cnl-device" data-device="meeting" transform="translate(208 516)"><ellipse rx="13" ry="7" fill="#e0e3df" stroke="#82948c" stroke-width=".9"/><rect x="-7" y="-5" width="14" height="6" rx="3" fill="#b4c8be"/><circle r="1.5" fill="#78a78d"/></g>
    ${plant(325,579,.7)}

    <!-- Customer lounge with active guest Wi-Fi. -->
    ${title(386, 466, '客户会见厅', 'CUSTOMER LOUNGE', '#cea985')}
    <rect x="418" y="491" width="217" height="92" rx="26" fill="#e8d5bd" opacity=".55"/>
    ${use('sofa',392,493,.84)}${use('sofa',564,493,.84)}
    ${person(431,518,'#749b96','#5e4a3f',.69)}${person(601,518,'#b49a80','#463e3e',.69)}
    <g transform="translate(486 512)"><ellipse cx="43" cy="31" rx="47" ry="7" fill="#8d8b70" opacity=".1"/><path d="M10 18V35M73 18V35" stroke="#a89e80" stroke-width="4"/><rect y="3" width="86" height="26" rx="12" fill="#d7c1a0" stroke="#9b9780" stroke-width="1"/><rect width="86" height="25" rx="12" fill="#fbf1da" stroke="#9b9780" stroke-width="1"/>${use('cup',16,9,.65)}${use('cup',69,10,.65)}<rect x="30" y="8" width="22" height="12" rx="1" fill="#d5d5b4" transform="rotate(-7 30 8)"/></g>
    <g class="cnl-device" data-device="reception" transform="translate(529 520)"><rect x="-11" y="-5" width="22" height="10" rx="4" fill="#f1f2e5" stroke="#7e9b8e" stroke-width="1"/><path d="M-5-9Q0-14 5-9M-3-6Q0-9 3-6" fill="none" stroke="#85aa96" stroke-width="1.3" stroke-linecap="round"/><circle cy="1" r="1.4" fill="#8ab18b"/></g>
    ${plant(390,586,.82)}${plant(653,582,.7)}
    <g transform="translate(483 579)"><rect width="83" height="12" rx="4" fill="#f9ecda" stroke="#c6b79b" stroke-width=".8"/><text x="41.5" y="8.5" text-anchor="middle" class="cnl-tiny">GUEST Wi-Fi</text></g>

    <!-- Finance team: locked drawers, files, accounts and two real desks. -->
    ${title(713, 466, '财务办公室', 'FINANCE & OPERATIONS', '#9aaf89')}
    <g transform="translate(711 491)"><rect width="36" height="69" rx="3" fill="#d4dac1" stroke="#8b9e83" stroke-width="1"/><rect x="4" y="5" width="28" height="17" rx="1.5" fill="#edf0de" stroke="#a9b49a" stroke-width=".8"/><rect x="4" y="26" width="28" height="17" rx="1.5" fill="#edf0de" stroke="#a9b49a" stroke-width=".8"/><rect x="4" y="47" width="28" height="17" rx="1.5" fill="#edf0de" stroke="#a9b49a" stroke-width=".8"/><path d="M14 12H22M14 33H22M14 54H22" stroke="#8a9d80" stroke-width="1.5" stroke-linecap="round"/></g>
    <g class="cnl-device" data-device="finance">${desk(795,491,'#8fa78a',{screen:'#b3d7be',hair:'#5a443b',cup:true})}</g>
    <g transform="translate(926 492)"><rect width="55" height="34" rx="4" fill="#d9dfca" stroke="#93a28a" stroke-width="1"/><rect x="3" y="3" width="49" height="13" rx="2" fill="#f2f0df" stroke="#b6bea5" stroke-width=".8"/><path d="M10 9H44" stroke="#a3af97" stroke-width="1"/><rect x="14" y="21" width="27" height="8" rx="1" fill="#f9f6e7"/><path d="M19 24H37" stroke="#b2b79d" stroke-width=".7"/></g>
    <g transform="translate(935 546)"><rect width="39" height="34" rx="3" fill="#c4ccb5" stroke="#8e9e85" stroke-width="1"/><path d="M0 9H39M13 10V34M26 10V34" stroke="#91a18a" stroke-width="1"/><g fill="#efdcaa"><path d="M4-7H9V7H4ZM12-10H17V7H12Z"/></g><g fill="#abc3b5"><path d="M20-7H25V7H20ZM28-9H33V7H28Z"/></g></g>
    ${plant(987,584,.72)}

    <!-- Small office-life details: coat hooks, floor directions, and room numbers. -->
    <g fill="#b7bda7" opacity=".7"><path d="M72 407l5-4v3h10v2H77v3Z"/><path d="M965 407l-5-4v3h-10v2h10v3Z"/></g>
    <text x="98" y="410" class="cnl-small" fill="#a4af9b">NETWORK FLOOR / 01</text>
    <g transform="translate(58 584)"><rect width="57" height="18" rx="4" fill="#e2e7d6" stroke="#acb99f" stroke-width=".7"/><circle cx="9" cy="9" r="2.4" fill="#8eaf89"/><text x="16" y="12" class="cnl-tiny">LAISEN LAB</text></g>

    <!-- Investment is an attached office, linked to the same working network. -->
    <g class="cnl-investment-room"><rect x="55" y="7" width="450" height="94" rx="11" fill="#e5e9ee" stroke="#a9b9b3" stroke-width="1.2"/><path d="M56 35H504" stroke="#c9d3d0" stroke-width="1"/>${title(230,25,'投资部','INVESTMENT DUE DILIGENCE','#9baec0')}${use('desk',104,43,.60, 'style="--screen:#b9d0e1"')}${use('desk',244,43,.60,'style="--screen:#cbd4b5"')}${use('desk',384,43,.60,'style="--screen:#cabeda"')}<path d="M68 101H489" stroke="#8da99b" stroke-width="2"/></g>
    <g class="cnl-node-layer">${hotspots}</g>
    <g class="cnl-handoff-layer"></g>
    <g class="cnl-human-approval" transform="translate(909 286)" tabindex="0" role="button" aria-label="你，真人负责人，需要审批" aria-hidden="true"><circle class="cnl-human-halo" r="34"/><circle class="cnl-human-ring" r="27"/><g transform="translate(-51 -72)"><rect width="102" height="31" rx="9"/><text x="51" y="13" text-anchor="middle">需要你审批</text><text class="cnl-human-sub" x="51" y="24" text-anchor="middle">你 · 真人负责人</text></g></g><g class="cnl-agent-layer"></g>
  </g>
  </svg>`;

  const svg = container.querySelector('svg');
  const nodeElements = new Map([...svg.querySelectorAll('[data-node]')].map(el => [el.dataset.node, el]));
  const deviceElements = new Map([...svg.querySelectorAll('[data-device]')].map(el => [el.dataset.device, el]));
  const links = [...svg.querySelectorAll('.cnl-link')];
  const humanApproval=svg.querySelector('.cnl-human-approval');humanApproval.addEventListener('click',e=>{e.stopPropagation();onSelectHuman();});humanApproval.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();onSelectHuman();}});
  const agentLayer = svg.querySelector('.cnl-agent-layer');
  const handoffLayer = svg.querySelector('.cnl-handoff-layer');
  const agentElements = new Map();
  const agentPositions = new Map();
  const agentSignatures = new Map();
  const seenHandoffs = new Set();
  const handoffTimers = new Set();
  let scale = 1;
  let panX = 0;
  let panY = 0;
  let selected = null;
  let selectedAgent = null;
  let drag = null;
  let suppressClickUntil = 0;
  let viewFrame = 0;
  let motionUntil = 0;
  let destroyed = false;

  const scheduleViewChange = (duration = 0) => {
    motionUntil = Math.max(motionUntil, performance.now() + duration);
    if (viewFrame || destroyed) return;
    const notify = () => {
      viewFrame = 0;
      if (destroyed) return;
      onViewChange();
      if (performance.now() < motionUntil) viewFrame = requestAnimationFrame(notify);
    };
    viewFrame = requestAnimationFrame(notify);
  };

  function setSelectedNode(id) {
    selected = id;
    nodeElements.forEach((el, key) => {
      el.classList.toggle('is-selected', key === id);
      el.setAttribute('aria-pressed', String(key === id));
    });
    if (id) setSelectedAgent(null);
  }

  function setSelectedAgent(id) {
    selectedAgent = id;
    agentElements.forEach((el, key) => {
      el.classList.toggle('is-selected', key === id);
      el.setAttribute('aria-pressed', String(key === id));
    });
    if (id && selected) setSelectedNode(null);
  }

  nodeElements.forEach((el, id) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (performance.now() < suppressClickUntil) return;
      setSelectedNode(id); onSelectNode(id);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setSelectedNode(id); onSelectNode(id); }
    });
  });

  function statusPhrase(agent) {
    if (agent.selected === false) return '未派遣';
    if (agent.status === 'working') {
      const action = agent.task || agent.currentTask || agent.action || '执行任务';
      return String(action).replace(/[「」“”\s]/g, '').slice(0, 8);
    }
    if (['waiting', 'blocked', 'queued'].includes(agent.status)) return '等待证据交接';
    if (['done', 'completed'].includes(agent.status)) return '任务已交付';
    if (agent.status === 'error') return '任务失败，查看原因';
    return `${String(agent.role || '成员').slice(0, 6)}待命`;
  }

  function renderAgents(agents) {
    const perNode = {};
    Object.entries(AGENT_META).forEach(([id, meta]) => {
      const data = agents.find(agent => agent.id === id) || {};
      const agent = { ...meta, ...data, id };
      const working = agent.selected !== false && !!NODE_META[agent.nodeId] && agent.status === 'working';
      let point = [meta.x, meta.y];
      if (working) {
        const offset = perNode[agent.nodeId] || 0;
        perNode[agent.nodeId] = offset + 1;
        const positions = WORK_POSITIONS[agent.nodeId];
        point = positions[offset % positions.length];
        if (offset >= positions.length) point = [point[0], point[1] + Math.floor(offset / positions.length) * 49];
      }
      agentPositions.set(id, { x:point[0], y:point[1] });
      let el = agentElements.get(id);
      if (!el) {
        el = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        el.classList.add('cnl-agent');
        el.dataset.agent = id;
        el.setAttribute('tabindex', '0');
        el.setAttribute('role', 'button');
        el.setAttribute('aria-pressed', 'false');
        el.addEventListener('click', e => {
          e.stopPropagation();
          if (performance.now() < suppressClickUntil) return;
          setSelectedAgent(id); onSelectAgent(id);
        });
        el.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setSelectedAgent(id); onSelectAgent(id); }
        });
        agentLayer.append(el);
        agentElements.set(id, el);
      }
      el.style.transform = `translate(${point[0]}px, ${point[1]}px)`;
      el.classList.toggle('is-working', working);
      el.classList.toggle('is-unassigned', agent.selected === false);
      el.classList.toggle('is-configured', !!agent.configured);
      el.classList.toggle('is-selected', id === selectedAgent);
      const phrase = statusPhrase(agent);
      el.setAttribute('aria-label', `${agent.name}，${agent.role} AI 虚拟员工，${phrase}，${agent.configured ? '已配置' : '点击配置'}，查看任务与配置`);
      const signature = JSON.stringify([agent.name, agent.role, agent.color, agent.hair, agent.configured, agent.selected, phrase, working]);
      if (signature !== agentSignatures.get(id)) {
        agentSignatures.set(id, signature);
        el.innerHTML = `<title>${esc(agent.name)} · ${esc(agent.role)} AI 虚拟员工 · ${esc(phrase)}；点击查看任务与配置</title>
          <rect class="cnl-agent-hit" x="-37" y="-20" width="74" height="70" rx="8"/>
          <ellipse class="cnl-ai-aura" cy="-1" rx="17" ry="22"/><ellipse class="cnl-agent-ground" cy="18" rx="18" ry="6"/>
          ${person(0, -1, agent.color, meta.hair, .56)}<g class="cnl-ai-badge" transform="translate(-3 3)"><rect width="7" height="5" rx="1"/><text x="3.5" y="3.8" text-anchor="middle">AI</text></g>
          <g class="cnl-role-tool" transform="translate(14 4)"><circle class="cnl-tool-ring" r="7"/><path class="cnl-tool" d="M-3 3L2-2M0-3Q4-4 4-1L2 1L0-1Z"/></g>
          <g transform="translate(-36 25)"><rect class="cnl-agent-card" width="72" height="24" rx="6"/>
            <text class="cnl-agent-name" x="8" y="10">${esc(String(agent.name).slice(0,5))}</text><text class="cnl-agent-type" x="39" y="9">AI 员工</text>
            <text class="cnl-agent-state" x="8" y="19">${esc(phrase)}</text><circle class="cnl-config-dot" cx="64" cy="18" r="3.3"/><path class="cnl-config-check" d="M62.2 18l1.2 1.2 2-2.5"/>
          </g>`;
      }
    });
  }

  function animateHandoffs(logs) {
    logs.filter(log => log.type === 'handoff').forEach(log => {
      const key = log.id || `${log.time}-${log.agentId}-${log.targetAgentId}-${log.text}`;
      if (seenHandoffs.has(key)) return;
      seenHandoffs.add(key);
      const from = agentPositions.get(log.sourceAgentId || log.agentId);
      const to = agentPositions.get(log.targetAgentId);
      if (!from || !to || (from.x === to.x && from.y === to.y)) return;
      const dx = to.x - from.x, dy = to.y - from.y;
      const bend = Math.min(38, Math.hypot(dx, dy) * .18);
      const d = `M${from.x} ${from.y - 12} Q${(from.x + to.x) / 2} ${(from.y + to.y) / 2 - bend - 12} ${to.x} ${to.y - 12}`;
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.innerHTML = `<path class="cnl-handoff-line" d="${d}"/><g class="cnl-handoff-envelope"><rect x="-7" y="-5" width="14" height="10" rx="2"/><path d="M-6-4L0 1L6-4"/><animateMotion dur="2.5s" path="${d}" fill="freeze"/></g>`;
      handoffLayer.append(group);
      const timer = setTimeout(() => { group.remove(); handoffTimers.delete(timer); }, 2800);
      handoffTimers.add(timer);
    });
  }

  function update(state = {}) {
    const nodes = state.nodes || {};humanApproval.classList.toggle('is-requesting',!!state.humanApproval);humanApproval.setAttribute('aria-hidden',String(!state.humanApproval));
    nodeElements.forEach((el, id) => {
      const status = nodes[id]?.status || (typeof nodes[id] === 'string' ? nodes[id] : 'online');
      el.dataset.status = status;
      el.setAttribute('aria-label', `查看${NODE_META[id].label}，${({online:'运行正常',warning:'存在异常',offline:'已离线',recovering:'正在恢复'})[status] || status}`);
      if (deviceElements.get(id)) deviceElements.get(id).dataset.status = status;
    });
    links.forEach(link => {
      const statuses = [nodes[link.dataset.a]?.status || nodes[link.dataset.a], nodes[link.dataset.b]?.status || nodes[link.dataset.b]];
      ['offline','warning','recovering'].forEach(status => link.classList.toggle(`is-${status}`, statuses.includes(status)));
    });
    const agents = Array.isArray(state.agents) ? state.agents : Object.values(state.agents || {});
    renderAgents(agents);
    if (!state.logs?.length) { seenHandoffs.clear(); handoffLayer.innerHTML = ''; }
    else animateHandoffs(state.logs);
    if (state.selectedNode !== undefined && state.selectedNode !== selected) setSelectedNode(state.selectedNode);
    if (state.selectedAgent !== undefined && state.selectedAgent !== selectedAgent) setSelectedAgent(state.selectedAgent);
    scheduleViewChange(700);
  }

  function applyView() {
    const width = 1060 / scale;
    const height = 650 / scale;
    svg.setAttribute('viewBox', `${530 + panX - width / 2} ${325 + panY - height / 2} ${width} ${height}`);
    scheduleViewChange();
  }

  function projectPoint(point, element = svg) {
    const matrix = element.getScreenCTM();
    if (!matrix) return null;
    const projected = new DOMPoint(point.x, point.y).matrixTransform(matrix);
    const rect = container.getBoundingClientRect();
    return { x:projected.x - rect.left, y:projected.y - rect.top };
  }

  function worldPoint(clientX, clientY) {
    const matrix = svg.getScreenCTM();
    return matrix ? new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse()) : new DOMPoint();
  }

  function zoomAt(delta, clientX, clientY) {
    const before = worldPoint(clientX, clientY);
    scale = Math.max(.72, Math.min(2.25, scale + delta));
    applyView();
    const after = worldPoint(clientX, clientY);
    panX += before.x - after.x;
    panY += before.y - after.y;
    applyView();
    return scale;
  }

  const onPointerDown = e => {
    if (e.button !== 0 || e.target.closest('[data-node], [data-agent]')) return;
    drag = { id:e.pointerId, x:e.clientX, y:e.clientY, lastX:e.clientX, lastY:e.clientY, moved:false };
  };
  const onPointerMove = e => {
    if (!drag || drag.id !== e.pointerId) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
    if (!drag.moved) { drag.moved = true; svg.setPointerCapture(e.pointerId); svg.classList.add('is-panning'); }
    const from = worldPoint(drag.lastX, drag.lastY), to = worldPoint(e.clientX, e.clientY);
    panX += from.x - to.x;
    panY += from.y - to.y;
    drag.lastX = e.clientX; drag.lastY = e.clientY;
    applyView();
  };
  const onPointerEnd = e => {
    if (!drag || drag.id !== e.pointerId) return;
    if (drag.moved) {
      suppressClickUntil = performance.now() + 200;
      if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
    }
    svg.classList.remove('is-panning'); drag = null;
  };
  const onBlankClick = e => {
    if (performance.now() < suppressClickUntil) { e.preventDefault(); e.stopPropagation(); }
  };
  const onWheel = e => {
    e.preventDefault();
    zoomAt(-Math.max(-.15, Math.min(.15, e.deltaY * .0015)), e.clientX, e.clientY);
  };
  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', onPointerMove);
  svg.addEventListener('pointerup', onPointerEnd);
  svg.addEventListener('pointercancel', onPointerEnd);
  svg.addEventListener('click', onBlankClick, true);
  svg.addEventListener('wheel', onWheel, { passive:false });
  const resizeObserver = new ResizeObserver(() => scheduleViewChange());
  resizeObserver.observe(container);
  renderAgents([]);

  return {
    update,
    setTopology(visible) { svg.classList.toggle('cnl-topology-off', !visible); },
    setSelectedNode,
    setSelectedAgent,
    getNodeAnchor(id) { const n = NODE_META[id]; return n ? projectPoint(n) : null; },
    getAgentAnchor(id) { const el = agentElements.get(id); return el ? projectPoint({ x:0, y:-13 }, el) : null; },
    focusAgent(id) {
      const point = agentPositions.get(id);
      if (!point) return false;
      panX = point.x - 530; panY = point.y - 325 + 52 / scale;
      applyView(); return true;
    },
    focusNode(id) {
      const point = NODE_META[id];
      if (!point) return false;
      panX = point.x - 530; panY = point.y - 325 + 52 / scale;
      applyView(); return true;
    },
    zoom(delta = .15) { scale = Math.max(.72, Math.min(2.25, scale + delta)); applyView(); return scale; },
    resetView() { scale = 1; panX = 0; panY = 0; applyView(); },
    destroy() {
      destroyed = true;
      resizeObserver.disconnect();
      cancelAnimationFrame(viewFrame);
      handoffTimers.forEach(clearTimeout);
      container.innerHTML = '';
    },
  };
}

export { NODE_META };
