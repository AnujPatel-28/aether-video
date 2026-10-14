import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkProjectState, hashProjectIR, ProjectIRSchema } from '@aether/core';
import { initProject, NOTES_MAX_BYTES, openProjectStore, StoreSegmentSchema, WorkspaceHeadSchema } from '@aether/workspace';
import type { ProjectStore } from '@aether/workspace';
import {
  batch, del, err, lockPath, moveTo, ok, PROJECT_ID, projectDir, removeRoot, reopen, ripple, safety, setup, task,
  tempRoot, threeClipProject, tree,
} from './workspace-support.js';

async function withStore(body: (store: ProjectStore, root: string) => Promise<void>, workspaces = ['ws-a', 'ws-b']) {
  const root = await tempRoot();
  const store = await setup(root, workspaces);
  try { await body(store, root); } finally { await store.close(); await removeRoot(root); }
}
const head = async (store: ProjectStore, id = 'ws-a') => ok(await store.readWorkspace(id)).workspace;
const userLock = (startMs: number, endMs: number) => ({
  id: 'lock-1', createdBy: 'user' as const, mode: 'retain_source_coverage' as const, provenanceId: 'user-pin',
  sourceRanges: [{ assetId: threeClipProject().assets[0]!.id, range: { startMs, endMs } }],
});

test('D1 checkProjectState validates structure, project binding and locks without editing', () => {
  const project = threeClipProject();
  const result = checkProjectState(project, safety());
  assert.ok(result.ok);
  assert.equal(result.contentHash, hashProjectIR(project));
  const mismatch = checkProjectState(project, { ...safety(), projectId: 'other' });
  assert.ok(!mismatch.ok && mismatch.error.code === 'invalid_reference');
  const empty = ProjectIRSchema.parse({ ...project, sequence: { ...project.sequence, clips: [] } });
  const locked = checkProjectState(empty, { ...safety(), userLocks: [userLock(0, 500)] });
  assert.ok(!locked.ok && locked.error.code === 'lock_violation');
  assert.ok(!checkProjectState({}, safety()).ok);
});

test('1 isolation: edits, undo, notes and discard in A leave accepted state and B byte-identical', () => withStore(async (store, root) => {
  const dir = projectDir(root);
  const before = await tree(dir);
  const others = Object.fromEntries(Object.entries(before).filter(([path]) => !path.startsWith('workspaces/ws-a/')));
  ok(await store.applyEditBatch(batch('ws-a', 'b1', 0, [del('A')])));
  ok(await store.undo('ws-a', 1));
  ok(await store.writeNotes('ws-a', 0, 'keep the caveat'));
  ok(await store.discard('ws-a'));
  const after = await tree(dir);
  for (const [path, content] of Object.entries(others)) {
    if (path.startsWith('snapshots/')) continue;
    assert.equal(after[path], content, path);
  }
  for (const path of Object.keys(before).filter(path => path.startsWith('snapshots/'))) assert.equal(after[path], before[path]);
}));

test('2 apply: revision +1, receipt and snapshot written, head hash equals kernel after-hash', () => withStore(async (store, root) => {
  const result = ok(await store.applyEditBatch(batch('ws-a', 'b1', 0, [ripple('B')])));
  assert.equal(result.outcome, 'applied');
  assert.equal(result.replayed, false);
  assert.deepEqual(result.head, { revision: 1, contentHash: result.receipt.afterContentHash });
  const { workspace, project } = ok(await store.readWorkspace('ws-a'));
  assert.equal(hashProjectIR(project), result.receipt.afterContentHash);
  assert.deepEqual(workspace.undoReceiptIds, [result.receipt.receiptId]);
  const files = await tree(projectDir(root));
  assert.ok(files[`workspaces/ws-a/receipts/${result.receipt.receiptId}.json`]);
  assert.ok(files[`snapshots/${result.receipt.afterContentHash}.json`]);
  assert.match(result.receipt.receiptId, /^receipt-[a-f0-9]{64}$/);
}));

