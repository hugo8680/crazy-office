import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS, AGENT_TOOLSETS, DEFAULT_AGENT_CONFIGS, NODES, SCENARIOS, Simulation } from '../src/simulation.js';

function toApproval(sim) {
  sim.start();
  sim.advance(500);
  assert.equal(sim.getState().status, 'awaiting_approval');
}

function finish(sim, approved = true) {
  toApproval(sim);
  sim.approve(approved);
  sim.advance(500);
  return sim.getState();
}

test('three incidents have complete, dependency-respecting recovery and a JSON evidence report', () => {
  for (const scenario of SCENARIOS) {
    const sim = new Simulation(scenario.id);
    const final = finish(sim);
    assert.equal(final.status, 'completed', scenario.id);
    assert.equal(final.phase, 'complete');
    assert.equal(final.metrics.availability, 100);
    assert.equal(final.metrics.healthyNodes, NODES.length);
    assert.equal(final.result.cost, scenario.budget);
    assert.equal(final.result.fullyRestored, true);
    assert.ok(final.maxConcurrent >= 4, 'diagnosis should involve real parallel tasks');
    assert.ok(final.result.serialWorkSeconds > final.elapsed);
    assert.equal(final.tasks.length, final.result.completedTasks);
    for (const task of final.tasks) {
      assert.equal(task.status, 'done');
      assert.equal(task.progress, 1);
      assert.ok(task.result.length > 0);
      for (const dependency of task.dependencies) {
        const predecessor = final.tasks.find((item) => item.id === dependency);
        assert.ok(task.startedAt >= predecessor.finishedAt, `${scenario.id}: ${task.id} ran before ${dependency}`);
      }
    }
    for (const agent of AGENTS) assert.ok(final.tasks.some((t) => t.ownerId === agent.id && t.status === 'done'));
    const report = JSON.parse(JSON.stringify(sim.exportReport()));
    assert.equal(report.status, 'completed');
    assert.equal(report.scenario.id, scenario.id);
    assert.ok(report.timeline.some((event) => event.type === 'handoff'));
    assert.ok(report.result.verifiedChecks.length >= 2);
    assert.match(report.disclaimer, /模拟/);
  }
});

test('approval freezes the network and budget work; a decision is required to recover', () => {
  const sim = new Simulation('power');
  toApproval(sim);
  const waiting = sim.getState();
  assert.equal(waiting.approval.amount, 1600);
  assert.equal(waiting.approval.fromAgentId, 'finance');
  assert.equal(waiting.tasks.find((t) => t.id === 'quote').status, 'done');
  assert.equal(waiting.tasks.find((t) => t.id === 'priority').status, 'done');
  assert.equal(waiting.tasks.find((t) => t.id === 'repair').status, 'pending');
  sim.advance(100);
  sim.resume();
  assert.deepEqual(sim.getState(), waiting);
  sim.approve(true);
  const approved = sim.getState();
  assert.equal(approved.approval, null);
  assert.equal(approved.tasks.find((t) => t.id === 'repair').status, 'running');
  assert.equal(approved.nodes.ups.status, 'recovering');
});

test('rejecting each budget takes a slower local path, costs zero, and preserves its actual limitation', () => {
  for (const scenario of SCENARIOS) {
    const standard = finish(new Simulation(scenario.id));
    const fallback = finish(new Simulation(scenario.id), false);
    assert.equal(fallback.status, 'completed');
    assert.equal(fallback.result.cost, 0);
    assert.equal(fallback.result.mode, 'local_fallback');
    assert.equal(fallback.result.fullyRestored, false);
    assert.ok(fallback.elapsed > standard.elapsed);
    assert.ok(fallback.metrics.healthyNodes < NODES.length);
    assert.ok(fallback.result.remainingRisk.length > 15);
    if (scenario.id === 'power') {
      assert.equal(fallback.nodes.meeting.status, 'offline');
      assert.equal(fallback.nodes.workstations.status, 'online');
      assert.ok(fallback.metrics.availability < 100);
      assert.match(fallback.result.remainingRisk, /20 分钟/);
    }
    if (scenario.id === 'switch') {
      assert.equal(fallback.nodes.meeting.status, 'warning');
      assert.equal(fallback.nodes.workstations.status, 'online');
    }
    if (scenario.id === 'ddos') {
      assert.equal(fallback.nodes.internet.status, 'warning');
      assert.equal(fallback.nodes.server.status, 'online');
      assert.match(fallback.result.remainingRisk, /上游/);
    }
  }
});

