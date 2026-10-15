import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runFoundationDemo } from '@aether/harness-cli';
import { RunManifestSchema } from '@aether/harness/evaluation';
import { readContract, writeContract } from '@aether/harness/orchestration';
import { safetyFixture, taskFixture } from './fixtures.js';
import { err, ok, removeRoot, setup, tempRoot } from './workspace-support.js';

test('M6-1 the foundation readiness demo passes every check', async () => {
  const directory = await tempRoot();
  try {
    const report = await runFoundationDemo(directory);
    assert.deepEqual(report.checks.map(item => item.id), [
      'aether_adapter', 'arms_same_schedule', 'baseline_adapter', 'caveat_dropper', 'diagnostics', 'equal_operations', 'history_isolation',
      'ingest', 'noninterference', 'offline_evaluation', 'preflight', 'run_manifest', 'token_budget', 'usage_ledger',
    ]);
    assert.ok(report.passed, JSON.stringify(report.checks.filter(item => item.status === 'fail')));
  } finally { await removeRoot(directory); }
});

test('M6-7 the trusted artifact slot validates contracts and is closed once the workspace is frozen', async () => {
  const root = await tempRoot();
  const store = await setup(root, ['ws-a']);
  try {
    const contract = {
      schemaVersion: 1, id: 'contract-1', taskId: taskFixture().id, objective: 'Shorten', preserve: [], protect: [], allow: [], avoid: [],
      autonomy: 'edit_candidate', successCriteria: [],
    };
    assert.deepEqual(await writeContract(store, 'ws-a', { ...contract, hidden: 1 }), { ok: false, code: 'invalid_artifact' });
    assert.deepEqual(await writeContract(store, 'ws-a', { ...contract, taskId: 'other-task' }), { ok: false, code: 'task_mismatch' });
    assert.deepEqual(await writeContract(store, 'ws-a', contract), { ok: true });
    assert.deepEqual(await readContract(store, 'ws-a'), contract);
    ok(await store.freezeSubmission('ws-a'));
    err(await store.writeOrchestrationArtifact('ws-a', 'contract', contract), 'workspace_not_open');
  } finally { await store.close(); await removeRoot(root); }
});

test('M6-5/6 ledger rejects invalid events; the run manifest schema is strict', async () => {
  const root = await tempRoot();
  const store = await setup(root, ['ws-a']);
  try {
    err(await store.appendLedgerEvent('ws-a', { kind: 'model', stage: '', requestDigest: 'x' } as never), 'invalid_input');
    ok(await store.appendLedgerEvent('ws-a', { kind: 'runtime', stage: 'compile', wallMs: 3, cpuMs: null }));
    assert.deepEqual(ok(await store.readLedger('ws-a')).events, [{ kind: 'runtime', sequence: 0, stage: 'compile', wallMs: 3, cpuMs: null }]);
  } finally { await store.close(); await removeRoot(root); }
  assert.equal(RunManifestSchema.safeParse({ schemaVersion: 1, runId: 'r' }).success, false);
  assert.equal(safetyFixture().schemaVersion, 1);
});
