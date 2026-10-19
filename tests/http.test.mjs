import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hashAccessPassword } from '../server/access.mjs';

const PROJECT=fileURLToPath(new URL('../',import.meta.url));
const ORIGIN='https://office.test';
const PASSWORD='http-integration-only-password-2026';

async function listen(server){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return server.address().port;}
async function unusedPort(){const reservation=createServer();const port=await listen(reservation);await new Promise(resolve=>reservation.close(resolve));return port;}

// The HTTP socket represents the loopback side of an HTTPS reverse proxy.
// Send Host/Origin explicitly, and carry only the opaque cookie issued by the app.
function call(port,path,{method='GET',cookie,origin,host='office.test',body}={}){
  return new Promise((resolve,reject)=>{
    const encoded=body===undefined?null:Buffer.from(JSON.stringify(body));
    const headers={Host:host,Connection:'close',...(cookie?{Cookie:cookie}:{}),...(origin!==undefined?{Origin:origin}:{}),...(encoded?{'Content-Type':'application/json','Content-Length':encoded.length}:{})};
    const req=httpRequest({hostname:'127.0.0.1',port,path,method,headers,agent:false},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{
        const text=Buffer.concat(chunks).toString('utf8');let data;try{data=JSON.parse(text);}catch{}
        resolve({status:res.statusCode,headers:res.headers,text,data});
      });
    });
    req.setTimeout(5000,()=>req.destroy(new Error('HTTP integration request timed out')));req.on('error',reject);req.end(encoded);
  });
}

async function stopChild(child){
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  const exited=once(child,'exit');child.kill('SIGTERM');
  await Promise.race([exited,delay(2500)]);
  if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}
}

