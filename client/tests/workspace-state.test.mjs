import test from 'node:test';
import assert from 'node:assert/strict';
import {CREW,ROOM_SECTIONS,SECTION_ROOMS,sceneProjection,crewDocument,workspaceCounts,createDocumentObserver,documentNotice,documentSignature,canApprove} from '../src/workspace-state.mjs';

const record=overrides=>({id:'doc-a',title:'设备采购',status:'draft',version:1,updatedAt:'2026-10-20T02:00:00Z',allowedActions:[],...overrides});
const run=overrides=>({id:'processing-a',status:'running',tasks:[],events:[],...overrides});

test('the office directory is immutable and routes every crew member to a real business section',()=>{
  assert.equal(CREW.length,11);assert.equal(new Set(CREW.map(p=>p.id)).size,CREW.length);assert.ok(Object.isFrozen(CREW));for(const person of CREW){assert.ok(Object.isFrozen(person));assert.ok(Object.hasOwn(ROOM_SECTIONS,person.nodeId));assert.ok(Object.hasOwn(SECTION_ROOMS,person.section));assert.equal(person.status,'idle');}for(const room of Object.values(SECTION_ROOMS))assert.ok(Object.hasOwn(ROOM_SECTIONS,room));
});

test('approval badges use explicit server permissions instead of status, role or requester assumptions',()=>{
  const snapshot={currentUser:{id:'admin-a',roles:['admin']},documents:[record({id:'waiting',status:'awaiting_approval'}),record({id:'owner',status:'awaiting_approval',requesterId:'admin-a',allowedActions:['view']}),record({id:'denied',allowedActions:[{id:'approve',allowed:false}]}),record({id:'allowed',allowedActions:['approve']}),record({id:'object',allowedActions:[{action:'approve',allowed:true}]}),record({id:'invalid',allowedActions:[null,{},12,false,{id:{action:'approve'}}]})]};
  assert.equal(workspaceCounts(snapshot,'admin-a').approvals,2);assert.equal(canApprove(snapshot.documents[0]),false);assert.equal(canApprove(snapshot.documents[2]),false);assert.equal(canApprove(snapshot.documents[3]),true);assert.equal(canApprove(snapshot.documents[5]),false);
});

test('task counts include only this employee open work and exclude accepted or cancelled tasks',()=>{
  const tasks=[{id:'one',assigneeId:'me',status:'in_progress'},{id:'two',assigneeId:'me',status:'submitted'},{id:'three',assigneeId:'me',status:'returned'},{assigneeId:'me',status:'completed'},{assigneeId:'me',status:'done'},{assigneeId:'me',status:'cancelled'},{assigneeId:'someone-else',status:'in_progress'}];assert.equal(workspaceCounts({tasks},'me').tasks,3);assert.equal(workspaceCounts({tasks},'unknown').tasks,0);assert.deepEqual(workspaceCounts({},'me'),{tasks:0,approvals:0});
});

test('the initial snapshot never announces historical approvals or completed results',()=>{
  const observer=createDocumentObserver(),documents=[record({allowedActions:['approve'],status:'awaiting_approval'}),record({id:'doc-b',status:'completed',version:4}),record({id:'doc-c',agentRun:run({status:'failed'})})];assert.deepEqual(observer.observe(documents),[]);assert.deepEqual(observer.observe(structuredClone(documents)),[]);observer.reset();assert.deepEqual(observer.observe(documents),[]);
});

test('document transitions are delivered once and expose only a business target, title and status',()=>{
  const observer=createDocumentObserver();observer.observe([record()]);const approval=record({status:'awaiting_approval',version:2,allowedActions:['approve'],input:{secret:'报价隐私'},agentRun:run({model:'不公开模型',output:'内部推理'})});const notices=observer.observe([approval]);assert.deepEqual(notices,[{kind:'approval',label:'待审批',id:'doc-a',title:'设备采购'}]);assert.deepEqual(observer.observe([structuredClone(approval)]),[]);const completed={...approval,status:'completed',version:3,allowedActions:[]};assert.deepEqual(observer.observe([completed]),[{kind:'result',label:'已完成',id:'doc-a',title:'设备采购'}]);assert.deepEqual(observer.observe([completed]),[]);assert.notEqual(documentSignature(approval),documentSignature(completed));assert.doesNotMatch(JSON.stringify(notices),/报价隐私|不公开模型|内部推理|input|agentRun/);
});

