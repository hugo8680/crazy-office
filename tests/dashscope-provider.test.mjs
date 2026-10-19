import test from 'node:test';
import assert from 'node:assert/strict';
import {createProvider} from '../server/provider.mjs';
import {DEFAULT_DASHSCOPE_MODEL,DEFAULT_DASHSCOPE_URL} from '../server/dashscope.mjs';

const key='test-only-dashscope-secret-not-a-real-key';
const env={OFFICE_PROVIDER:'dashscope',DASHSCOPE_API_KEY:key,OFFICE_MODEL_RETRIES:'0'};
const tool={name:'design_database',description:'使用真实SQLite验证DDL',parameters:{type:'object',properties:{ddl:{type:'string'}},required:['ddl'],additionalProperties:false}};
const input={role:{id:'zhang',instructions:'只处理本次隔离数据库'},goal:'保存真实模型设计的DDL',context:{input:{requirements:'保留全部字段和约束。'}},messages:[],tools:[tool]};
const ddl="CREATE TABLE test_rows(id INTEGER PRIMARY KEY,name TEXT NOT NULL);\nCREATE INDEX test_names ON test_rows(name);";
const response=(payload,status=200)=>({ok:status>=200&&status<300,status,headers:new Map(),text:async()=>JSON.stringify(payload)});
const native=(args={ddl},name=tool.name)=>({model:'dashscope-mock-model',choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'call_native_1',type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],usage:{prompt_tokens:72,completion_tokens:23,total_tokens:95}});
const complete=()=>({model:'dashscope-mock-model',choices:[{finish_reason:'stop',message:{role:'assistant',content:'真实模型测试交接正文。'}}]});
const provider=(options={})=>createProvider({env,configPath:'/not-present/dashscope-provider.json',...options});

test('DashScope missing key is unready and neither ordinary status nor refresh sends an HTTP request',async()=>{
 let calls=0;const instance=provider({env:{...env,DASHSCOPE_API_KEY:''},fetch:async()=>{calls++;throw new Error('must not fetch');}});
 const initial=await instance.getProviderStatus();assert.equal(initial.provider,'dashscope');assert.equal(initial.ready,false);assert.match(initial.message,/DASHSCOPE_API_KEY/);assert.equal((await instance.getProviderStatus({refresh:true})).ready,false);await assert.rejects(instance.decide(input),{code:'AUTH_REQUIRED'});assert.equal(calls,0);
});

test('DashScope sends private header key and native authorized tools to the official endpoint',async()=>{
 let sent;const instance=provider({fetch:async(url,options)=>{sent={url,...options};return response(native());}});const result=await instance.decide(input),body=JSON.parse(sent.body);
 assert.equal(sent.url,DEFAULT_DASHSCOPE_URL);assert.equal(sent.redirect,'error');assert.equal(sent.headers.authorization,'Bearer '+key);assert.equal(body.model,DEFAULT_DASHSCOPE_MODEL);assert.equal(body.enable_thinking,false);assert.equal(body.parallel_tool_calls,false);assert.equal(body.max_tokens,4096);assert.deepEqual(body.tools,[{type:'function',function:tool}]);assert.equal(JSON.stringify(body).includes(key),false);assert.equal(JSON.stringify(result).includes(key),false);assert.equal(result.args.ddl,ddl);assert(result.args.ddl.includes('\n'));assert.equal(result.summarySource,'tool_call_metadata');assert.equal(result.summary,'请求执行 design_database');assert.equal(result.output,'');assert.equal(result.usage.input_tokens,72);assert.equal(result.usage.output_tokens,23);
});

test('DashScope real probe may finish, concurrent probes coalesce and ordinary status does not spend tokens',async()=>{
 let calls=0;const instance=provider({fetch:async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,5));return response(complete());}});
 const results=await Promise.all([instance.getProviderStatus({refresh:true}),instance.getProviderStatus({refresh:true})]);assert.equal(calls,1);assert(results.every(result=>result.ready&&result.provider==='dashscope'));assert.equal((await instance.getProviderStatus()).ready,true);assert.equal(calls,1);const done=await instance.decide(input);assert.equal(done.action,'finish');assert.equal(done.summarySource,'model');assert.equal(done.output,'真实模型测试交接正文。');
});

test('DashScope native SQL history pairs only real receipts and leaves format feedback as data',async()=>{
 let body;const history=[{role:'tool',content:'args_json旧格式错误，只修正原生参数'},{role:'assistant',content:JSON.stringify({action:'tool',tool:tool.name,args:{ddl},summary:'模型请求',output:''})},{role:'tool',content:'{"ok":false,"error":"缺少NOT NULL"}'}];
 const instance=provider({fetch:async(url,options)=>{body=JSON.parse(options.body);return response(native());}});await instance.decide({...input,messages:history});assert.equal(body.messages[2].role,'user');assert(body.messages[2].content.endsWith(history[0].content));assert.equal(body.messages[3].content,history[1].content);assert.equal(JSON.parse(body.messages[3].tool_calls[0].function.arguments).ddl,ddl);assert.equal(body.messages[4].tool_call_id,body.messages[3].tool_calls[0].id);assert.equal(body.messages[4].content,history[2].content);
});

test('DashScope fails closed for unapproved tools, invalid arguments and multiple native calls',async()=>{
 const multi=native();multi.choices[0].message.tool_calls.push(structuredClone(multi.choices[0].message.tool_calls[0]));
 for(const [payload,code] of [[native({ddl},'fake_shell'),'UNAUTHORIZED_TOOL'],[native({ddl:17}),'MALFORMED_ARGUMENTS'],[native({ddl,extra:true}),'MALFORMED_ARGUMENTS'],[multi,'MULTIPLE_TOOL_CALLS']]){const instance=provider({fetch:async()=>response(payload)});await assert.rejects(instance.decide(input),error=>error.code===code&&!error.message.includes(key));}
});

test('DashScope permits Beijing workspace HTTPS endpoint and rejects nonofficial addresses before fetch',async()=>{
 let called;const base='https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';const valid=provider({env:{...env,OFFICE_DASHSCOPE_URL:base},fetch:async url=>{called=url;return response(native());}});await valid.decide(input);assert.equal(called,base+'/chat/completions');
 for(const url of ['http://dashscope.aliyuncs.com/compatible-mode/v1','https://127.0.0.1/compatible-mode/v1','https://dashscope.aliyuncs.com.evil.example/compatible-mode/v1','https://key:secret@dashscope.aliyuncs.com/compatible-mode/v1','https://dashscope.aliyuncs.com/compatible-mode/v1?key=secret','https://dashscope.aliyuncs.com/other']){let calls=0;const invalid=provider({env:{...env,OFFICE_DASHSCOPE_URL:url},fetch:async()=>{calls++;return response(native());}});await assert.rejects(invalid.decide(input),error=>error.code==='INVALID_CONFIG'&&!error.message.includes('secret'));assert.equal(calls,0);}
});

test('DashScope HTTP authentication errors never echo upstream body or the private key',async()=>{
 const instance=provider({fetch:async()=>response({error:{message:'401 invalid api key '+key}},401)});await assert.rejects(instance.decide(input),error=>error.code==='AUTH_REQUIRED'&&!error.message.includes(key));const status=await instance.getProviderStatus();assert.equal(status.ready,false);assert.equal(JSON.stringify(status).includes(key),false);
});