test('hardware faults propagate to dependent areas and recovery follows power, storage, then application', () => {
  const sim = new Simulation('power');
  sim.start();
  const initial = sim.getState();
  assert.equal(initial.nodes.internet.status, 'online');
  assert.equal(initial.nodes.ups.status, 'offline');
  assert.equal(initial.nodes.workstations.status, 'offline');
  assert.equal(initial.metrics.affectedUsers, 80);
  sim.advance(500);
  sim.approve(true);
  sim.advance(9);
  const powerRestored = sim.getState();
  assert.equal(powerRestored.nodes.ups.status, 'online');
  assert.equal(powerRestored.tasks.find((t) => t.id === 'application').status, 'pending');
  assert.equal(powerRestored.nodes.server.status, 'offline');
  sim.advance(7);
  const coreAndStorageReady = sim.getState();
  assert.equal(coreAndStorageReady.nodes.core.status, 'online');
  assert.equal(coreAndStorageReady.nodes.storage.status, 'online');
  assert.equal(coreAndStorageReady.tasks.find((t) => t.id === 'application').status, 'running');
  assert.equal(coreAndStorageReady.nodes.server.status, 'recovering');
  sim.advance(5);
  assert.equal(sim.getState().nodes.workstations.status, 'online');
});

test('agents own one task at a time, exchange evidence, and diagnosis runs in parallel', () => {
  const sim = new Simulation('ddos');
  sim.start();
  sim.advance(3);
  const concurrent = sim.getState().tasks.filter((t) => t.status === 'running');
  assert.ok(concurrent.length >= 4);
  assert.equal(new Set(concurrent.map((t) => t.ownerId)).size, concurrent.length);
  assert.equal(sim.getState().tasks.find((t) => t.id === 'plan').status, 'pending');
  const final = finish(new Simulation('ddos'));
  const plan = final.tasks.find((t) => t.id === 'plan');
  for (const evidenceId of ['network', 'security', 'rack', 'impact']) {
    assert.ok(final.tasks.find((t) => t.id === evidenceId).finishedAt <= plan.startedAt);
  }
  assert.ok(final.logs.some((log) => log.type === 'handoff' && log.targetAgentId === 'finance'));
  assert.ok(final.logs.some((log) => log.type === 'approval' && log.agentId === 'finance' && log.targetAgentId === 'boss'));
});

test('pause freezes all work, speed is caller-controlled, reset clears incident evidence', () => {
  const sim = new Simulation();
  sim.start();
  sim.advance(4);
  sim.pause();
  const paused = sim.getState();
  sim.advance(50);
  assert.deepEqual(sim.getState(), paused);
  sim.setSpeed(4);
  sim.resume();
  sim.advance(1);
  assert.equal(sim.getState().elapsed, 5, 'advance receives already-scaled simulation seconds');
  sim.reset();
  const idle = sim.getState();
  assert.equal(idle.status, 'idle');
  assert.equal(idle.elapsed, 0);
  assert.equal(idle.logs.length, 0);
  assert.equal(idle.approval, null);
  assert.equal(idle.result, null);
  assert.equal(idle.metrics.availability, 100);
  assert.equal(idle.maxConcurrent, 0);
  assert.ok(idle.tasks.every((t) => t.status === 'pending' && t.progress === 0));
  assert.equal(idle.speed, 4);
});

