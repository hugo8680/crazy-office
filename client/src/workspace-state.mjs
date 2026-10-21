import {ORGANIZATION_DEPARTMENTS} from './organization.mjs';
// Scene projections carry positions and state only. Business content lives in ERP views.
export const CREW = Object.freeze([
  ['hr','小禾','人事','workstations','people'],['invest_research','沈研','研究','investment','projects'],
  ['invest_finance','顾衡','财务','investment','reports'],['invest_risk','何审','审查','investment','projects'],
  ['zhang','小张','网络','server','inventory'],['liu','小刘','审核','firewall','desk'],
  ['lead','陈工','技术','core','projects'],['business','林悦','业务','reception','flows'],
  ['finance','许姐','财务','finance','reports'],['boss','周助理','管理','general_office','desk'],
  ['ops','阿杰','运维','server','inventory']
].map(([id,name,role,nodeId,section])=>Object.freeze({id,name,role,nodeId,section,selected:true,status:'idle'})));
export const ROOM_SECTIONS=Object.freeze({bulletin:'notices',...Object.fromEntries(ORGANIZATION_DEPARTMENTS.map(d=>[d.id,({hr_admin:'people',finance:'reports',general_office:'desk',maintenance:'inventory',channels:'flows',business:'flows'})[d.id]||'projects'])),workstations:'people',executive:'projects',storage:'inventory',reception:'flows',meeting:'projects',finance:'reports',general_office:'desk',investment:'projects',server:'inventory',core:'inventory',access:'inventory',ups:'inventory',internet:'desk',firewall:'desk'});
export const SECTION_ROOMS=Object.freeze({notices:'bulletin',desk:'general_office',projects:'research',flows:'business',inventory:'maintenance',products:'maintenance',people:'hr_admin',reports:'finance'});
const list=value=>Array.isArray(value)?value:[];
const records=value=>list(value).filter(item=>item&&typeof item==='object');
const scalar=value=>typeof value==='string'?value:'';
const node=value=>typeof value==='string'&&Object.hasOwn(ROOM_SECTIONS,value)?value:null;
const actions=d=>list(d?.allowedActions).filter(a=>typeof a==='string'||a&&typeof a==='object'&&a.allowed!==false).map(a=>typeof a==='string'?a:a.id||a.action).filter(a=>typeof a==='string');
export function documentSignature(d){return [d.status,d.version,d.agentRun?.id,d.agentRun?.status,d.proposal?.updatedAt,d.updatedAt].join('|');}
export function canApprove(d){return actions(d).includes('approve');}
export function workspaceCounts(snapshot={},actorId){return {approvals:records(snapshot.documents).filter(canApprove).length,tasks:records(snapshot.tasks).filter(t=>t.assigneeId===actorId&&!['completed','done','cancelled'].includes(t.status)).length};}
export function documentNotice(d){
  if(canApprove(d))return {kind:'approval',label:'待审批',id:d.id,title:d.title||d.number||'业务单'};
  if(d.agentRun?.status==='failed')return {kind:'error',label:'处理未完成',id:d.id,title:d.title||d.number||'业务单'};
  if(d.agentRun?.status==='completed'&&d.proposal)return {kind:'result',label:'方案已就绪',id:d.id,title:d.title||d.number||'业务单'};
  if(['completed','approved','rejected','cancelled','partial'].includes(d.status))return {kind:'result',label:({completed:'已完成',approved:'已批准',rejected:'已退回',cancelled:'已取消',partial:'部分完成'})[d.status],id:d.id,title:d.title||d.number||'业务单'};
  return null;
}
export function createDocumentObserver(){
  let initialized=false,seen=new Map();
  return {reset(){initialized=false;seen.clear();},observe(documents=[]){
    const next=new Map(),changes=[];
    for(const d of list(documents)){if(!d?.id)continue;const sig=documentSignature(d);next.set(d.id,sig);if(initialized&&seen.get(d.id)!==sig){const notice=documentNotice(d);if(notice)changes.push(notice);}}
    seen=next;initialized=true;return changes;
  }};
}
export function sceneProjection(snapshot={},preferredId){
  const docs=records(snapshot.documents),document=docs.find(d=>d.id===preferredId&&d.agentRun)||docs.find(d=>['running','queued'].includes(d.agentRun?.status))||docs.filter(d=>d.agentRun).sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')))[0];
  const run=document?.agentRun;
  const tasks=records(run?.tasks);
  const agents=CREW.map(person=>{const task=tasks.find(t=>t.agentId===person.id&&t.status==='running')||tasks.find(t=>t.agentId===person.id);return {...person,status:task?.status==='running'?'working':['completed','done'].includes(task?.status)?'done':'idle',nodeId:node(task?.nodeId)||person.nodeId};});
  const logs=records(run?.events).filter(event=>event.type==='handoff').map(event=>{
    const safe={id:scalar(event.id),type:'handoff',createdAt:scalar(event.createdAt)};
    for(const key of ['agentId','sourceAgentId','targetAgentId','sourceHumanId','targetHumanId','targetNodeId','deliveryKind'])if(typeof event[key]==='string')safe[key]=event[key];
    return safe;
  });
  return {runId:scalar(run?.id)||null,runStatus:['running','queued','completed','failed','cancelled'].includes(run?.status)?run.status:'idle',agents,logs,nodes:{},humans:[],humanApproval:false};
}
export function crewDocument(snapshot={},agentId){return records(snapshot.documents).find(d=>['running','queued'].includes(d.agentRun?.status)&&records(d.agentRun?.tasks).some(t=>t.agentId===agentId))||null;}
