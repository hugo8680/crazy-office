import {ORGANIZATION_DEPARTMENTS} from '../src/organization.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {escapeHtml} from '../src/erp-ui.mjs';
import {mountWorkspaceViewport} from '../src/workspace-viewport.mjs';
import {CREW,ROOM_SECTIONS,SECTION_ROOMS,sceneProjection,crewDocument,workspaceCounts,createDocumentObserver} from '../src/workspace-state.mjs';

// Execute the actual office coordinator. Scene, account and workbench adapters
// isolate navigation/session races; their own modules have independent tests.
const source=(await readFile(new URL('../src/office.js',import.meta.url),'utf8')).replace(/^import [^\n]*\n/gm,'');
const plain=value=>JSON.parse(JSON.stringify(value));
const flush=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const loginSession=(id='employee-a',name='王敏')=>({authenticated:true,actor:{id,name,roles:['employee'],department:'项目部',title:'项目经理'}});
const businessSnapshot=(overrides={})=>({currentUser:loginSession().actor,documents:[],tasks:[],users:[],projects:[],products:[],inventory:[],...overrides});
const documentRow=(overrides={})=>({id:'order-a',title:'服务器采购',status:'draft',version:1,updatedAt:'2026-10-20T02:00:00Z',allowedActions:[],...overrides});
const response=(status,data)=>({__response:true,status,data});

