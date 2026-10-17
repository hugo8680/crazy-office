/* Functional human representatives; these do not claim that six people are online. */
export const HUMAN_EMPLOYEES = Object.freeze([
  { id:'owner', name:'你', role:'老板／最终审批', nodeId:'executive', x:909, y:315, color:'#d29165', hair:'#4e4742', responsibility:'审阅方案，决定批准、退回或暂缓。' },
  { id:'finance_owner', name:'财务负责人', role:'财务资料与验收', nodeId:'finance', x:786, y:579, color:'#d9a36d', hair:'#5a443b', responsibility:'提供财务资料，核对口径并接收财务报告。' },
  { id:'it_owner', name:'IT负责人', role:'技术需求与验收', nodeId:'server', x:757, y:390, color:'#c98a75', hair:'#424644', responsibility:'提供日志、架构和业务约束，接收修复验证或数据库成果。' },
  { id:'business_owner', name:'业务负责人', role:'需求与交付验收', nodeId:'meeting', x:322, y:493, color:'#d6a86b', hair:'#62483c', responsibility:'提供客户需求、确认范围，并接收交付计划。' },
  { id:'purchasing_owner', name:'采购负责人', role:'采购需求与询价', nodeId:'reception', x:620, y:560, color:'#ca9476', hair:'#5b4b3d', responsibility:'提出采购约束，核实报价和供应商，接收采购建议。' },
  { id:'investment_owner', name:'投资负责人', role:'项目资料与尽调验收', nodeId:'investment', x:458, y:87, color:'#c49c72', hair:'#514a46', responsibility:'提供项目和融资资料，补充线下核查，接收投前尽调报告。' },
].map(person => Object.freeze(person)));

const SCENARIO_HUMANS = Object.freeze({ finance:'finance_owner', procurement:'purchasing_owner', ddos:'it_owner', database:'it_owner', delivery:'business_owner', investment:'investment_owner' });
export function humanForScenario(scenarioId) {
  return HUMAN_EMPLOYEES.find(person => person.id === SCENARIO_HUMANS[scenarioId]) || HUMAN_EMPLOYEES[0];
}
