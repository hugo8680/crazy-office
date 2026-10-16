import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS, NODES, SCENARIOS, Simulation } from '../dist/simulation.js';

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
