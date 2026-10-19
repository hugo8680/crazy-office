import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDashscopeRequest,parseDashscopeResponse,resolveDashscopeEndpoint,DEFAULT_DASHSCOPE_URL,DEFAULT_DASHSCOPE_MODEL,DASHSCOPE_MAX_REQUEST_BYTES,DashscopeAdapterError} from '../server/dashscope.mjs';
import {parseDecision} from '../server/provider.mjs';

const sql="CREATE TABLE quotes(id INTEGER PRIMARY KEY,price REAL CHECK(price >= 0));\nCREATE INDEX quote_price ON quotes(price);";
const tool={name:'design_database',description:'真实内存执行模型DDL后核验显式SQL合同。',parameters:{type:'object',properties:{ddl:{type:'string'},description:{type:'string'}},required:['ddl'],additionalProperties:false}};
const input={role:{id:'zhang',name:'小张',instructions:'仅设计隔离工作区数据库，等待独立验收。',tools:['design_database']},goal:'根据真实需求设计三表并保留约束。',context:{input:{requirements:'必须保存真实来源，未知价格保留NULL。',data:{preview:'所有原始文本均需保留。'}}},messages:[],tools:[tool]};
const response=(message,finish_reason='tool_calls',extra={})=>({model:'official-test-fixture-model',choices:[{index:0,message:{role:'assistant',...message},finish_reason}],usage:{prompt_tokens:51,completion_tokens:27,total_tokens:78},...extra});
const toolResponse=args=>response({content:null,tool_calls:[{id:'call_test_1',type:'function',function:{name:tool.name,arguments:JSON.stringify(args)}}]});