async function harness({sessionValue=null,savedView=null,reducedMotion=false}={}){
  const elements=new Map(),documentEvents=new Map(),windowEvents=new Map(),requests=[],intervals=new Map(),timeouts=new Map(),stored=new Map(),animations=[],motionListeners=new Map();let timerSequence=0,responder;
  const motionPreference={matches:reducedMotion,addEventListener(type,listener){motionListeners.set(type,listener);},removeEventListener(type){motionListeners.delete(type);}};
  class Element{
    constructor(){this.dataset={};this.hidden=false;this.innerHTML='';this.textContent='';this.children=[];this.style={};this.attributes=new Map();this.handlers=new Map();}
    append(...children){this.children.push(...children);}setAttribute(key,value){this.attributes.set(key,value);}getAttribute(key){return this.attributes.get(key);}addEventListener(type,fn){this.handlers.set(type,fn);}removeEventListener(type){this.handlers.delete(type);}focus(){}remove(){this.removed=true;}
    animate(frames,options){const animation={element:this,frames,options,cancelled:false,cancel(){this.cancelled=true;this.oncancel?.();},finish(){this.onfinish?.();}};animations.push(animation);return animation;}
  }
  const element=selector=>{if(!elements.has(selector)){const value=new Element();if(['#view-menu','#workspace-receipt','#toast'].includes(selector))value.hidden=true;elements.set(selector,value);}return elements.get(selector);};
  const document={hidden:false,fullscreenElement:null,querySelector:element,createElement:()=>new Element(),addEventListener:(type,fn)=>documentEvents.set(type,fn),removeEventListener:type=>documentEvents.delete(type),async exitFullscreen(){this.fullscreenElement=null;documentEvents.get('fullscreenchange')?.();}};
  element('#lab').requestFullscreen=async()=>{document.fullscreenElement=element('#lab');documentEvents.get('fullscreenchange')?.();};
  const scene={focusNode(id){this.viewCalls.push(['focusNode',id]);},mode:'2d',pending:false,updates:[],presence:[],selected:[],viewCalls:[],update(value){this.updates.push(plain(value));},setPresence(value){this.presence.push(plain(value));},setSelectedNode(id){this.selected.push(['node',id]);},setSelectedAgent(id){this.selected.push(['agent',id]);},setSelectedHuman(id){this.selected.push(['human',id]);},setTopology(value){this.viewCalls.push(['topology',value]);},zoom(delta){this.viewCalls.push(['zoom',delta]);},rotate(delta){this.viewCalls.push(['rotate',delta]);},resetView(){this.viewCalls.push(['reset']);},fit(){this.viewCalls.push(['fit']);},destroy(){this.destroyed=true;}};
  const erps=[],presences=[];let account,sessionOptions;
  responder=request=>request.path==='/api/session'?{session:sessionValue||{authenticated:false}}:request.path==='/api/erp/snapshot'?businessSnapshot():{};
  const fetch=async(path,options={})=>{const request={path:String(path),method:options.method||'GET',credentials:options.credentials,cache:options.cache,headers:options.headers||{},...(options.body===undefined?{}:{body:JSON.parse(options.body)})};requests.push(request);const result=await responder(request);const status=result?.__response?result.status:200,data=result?.__response?result.data:result;return{status,ok:status>=200&&status<300,json:async()=>data};};
  const scope={console,ORGANIZATION_DEPARTMENTS,CREW,ROOM_SECTIONS,SECTION_ROOMS,sceneProjection,crewDocument,workspaceCounts,createDocumentObserver,mountWorkspaceViewport,e:escapeHtml,document,fetch,window:{matchMedia:()=>motionPreference,addEventListener:(type,fn)=>windowEvents.set(type,fn)},localStorage:{getItem:key=>key==='office-view-mode'?savedView:null,setItem:(key,value)=>stored.set(key,value)},setInterval(fn,ms){const id=++timerSequence;intervals.set(id,{fn,ms});return id;},clearInterval:id=>intervals.delete(id),setTimeout(fn,ms){const id=++timerSequence;timeouts.set(id,{fn,ms});return id;},clearTimeout:id=>timeouts.delete(id),mountScene(){},
    createSceneViewController(container,callbacks,options){scene.callbacks=callbacks;scene.setMode=async mode=>{scene.mode=mode;scene.viewCalls.push(['mode',mode]);options.onChange({mode,pending:false});return mode;};return scene;},
    mountErp(options){const instance={options,isOpen:false,destroyed:false,opens:[],documents:[],people:[],refreshes:[],draft:null,async refresh(settings={}){this.refreshes.push(plain(settings));const value=await options.request('/api/erp/snapshot');if(!this.destroyed)options.onChange({snapshot:value});return value;},async open(section,context){this.isOpen=true;this.opens.push({section,context:plain(context)});options.onNavigate({section,opened:true});},async openDocument(id){this.isOpen=true;this.documents.push(id);options.onNavigate({section:'flows',opened:true,documentId:id});},async openPerson(id){this.isOpen=true;this.people.push(id);options.onNavigate({section:'people',opened:true});},close(){if(!this.isOpen)return;this.isOpen=false;options.onNavigate({section:null,opened:false});options.onClose();},updateSession(next){this.lastSession=next;},destroy(){this.close();this.destroyed=true;this.draft=null;}};erps.push(instance);return instance;},
    mountErpPresence(options){const instance={options,moves:[],destroyed:false,async moveTo(node){this.moves.push(node);},destroy(){this.destroyed=true;}};presences.push(instance);return instance;},
    mountSession(options){sessionOptions=options;const dialog=new Element();dialog.className='session-dialog';options.container.append(dialog);account={session:null,loginRequests:[],opens:0,refreshes:0,async refresh(){this.refreshes++;const raw=await fetch('/api/session');const data=await raw.json();this.session=data.session;if(data.session?.authenticated)options.onAuthenticated(data.session);else this.requireLogin();},open(){this.opens++;},requireLogin(message=''){this.loginRequests.push(message);this.session=null;},destroy(){this.destroyed=true;}};account.ready=account.refresh();return account;},
  };
  const context=vm.createContext(scope);
  const controller=await vm.runInContext(`(async()=>{${source}\nreturn {api,startSession,receiveSnapshot,handleOfficeClick,cleanPrivateState,state:()=>({session,snapshot,section,preferredDocument,sessionEpoch})};})()`,context);
  await flush();
  const target=dataset=>({dataset,closest(selector){if(selector.includes('[data-office-section]'))return this;if(selector==='#view-menu,[data-office-action="view"]')return dataset.officeAction==='view'?this:null;return null;}});
  return{scene,erps,presences,requests,document,documentEvents,windowEvents,intervals,timeouts,stored,animations,motionPreference,motionListeners,account,element,controller,context,scope,
    setResponder(fn){responder=fn;},async login(value=loginSession()){account.session=value;sessionOptions.onAuthenticated(value);await flush();},async signOut(){account.session=null;sessionOptions.onSignedOut();await flush();},async click(dataset){await controller.handleOfficeClick({target:target(dataset)});await flush();},async documentClick(dataset){documentEvents.get('click')?.({target:target(dataset)});await flush();},publish(value){controller.receiveSnapshot(value);},async poll(){for(const timer of [...intervals.values()])if(timer.ms===8000)timer.fn();await flush();},async event(type){windowEvents.get(type)?.();await flush();},cleanup(){windowEvents.get('pagehide')?.();},get currentErp(){return erps.at(-1);},get currentPresence(){return presences.at(-1);}};
}