test('state snapshots are isolated, subscriptions unsubscribe, and switching scenarios resets state', () => {
  const sim = new Simulation();
  let calls = 0;
  const unsubscribe = sim.subscribe(() => { calls++; });
  assert.equal(calls, 1);
  const snapshot = sim.getState();
  snapshot.nodes.core.status = 'offline';
  snapshot.agents[0].name = 'mutated';
  assert.equal(sim.getState().nodes.core.status, 'online');
  assert.notEqual(sim.getState().agents[0].name, 'mutated');
  sim.start();
  assert.equal(calls, 2);
  unsubscribe();
  sim.advance(1);
  assert.equal(calls, 2);
  sim.selectScenario('switch');
  assert.equal(sim.getState().status, 'idle');
  assert.equal(sim.getState().logs.length, 0);
  assert.equal(sim.getState().scenarioId, 'switch');
  assert.throws(() => sim.selectScenario('invalid'), /Unknown scenario/);
  assert.throws(() => sim.setSpeed(3), /speed/);
  assert.throws(() => sim.advance(-1), /non-negative/);
});

test('role configuration is preserved across reset and scenario changes, and logs keep stable identities', () => {
  const sim = new Simulation();
  sim.configureAgent('zhang', { name: '网络队长小橙', role: '链路诊断 Agent', instructions: '先采集证据，再恢复连接；不执行自由文本。', configured: true });
  const final = finish(sim);
  const actions = final.logs.filter((event) => event.agentId === 'zhang' && event.type === 'action');
  assert.ok(actions.length > 0);
  assert.ok(actions.every((event) => event.agentName === '网络队长小橙' && event.role === '链路诊断 Agent'));
  assert.ok(actions.every((event) => event.toolId && event.toolName && event.taskId && event.instructions.includes('先采集证据')));
  assert.ok(final.tasks.some((task) => task.ownerId === 'zhang'));
  sim.reset();
  assert.equal(sim.getState().agents.find((agent) => agent.id === 'zhang').name, '网络队长小橙');
  sim.selectScenario('power');
  const config = sim.getState().agentConfigs.find((agent) => agent.id === 'zhang');
  assert.equal(config.configured, true);
  assert.equal(config.role, '链路诊断 Agent');
  assert.equal(sim.exportReport().agentConfigs.find((agent) => agent.id === 'zhang').instructions, config.instructions);
});

test('missing required tool permissions block start and restore to an executable graph when enabled', () => {
  const sim = new Simulation('ddos');
  const liu = DEFAULT_AGENT_CONFIGS.find((agent) => agent.id === 'liu');
  sim.configureAgent('liu', { tools: liu.tools.filter((id) => id !== 'traffic_defense') });
  const validation = sim.validateConfiguration();
  assert.equal(validation.ready, false);
  assert.ok(validation.errors.some((error) => error.agentId === 'liu' && error.missingTools?.includes('traffic_defense')));
  sim.start();
  assert.equal(sim.getState().status, 'idle');
  assert.equal(sim.getState().logs.length, 0);
  assert.ok(sim.getState().configurationErrors.length > 0);
  assert.equal(sim.getState().nodes.server.status, 'online', 'blocked start must not inject a fault');
  sim.configureAgent('liu', { tools: liu.tools });
  assert.equal(sim.validateConfiguration().ready, true);
  assert.equal(finish(sim).status, 'completed');
});

test('role capabilities cannot be forged by renaming, free instructions, or cross-role tools', () => {
  const sim = new Simulation();
  assert.throws(() => sim.configureAgent('finance', { tools: ['traffic_defense'] }), /工具/);
  assert.throws(() => sim.configureAgent('liu', { name: ' ' }), /name/);
  assert.throws(() => sim.configureAgent('liu', { instructions: '' }), /instructions/);
  assert.throws(() => sim.configureAgent('lead', { collaborators: ['unknown'] }), /协作对象/);
  assert.throws(() => sim.configureAgent('lead', { collaborators: ['lead'] }), /协作对象/);
  sim.start();
  assert.throws(() => sim.configureAgent('zhang', { name: '忙碌时改名' }), /待命/);
  assert.throws(() => sim.setTeam(['zhang']), /待命/);
});