test('notices distinguish failed processing, prepared proposals and committed business outcomes',()=>{
  assert.equal(documentNotice(record()),null);assert.equal(documentNotice(record({agentRun:run({status:'running'})})),null);assert.deepEqual(documentNotice(record({agentRun:run({status:'failed'})})),{kind:'error',label:'处理未完成',id:'doc-a',title:'设备采购'});assert.equal(documentNotice(record({agentRun:run({status:'completed'})})),null,'a model finish without a persisted proposal is not a result');assert.equal(documentNotice(record({agentRun:run({status:'completed'}),proposal:{id:'proposal'}})).label,'方案已就绪');for(const [status,label]of[['completed','已完成'],['approved','已批准'],['rejected','已退回'],['cancelled','已取消'],['partial','部分完成']])assert.equal(documentNotice(record({status})).label,label);assert.equal(documentNotice(record({status:'completed',allowedActions:['approve']})).kind,'approval','an actual outstanding approval takes priority');
});

test('scene projection strips all financial, employee, prompt, model, task and tool content',()=>{
  const secret='保密报价-938541',snapshot={currentUser:{name:'真实员工姓名',password:secret},inventory:[{price:secret}],documents:[record({title:secret,input:{quotation:secret,salary:secret},proposal:{text:secret},reportUrl:secret,agentRun:run({model:secret,provider:secret,prompt:secret,summary:secret,tasks:[{id:'task-a',agentId:'finance',status:'running',nodeId:'finance',title:secret,action:secret,output:secret,toolResults:[{tool:secret,result:secret}]}],events:[{id:'handoff-a',type:'handoff',createdAt:'2026-10-20T02:00:00Z',agentId:'finance',targetAgentId:'boss',targetNodeId:'general_office',deliveryKind:'approval_request',text:secret,tool:secret,evidence:secret},{id:'tool-a',type:'tool_result',text:secret,result:secret},{id:'message-a',type:'message',text:secret}]})})]};
  const before=structuredClone(snapshot),projection=sceneProjection(snapshot);assert.deepEqual(snapshot,before);assert.equal(projection.runId,'processing-a');assert.equal(projection.agents.find(a=>a.id==='finance').status,'working');assert.equal(projection.agents.find(a=>a.id==='finance').nodeId,'finance');assert.equal(projection.logs.length,1);assert.deepEqual(projection.logs[0],{id:'handoff-a',type:'handoff',createdAt:'2026-10-20T02:00:00Z',agentId:'finance',targetAgentId:'boss',targetNodeId:'general_office',deliveryKind:'approval_request'});assert.doesNotMatch(JSON.stringify(projection),new RegExp(secret+'|真实员工姓名|toolResults|summary|provider|prompt|quotation|salary'));assert.deepEqual(Object.keys(projection).sort(),['agents','humanApproval','humans','logs','nodes','runId','runStatus']);assert.equal(projection.humanApproval,false);assert.deepEqual(projection.humans,[]);assert.deepEqual(projection.nodes,{});
});

test('the active scene follows the selected business document, then active work, then the newest history',()=>{
  const historical=record({id:'history',updatedAt:'2026-10-19',agentRun:run({id:'old',status:'completed'})}),current=record({id:'current',updatedAt:'2026-10-18',agentRun:run({id:'active'})}),newest=record({id:'newest',updatedAt:'2026-10-20',agentRun:run({id:'latest',status:'completed'})});const snapshot={documents:[historical,current,newest]};assert.equal(sceneProjection(snapshot).runId,'active');assert.equal(sceneProjection(snapshot,'history').runId,'old');assert.equal(sceneProjection(snapshot,'missing').runId,'active');assert.equal(sceneProjection({documents:[historical,newest]}).runId,'latest');assert.equal(sceneProjection().runId,null);
});