test('anonymous startup keeps the office visible and requires same-layer sign-in before business access',async()=>{
  const h=await harness();try{assert.equal(h.erps.length,0);assert.equal(h.presences.length,0);assert.equal(h.account.loginRequests.length,1);assert.equal(h.element('#lab').children[0].className,'session-dialog');assert.equal(h.scene.updates.at(-1).runId,null);assert.ok(h.scene.presence.every(p=>p.people.length===0));
    await h.click({officeSection:'inventory'});h.scene.callbacks.onSelectAgent('finance');h.scene.callbacks.onSelectNode('meeting');await flush();assert.equal(h.erps.length,0);assert.equal(h.requests.length,1);assert.equal(h.requests[0].path,'/api/session');assert.ok(h.account.loginRequests.length>=4);
    await h.click({officeAction:'account'});assert.equal(h.account.opens,1);assert.equal(h.element('#lab').hidden,false);
  }finally{h.cleanup();}
});

test('sign-in mounts business and presence once; repeated public session metadata does not replace the workbench',async()=>{
  const h=await harness();try{await h.login();assert.equal(h.erps.length,1);assert.equal(h.presences.length,1);assert.equal(h.currentErp.options.container,h.element('#workspace-business'));assert.equal(h.currentPresence.options.session.actor.id,'employee-a');assert.equal(h.currentErp.refreshes.length,1);assert.match(h.element('#action-dock').innerHTML,/王敏/);
    const original=h.currentErp;await h.login({...loginSession(),actor:{...loginSession().actor,title:'交付负责人'}});assert.equal(h.erps.length,1);assert.equal(h.currentErp,original);assert.equal(original.lastSession.actor.title,'交付负责人');
  }finally{h.cleanup();}
});

test('all business sections navigate through the dock and never submit a business mutation',async()=>{
  const h=await harness();try{await h.login();h.requests.length=0;for(const section of['desk','projects','flows','inventory','people','reports'])await h.click({officeSection:section});assert.deepEqual(h.currentErp.opens.map(v=>v.section),['desk','projects','flows','inventory','people','reports']);assert.deepEqual(h.currentPresence.moves,['general_office','research','business','maintenance','hr_admin','finance']);assert.equal(h.requests.length,0);assert.match(h.element('#action-dock').innerHTML,/aria-current="page"/);assert.doesNotMatch(h.element('#action-dock').innerHTML,/产物|实验室|模型|虚拟员工|查看进展|日志|Agent/i);
  }finally{h.cleanup();}
});

test('perspective and full screen preserve business drafts without exposing camera adjustment buttons',async()=>{
 const h=await harness();try{await h.login();await h.click({officeSection:'flows'});const draft={title:'待提交采购',quantity:3};h.currentErp.draft=draft;h.requests.length=0;
  await h.click({officeView:'3d'});assert.equal(h.scene.mode,'3d');assert.equal(h.element('#lab').dataset.view,'3d');assert.equal(h.stored.get('office-view-mode'),'3d');
  assert.doesNotMatch(h.element('#action-dock').innerHTML,/workspace-new|data-office-action="(?:view|zoom-in|zoom-out|rotate-left|rotate-right|fit)"/);
  await h.click({officeAction:'fullscreen'});assert.equal(h.document.fullscreenElement,h.element('#lab'));assert.match(h.element('#action-dock').innerHTML,/aria-label="退出全屏"/);await h.click({officeAction:'fullscreen'});assert.equal(h.document.fullscreenElement,null);await h.click({officeView:'2d'});assert.equal(h.currentErp.draft,draft);assert.equal(h.requests.length,0);
  const cameraCalls=h.scene.viewCalls.length;await h.click({officeAction:'home'});assert.equal(h.currentErp.isOpen,false);assert.equal(h.scene.viewCalls.length,cameraCalls,'returning from business does not adjust the camera');
 }finally{h.cleanup();}
});