test('a required cross-agent handoff is a real permission and is included in the exported configuration', () => {
  const sim = new Simulation();
  const lead = DEFAULT_AGENT_CONFIGS.find((agent) => agent.id === 'lead');
  sim.configureAgent('lead', { collaborators: lead.collaborators.filter((id) => id !== 'zhang') });
  assert.equal(sim.validateConfiguration().ready, false);
  assert.ok(sim.validateConfiguration().errors.some((error) => error.agentId === 'lead' && error.missingCollaborators?.includes('zhang')));
  assert.equal(sim.start().status, 'idle');
  sim.configureAgent('lead', { collaborators: lead.collaborators });
  finish(sim);
  const report = sim.exportReport();
  for (const handoff of report.timeline.filter((event) => event.type === 'handoff')) {
    assert.ok(report.agentConfigs.find((config) => config.id === handoff.agentId).collaborators.includes(handoff.targetAgentId));
  }
  for (const action of report.timeline.filter((event) => event.type === 'action')) {
    assert.ok(report.agentConfigs.find((config) => config.id === action.agentId).tools.includes(action.toolId));
    assert.ok(AGENT_TOOLSETS[action.agentId].some((tool) => tool.id === action.toolId));
  }
});

test('scenario-specific teams change real owners and forbid paid recovery without both optional management roles', () => {
  for (const scenario of SCENARIOS) {
    const sim = new Simulation(scenario.id);
    sim.setTeam(scenario.recommendedAgents);
    assert.equal(sim.validateConfiguration().ready, true, scenario.id);
    const configured = sim.getState();
    assert.ok(configured.tasks.every((task) => scenario.recommendedAgents.includes(task.ownerId)));
    assert.ok(!configured.tasks.some((task) => ['quote', 'priority', 'reconcile'].includes(task.id)));
    toApproval(sim);
    assert.equal(sim.getState().approval.canApprovePaid, false);
    assert.equal(sim.getState().approval.amount, 0);
    sim.approve(true); // A caller cannot bypass the lack of a financial approval chain.
    sim.advance(500);
    const final = sim.getState();
    assert.equal(final.status, 'completed');
    assert.equal(final.result.cost, 0);
    assert.equal(final.result.mode, 'local_fallback');
    assert.ok(final.logs.every((event) => scenario.recommendedAgents.includes(event.agentId)));
    assert.ok(final.logs.filter((event) => event.targetAgentId).every((event) => scenario.recommendedAgents.includes(event.targetAgentId)));
    assert.equal(final.result.businessConfirmed, scenario.recommendedAgents.includes('business'));
    if (scenario.id === 'ddos') assert.equal(final.tasks.find((task) => task.id === 'rack').ownerId, 'zhang');
    if (scenario.id === 'switch') assert.equal(final.tasks.find((task) => task.id === 'security').ownerId, 'zhang');
    if (scenario.id === 'power') {
      assert.equal(final.tasks.find((task) => task.id === 'businessCheck').ownerId, 'lead');
      assert.match(final.tasks.find((task) => task.id === 'businessCheck').result, /尚缺业务用户侧确认/);
      assert.match(final.result.remainingRisk, /尚缺业务用户侧确认/);
    }
    sim.reset();
    assert.deepEqual(sim.getState().selectedAgentIds, scenario.recommendedAgents);
  }
});

test('missing role skills identify recommended specialists while compatible backup roles can cover storage', () => {
  const sim = new Simulation('ddos');
  sim.setTeam(['lead', 'zhang', 'business']);
  const validation = sim.validateConfiguration();
  assert.equal(validation.ready, false);
  assert.ok(validation.errors.some((error) => error.missingSkills && error.recommendedAgents.includes('liu')));
  assert.equal(sim.start().status, 'idle');
  sim.selectScenario('power');
  sim.setTeam(['lead', 'zhang', 'ops']);
  assert.equal(sim.validateConfiguration().ready, true);
  assert.equal(sim.getState().tasks.find((task) => task.id === 'storageCheck').ownerId, 'ops');
  const final = finish(sim, false);
  assert.equal(final.status, 'completed');
  assert.ok(final.maxConcurrent >= 2);
  assert.ok(final.tasks.every((task) => task.ownerId !== 'liu' && task.ownerId !== 'business'));
});