test('3 stale revision, unknown workspace and non-open state give typed errors and change only the attempt line', () => withStore(async (store, root) => {
  const dir = projectDir(root);
  const before = await tree(dir);
  err(await store.applyEditBatch(batch('ws-a', 'b1', 7, [del('A')])), 'stale_revision');
  err(await store.applyEditBatch(batch('ws-zzz', 'b1', 0, [del('A')])), 'workspace_mismatch');
  assert.deepEqual(await tree(dir), before);
  const attempts = (await readFile(join(dir, 'workspaces/ws-a/attempts.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(attempts.length, 1);
  assert.equal(JSON.parse(attempts[0]!).errorCode, 'stale_revision');
  ok(await store.discard('ws-b'));
  const discarded = await tree(dir);
  err(await store.applyEditBatch(batch('ws-b', 'b1', 0, [del('A')])), 'workspace_not_open');
  err(await store.undo('ws-b', 0), 'workspace_not_open');
  err(await store.writeNotes('ws-b', 0, 'x'), 'workspace_not_open');
  assert.deepEqual(await tree(dir), discarded);
}));

test('4 kernel failure at operation N leaves head and history unchanged and passes the code through', () => withStore(async (store, root) => {
  const before = await tree(projectDir(root));
  const error = err(await store.applyEditBatch(batch('ws-a', 'b1', 0, [del('A', 'o1'), del('missing', 'o2')])), 'kernel', 'invalid_reference');
  assert.equal(error.kernel?.operationIndex, 1);
  assert.deepEqual(await tree(projectDir(root)), before);
  const attempt = JSON.parse((await readFile(join(projectDir(root), 'workspaces/ws-a/attempts.jsonl'), 'utf8')).trim());
  assert.equal(attempt.errorCode, 'invalid_reference');
  ok(await store.applyEditBatch(batch('ws-a', 'b1', 0, [del('A')])));
}));

test('5 deduplication: retry, retry after undo, conflicting payload and retry after restart', async () => {
  const root = await tempRoot();
  let store = await setup(root);
  try {
    const first = ok(await store.applyEditBatch(batch('ws-a', 'b1', 0, [del('A')])));
    const retry = ok(await store.applyEditBatch(batch('ws-a', 'b1', 0, [del('A')])));
    assert.equal(retry.replayed, true);
    assert.deepEqual(retry.receipt, first.receipt);
    assert.deepEqual(retry.head, first.head);
    assert.equal((await head(store)).head.revision, 1);
    ok(await store.undo('ws-a', 1));
    const afterUndo = ok(await store.applyEditBatch(batch('ws-a', 'b1', 0, [del('A')])));
    assert.equal(afterUndo.replayed, true);
    assert.deepEqual(afterUndo.receipt, first.receipt);
    assert.deepEqual(afterUndo.head, { revision: 2, contentHash: first.receipt.beforeContentHash });
    err(await store.applyEditBatch(batch('ws-a', 'b1', 2, [del('B')])), 'batch_id_conflict');
    await store.close();
    store = await reopen(root);
    const restarted = ok(await store.applyEditBatch(batch('ws-a', 'b1', 0, [del('A')])));
    assert.equal(restarted.replayed, true);
    assert.equal((await head(store)).head.revision, 2);
  } finally { await store.close(); await removeRoot(root); }
});

test('6 no-change batch: revision and stacks unchanged, deduplicated, not undoable', () => withStore(async store => {
  const result = ok(await store.applyEditBatch(batch('ws-a', 'noop', 0, [moveTo('A', 0)])));
  assert.equal(result.outcome, 'no_change');
  assert.equal(result.receipt.fromRevision, result.receipt.toRevision);
  const workspace = await head(store);
  assert.equal(workspace.head.revision, 0);
  assert.deepEqual(workspace.undoReceiptIds, []);
  assert.equal(workspace.committedBatches.length, 1);
  assert.equal(ok(await store.applyEditBatch(batch('ws-a', 'noop', 0, [moveTo('A', 0)]))).replayed, true);
  err(await store.undo('ws-a', 0), 'nothing_to_undo');
}));

test('7 undo/redo restore exact hashes with increasing revisions; new edit clears redo; empty stacks are typed', () => withStore(async store => {
  const base = (await head(store)).head.contentHash;
  err(await store.undo('ws-a', 0), 'nothing_to_undo');
  err(await store.redo('ws-a', 0), 'nothing_to_redo');
  const one = ok(await store.applyEditBatch(batch('ws-a', 'b1', 0, [del('A')])));
  const two = ok(await store.applyEditBatch(batch('ws-a', 'b2', 1, [ripple('B')])));
  assert.deepEqual(ok(await store.undo('ws-a', 2)).head, { revision: 3, contentHash: one.head.contentHash });
  assert.deepEqual(ok(await store.undo('ws-a', 3)).head, { revision: 4, contentHash: base });
  err(await store.undo('ws-a', 3), 'stale_revision');
  assert.deepEqual(ok(await store.redo('ws-a', 4)).head, { revision: 5, contentHash: one.head.contentHash });
  assert.deepEqual(ok(await store.redo('ws-a', 5)).head, { revision: 6, contentHash: two.head.contentHash });
  ok(await store.undo('ws-a', 6));
  ok(await store.applyEditBatch(batch('ws-a', 'b3', 7, [moveTo('C', 5000)])));
  assert.deepEqual((await head(store)).redoReceiptIds, []);
  err(await store.redo('ws-a', 8), 'nothing_to_redo');
}));

test('7b undo restores only a verified stored snapshot', () => withStore(async (store, root) => {
  const { receipt } = ok(await store.applyEditBatch(batch('ws-a', 'b1', 0, [del('A')])));
  const tampered = threeClipProject();
  tampered.sequence.clips = tampered.sequence.clips.slice(1);
  await writeFile(join(projectDir(root), `snapshots/${receipt.beforeContentHash}.json`), JSON.stringify(tampered));
  err(await store.undo('ws-a', 1), 'store_corrupt');
}));

test('8 replay matches every receipt and detects a tampered receipt', () => withStore(async (store, root) => {
  ok(await store.applyEditBatch(batch('ws-a', 'b1', 0, [del('A')])));
  const second = ok(await store.applyEditBatch(batch('ws-a', 'b2', 1, [moveTo('C', 0)])));
  ok(await store.applyEditBatch(batch('ws-a', 'b3', 2, [ripple('B')])));
  ok(await store.undo('ws-a', 3));
  assert.deepEqual(ok(await store.replay('ws-a')).report, { ok: true, checkedReceipts: 2 });
  const file = join(projectDir(root), `workspaces/ws-a/receipts/${second.receipt.receiptId}.json`);
  const receipt = JSON.parse(await readFile(file, 'utf8'));
  receipt.operationReceipts[0].effective.destinationTimelineStartMs = 3000;
  await writeFile(file, JSON.stringify(receipt));
  const report = ok(await store.replay('ws-a')).report;
  assert.equal(report.ok, false);
  assert.deepEqual(report.firstMismatch, { index: 1, receiptId: second.receipt.receiptId, reason: 'after_hash' });
}));

test('9 promotion: succeeds from unchanged base, stale after another promotes, empty timeline and lock failures', async () => {
  await withStore(async store => {
    ok(await store.applyEditBatch(batch('ws-a', 'b1', 0, [ripple('A')])));
    const { acceptedHead } = ok(await store.promote('ws-a', 0));
    assert.equal(acceptedHead.revision, 1);
    assert.equal(acceptedHead.contentHash, (await head(store)).head.contentHash);
    assert.deepEqual(acceptedHead.promotions, [{ revision: 1, workspaceId: 'ws-a', workspaceRevision: 1 }]);
    assert.equal((await head(store)).state, 'committed');
    err(await store.applyEditBatch(batch('ws-a', 'b2', 1, [del('B')])), 'workspace_not_open');
    err(await store.promote('ws-b', 1), 'stale_base');
    err(await store.promote('ws-b', 0), 'stale_base');
    ok(await store.forkWorkspace('ws-c', task()));
    ok(await store.applyEditBatch(batch('ws-c', 'b1', 1, [del('B', 'o1'), del('C', 'o2')])));
    err(await store.promote('ws-c', 1), 'empty_timeline');
  });
  const root = await tempRoot();
  const locked = { ...safety(), userLocks: [userLock(0, 500)] };
  ok(await initProject({ storeRoot: root }, threeClipProject(), locked));
  const store = ok(await openProjectStore({ storeRoot: root, projectId: PROJECT_ID })).store;
  try {
    ok(await store.forkWorkspace('ws-a', task()));
    err(await store.applyEditBatch(batch('ws-a', 'b1', 0, [del('A')])), 'kernel', 'lock_violation');
    // A violating snapshot can only arise from tampering; D1 still blocks promotion.
    const dir = projectDir(root);
    const workspace = await head(store);
    const bad = threeClipProject();
    bad.sequence.clips = bad.sequence.clips.slice(1);
    const badHash = hashProjectIR(bad);
    const { serializeProjectIR } = await import('@aether/core');
    await writeFile(join(dir, `snapshots/${badHash}.json`), serializeProjectIR(bad));
    await writeFile(join(dir, 'workspaces/ws-a/head.json'), JSON.stringify({ ...workspace, head: { revision: 1, contentHash: badHash } }));
    err(await store.promote('ws-a', 0), 'kernel', 'lock_violation');
  } finally { await store.close(); await removeRoot(root); }
});

test('10 freeze and discard: later mutations fail, reads work, submission binds revision, hash and notes', () => withStore(async (store, root) => {
  ok(await store.applyEditBatch(batch('ws-a', 'b1', 0, [del('A')])));
  ok(await store.writeNotes('ws-a', 0, 'notes v1'));
  const { workspace } = ok(await store.freezeSubmission('ws-a'));
  assert.equal(workspace.state, 'frozen');
  assert.deepEqual(workspace.submission, { revision: 1, contentHash: workspace.head.contentHash, notesRevision: 1 });
  const frozen = await tree(projectDir(root));
  err(await store.applyEditBatch(batch('ws-a', 'b2', 1, [del('B')])), 'workspace_not_open');
  err(await store.applyEditBatch(batch('ws-a', 'b1', 0, [del('A')])), 'workspace_not_open');
  err(await store.undo('ws-a', 1), 'workspace_not_open');
  err(await store.writeNotes('ws-a', 1, 'x'), 'workspace_not_open');
  err(await store.promote('ws-a', 0), 'workspace_not_open');
  err(await store.discard('ws-a'), 'workspace_not_open');
  err(await store.freezeSubmission('ws-a'), 'workspace_not_open');
  assert.deepEqual(await tree(projectDir(root)), frozen);
  assert.equal(ok(await store.readNotes('ws-a')).notes.text, 'notes v1');
  assert.ok(ok(await store.replay('ws-a')).report.ok);
  ok(await store.discard('ws-b'));
  assert.equal((await head(store, 'ws-b')).state, 'discarded');
  err(await store.freezeSubmission('ws-b'), 'workspace_not_open');
}));

test('11 corruption fails closed: missing snapshot, invalid JSON, hash mismatch, dangling receipt', async () => {
  const cases: [string, (dir: string, receiptId: string, after: string) => Promise<void>][] = [
    ['missing snapshot', (dir, _r, after) => rm(join(dir, `snapshots/${after}.json`))],
    ['invalid JSON', dir => writeFile(join(dir, 'workspaces/ws-a/head.json'), '{"schemaVersion":')],
    ['hash mismatch', async (dir, _r, after) => {
      const project = JSON.parse(await readFile(join(dir, `snapshots/${after}.json`), 'utf8'));
      project.segments[0].transcriptText = 'altered';
      await writeFile(join(dir, `snapshots/${after}.json`), JSON.stringify(project));
    }],
    ['dangling receipt', (dir, receiptId) => rm(join(dir, `workspaces/ws-a/receipts/${receiptId}.json`))],
  ];
  for (const [name, corrupt] of cases) {
    const root = await tempRoot();
    const store = await setup(root);
    try {
      const { receipt } = ok(await store.applyEditBatch(batch('ws-a', 'b1', 0, [del('A')])));
      await corrupt(projectDir(root), receipt.receiptId, receipt.afterContentHash);
      const result = await store.readWorkspace('ws-a');
      assert.ok(!result.ok && result.error.code === 'store_corrupt', name);
      err(await store.applyEditBatch(batch('ws-a', 'b2', 1, [del('B')])), 'store_corrupt');
    } finally { await store.close(); await removeRoot(root); }
  }
});

test('13 safety binding: changing safety.json after fork gives safety_changed', () => withStore(async (_store, root) => {
  const file = join(projectDir(root), 'safety.json');
  await writeFile(file, JSON.stringify({ ...safety(), maxOperationsPerBatch: 5 }));
  const store = _store;
  err(await store.applyEditBatch(batch('ws-a', 'b1', 0, [del('A')])), 'safety_changed');
  err(await store.promote('ws-a', 0), 'safety_changed');
}));

test('14 owner lock: second owner is refused; clean close allows reopening; closed session refuses commands', async () => {
  const root = await tempRoot();
  const store = await setup(root);
  try {
    err(await openProjectStore({ storeRoot: root, projectId: PROJECT_ID }), 'owner_locked');
    await store.close();
    err(await store.readWorkspace('ws-a'), 'owner_locked');
    const again = await reopen(root);
    ok(await again.readWorkspace('ws-a'));
    await again.close();
    await writeFile(lockPath(root), '{}');
    err(await openProjectStore({ storeRoot: root, projectId: PROJECT_ID }), 'owner_locked');
    err(await openProjectStore({ storeRoot: root, projectId: 'no-such-project' }), 'project_not_found');
    err(await initProject({ storeRoot: root }, threeClipProject(), safety()), 'owner_locked');
    await rm(lockPath(root));
    err(await initProject({ storeRoot: root }, threeClipProject(), safety()), 'already_exists');
  } finally { await removeRoot(root); }
});

test('15 path safety: unsafe project/workspace IDs are rejected before filesystem access; batch IDs are data', () => withStore(async (store, root) => {
  const unsafe = ['..', 'a/b', 'a\\b', 'C:x', 'abc.', 'Abc', 'con', 'NUL', 'com1', 'lpt9', '', '-a', 'a-', 'x'.repeat(65)];
  for (const id of unsafe) assert.equal(StoreSegmentSchema.safeParse(id).success, false, id);
  assert.equal(StoreSegmentSchema.safeParse('x'.repeat(64)).success, true);
  const before = await tree(root, true);
  for (const id of unsafe) {
    err(await store.forkWorkspace(id, task()), 'invalid_segment');
    err(await store.readWorkspace(id), 'invalid_segment');
    // An empty workspace ID already fails EditBatch validation; every other unsafe ID reaches the segment check.
    if (id !== '') err(await store.applyEditBatch(batch(id, 'b1', 0, [del('A')])), 'invalid_segment');
    err(await openProjectStore({ storeRoot: root, projectId: id }), 'invalid_segment');
  }
  assert.deepEqual(await tree(root, true), before);
  let revision = 0;
  for (const batchId of ['../x', 'a\\b', 'CON']) {
    const result = ok(await store.applyEditBatch(batch('ws-a', batchId, revision, [moveTo('C', 4000 + revision * 1000, batchId)])));
    revision = result.head.revision;
    assert.equal(result.receipt.batchId, batchId);
  }
  const paths = Object.keys(await tree(root, true));
  assert.ok(paths.every(path => !path.includes('CON') && !path.includes('..')), paths.join('\n'));
}));

test('16 notes round-trip, stale revision, size limit, and never touch content or revision', () => withStore(async store => {
  assert.deepEqual(ok(await store.readNotes('ws-a')).notes, { revision: 0, text: '' });
  const text = 'Caveat at 01:10 — keep it.\nSecond line ✓';
  assert.deepEqual(ok(await store.writeNotes('ws-a', 0, text)).notes, { revision: 1, text });
  assert.deepEqual(ok(await store.readNotes('ws-a')).notes, { revision: 1, text });
  err(await store.writeNotes('ws-a', 0, 'stale'), 'stale_revision');
  err(await store.writeNotes('ws-a', 1, 'é'.repeat(NOTES_MAX_BYTES / 2 + 1)), 'notes_too_large');
  ok(await store.writeNotes('ws-a', 1, 'x'.repeat(NOTES_MAX_BYTES)));
  err(await store.writeNotes('ws-a', 2, 42), 'invalid_input');
  const workspace = await head(store);
  assert.equal(workspace.head.revision, 0);
  assert.equal(workspace.head.contentHash, workspace.base.contentHash);
  assert.deepEqual(ok(await store.readNotes('ws-b')).notes, { revision: 0, text: '' });
}));

test('fork: existing workspace and invalid task are rejected; head binds accepted state and safety', () => withStore(async store => {
  err(await store.forkWorkspace('ws-a', task()), 'already_exists');
  err(await store.forkWorkspace('ws-new', { ...task(), hidden: true }), 'invalid_input');
  const workspace = await head(store);
  WorkspaceHeadSchema.parse(workspace);
  const { acceptedHead } = ok(await store.readAcceptedHead());
  assert.deepEqual(workspace.base, { revision: 0, contentHash: acceptedHead.contentHash });
  assert.equal(workspace.taskId, task().id);
}, ['ws-a']));

test('WorkspaceHead requires submission exactly when frozen', () => {
  const snapshot = { revision: 0, contentHash: 'c'.repeat(64) };
  const value = { schemaVersion: 1, id: 'ws', projectId: 'p', base: snapshot, head: snapshot, safetyContextHash: 'd'.repeat(64),
    state: 'open', undoReceiptIds: [], redoReceiptIds: [], proposedBatches: [], previewIds: [], committedBatches: [] };
  assert.ok(WorkspaceHeadSchema.safeParse(value).success);
  assert.ok(!WorkspaceHeadSchema.safeParse({ ...value, state: 'frozen' }).success);
  assert.ok(!WorkspaceHeadSchema.safeParse({ ...value, submission: { ...snapshot, notesRevision: 0 } }).success);
  assert.ok(WorkspaceHeadSchema.safeParse({ ...value, state: 'frozen', submission: { ...snapshot, notesRevision: 0 } }).success);
});

test('stored identities are re-checked before use as paths: a tampered receipt ID fails closed', () => withStore(async (store, root) => {
  ok(await store.applyEditBatch(batch('ws-a', 'b1', 0, [del('A')])));
  const file = join(projectDir(root), 'workspaces/ws-a/head.json');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  stored.undoReceiptIds = ['../../../safety'];
  await writeFile(file, JSON.stringify(stored));
  err(await store.readWorkspace('ws-a'), 'store_corrupt');
}, ['ws-a']));