test('crew status is derived from current tasks and never fabricates completion or approval',()=>{
  const tasks=[{agentId:'finance',status:'completed',nodeId:'finance'},{agentId:'finance',status:'running',nodeId:'general_office'},{agentId:'zhang',status:'failed',nodeId:'not-a-real-room'},{agentId:'unknown-agent',status:'running',nodeId:'server'}];const projection=sceneProjection({documents:[record({agentRun:run({tasks})})]});assert.equal(projection.agents.length,CREW.length);assert.equal(projection.agents.find(p=>p.id==='finance').status,'working');assert.equal(projection.agents.find(p=>p.id==='finance').nodeId,'general_office');assert.equal(projection.agents.find(p=>p.id==='zhang').status,'idle');assert.equal(projection.agents.find(p=>p.id==='zhang').nodeId,'server');assert.ok(!projection.agents.some(p=>p.id==='unknown-agent'));assert.equal(projection.humanApproval,false);
});

test('colleague clicks resolve only currently running or queued business records',()=>{
  const history=record({id:'history',agentRun:run({status:'completed',tasks:[{agentId:'finance'}]})}),queued=record({id:'queued',agentRun:run({status:'queued',tasks:[{agentId:'finance'}]})}),active=record({id:'active',agentRun:run({tasks:[{agentId:'hr'}]})});assert.equal(crewDocument({documents:[history,queued,active]},'finance'),queued);assert.equal(crewDocument({documents:[history,queued,active]},'hr'),active);assert.equal(crewDocument({documents:[history]},'finance'),null);assert.equal(crewDocument({},'unknown'),null);
});

test('unexpected scalar and array fields are ignored without leaking nested objects into the scene',()=>{
  const privateValue={secret:'PRIVATE-MODEL-TOOL-QUOTE'},snapshot={documents:[null,false,record({agentRun:{id:privateValue,status:privateValue,tasks:[null,false,{agentId:'finance',status:'running',nodeId:privateValue},{agentId:'hr',status:'completed',nodeId:{toString(){return 'server';},secret:'PRIVATE-MODEL-TOOL-QUOTE'}}],events:[null,5,{id:privateValue,type:'handoff',createdAt:privateValue,agentId:privateValue,targetAgentId:'finance',text:privateValue}]}})]};
  const projection=sceneProjection(snapshot);assert.equal(projection.runId,null);assert.equal(projection.runStatus,'idle');assert.equal(projection.agents.find(p=>p.id==='finance').nodeId,'finance');assert.equal(projection.agents.find(p=>p.id==='hr').nodeId,'workstations');assert.doesNotMatch(JSON.stringify(projection),/PRIVATE-MODEL-TOOL-QUOTE/);assert.equal(typeof projection.logs[0].id,'string');assert.equal(typeof projection.logs[0].createdAt,'string');assert.equal(projection.logs[0].agentId,undefined);assert.doesNotThrow(()=>workspaceCounts({documents:[null,{}],tasks:[null,4,{}]},'me'));assert.doesNotThrow(()=>crewDocument(snapshot,'finance'));
});

test('native Go done task status produces a settled colleague without exporting its tool result',()=>{
  const nativeRun={id:'acceptance-run',status:'completed',tasks:[{id:'prepare',agentId:'business',name:'林悦',role:'业务整理',status:'done',toolCalls:2,result:{proposal:{supplier:'PRIVATE-SUPPLIER'}}},{id:'review',agentId:'liu',status:'done',toolCalls:2,result:{passed:true}}],events:[{id:'receipt-1',type:'handoff',agentId:'business',sourceAgentId:'business',sourceNodeId:'reception',targetNodeId:'firewall',targetAgentId:'liu'}]};const projected=sceneProjection({documents:[record({agentRun:nativeRun})]});assert.equal(projected.agents.find(p=>p.id==='business').status,'done');assert.equal(projected.agents.find(p=>p.id==='liu').status,'done');assert.doesNotMatch(JSON.stringify(projected),/PRIVATE-SUPPLIER|toolCalls|result|proposal/);
});