test('public office HTTP entry, real login cookie and protected automation work together',{timeout:30000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'office-http-'));
  let child,stub,output='',spawnError;const modelRequests=[],responseTimers=new Set();
  t.after(async()=>{
    await stopChild(child);
    for(const timer of responseTimers)clearTimeout(timer);
    if(stub){stub.closeAllConnections?.();await new Promise(resolve=>stub.close(resolve));}
    await rm(directory,{recursive:true,force:true});
  });

  // Every model response is a legal finish. It can never request a business
  // tool or approval, even if the manual-source check starts its first step.
  stub=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}
    modelRequests.push({path:req.url,body});
    const timer=setTimeout(()=>{
      responseTimers.delete(timer);if(res.destroyed)return;
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({model:'http-test-stub',message:{role:'assistant',content:JSON.stringify({action:'finish',tool:null,args_json:'{}',summary:'HTTP集成测试模型，不执行办公工具。',output:'仅验证HTTP接入。'})},done:true,prompt_eval_count:1,eval_count:1}));
    },30);
    responseTimers.add(timer);res.on('close',()=>{clearTimeout(timer);responseTimers.delete(timer);});
  });
  const modelPort=await listen(stub),port=await unusedPort();
  const secret=randomBytes(40).toString('hex'),passwordHash=await hashAccessPassword(PASSWORD);
  const companyFile=join(directory,'company.json');
  await writeFile(companyFile,JSON.stringify({name:'HTTP集成测试公司（隔离资料）',source:'test-fixture',verifiedFacts:[],sources:[]}));
  child=spawn(process.execPath,['scripts/server.mjs'],{cwd:PROJECT,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',OFFICE_DATA_DIR:join(directory,'state'),OFFICE_COMPANY_FILE:companyFile,OFFICE_PUBLIC_ORIGIN:ORIGIN,OFFICE_ACCESS_USERNAME:'http-owner',OFFICE_ACCESS_PASSWORD_HASH:passwordHash,OFFICE_SESSION_SECRET:secret,OFFICE_PROVIDER:'ollama',OFFICE_MODEL:'http-test-stub',OFFICE_OLLAMA_URL:`http://127.0.0.1:${modelPort}`,OFFICE_MODEL_RETRIES:'0',OFFICE_MODEL_TIMEOUT_MS:'2000',OFFICE_PROBE_TIMEOUT_MS:'2000'},stdio:['ignore','pipe','pipe']});
  child.on('error',error=>{spawnError=error;});
  child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
  const deadline=Date.now()+8000;let ready=false;
  while(Date.now()<deadline){
    if(spawnError)throw spawnError;
    if(child.exitCode!==null)throw new Error('Isolated HTTP server exited during startup: '+output.slice(-1200));
    try{if((await call(port,'/api/session')).status===200){ready=true;break;}}catch{}
    await delay(25);
  }
  assert.equal(ready,true,'isolated office should bind its assigned port');
  let cookie;

  await t.test('unauthenticated data is 401, root redirects, and login assets stay reachable',async()=>{
    const session=await call(port,'/api/session');assert.equal(session.data.session.enabled,true);assert.equal(session.data.session.authenticated,false);
    for(const path of ['/api/catalog','/api/runs','/api/automation']){const result=await call(port,path);assert.equal(result.status,401,path);assert.equal(result.headers['set-cookie'],undefined);}
    const home=await call(port,'/');assert.equal(home.status,303);assert.equal(home.headers.location,'/login');
    const login=await call(port,'/login');assert.equal(login.status,200);assert.match(login.headers['content-type'],/text\/html/);assert.match(login.text,/<form\b/);assert.match(login.headers['content-security-policy'],/default-src 'self'/);
    assert.equal((await call(port,'/login.js')).status,200);
    assert.equal((await call(port,'/api/session',{host:'unrelated.test'})).status,403);
  });

  await t.test('login issues an opaque host cookie with browser protections and no credential disclosure',async()=>{
    const wrong=await call(port,'/api/session/login',{method:'POST',origin:ORIGIN,body:{username:'http-owner',password:'wrong'}});assert.equal(wrong.status,401);assert.equal(wrong.headers['set-cookie'],undefined);
    const login=await call(port,'/api/session/login',{method:'POST',origin:ORIGIN,body:{username:'http-owner',password:PASSWORD}});assert.equal(login.status,200);assert.equal(login.data.session.authenticated,true);assert.equal(login.data.session.username,'http-owner');
    const issued=login.headers['set-cookie'];assert.equal(issued.length,1);assert.match(issued[0],/^__Host-office_session=[^;]+;/);for(const attribute of [/; Path=\/(?:;|$)/,/; Secure(?:;|$)/,/; HttpOnly(?:;|$)/,/; SameSite=Strict(?:;|$)/])assert.match(issued[0],attribute);assert.doesNotMatch(issued[0],/; Domain=/i);assert.match(issued[0],/; Max-Age=\d+/);
    for(const confidential of [PASSWORD,passwordHash,secret]){assert.equal(login.text.includes(confidential),false);assert.equal(issued[0].includes(confidential),false);}
    cookie=issued[0].split(';')[0];
    const session=await call(port,'/api/session',{cookie});assert.equal(session.data.session.authenticated,true);
    assert.equal((await call(port,'/api/catalog',{cookie:cookie+'tampered'})).status,401);
  });

  await t.test('authenticated catalog and disabled automation are usable; private task inputs stay private',async()=>{
    assert.equal((await call(port,'/',{cookie})).status,200);
    const catalog=await call(port,'/api/catalog',{cookie});assert.equal(catalog.status,200);assert.ok(catalog.data.scenarios.some(s=>s.id==='onboarding'));assert.ok(catalog.data.agents.some(a=>a.id==='hr'));
    const runs=await call(port,'/api/runs',{cookie});assert.equal(runs.status,200);assert.deepEqual(runs.data.runs,[]);
    const initial=await call(port,'/api/automation',{cookie});assert.equal(initial.status,200);assert.equal(initial.data.automation.enabled,false);assert.equal(initial.data.automation.nextRunAt,null);
    const privateMarker='PRIVATE_HTTP_REQUIREMENTS_'+randomBytes(8).toString('hex');
    const updated=await call(port,'/api/automation',{method:'PUT',cookie,origin:ORIGIN,body:{enabled:false,minIntervalMinutes:2,maxIntervalMinutes:4,scenarioIds:['finance','onboarding'],taskInputs:{delivery:{company:'HTTP测试',requirements:privateMarker}}}});
    assert.equal(updated.status,200);assert.equal(updated.data.automation.minIntervalMinutes,2);assert.equal(updated.data.automation.enabled,false);assert.equal(Object.hasOwn(updated.data.automation,'taskInputs'),false);assert.equal(updated.text.includes(privateMarker),false);
    const status=await call(port,'/api/automation',{cookie});assert.equal(Object.hasOwn(status.data.automation,'taskInputs'),false);assert.equal(status.text.includes(privateMarker),false);
    for(const id of ['finance','onboarding'])assert.equal(status.data.automation.scenarioAvailability.find(s=>s.id===id).available,false);
    const dispatched=await call(port,'/api/automation/dispatch',{method:'POST',cookie,origin:ORIGIN,body:{}});assert.equal(dispatched.status,202);assert.equal(dispatched.data.run,null);assert.equal(dispatched.data.skipped,true);assert.equal(dispatched.data.automation.enabled,false);
    assert.deepEqual((await call(port,'/api/runs',{cookie})).data.runs,[]);
  });

  await t.test('a cross-origin PUT cannot enable the scheduler or change saved settings',async()=>{
    for(const origin of ['https://attacker.test','http://office.test']){
      const rejected=await call(port,'/api/automation',{method:'PUT',cookie,origin,body:{enabled:true,scenarioIds:['database']}});assert.equal(rejected.status,403);
    }
    const status=(await call(port,'/api/automation',{cookie})).data.automation;assert.equal(status.enabled,false);assert.deepEqual(status.scenarioIds,['finance','onboarding']);assert.equal(status.nextRunAt,null);
  });

  await t.test('manual HTTP submission cannot forge automatic origin and never receives synthetic approval',async()=>{
    const modelDeadline=Date.now()+4000;let connected=false;
    while(Date.now()<modelDeadline){const health=await call(port,'/api/health',{cookie});if(health.data.provider.ready){connected=true;break;}await delay(25);}
    assert.equal(connected,true,'the fake local Ollama probe should be ready');
    const submitted=await call(port,'/api/runs',{method:'POST',cookie,origin:ORIGIN,body:{scenarioId:'delivery',input:{company:'HTTP隔离测试',requirements:'仅验证HTTP任务来源，不请求业务工具或账号。',dailyRate:1500},source:'automation',automation:{companyName:'forged-company',templateId:'forged-template'}}});
    assert.equal(submitted.status,202);assert.equal(submitted.data.run.source,'manual');assert.equal(submitted.data.run.automation,undefined);assert.equal(submitted.data.run.approval,null);
    const id=submitted.data.run.id;const stopped=await call(port,`/api/runs/${id}/cancel`,{method:'POST',cookie,origin:ORIGIN,body:{}});assert.equal(stopped.status,200);assert.ok(['cancelled','failed'].includes(stopped.data.run.status));
    const run=(await call(port,`/api/runs/${id}`,{cookie})).data.run;assert.equal(run.source,'manual');assert.equal(run.approval,null);assert.ok(run.tasks.every(task=>task.toolCalls===0));assert.ok(run.events.every(event=>event.type!=='approval'&&event.type!=='tool'));
    assert.equal((await call(port,'/api/automation',{cookie})).data.automation.lastRunId,null);
    assert.ok(modelRequests.length>0);assert.ok(modelRequests.every(item=>item.path==='/api/chat'&&item.body.model==='http-test-stub'));
  });

  await t.test('logout clears the browser cookie and leaves private endpoints unauthenticated',async()=>{
    const result=await call(port,'/api/session/logout',{method:'POST',cookie,origin:ORIGIN,body:{}});assert.equal(result.status,200);assert.deepEqual(result.data,{ok:true});
    const cleared=result.headers['set-cookie'][0];assert.match(cleared,/^__Host-office_session=;/);assert.match(cleared,/; Max-Age=0(?:;|$)/);assert.match(cleared,/; Secure(?:;|$)/);assert.match(cleared,/; HttpOnly(?:;|$)/);assert.match(cleared,/; SameSite=Strict(?:;|$)/);
    const emptyCookie=cleared.split(';')[0];assert.equal((await call(port,'/api/session',{cookie:emptyCookie})).data.session.authenticated,false);assert.equal((await call(port,'/api/runs',{cookie:emptyCookie})).status,401);
    for(const confidential of [PASSWORD,passwordHash,secret])assert.equal(output.includes(confidential),false,'server logs must not contain authentication material');
  });
});
