import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShutdown } from '../server/lifecycle.mjs';
import { AGENTS, SCENARIOS } from '../server/catalog.mjs';

test('停机关闭真实SSE连接、取消probe、等待引擎收尾且可重复调用', async () => {
  const sseResponses = new Set(), probeController = new AbortController();let shuttingDown=false, engineStops=0, engineFinished=false;
  const server = createServer((req,res)=>{
    if(shuttingDown){res.writeHead(503).end('stopping');return;}
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: ready\n\n');sseResponses.add(res);res.on('close',()=>sseResponses.delete(res));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client = get({hostname:'127.0.0.1',port:server.address().port,path:'/events'});
  const response = await new Promise((resolve,reject)=>{client.on('response',resolve);client.on('error',reject);});response.resume();
  const ended = new Promise(resolve=>response.on('end',resolve));
  const engine={shutdown:async()=>{engineStops++;await new Promise(resolve=>setTimeout(resolve,25));engineFinished=true;}};
  const stop=createShutdown({server,engine,sseResponses,probeController,onStart:()=>{shuttingDown=true;}});
  const promise=stop();assert.equal(stop(),promise);await promise;await ended;
  assert.equal(engineStops,1);assert.equal(engineFinished,true);assert.equal(probeController.signal.aborted,true);assert.equal(shuttingDown,true);assert.equal(server.listening,false);assert.equal(sseResponses.size,0);
});

test('引擎停机失败也会释放真实HTTP连接并报告失败', async () => {
  const server=createServer((req,res)=>{res.writeHead(200);res.write('held response');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client=get({hostname:'127.0.0.1',port:server.address().port});
  const response=await new Promise((resolve,reject)=>{client.on('response',resolve);client.on('error',reject);});response.resume();
  const closed=new Promise(resolve=>response.on('close',resolve));
  const stop=createShutdown({server,engine:{shutdown:async()=>{throw new Error('unit-test shutdown failure');}}});
  await assert.rejects(stop(),/shutdown failure/);await closed;assert.equal(server.listening,false);
});

test('独立真实服务器收到SIGTERM会关闭SSE并正常退出，恢复记录保留在隔离目录', async () => {
  const projectRoot=fileURLToPath(new URL('../',import.meta.url));
  const dataDir=await mkdtemp(path.join(tmpdir(),'office-server-lifecycle-'));
  const id='isolated-recovered-run',runDir=path.join(dataDir,id);await mkdir(runDir);
  const scenario=SCENARIOS.find(s=>s.id==='finance'),createdAt=new Date(Date.now()-30000).toISOString();
  const snapshot={id,scenarioId:scenario.id,title:scenario.title,status:'running',createdAt,updatedAt:createdAt,input:{company:'isolated lifecycle test',year:2025,data:'explicit test only'},configs:Object.fromEntries(AGENTS.map(a=>[a.id,{instructions:a.instructions,tools:a.tools}])),runDir,tasks:scenario.tasks.map((t,i)=>({...t,status:i===0?'running':'pending',startedAt:i===0?createdAt:null,finishedAt:null})),events:[],artifacts:[],approval:null,error:null,nodes:{}};
  await writeFile(path.join(runDir,'run.json'),JSON.stringify(snapshot));
  const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const child=spawn(process.execPath,['scripts/server.mjs'],{cwd:projectRoot,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),OFFICE_DATA_DIR:dataDir},stdio:['ignore','pipe','pipe']});
  let output='',errorOutput='',client,response;
  child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errorOutput+=chunk;});
  const exited=new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));
  try{
    const deadline=Date.now()+5000;
    while(!output.includes('Office:')){if(child.exitCode!==null)throw new Error('Isolated server exited before listening: '+errorOutput);if(Date.now()>deadline)throw new Error('Isolated server did not start');await new Promise(resolve=>setTimeout(resolve,10));}
    client=get({hostname:'127.0.0.1',port,path:`/api/runs/${id}/events`});
    response=await new Promise((resolve,reject)=>{client.on('response',resolve);client.on('error',reject);});response.resume();
    assert.equal(response.statusCode,200);const streamClosed=new Promise(resolve=>response.on('end',resolve));
    child.kill('SIGTERM');
    let timer;const result=await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('SIGTERM left SSE/server alive')),5000);})]).finally(()=>clearTimeout(timer));
    await streamClosed;assert.equal(result.code,0);assert.equal(result.signal,null);
    const saved=JSON.parse(await readFile(path.join(runDir,'run.json'),'utf8'));assert.equal(saved.status,'failed');assert.ok(saved.finishedAt);assert.ok(saved.artifacts.some(a=>a.id==='execution-evidence'));
    const record=JSON.parse(await readFile(path.join(runDir,'协作执行记录.json'),'utf8'));assert.equal(record.status,'failed');
  }finally{client?.destroy();response?.destroy();if(child.exitCode===null){child.kill('SIGKILL');await exited;}await rm(dataDir,{recursive:true,force:true});}
});