test('initial documents are a quiet baseline and new results open the actual business document in the office',async()=>{
  const h=await harness();try{const existing=documentRow({status:'approved',version:2});h.setResponder(()=>businessSnapshot({documents:[existing]}));await h.login();assert.equal(h.element('#workspace-receipt').hidden,true);assert.deepEqual(h.currentErp.documents,[]);
    h.publish(businessSnapshot({documents:[{...existing,status:'completed',version:3,updatedAt:'2026-10-20T03:00:00Z'}]}));await flush();assert.deepEqual(h.currentErp.documents,['order-a']);assert.equal(h.element('#workspace-receipt').hidden,true,'opening the business record consumes its toast');assert.match(h.element('#workspace-receipt').innerHTML,/已完成/);assert.match(h.element('#workspace-receipt').innerHTML,/服务器采购/);assert.equal(h.controller.state().preferredDocument,'order-a');
  }finally{h.cleanup();}
});

test('incoming approval stays actionable without replacing an open form, then a receipt opens that document',async()=>{
  const h=await harness();try{await h.login();const initial=documentRow();h.publish(businessSnapshot({documents:[initial]}));await h.click({officeSection:'flows'});const draft={supplier:'供应商乙',quantity:'12'};h.currentErp.draft=draft;const before=h.currentErp.opens.length;
    h.publish(businessSnapshot({documents:[{...initial,status:'awaiting_approval',version:2,allowedActions:['approve'],title:'<script>采购审批</script>'}]}));await flush();assert.equal(h.currentErp.draft,draft);assert.equal(h.currentErp.opens.length,before);assert.deepEqual(h.currentErp.documents,[]);assert.equal(h.element('#workspace-receipt').hidden,false);assert.match(h.element('#workspace-receipt').innerHTML,/待审批/);assert.match(h.element('#workspace-receipt').innerHTML,/&lt;script&gt;/);assert.doesNotMatch(h.element('#workspace-receipt').innerHTML,/<script>/);assert.match(h.element('#action-dock').innerHTML,/1 项待审批/);
    await h.documentClick({officeDocument:'order-a'});assert.deepEqual(h.currentErp.documents,['order-a']);assert.equal(h.requests.filter(r=>r.method!=='GET').length,0);
  }finally{h.cleanup();}
});

test('background reconciliation runs only when the workbench is closed and visible',async()=>{
  const h=await harness();try{await h.login();await h.click({officeSection:'projects'});const draft={objective:'用户尚未提交'};h.currentErp.draft=draft;const before=h.currentErp.refreshes.length;await h.poll();assert.equal(h.currentErp.refreshes.length,before);assert.equal(h.currentErp.draft,draft);h.document.hidden=true;h.currentErp.close();await h.poll();assert.equal(h.currentErp.refreshes.length,before);h.document.hidden=false;await h.poll();assert.equal(h.currentErp.refreshes.length,before+1);assert.deepEqual(h.currentErp.refreshes.at(-1),{silent:true});assert.equal(h.currentErp.draft,draft);
  }finally{h.cleanup();}
});

test('room, colleague and employee clicks lead to business records or scoped modules, never execution details',async()=>{
  const h=await harness();try{await h.login();h.publish(businessSnapshot({documents:[documentRow({agentRun:{id:'work-a',status:'running',tasks:[{agentId:'finance',status:'running',output:'private model output'}]}})]}));h.scene.callbacks.onSelectAgent('finance');await flush();assert.deepEqual(h.currentErp.documents,['order-a']);h.scene.callbacks.onSelectAgent('hr');await flush();assert.equal(h.currentErp.opens.at(-1).section,'people');h.scene.callbacks.onSelectNode('finance');await flush();assert.equal(h.currentErp.opens.at(-1).section,'people');assert.ok(h.scene.viewCalls.some(([action,id])=>action==='focusNode'&&id==='finance'));h.scene.callbacks.onSelectHuman('owner');await flush();assert.equal(h.currentErp.opens.at(-1).section,'desk');h.currentPresence.options.onSelectEmployee({id:'employee-b'});await flush();assert.deepEqual(h.currentErp.people,['employee-b']);h.currentPresence.options.onSelectEmployee({id:'employee-a'});await flush();assert.equal(h.currentErp.opens.at(-1).section,'desk');assert.doesNotMatch(JSON.stringify(h.scene.updates),/private model output/);assert.ok(h.requests.every(r=>r.path==='/api/session'||r.path.startsWith('/api/erp/')));
  }finally{h.cleanup();}
});

