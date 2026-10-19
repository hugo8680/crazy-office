import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {hashAccessPassword} from '../server/access.mjs';

const PROJECT=fileURLToPath(new URL('../',import.meta.url)),ORIGIN='https://office.test';
const OWNER_PASSWORD='erp-http-owner-password-2026',EMPLOYEE_PASSWORD='erp-http-employee-password-2026';
async function listen(server){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return server.address().port;}
async function unusedPort(){const socket=createServer(),port=await listen(socket);await new Promise(resolve=>socket.close(resolve));return port;}
// This local HTTP socket is the loopback side of a TLS reverse proxy. Only the
// app-issued opaque Secure cookie is carried, without weakening cookie policy.
function call(port,path,{method='GET',cookie,body,origin=method==='GET'?undefined:ORIGIN}={}){return new Promise((resolve,reject)=>{
 const encoded=body===undefined?null:Buffer.from(JSON.stringify(body)),headers={Host:'office.test',Connection:'close',...(cookie?{Cookie:cookie}:{}),...(origin?{Origin:origin}:{}),...(encoded?{'Content-Type':'application/json','Content-Length':encoded.length}:{})};
 const req=httpRequest({hostname:'127.0.0.1',port,path,method,headers,agent:false},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,text,data});});});
 req.setTimeout(8000,()=>req.destroy(new Error('Isolated ERP HTTP request timed out')));req.on('error',reject);req.end(encoded);
});}
async function stopChild(child){if(!child||child.exitCode!==null||child.signalCode!==null)return;const exited=once(child,'exit');child.kill('SIGTERM');await Promise.race([exited,delay(2500)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
function issuedCookie(response){assert.equal(response.status,200,response.data?.error);const value=response.headers['set-cookie']?.[0];assert.match(value,/^__Host-office_session=[^;]+;/);assert.match(value,/; Secure;/);assert.match(value,/; HttpOnly;/);assert.match(value,/; SameSite=Strict/);return value.split(';')[0];}

test('isolated ERP HTTP joins real employees, enforces current roles and scopes all business reads',{timeout:60000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'office-erp-http-'));let child,stub,output='',spawnError,adminCookie,aliceCookie,bobCookie,alice,bob,projectA,projectB,privateDocument,legacyRun;
 const modelRequests=[];
 t.after(async()=>{await stopChild(child);if(stub){stub.closeAllConnections?.();await new Promise(resolve=>stub.close(resolve));}await rm(directory,{recursive:true,force:true});});
 stub=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}modelRequests.push({path:req.url,body});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({model:'erp-http-stub',message:{role:'assistant',content:JSON.stringify({action:'finish',tool:null,args_json:'{}',summary:'隔离 HTTP 接入测试，不执行任何业务工具。',output:'仅验证 HTTP 权限。'})},done:true,prompt_eval_count:1,eval_count:1}));});
 const modelPort=await listen(stub),port=await unusedPort(),passwordHash=await hashAccessPassword(OWNER_PASSWORD),secret=randomBytes(40).toString('hex'),companyFile=join(directory,'company.json');
 await writeFile(companyFile,JSON.stringify({name:'ERP HTTP 隔离测试公司',source:'test-fixture',verifiedFacts:[],sources:[]}));
 child=spawn(process.execPath,['scripts/server.mjs'],{cwd:PROJECT,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),OFFICE_DATA_DIR:join(directory,'state'),OFFICE_COMPANY_FILE:companyFile,OFFICE_PUBLIC_ORIGIN:ORIGIN,OFFICE_ACCESS_USERNAME:'erp-owner',OFFICE_ACCESS_PASSWORD_HASH:passwordHash,OFFICE_SESSION_SECRET:secret,OFFICE_PROVIDER:'ollama',OFFICE_MODEL:'erp-http-stub',OFFICE_OLLAMA_URL:`http://127.0.0.1:${modelPort}`,OFFICE_MODEL_RETRIES:'0',OFFICE_MODEL_TIMEOUT_MS:'2000',OFFICE_PROBE_TIMEOUT_MS:'2000'},stdio:['ignore','pipe','pipe']});
 child.on('error',error=>{spawnError=error;});child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
 const deadline=Date.now()+12000;let ready=false;while(Date.now()<deadline){if(spawnError)throw spawnError;if(child.exitCode!==null)throw new Error('Isolated ERP server startup failed: '+output.slice(-1200));try{if((await call(port,'/api/session')).status===200){ready=true;break;}}catch{}await delay(30);}assert.equal(ready,true,'isolated ERP server should own its assigned port');

 await t.test('join form and assets are public; token belongs to fragment and is never required in URL query',async()=>{
  for(const path of ['/join','/join.html','/join.js','/join.css']){const r=await call(port,path);assert.equal(r.status,200,path);assert.match(r.headers['cache-control'],/no-cache|no-store/);}
  const page=await call(port,'/join');assert.match(page.text,/<form\b/);assert.match(page.headers['content-security-policy'],/default-src 'self'/);
  const script=await call(port,'/join.js');assert.match(script.text,/location\.hash/);assert.doesNotMatch(script.text,/URLSearchParams\(location\.search\)/);
  assert.equal((await call(port,'/api/erp/snapshot')).status,401);
 });

 await t.test('existing configured account remains the bootstrap administrator and keeps its original login',async()=>{
  const login=await call(port,'/api/session/login',{method:'POST',body:{username:'erp-owner',password:OWNER_PASSWORD}});adminCookie=issuedCookie(login);assert.equal(login.data.session.authenticated,true);assert.equal(login.data.session.username,'erp-owner');assert.equal(login.data.session.actor.id,'bootstrap');assert.deepEqual(login.data.session.actor.roles,['admin']);
  const current=await call(port,'/api/session',{cookie:adminCookie});assert.equal(current.data.session.actor.id,'bootstrap');
  assert.equal((await call(port,'/api/erp/snapshot',{cookie:adminCookie})).status,200);
  const erpModule=await call(port,'/erp-ui.mjs',{cookie:adminCookie});assert.equal(erpModule.status,200);assert.match(erpModule.headers['content-type'],/^text\/javascript(?:;|$)/);assert.equal(erpModule.headers['x-content-type-options'],'nosniff');assert.match(erpModule.text,/^export\s+(?:const|function)\s/);
 });

 async function joinEmployee(username,name,roles,department){
  const invitation=await call(port,'/api/erp/invitations',{method:'POST',cookie:adminCookie,body:{username,name,roles,department,title:'测试岗位',_requestId:randomUUID()}});assert.equal(invitation.status,201,invitation.data?.error);assert.ok(invitation.data.token);assert.equal(invitation.text.includes('passwordHash'),false);
  const accepted=await call(port,'/api/erp/invitations/accept',{method:'POST',body:{token:invitation.data.token,password:EMPLOYEE_PASSWORD}});assert.equal(accepted.status,200,accepted.data?.error);assert.equal(accepted.data.employee.username,username);
  assert.equal((await call(port,'/api/erp/invitations/accept',{method:'POST',body:{token:invitation.data.token,password:EMPLOYEE_PASSWORD}})).status,410);
  const login=await call(port,'/api/session/login',{method:'POST',body:{username,password:EMPLOYEE_PASSWORD}});return {employee:accepted.data.employee,cookie:issuedCookie(login)};
 }
 await t.test('administrator invites employees and employees set their own passwords before signing in',async()=>{
  ({employee:alice,cookie:aliceCookie}=await joinEmployee('erp-alice','研发员工甲',['employee'],'研发部'));
  ({employee:bob,cookie:bobCookie}=await joinEmployee('erp-bob','项目负责人乙',['project_manager'],'交付部'));
  const session=await call(port,'/api/session',{cookie:aliceCookie});assert.equal(session.data.session.actor.id,alice.id);assert.deepEqual(session.data.session.actor.roles,['employee']);
 });

 await t.test('ordinary employees can read a minimal directory and their own snapshot without secrets',async()=>{
  const directory=await call(port,'/api/erp/users',{cookie:aliceCookie});assert.equal(directory.status,200);assert.ok(directory.data.users.some(u=>u.id===bob.id));for(const user of directory.data.users){for(const secretKey of ['passwordHash','epoch','token','tokenHash','source'])assert.equal(Object.hasOwn(user,secretKey),false,secretKey);}
  const snapshot=await call(port,'/api/erp/snapshot',{cookie:aliceCookie});assert.equal(snapshot.status,200);assert.equal(snapshot.data.currentUser.id,alice.id);assert.deepEqual(snapshot.data.documents,[]);assert.equal(snapshot.text.includes(OWNER_PASSWORD),false);assert.equal(snapshot.text.includes(EMPLOYEE_PASSWORD),false);
 });

 await t.test('ordinary employees cannot invite, change another account or manage global automation',async()=>{
  const denied=[['/api/erp/invitations','POST',{username:'forged-admin',name:'伪管理员',department:'研发部',roles:['admin']}],[`/api/erp/users/${bob.id}`,'PUT',{roles:['admin'],_requestId:randomUUID()}],[`/api/erp/users/${bob.id}/reset`,'POST',{}],['/api/automation','GET'],['/api/automation','PUT',{enabled:true}],['/api/automation/dispatch','POST',{}]];
  for(const [path,method,body]of denied){const response=await call(port,path,{method,body,cookie:aliceCookie});assert.equal(response.status,403,path);}
  const globalRuns=await call(port,'/api/runs',{cookie:aliceCookie});assert.equal(globalRuns.status,200);assert.deepEqual(globalRuns.data.runs,[]);
 });

 await t.test('admin profile updates strip idempotency metadata without accepting role or identity forgery',async()=>{
  const result=await call(port,`/api/erp/users/${alice.id}`,{method:'PUT',cookie:adminCookie,body:{name:'研发员工甲（已核对）',department:'研发部',_requestId:randomUUID()}});assert.equal(result.status,200,result.data?.error);assert.equal(result.data.employee.name,'研发员工甲（已核对）');
  const current=await call(port,'/api/session',{cookie:aliceCookie});assert.equal(current.data.session.authenticated,true);assert.equal(current.data.session.actor.name,'研发员工甲（已核对）');assert.deepEqual(current.data.session.actor.roles,['employee']);
 });

 await t.test('project owners, members and task assignees must be actual active employee IDs',async()=>{
  for(const record of [{name:'不存在负责人',customer:'测试客户',ownerId:'not-an-employee',members:[]},{name:'不存在成员',customer:'测试客户',ownerId:'bootstrap',members:['not-an-employee']}]){const response=await call(port,'/api/erp/masterdata',{method:'POST',cookie:adminCookie,body:{kind:'projects',record,_requestId:randomUUID()}});assert.equal(response.status,400,response.data?.error);assert.match(response.data.error,/真实员工|在岗|员工/);}
  const a=await call(port,'/api/erp/masterdata',{method:'POST',cookie:adminCookie,body:{kind:'projects',record:{name:'ALICE_VISIBLE_PROJECT',customer:'测试客户甲',ownerId:bob.id,members:[alice.id,bob.id]},_requestId:randomUUID()}});assert.equal(a.status,201,a.data?.error);projectA=a.data.record;
  const b=await call(port,'/api/erp/masterdata',{method:'POST',cookie:adminCookie,body:{kind:'projects',record:{name:'ADMIN_PRIVATE_PROJECT',customer:'隔离测试客户乙',ownerId:'bootstrap',members:[]},_requestId:randomUUID()}});assert.equal(b.status,201,b.data?.error);projectB=b.data.record;
  const fakeTask=await call(port,'/api/erp/tasks',{method:'POST',cookie:adminCookie,body:{projectId:projectA.id,title:'虚假经办人',assigneeId:'not-an-employee',_requestId:randomUUID()}});assert.equal(fakeTask.status,400);
 });

 await t.test('cross-project snapshot, detail, report and exported CSV exclude inaccessible business data',async()=>{
  let modelReady=false;const until=Date.now()+5000;while(Date.now()<until){const h=await call(port,'/api/health',{cookie:adminCookie});if(h.data.provider.ready){modelReady=true;break;}await delay(25);}assert.equal(modelReady,true,'the isolated model stub should answer the provider probe');
  const created=await call(port,'/api/erp/workitems',{method:'POST',cookie:adminCookie,body:{type:'project_setup',title:'PRIVATE_ERP_DOCUMENT',projectId:projectB.id,input:{objective:'PRIVATE_ERP_INPUT_MARKER'},_requestId:randomUUID()}});assert.equal(created.status,202,created.data?.error);privateDocument=created.data.document;assert.equal(privateDocument.projectId,projectB.id);
  const own=(await call(port,'/api/erp/snapshot',{cookie:aliceCookie}));assert.equal(own.status,200);assert.ok(own.data.projects.some(p=>p.id===projectA.id));assert.equal(own.text.includes(projectB.name),false);assert.equal(own.text.includes('PRIVATE_ERP_INPUT_MARKER'),false);
  for(const path of [`/api/erp/workitems/${privateDocument.id}`,`/api/erp/workitems/${privateDocument.id}/report`]){const denied=await call(port,path,{cookie:aliceCookie});assert.ok([403,404].includes(denied.status),path);assert.equal(denied.text.includes('PRIVATE_ERP_INPUT_MARKER'),false);}
  const exported=await call(port,'/api/erp/export',{method:'POST',cookie:aliceCookie,body:{kind:'projects',_requestId:randomUUID()}});assert.equal(exported.status,200,exported.data?.error);assert.match(exported.headers['content-type'],/text\/csv/);assert.ok(exported.text.includes(projectA.name));assert.equal(exported.text.includes(projectB.name),false);
  const guessed=await call(port,'/api/erp/export',{method:'POST',cookie:aliceCookie,body:{kind:'documents',projectId:projectB.id,_requestId:randomUUID()}});assert.equal(guessed.status,200);assert.equal(guessed.text.includes('PRIVATE_ERP_DOCUMENT'),false);
 });

 await t.test('ordinary employee cannot read or alter a pre-existing legacy global run',async()=>{
  const submitted=await call(port,'/api/runs',{method:'POST',cookie:adminCookie,body:{scenarioId:'delivery',input:{company:'隔离 HTTP 测试',requirements:'PRIVATE_LEGACY_RUN_MARKER；仅验证访问权限，不执行工具。',dailyRate:1500}}});assert.equal(submitted.status,202,submitted.data?.error);legacyRun=submitted.data.run.id;
  await call(port,`/api/runs/${legacyRun}/cancel`,{method:'POST',cookie:adminCookie,body:{}});
  for(const [path,method,body]of [[`/api/runs/${legacyRun}`,'GET'],[`/api/runs/${legacyRun}/download`,'GET'],[`/api/runs/${legacyRun}/approval`,'POST',{approved:true}],['/api/runs','POST',{scenarioId:'delivery',input:{}}]]){const denied=await call(port,path,{method,body,cookie:aliceCookie});assert.equal(denied.status,403,path);assert.equal(denied.text.includes('PRIVATE_LEGACY_RUN_MARKER'),false);}
  assert.deepEqual((await call(port,'/api/runs',{cookie:aliceCookie})).data.runs,[]);
 });

 await t.test('disabling an employee immediately invalidates their previously issued cookie',async()=>{
  const disabled=await call(port,`/api/erp/users/${alice.id}`,{method:'PUT',cookie:adminCookie,body:{active:false,_requestId:randomUUID()}});assert.equal(disabled.status,200,disabled.data?.error);assert.equal(disabled.data.employee.active,false);
  const session=await call(port,'/api/session',{cookie:aliceCookie});assert.equal(session.status,200);assert.equal(session.data.session.authenticated,false);
  for(const path of ['/api/erp/snapshot','/api/erp/users','/api/runs'])assert.equal((await call(port,path,{cookie:aliceCookie})).status,401,path);
  const relogin=await call(port,'/api/session/login',{method:'POST',body:{username:'erp-alice',password:EMPLOYEE_PASSWORD}});assert.equal(relogin.status,401);
  assert.equal((await call(port,'/api/erp/snapshot',{cookie:bobCookie})).status,200);
 });

 await t.test('test calls remain on isolated model and service logs never contain credentials',async()=>{
  assert.ok(modelRequests.length>0);assert.ok(modelRequests.every(r=>r.path==='/api/chat'&&r.body.model==='erp-http-stub'));for(const confidential of [OWNER_PASSWORD,EMPLOYEE_PASSWORD,passwordHash,secret])assert.equal(output.includes(confidential),false);
 });
});
