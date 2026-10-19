import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProvider, parseDecision, getProxyUrl } from '../server/provider.mjs';

const tool = { name: 'inspect_network', description: 'Read network observations', parameters: { type: 'object', properties: { scope: { type: 'string', enum: ['edge', 'all'] } }, required: ['scope'], additionalProperties: false } };
const call = { action: 'tool', tool: tool.name, args_json: '{"scope":"edge"}', summary: '检查边界网络', output: '' };
const finish = { action: 'finish', tool: null, args_json: '{}', summary: '检查完成', output: '真实工具结果已交接。' };
const input = { role: { id: 'zhang', name: '小张', instructions: '只做链路检查' }, goal: '检查边界网络', context: { observations: [] }, messages: [], tools: [tool] };
const response = value => ({ ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ status: 'completed', model: 'test-model', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }], usage: { input_tokens: 12, output_tokens: 8 } }) });
const openaiEnv = { OFFICE_PROVIDER: 'openai', OFFICE_MODEL: 'test-model', OPENAI_API_KEY: 'test-only-not-a-real-key', OFFICE_MODEL_RETRIES: '0' };

test('provider returns an unverified status until a real request succeeds; health reads do not generate requests', async () => {
  let calls = 0;
  const provider = createProvider({ env: openaiEnv, fetch: async () => { calls += 1; return response(finish); }, configPath: '/not-present/office-provider.json' });
  assert.equal((await provider.getProviderStatus()).ready, false);
  assert.equal(calls, 0);
  assert.equal((await provider.getProviderStatus({ refresh: true })).ready, true);
  assert.equal(calls, 1);
  assert.equal((await provider.getProviderStatus()).model, 'test-model');
  assert.equal(calls, 1);
});

test('concurrent provider checks share one real connection probe', async () => {
  let calls = 0;
  const provider = createProvider({ env: openaiEnv, fetch: async () => { calls += 1; await new Promise(resolve => setTimeout(resolve, 15)); return response(finish); }, configPath: '/not-present/provider.json' });
  const results = await Promise.all([provider.getProviderStatus({ refresh: true }), provider.getProviderStatus({ refresh: true })]);
  assert.equal(calls, 1); assert.ok(results.every(item => item.ready));
});

test('real Responses adapter sends structured output, employee context and only a server-side API key', async () => {
  let request;
  const provider = createProvider({ env: openaiEnv, fetch: async (url, options) => { request = { url, ...options }; return response(call); }, configPath: '/not-present/provider.json' });
  const decision = await provider.decide(input);
  assert.deepEqual(decision.args, { scope: 'edge' });
  assert.equal(decision.tool, tool.name); assert.equal(decision.model, 'test-model');
  const body = JSON.parse(request.body);
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(body.store, false); assert.equal(body.text.format.strict, true);
  assert.ok(body.input.includes('只做链路检查'));
  assert.ok(body.input.includes('为外部办公服务器生成下一条调度指令'));
  assert.ok(body.input.includes('不需要、也不会注册为本 Codex 进程的原生函数'));
  assert.ok(body.input.indexOf('"availableTools"') < body.input.indexOf('"context"'));
  assert.ok(!body.input.includes(openaiEnv.OPENAI_API_KEY));
  assert.ok(!JSON.stringify(decision).includes(openaiEnv.OPENAI_API_KEY));
});

test('model may not select an unassigned tool or invalid arguments', () => {
  assert.throws(() => parseDecision(JSON.stringify({ ...call, tool: 'exec_command' }), [tool], 'model'), { code: 'UNAUTHORIZED_TOOL' });
  assert.throws(() => parseDecision(JSON.stringify({ ...call, args_json: '{}' }), [tool], 'model'), { code: 'MALFORMED_ARGUMENTS' });
  assert.throws(() => parseDecision(JSON.stringify({ ...call, args_json: '{"scope":"edge","shell":"id"}' }), [tool], 'model'), { code: 'MALFORMED_ARGUMENTS' });
  assert.throws(() => parseDecision(JSON.stringify({ ...call, args_json: '{"scope":"bad"}' }), [tool], 'model'), { code: 'MALFORMED_ARGUMENTS' });
  assert.throws(() => parseDecision(JSON.stringify({ ...finish, tool: 'inspect_network' }), [], 'model'), { code: 'MALFORMED_OUTPUT' });
  assert.throws(() => parseDecision(JSON.stringify({ ...call, args_json: '{"scope":null}' }), [tool], 'model'), error => error.code === 'MALFORMED_ARGUMENTS' && error.toolName === 'inspect_network' && !error.message.includes('scope'));
  assert.throws(() => parseDecision(JSON.stringify({ ...call, tool: 'unassigned_admin_shell', args_json: '{broken' }), [tool], 'model'), { code: 'UNAUTHORIZED_TOOL' });
});