test('401 destroys private workbench and presence and opens login in place',async()=>{
  const h=await harness();try{await h.login();h.publish(businessSnapshot({documents:[documentRow({title:'账户A私有报价'})]}));const erp=h.currentErp,presence=h.currentPresence;erp.draft={price:'999999'};await h.click({officeSection:'flows'});h.setResponder(()=>response(401,{error:'unauthorized'}));await assert.rejects(h.controller.api('/api/erp/snapshot'),err=>err.status===401);assert.equal(erp.destroyed,true);assert.equal(presence.destroyed,true);assert.equal(erp.draft,null);assert.equal(h.controller.state().session,null);assert.deepEqual(plain(h.controller.state().snapshot),{});assert.equal(h.element('#workspace-receipt').hidden,true);assert.deepEqual(h.scene.presence.at(-1).people,[]);assert.equal(h.scene.updates.at(-1).runId,null);assert.doesNotMatch(h.element('#action-dock').innerHTML,/王敏|账户A私有报价/);assert.ok(h.account.loginRequests.some(value=>value.includes('过期')));const count=h.requests.length;await h.poll();await h.click({officeSection:'reports'});assert.equal(h.requests.length,count);
  }finally{h.cleanup();}
});

test('sign-out and explicit session-ended clear results and prevent old in-flight responses from crossing accounts',async()=>{
  const h=await harness();try{await h.login();const slow=deferred();h.setResponder(request=>request.path==='/api/erp/snapshot'?slow.promise:{});const pending=h.controller.api('/api/erp/snapshot');await h.signOut();h.setResponder(()=>businessSnapshot({currentUser:loginSession('employee-b','李岩').actor}));await h.login(loginSession('employee-b','李岩'));slow.resolve(businessSnapshot({documents:[documentRow({title:'旧账户私密'})]}));await assert.rejects(pending,err=>err.status===401);assert.equal(h.controller.state().session.actor.id,'employee-b');assert.doesNotMatch(JSON.stringify(h.scene.updates.at(-1)),/旧账户私密/);assert.match(h.element('#action-dock').innerHTML,/李岩/);const erp=h.currentErp,presence=h.currentPresence;await h.event('office:session-ended');assert.equal(erp.destroyed,true);assert.equal(presence.destroyed,true);assert.equal(h.controller.state().session,null);assert.equal(h.scene.updates.at(-1).runId,null);
  }finally{h.cleanup();}
});

test('startup, refreshes and navigation never request legacy laboratory, model or automation APIs',async()=>{
  const h=await harness({sessionValue:loginSession(),savedView:'3d'});try{await flush();assert.equal(h.erps.length,1);assert.equal(h.scene.mode,'3d');await h.poll();await h.click({officeSection:'reports'});await h.click({officeAction:'account'});assert.ok(h.requests.length>=2);assert.ok(h.requests.every(r=>r.method==='GET'));assert.ok(h.requests.every(r=>r.path==='/api/session'||r.path.startsWith('/api/erp/')));assert.ok(h.requests.every(r=>!/^\/api\/(?:runs|catalog|health|provider|automation)(?:\/|$)/.test(r.path)));assert.doesNotMatch(h.element('#action-dock').innerHTML,/产物|实验室|模型连接|查看进展|日志/);
  }finally{h.cleanup();}
});

test('the HTML shell contains one office scene and dock without the removed status and entry overlays',async()=>{
  const html=await readFile(new URL('../src/index.html',import.meta.url),'utf8');assert.match(html,/<main[^>]*id="lab"/);assert.match(html,/id="office-scene"/);assert.match(html,/<nav[^>]*id="action-dock"/);assert.doesNotMatch(html,/id="(?:network-hud|configuration-hud|incident-hud|map-controls|map-legend|view-menu)"/);assert.doesNotMatch(html,/模型已连接|交办业务|查看进展|统一工作服|便服与工牌/);assert.match(html,/src="\.\/office.js"/);
});