test('DashScope endpoint permits only Beijing official HTTPS compatibility URLs',()=>{
 assert.equal(resolveDashscopeEndpoint(),DEFAULT_DASHSCOPE_URL);assert.equal(resolveDashscopeEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1/'),DEFAULT_DASHSCOPE_URL);assert.equal(resolveDashscopeEndpoint('https://llm-workspace-17.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'),'https://llm-workspace-17.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
 for(const value of ['http://dashscope.aliyuncs.com/compatible-mode/v1','https://127.0.0.1/compatible-mode/v1','https://dashscope.aliyuncs.com.evil.test/compatible-mode/v1','https://user:secret@dashscope.aliyuncs.com/compatible-mode/v1','https://dashscope.aliyuncs.com:8443/compatible-mode/v1','https://dashscope.aliyuncs.com/api/v2/apps/protocols/compatible-mode/v1/responses','https://dashscope.aliyuncs.com/compatible-mode/v1?key=secret','https://dashscope-intl.aliyuncs.com/compatible-mode/v1'])assert.throws(()=>resolveDashscopeEndpoint(value),error=>error.code==='INVALID_CONFIG'&&!error.message.includes('secret'));
});

test('native Chat request preserves role, goal, full context and authorized tool schema without JSON response wrappers',()=>{
 const before=structuredClone(input),body=buildDashscopeRequest(input);assert.equal(body.model,DEFAULT_DASHSCOPE_MODEL);assert.equal(body.enable_thinking,false);assert.equal(body.parallel_tool_calls,false);assert.equal(body.max_tokens,4096);assert.equal(body.stream,false);assert.equal(body.tool_choice,'auto');assert.equal('response_format' in body,false);assert.equal('text' in body,false);assert.deepEqual(body.tools,[{type:'function',function:tool}]);
 const payload=JSON.parse(body.messages[1].content.split('\n').slice(1).join('\n'));assert.deepEqual(payload.role,input.role);assert.equal(payload.goal,input.goal);assert.deepEqual(payload.context,input.context);assert.deepEqual(input,before);
});

test('single actual native call normalizes decoded SQL once and passes existing authorization/parameter checks',()=>{
 const wire=parseDashscopeResponse(toolResponse({ddl:sql,description:'三表设计'}),input.tools);assert.equal(wire.summarySource,'tool_call_metadata');assert.equal(wire.decision.summary,'请求执行 design_database');assert.equal(wire.decision.output,'');assert.equal(wire.nativeToolCallId,'call_test_1');
 const decision=parseDecision(JSON.stringify(wire.decision),input.tools,wire.model,wire.usage);assert.equal(decision.action,'tool');assert.equal(decision.args.ddl,sql);assert.equal(decision.model,'official-test-fixture-model');assert.equal(decision.usage.input_tokens,51);assert.equal(decision.usage.output_tokens,27);assert.equal(decision.usage.total_tokens,78);
});

test('final content is the actual model finish text, preserved without truncating or inventing an execution result',()=>{
 const content='已检查真实工具回执，价格约束仍有待确认项。\n'+'x'.repeat(9000);const wire=parseDashscopeResponse(response({content},'stop'),input.tools);assert.equal(wire.summarySource,'model');assert.equal(wire.decision.action,'finish');assert.equal(wire.decision.summary,content);assert.equal(wire.decision.output,content);assert.equal(wire.decision.tool,null);
 const fake='{"action":"tool","tool":"invented_shell","args":{"command":"bad"}}';assert.equal(parseDashscopeResponse(response({content:fake},'stop'),input.tools).decision.action,'finish');
});

test('engine assistant decisions and their real receipts become paired native history while preserving original contents',()=>{
 const native={action:'tool',tool:tool.name,args:{ddl:sql},summary:'请求设计数据库',output:'',model:'test-model'};const original=JSON.stringify(native),receipt=JSON.stringify({ok:false,error:'真实SQL验收失败，必须修正NOT NULL。'});
 const body=buildDashscopeRequest({...input,messages:[{role:'assistant',content:original},{role:'tool',content:receipt}]});const assistant=body.messages[2],result=body.messages[3];assert.equal(assistant.content,original);assert.equal(assistant.tool_calls.length,1);assert.equal(assistant.tool_calls[0].function.name,tool.name);assert.equal(JSON.parse(assistant.tool_calls[0].function.arguments).ddl,sql);assert.equal(result.role,'tool');assert.equal(result.tool_call_id,assistant.tool_calls[0].id);assert.equal(result.content,receipt);
 const legacy=buildDashscopeRequest({...input,messages:[{role:'assistant',content:JSON.stringify({...native,args:undefined,args_json:JSON.stringify(native.args)})},{role:'tool',content:receipt}]});assert.equal(JSON.parse(legacy.messages[2].tool_calls[0].function.arguments).ddl,sql);
});

test('unpaired correction feedback stays labeled user data and never obtains an invented call/receipt',()=>{
 const feedback='模型格式校验失败：原始错误末尾不能丢失。';const decision=JSON.stringify({action:'tool',tool:tool.name,args:{ddl:sql},summary:'历史请求',output:''});const body=buildDashscopeRequest({...input,messages:[{role:'tool',content:feedback},{role:'assistant',content:decision}]});
 assert.equal(body.messages[2].role,'user');assert(body.messages[2].content.endsWith(feedback));assert.equal(body.messages[3].role,'user');assert(body.messages[3].content.endsWith(decision));assert.equal(body.messages.some(message=>message.role==='tool'),false);assert.equal(body.messages.some(message=>message.tool_calls),false);
});

test('multiple native calls, unknown tools, malformed JSON and nonobject arguments are rejected before execution',()=>{
 const first=toolResponse({ddl:sql});const multiple=structuredClone(first);multiple.choices[0].message.tool_calls.push(structuredClone(first.choices[0].message.tool_calls[0]));assert.throws(()=>parseDashscopeResponse(multiple,input.tools),error=>error.code==='MULTIPLE_TOOL_CALLS');
 const unknown=structuredClone(first);unknown.choices[0].message.tool_calls[0].function.name='untrusted_shell';assert.throws(()=>parseDashscopeResponse(unknown,input.tools),error=>error.code==='UNAUTHORIZED_TOOL');
 for(const args of ['{bad json','[]','null','{"__proto__":{"bad":true}}']){const bad=structuredClone(first);bad.choices[0].message.tool_calls[0].function.arguments=args;assert.throws(()=>parseDashscopeResponse(bad,input.tools),error=>error instanceof DashscopeAdapterError&&error.code==='MALFORMED_ARGUMENTS'&&!error.message.includes(args));}
});

test('shared parseDecision remains authoritative for permitted tool parameter types and extra fields',()=>{
 for(const args of [{ddl:37},{ddl:sql,unapproved:true}]){const wire=parseDashscopeResponse(toolResponse(args),input.tools);assert.throws(()=>parseDecision(JSON.stringify(wire.decision),input.tools,wire.model,wire.usage),error=>error.code==='MALFORMED_ARGUMENTS');}
});

test('truncated, filtered, empty, unsupported or multiple-choice responses cannot become successful decisions',()=>{
 for(const value of [response({content:'partial'},'length'),response({content:'blocked'},'content_filter'),response({content:''},'stop'),response({content:[{type:'text',text:'wrong format'}]},'stop'),response({content:'不能丢掉旧式调用',function_call:{name:tool.name,arguments:'{}'}},'stop'),{choices:[]},response({content:'x'},'stop',{choices:[{},{}]})])assert.throws(()=>parseDashscopeResponse(value,input.tools),error=>error.code==='MALFORMED_OUTPUT');
});

test('context and history tails are retained in full; oversized requests fail at 700KiB instead of truncating',()=>{
 const tail='必须保留的尾部验收条款',raw='原始资料'.repeat(18000)+tail;const body=buildDashscopeRequest({...input,context:{raw},messages:[{role:'tool',content:raw}]});assert(body.messages[1].content.includes(tail));assert(body.messages[2].content.endsWith(tail));assert.equal(JSON.parse(body.messages[1].content.split('\n').slice(1).join('\n')).context.raw,raw);
 assert.throws(()=>buildDashscopeRequest({...input,context:{raw:'x'.repeat(DASHSCOPE_MAX_REQUEST_BYTES)}}),error=>error.code==='CONTEXT_TOO_LARGE');
});

test('invalid or unapproved history/tool definitions are rejected and empty-tool probes use plain native finish',()=>{
 assert.throws(()=>buildDashscopeRequest({...input,tools:[tool,tool]}),error=>error.code==='INVALID_INPUT');assert.throws(()=>buildDashscopeRequest({...input,messages:[{role:'assistant',content:JSON.stringify({action:'tool',tool:'fake_tool',args:{}})},{role:'tool',content:'not real'}]}),error=>error.code==='UNAUTHORIZED_TOOL');
 const probe=buildDashscopeRequest({role:'连接检查员',goal:'仅回复连接状态',context:{},messages:[],tools:[]});assert.equal('tools' in probe,false);assert.equal('tool_choice' in probe,false);assert.equal(parseDashscopeResponse(response({content:'连接正常'},'stop'),[]).decision.output,'连接正常');
});