test('malformed output and missing credentials explicitly fail without simulated decisions', async () => {
  assert.throws(() => parseDecision('not JSON', [tool], 'model'), { code: 'MALFORMED_OUTPUT' });
  let calls = 0;
  const provider = createProvider({ env: { ...openaiEnv, OPENAI_API_KEY: '' }, fetch: async () => { calls += 1; return response(finish); }, configPath: '/not-present/provider.json' });
  await assert.rejects(provider.decide(input), { code: 'AUTH_REQUIRED' });
  assert.equal(calls, 0); assert.equal((await provider.getProviderStatus()).ready, false);
});

test('transient HTTP errors have a bounded retry, authentication errors do not retry or leak raw payloads', async () => {
  let calls = 0;
  const provider = createProvider({ env: { ...openaiEnv, OFFICE_MODEL_RETRIES: '1' }, fetch: async () => { calls += 1; return calls === 1 ? { ok: false, status: 503, headers: new Map(), text: async () => 'service unavailable' } : response(call); }, configPath: '/not-present/provider.json' });
  assert.equal((await provider.decide(input)).action, 'tool'); assert.equal(calls, 2);
  const auth = createProvider({ env: { ...openaiEnv, OFFICE_MODEL_RETRIES: '1' }, fetch: async () => { calls += 1; return { ok: false, status: 401, headers: new Map(), text: async () => 'secret-token-should-not-appear' }; }, configPath: '/not-present/provider.json' });
  await assert.rejects(auth.decide(input), error => error.code === 'AUTH_REQUIRED' && !error.message.includes('secret-token'));
  assert.equal(calls, 3);
});

test('cancellation propagates into real HTTP work', async () => {
  const controller = new AbortController();
  const provider = createProvider({ env: openaiEnv, fetch: async (url, options) => new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }); }), configPath: '/not-present/provider.json' });
  const promise = provider.decide({ ...input, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, { code: 'CANCELLED' });
});

function fakeCli(events, observe) {
  return (command, args, options) => {
    observe?.({ command, args, options });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => queueMicrotask(() => child.emit('close', 1));
    let prompt = ''; child.stdin.on('data', chunk => { prompt += chunk; });
    child.stdin.on('finish', () => queueMicrotask(() => {
      observe?.({ prompt, stdinEnded: true });
      for (const event of events) child.stdout.write(`${JSON.stringify(event)}\n`);
      child.stdout.end(); child.emit('close', 0);
    }));
    return child;
  };
}

test('Codex adapter closes stdin, isolates cwd, disables native execution and parses only final decision', async () => {
  const observed = []; const activity = [];
  const provider = createProvider({ env: { OFFICE_PROVIDER: 'codex', OFFICE_MODEL: 'test-model', HTTPS_PROXY: 'http://127.0.0.1:7897', OFFICE_MODEL_RETRIES: '0' }, configPath: '/not-present/provider.json', spawn: fakeCli([
    { type: 'thread.started' }, { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'reasoning', text: 'private reasoning should not be exposed' } },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(call) } },
    { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 5 } },
  ], item => observed.push(item)) });
  const decision = await provider.decide({ ...input, onActivity: item => activity.push(item) });
  assert.equal(decision.action, 'tool'); assert.equal(observed[1].stdinEnded, true);
  assert.ok(observed[0].args.includes('--ignore-user-config')); assert.ok(observed[0].args.includes('read-only'));
  assert.ok(observed[0].args.includes('features.shell_tool=false')); assert.ok(observed[0].args.includes('features.plugins=false'));
  assert.ok(observed[0].options.cwd.startsWith(tmpdir()));
  assert.equal(observed[0].options.env.HTTPS_PROXY, 'http://127.0.0.1:7897');
  assert.ok(activity.every(item => item.type === 'status'));
  assert.ok(!JSON.stringify(activity).includes('private reasoning'));
});