test('perspective controls are accessible icons in the scene, with no duplicated text controls in the dock',async()=>{
  const h=await harness();try{
    assert.match(h.element('#view-switch').innerHTML,/aria-label="平面视角"/);assert.match(h.element('#view-switch').innerHTML,/aria-label="立体视角"/);
    assert.match(h.element('#view-switch').innerHTML,/#i-cube/);assert.match(h.element('#view-switch').innerHTML,/#i-plan/);assert.doesNotMatch(h.element('#view-switch').innerHTML,/data-office-action/);
    assert.doesNotMatch(h.element('#view-switch').innerHTML,/>2D<|>3D</);assert.doesNotMatch(h.element('#action-dock').innerHTML,/data-office-view/);
    await h.click({officeView:'3d'});assert.match(h.element('#view-switch').innerHTML,/data-office-view="3d"[^>]*aria-pressed="true"/);assert.equal(h.scene.mode,'3d');assert.equal(h.requests.filter(r=>r.method!=='GET').length,0);
  }finally{h.cleanup();}
});

test('surface feedback follows new business notices and cleans up on account change',async()=>{
 const h=await harness();try{
  await h.login();const baselineAnimations=h.animations.length;await h.poll();assert.equal(h.animations.length,baselineAnimations);
  await h.click({officeSection:'flows'});h.publish(businessSnapshot({documents:[documentRow()]}));h.publish(businessSnapshot({documents:[documentRow({version:2,status:'awaiting_approval',allowedActions:['approve']})]}));
  const receipt=h.animations.at(-1);assert.equal(receipt.element,h.element('#workspace-receipt'));assert.equal(receipt.options.duration,300);
  const latest=h.animations.length;h.publish(businessSnapshot({documents:[documentRow({version:2,status:'awaiting_approval',allowedActions:['approve']})]}));assert.equal(h.animations.length,latest);
  await h.signOut();assert.equal(receipt.cancelled,true);assert.equal(h.element('#workspace-receipt').innerHTML,'');
 }finally{h.cleanup();}
});

test('reduced motion, hidden pages and bfcache transitions do not leave decorative animations running',async()=>{
 const h=await harness({reducedMotion:true});try{
  await h.login();await h.click({officeSection:'flows'});h.publish(businessSnapshot({documents:[documentRow()]}));
  const publish=(version,status)=>h.publish(businessSnapshot({documents:[documentRow({version,status,allowedActions:['approve']})]}));
  publish(2,'awaiting_approval');assert.equal(h.animations.length,0);
  h.motionPreference.matches=false;h.document.hidden=true;publish(3,'completed');assert.equal(h.animations.length,0);
  h.document.hidden=false;publish(4,'awaiting_approval');const receipt=h.animations.at(-1);assert.equal(receipt.cancelled,false);
  h.motionPreference.matches=true;h.motionListeners.get('change')();assert.equal(receipt.cancelled,true);
  h.windowEvents.get('pagehide')({persisted:true});assert.equal(h.scene.destroyed,undefined);h.windowEvents.get('pagehide')({persisted:false});assert.equal(h.scene.destroyed,true);assert.equal(h.motionListeners.size,0);
 }finally{h.cleanup();}
});

test('session cleanup removes private notification and error text from the DOM, rather than only hiding it',async()=>{
  const h=await harness();try{await h.login();h.publish(businessSnapshot({documents:[documentRow()]}));await h.click({officeSection:'flows'});h.publish(businessSnapshot({documents:[documentRow({status:'awaiting_approval',version:2,title:'保密客户采购标题',allowedActions:['approve']})]}));assert.match(h.element('#workspace-receipt').innerHTML,/保密客户采购标题/);h.currentErp.open=async()=>{throw new Error('保密客户业务错误');};await h.click({officeSection:'reports'});assert.equal(h.element('#toast').textContent,'保密客户业务错误');await h.signOut();assert.equal(h.element('#workspace-receipt').innerHTML,'');assert.equal(h.element('#toast').textContent,'');assert.equal(h.element('#toast').hidden,true);assert.equal(h.element('#workspace-receipt').hidden,true);
  }finally{h.cleanup();}
});

test('a different cookie identity clears the old draft before projection and refreshes the public session',async()=>{
  const h=await harness();try{await h.login();await h.click({officeSection:'flows'});const oldErp=h.currentErp,oldPresence=h.currentPresence;oldErp.draft={supplier:'账户A草稿报价'};const freshSession=deferred(),before=h.account.refreshes;h.setResponder(request=>request.path==='/api/session'?freshSession.promise:businessSnapshot({currentUser:loginSession('employee-b','李岩').actor}));
    h.publish(businessSnapshot({currentUser:loginSession('employee-b','李岩').actor,documents:[documentRow({agentRun:{id:'COOKIE-USER-B-WORK',status:'running',tasks:[],events:[]}})]}));
    assert.equal(oldErp.destroyed,true);assert.equal(oldPresence.destroyed,true);assert.equal(oldErp.draft,null);assert.equal(h.controller.state().session,null);assert.deepEqual(plain(h.controller.state().snapshot),{});assert.deepEqual(h.scene.presence.at(-1).people,[]);assert.equal(h.scene.updates.at(-1).runId,null);assert.doesNotMatch(JSON.stringify(h.scene.updates),/COOKIE-USER-B-WORK/);assert.equal(h.account.refreshes,before+1);assert.equal(h.erps.length,1,'new business is not mounted before public session restoration');
    freshSession.resolve({session:loginSession('employee-b','李岩')});await flush();assert.equal(h.controller.state().session.actor.id,'employee-b');assert.equal(h.erps.length,2);assert.equal(h.currentErp.options.session.actor.id,'employee-b');assert.match(h.element('#action-dock').innerHTML,/李岩/);assert.doesNotMatch(h.element('#action-dock').innerHTML,/王敏|账户A草稿报价/);
  }finally{h.cleanup();}
});

test('every ERP request carries the currently displayed employee identity for reads and writes',async()=>{
  const h=await harness();try{await h.login();await h.controller.api('/api/erp/workitems/doc-a');await h.currentPresence.options.request('/api/erp/presence','PUT',{nodeId:'finance'});await h.controller.api('/api/erp/workitems','POST',{type:'weekly_report',title:'测试请求'});const first=h.requests.filter(r=>r.path.startsWith('/api/erp/'));assert.ok(first.length>=4);assert.ok(first.every(r=>r.headers['X-Office-Actor']==='employee-a'));assert.equal(first.find(r=>r.method==='PUT').headers['Content-Type'],'application/json');assert.ok(first.every(r=>r.credentials==='same-origin'&&r.cache==='no-store'));
    const previous=h.requests.length;h.setResponder(()=>businessSnapshot({currentUser:loginSession('employee-b','李岩').actor}));await h.login(loginSession('employee-b','李岩'));await h.controller.api('/api/erp/snapshot');assert.ok(h.requests.slice(previous).filter(r=>r.path.startsWith('/api/erp/')).every(r=>r.headers['X-Office-Actor']==='employee-b'));assert.equal(h.requests[0].headers['X-Office-Actor'],undefined,'public session bootstrap is independent of a stale UI identity');
  }finally{h.cleanup();}
});


test('all twelve department areas focus the office without opening a maintenance form or creating work',async()=>{
 const h=await harness();try{
  await h.login();h.requests.length=0;const opened=h.currentErp.opens.length;
  for(const department of ORGANIZATION_DEPARTMENTS){h.scene.callbacks.onSelectNode(department.id);await flush();assert.ok(h.scene.viewCalls.some(([action,id])=>action==='focusNode'&&id===department.id));}
  assert.equal(h.currentErp.opens.length,opened);assert.deepEqual(h.currentPresence.moves,ORGANIZATION_DEPARTMENTS.map(d=>d.id));assert.equal(h.requests.length,0);
 }finally{h.cleanup();}
});


test('the physical public board opens real notices and moves the current employee to the board, without a new dock entry',async()=>{
 const h=await harness();try{await h.login();h.requests.length=0;h.scene.callbacks.onSelectNode('bulletin');await flush();assert.equal(h.currentErp.opens.at(-1).section,'notices');assert.equal(h.currentPresence.moves.at(-1),'bulletin');assert.doesNotMatch(h.element('#action-dock').innerHTML,/data-office-section="notices"/);assert.equal(h.requests.length,0);}finally{h.cleanup();}
});