test('unexpected native tool events terminate the Codex response instead of reporting success', async () => {
  const provider = createProvider({ env: { OFFICE_PROVIDER: 'codex', OFFICE_MODEL: 'test-model', OFFICE_MODEL_RETRIES: '0', HTTPS_PROXY: 'http://127.0.0.1:7897' }, configPath: '/not-present/provider.json', spawn: fakeCli([
    { type: 'item.started', item: { type: 'command_execution', command: 'id' } },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(finish) } }, { type: 'turn.completed' },
  ]) });
  await assert.rejects(provider.decide(input), { code: 'NATIVE_TOOL_BLOCKED' });
});

test('Codex stdout preserves Chinese and emoji when UTF-8 characters cross chunk boundaries', async () => {
  const expected = { ...finish, summary: '财务交接完成 🧾', output: '年度财务汇报：收入与现金已核对。' };
  const provider = createProvider({ env: { OFFICE_PROVIDER: 'codex', OFFICE_MODEL: 'test-model', OFFICE_MODEL_RETRIES: '0', HTTPS_PROXY: 'http://127.0.0.1:7897' }, configPath: '/not-present/provider.json', spawn: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => queueMicrotask(() => child.emit('close', 1));
    child.stdin.resume();
    child.stdin.on('finish', () => queueMicrotask(() => {
      const bytes = Buffer.from(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(expected) } })}\n${JSON.stringify({ type: 'turn.completed' })}`);
      // One-byte writes split every three-byte Chinese and four-byte emoji character.
      // The final event deliberately has no newline to exercise decoder flushing too.
      for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
      child.stdout.end(); child.emit('close', 0);
    }));
    return child;
  } });
  const decision = await provider.decide(input);
  assert.equal(decision.summary, expected.summary);
  assert.equal(decision.output, expected.output);
  assert.ok(!decision.output.includes('\uFFFD'));
});

test('oversized Codex prompts fail before spawning a process or waiting for stdin', async () => {
  let spawns = 0;
  const provider = createProvider({ env: { OFFICE_PROVIDER: 'codex', OFFICE_MODEL: 'test-model', OFFICE_MODEL_RETRIES: '0', HTTPS_PROXY: 'http://127.0.0.1:7897' }, configPath: '/not-present/provider.json', spawn: () => { spawns += 1; throw new Error('must not spawn'); } });
  await assert.rejects(provider.decide({ ...input, context: { upload: 'x'.repeat(750 * 1024) } }), { code: 'CONTEXT_TOO_LARGE' });
  assert.equal(spawns, 0);
  assert.equal((await provider.getProviderStatus()).ready, false);
});

test('local config rejects stored secrets, Ollama stays on loopback and never downloads a model', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'office-provider-test-'));
  try {
    const configPath = path.join(directory, 'provider.json');
    await writeFile(configPath, JSON.stringify({ provider: 'openai', apiKey: 'do-not-store' }));
    const provider = createProvider({ env: {}, configPath });
    assert.equal((await provider.getProviderStatus()).ready, false);
    await assert.rejects(provider.decide(input), { code: 'INVALID_CONFIG' });
    await writeFile(configPath, JSON.stringify({ provider: 'ollama', model: 'existing-model', ollamaBase: 'http://example.com:11434' }));
    await assert.rejects(provider.decide(input), { code: 'INVALID_CONFIG' });
    await writeFile(configPath, JSON.stringify({ provider: 'ollama', model: 'existing-model' }));
    let url;
    const ollama = createProvider({ env: {}, configPath, fetch: async (target, options) => { url = target; assert.equal(JSON.parse(options.body).model, 'existing-model'); return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ model: 'existing-model', message: { content: JSON.stringify(call) } }) }; } });
    assert.equal((await ollama.decide(input)).action, 'tool'); assert.equal(url, 'http://127.0.0.1:11434/api/chat');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const ollamaEnv = { OFFICE_PROVIDER: 'ollama', OFFICE_MODEL: 'existing-model', OFFICE_MODEL_RETRIES: '0', OFFICE_OLLAMA_CONTEXT: '8192' };
const ollamaResponse = (decision, extra = {}) => ({ ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ model: 'existing-model', message: { content: JSON.stringify(decision) }, done: true, done_reason: 'stop', ...extra }) });

test('Ollama constrains tool output and short handoffs without removing source evidence or tool schemas', async () => {
  let body;
  const context = { input: { requirements: '原始要求：邮箱唯一。' + '证据'.repeat(1800) + '原文末尾保留' }, taskProgress: { remainingRequiredTools: ['inspect_network'] } };
  const messages = [{ role: 'tool', content: '真实回执：没有原始日志，不能宣称恢复。' }];
  const provider = createProvider({ env: ollamaEnv, configPath: '/not-present/provider.json', fetch: async (url, options) => { body = JSON.parse(options.body); return ollamaResponse(call); } });
  await provider.decide({ ...input, role: { ...input.role, color: '#fff', tools: ['unrelated_global_tool'] }, context, messages });
  assert.equal(body.think, false); assert.equal(body.options.num_ctx, 8192); assert.equal(body.options.num_predict, 768);
  assert.ok(body.messages[0].content.includes('output必须为空字符串'));
  assert.ok(!body.messages[0].content.includes('不需要、也不会注册为本 Codex'));
  assert.ok(!body.messages[0].content.includes('unrelated_global_tool'));
  const serialized = body.messages[0].content.split('\n\n')[1];
  const payload = JSON.parse(serialized);
  assert.deepEqual(payload.context, context); assert.deepEqual(payload.conversation, messages); assert.deepEqual(payload.availableTools, input.tools);
  assert.equal(payload.employee.instructions, input.role.instructions);
  const [dispatch, handoff] = body.format.oneOf;
  assert.equal(dispatch.properties.output.const, ''); assert.equal(dispatch.properties.summary.maxLength, 100);
  assert.equal(dispatch.properties.tool.const, 'inspect_network');
  assert.deepEqual(dispatch.properties.args, tool.parameters);
  assert.ok(!Object.hasOwn(dispatch.properties, 'args_json'));
  assert.deepEqual(handoff.properties.args.properties, {});
  assert.equal(handoff.properties.args.additionalProperties, false); assert.equal(handoff.properties.output.maxLength, 700);
});

test('Ollama decoding budgets reflect requirements, executable content and evidence handoffs', async () => {
  const requests = [];
  const provider = createProvider({ env: ollamaEnv, configPath: '/not-present/provider.json', fetch: async (url, options) => { requests.push(JSON.parse(options.body)); return ollamaResponse(finish); } });
  const named = name => ({ ...tool, name });
  await provider.decide({ ...input, tools: [named('extract_requirements')] });
  await provider.decide({ ...input, tools: [named('write_report')] });
  await provider.decide({ ...input, tools: [named('test_database')] });
  await provider.decide({ ...input, context: { taskProgress: { remainingRequiredTools: [] } } });
  await provider.decide({ ...input, tools: [] });
  assert.deepEqual(requests.map(request => request.options.num_predict), [2048, 2048, 1536, 768, 768]);
  assert.equal(requests.at(-1).format.properties.action.const, 'finish');
});

test('Ollama rejects verbose or incomplete dispatches and retains authorization and argument validation', async () => {
  async function rejects(decision, code, extra) {
    const provider = createProvider({ env: ollamaEnv, configPath: '/not-present/provider.json', fetch: async () => ollamaResponse(decision, extra) });
    await assert.rejects(provider.decide(input), { code });
  }
  await rejects({ ...call, output: '不能在工具调度里重复正文' }, 'MALFORMED_OUTPUT');
  await rejects({ ...finish, output: '文'.repeat(701) }, 'MALFORMED_OUTPUT');
  await rejects({ ...call, summary: '文'.repeat(101) }, 'MALFORMED_OUTPUT');
  await rejects({ ...finish, args_json: '{"unexpected":"value"}' }, 'MALFORMED_OUTPUT');
  await rejects({ ...call, tool: 'unassigned_tool' }, 'UNAUTHORIZED_TOOL');
  await rejects({ ...call, args_json: '{"scope":"bad"}' }, 'MALFORMED_ARGUMENTS');
  await rejects(call, 'INCOMPLETE_OUTPUT', { done_reason: 'length' });
});

test('Ollama native args preserve quoted multiline SQL and nested parameters through the shared validator', async () => {
  const sql = 'INSERT INTO "customers" ("name", "note")\nVALUES (\'O\'\'Reilly\', \'第一行\\第二行\');';
  const definition = { name: 'test_database', description: 'Execute checked SQL tests', parameters: { type: 'object', additionalProperties: false, properties: {
    tests: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, sql: { type: 'string' }, expectError: { type: 'boolean' }, params: { type: 'array', items: { type: ['string', 'number', 'null'] } } }, required: ['name', 'sql', 'expectError', 'params'] } },
    queries: { type: 'array', items: { type: 'string' } },
  }, required: ['tests'] } };
  const args = { tests: [{ name: '含引号与换行的真实SQL', sql, expectError: false, params: ['O\'Reilly', 7, null] }], queries: ['SELECT "name" FROM "customers";'] };
  let request;
  const provider = createProvider({ env: ollamaEnv, configPath: '/not-present/provider.json', fetch: async (url, options) => { request = JSON.parse(options.body); return ollamaResponse({ action: 'tool', tool: 'test_database', args, summary: '执行约束验证', output: '' }); } });
  const decision = await provider.decide({ ...input, tools: [definition] });
  assert.deepEqual(decision.args, args); assert.equal(decision.args.tests[0].sql, sql);
  assert.deepEqual(request.format.oneOf[0].properties.args, definition.parameters);
  assert.equal(request.format.oneOf[0].properties.tool.const, 'test_database');
  assert.ok(request.messages[0].content.includes('不要生成args_json字段'));
  const invalid = createProvider({ env: ollamaEnv, configPath: '/not-present/provider.json', fetch: async () => ollamaResponse({ action: 'tool', tool: 'test_database', args: { ...args, tests: [{ ...args.tests[0], unauthorized: true }] }, summary: '执行约束验证', output: '' }) });
  await assert.rejects(invalid.decide({ ...input, tools: [definition] }), { code: 'MALFORMED_ARGUMENTS' });
});

test('Ollama native argument branches grant no extra tools or unknown fields', async () => {
  const native = { action: 'tool', tool: 'inspect_network', args: { scope: 'edge' }, summary: '检查网络', output: '' };
  async function decide(value) {
    const provider = createProvider({ env: ollamaEnv, configPath: '/not-present/provider.json', fetch: async () => ollamaResponse(value) });
    return provider.decide(input);
  }
  await assert.rejects(decide({ ...native, tool: 'unassigned_admin_tool' }), { code: 'UNAUTHORIZED_TOOL' });
  await assert.rejects(decide({ ...native, args: { scope: 'edge', shell: 'id' } }), { code: 'MALFORMED_ARGUMENTS' });
  await assert.rejects(decide({ ...native, args: { scope: 'unknown' } }), { code: 'MALFORMED_ARGUMENTS' });
  await assert.rejects(decide({ ...native, args: [] }), { code: 'MALFORMED_ARGUMENTS' });
  await assert.rejects(decide({ ...native, unauthorized: true }), { code: 'MALFORMED_OUTPUT' });
  await assert.rejects(decide({ ...native, args_json: '{"scope":"all"}' }), { code: 'MALFORMED_OUTPUT' });
  const completed = await decide({ action: 'finish', tool: null, args: {}, summary: '检查结束', output: '保留实际证据。' });
  assert.deepEqual(completed.args, {});
  await assert.rejects(decide({ action: 'finish', tool: null, args: { scope: 'all' }, summary: '检查结束', output: '' }), { code: 'MALFORMED_OUTPUT' });
});

test('Ollama requires complete sourced requirement rows without mutating the shared tool contract or input', async () => {
  const definition = { name: 'extract_requirements', parameters: { type: 'object', additionalProperties: false, properties: { requirements: { type: 'array', items: { type: 'object', additionalProperties: false, properties: Object.fromEntries(['id', 'description', 'source', 'acceptance'].map(key => [key, { type: 'string', description: key }])) } } } } };
  const original = structuredClone(definition);
  const context = { input: { requirements: '完整公司背景和业务原文' + '保留'.repeat(1200) + '原文末项' } };
  let body;
  const provider = createProvider({ env: ollamaEnv, configPath: '/not-present/provider.json', fetch: async (url, options) => { body = JSON.parse(options.body); return ollamaResponse(finish); } });
  await provider.decide({ ...input, tools: [definition], context });
  const schema = body.format.oneOf[0].properties.args;
  assert.deepEqual(schema.required, ['requirements']);
  assert.deepEqual(schema.properties.requirements.items.required, ['id', 'description', 'source', 'acceptance']);
  assert.equal(schema.properties.requirements.items.properties.description.maxLength, 80);
  assert.equal(schema.properties.requirements.items.properties.acceptance.maxLength, 80);
  assert.equal(schema.properties.requirements.items.properties.source.maxLength, 600);
  assert.deepEqual(definition, original);
  assert.equal(JSON.parse(body.messages[0].content.split('\n\n')[1]).context.input.requirements, context.input.requirements);
});

test('Ollama requires a real-success progress receipt before constraining the model to a handoff', async () => {
  const completedContext = { taskProgress: { remainingRequiredTools: [], successfulTools: ['inspect_network'], lastToolError: null } };
  const receipts = [{ role: 'tool', content: '{"ok":true,"evidence":{"parsedRequests":20}}' }];
  const bodies = [];
  let reply = { action: 'finish', tool: null, args: {}, summary: '检查完成', output: '已解析20条请求，交给安全审校。' };
  const provider = createProvider({ env: ollamaEnv, configPath: '/not-present/provider.json', fetch: async (url, options) => { bodies.push(JSON.parse(options.body)); return ollamaResponse(reply); } });
  const handoff = await provider.decide({ ...input, context: completedContext, messages: receipts });
  assert.equal(handoff.output, reply.output);
  assert.equal(bodies.at(-1).format.properties.action.const, 'finish');
  assert.ok(bodies.at(-1).messages[0].content.includes('当前岗位要求的工具已经有真实成功回执'));
  await provider.decide({ ...input, context: completedContext, messages: [] });
  assert.ok(bodies.at(-1).format.oneOf);
  await provider.decide({ ...input, context: { taskProgress: { ...completedContext.taskProgress, successfulTools: [] } }, messages: receipts });
  assert.ok(bodies.at(-1).format.oneOf);
  await provider.decide({ ...input, context: { taskProgress: { ...completedContext.taskProgress, lastToolError: '后续工具失败' } }, messages: receipts });
  assert.ok(bodies.at(-1).format.oneOf);
  reply = { ...call, args: { scope: 'edge' } }; delete reply.args_json;
  await assert.rejects(provider.decide({ ...input, context: completedContext, messages: receipts }), { code: 'MALFORMED_OUTPUT' });
});

test('Ollama procurement research can fetch additional sources after its first successful receipts', async () => {
  const fetchTool = { name: 'fetch_quote', parameters: { type: 'object', properties: { url: { type: 'string' } }, additionalProperties: false } };
  const context = { taskProgress: { remainingRequiredTools: [], successfulTools: ['fetch_quote'], lastToolError: null } };
  const messages = [{ role: 'tool', content: '{"ok":true,"evidence":{"quotes":[{"sourceUrl":"https://first.example/product"}]}}' }];
  let body;
  const provider = createProvider({ env: ollamaEnv, configPath: '/not-present/provider.json', fetch: async (url, options) => { body = JSON.parse(options.body); return ollamaResponse({ action: 'tool', tool: 'fetch_quote', args: { url: 'https://second.example/product' }, summary: '补充抓取指定来源', output: '' }); } });
  const decision = await provider.decide({ ...input, tools: [fetchTool], context, messages });
  assert.equal(decision.tool, 'fetch_quote');
  assert.equal(body.format.oneOf[0].properties.tool.const, 'fetch_quote');
});

test('Ollama requires executable SQL, complete test rows and a bounded real report body', async () => {
  const string = { type: 'string' };
  const definitions = [
    { name: 'design_database', parameters: { type: 'object', properties: { ddl: string, description: string, assumptions: { type: 'array', items: string } }, additionalProperties: false } },
    { name: 'test_database', parameters: { type: 'object', properties: { tests: { type: 'array', items: { type: 'object', properties: { name: string, sql: string, expectError: { type: 'boolean' } }, additionalProperties: false } } }, additionalProperties: false } },
    { name: 'write_report', parameters: { type: 'object', properties: { title: string, content: string }, additionalProperties: false } },
  ];
  const originals = structuredClone(definitions);
  let body;
  const provider = createProvider({ env: ollamaEnv, configPath: '/not-present/provider.json', fetch: async (url, options) => { body = JSON.parse(options.body); return ollamaResponse(finish); } });
  await provider.decide({ ...input, tools: definitions });
  const [design, tests, report] = body.format.oneOf.map(branch => branch.properties.args);
  assert.deepEqual(design.required, ['ddl']);
  assert.equal(design.properties.description.maxLength, 80);
  assert.equal(design.properties.assumptions.maxItems, 3);
  assert.deepEqual(tests.required, ['tests']);
  assert.deepEqual(tests.properties.tests.items.required, ['name', 'sql', 'expectError']);
  assert.deepEqual(report.required, ['title', 'content']);
  assert.equal(report.properties.content.minLength, 100);
  assert.equal(report.properties.content.maxLength, 1000);
  assert.deepEqual(definitions, originals);
});

test('proxy helper respects an existing application environment without exposing credentials', async () => {
  assert.equal(await getProxyUrl({ env: { HTTPS_PROXY: 'http://localhost:7897' } }), 'http://localhost:7897/');
  assert.equal(await getProxyUrl({ env: { HTTPS_PROXY: 'file:///tmp/not-proxy' } }), null);
});
