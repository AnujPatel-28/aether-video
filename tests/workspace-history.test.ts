import assert from 'node:assert/strict';
import { cp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalSerialize, executeEditBatch, hashProjectIR } from '@aether/core';
import type { EditOperation, ProjectIR } from '@aether/core';
import type { ProjectStore, StoreResult } from '@aether/workspace';
import {
  batch, del, err, faultFs, lockPath, moveTo, ok, projectDir, removeRoot, reopen, safety, setup, tempRoot, threeClipProject,
} from './workspace-support.js';

/** Logical state seen by a fresh owner instance (after the documented manual lock removal). */
async function observe(root: string) {
  await rm(lockPath(root), { force: true });
  const store = await reopen(root);
  try {
    const { acceptedHead } = ok(await store.readAcceptedHead());
    const workspaces: Record<string, unknown> = {};
    for (const id of ['ws-a', 'ws-b']) {
      const { workspace, project } = ok(await store.readWorkspace(id));
      assert.equal(hashProjectIR(project), workspace.head.contentHash);
      assert.ok(ok(await store.replay(id)).report.ok);
      workspaces[id] = { workspace, notes: ok(await store.readNotes(id)).notes };
    }
    return { acceptedHead, workspaces };
  } finally { await store.close(); }
}

interface Scenario {
  name: string;
  prepare: (store: ProjectStore) => Promise<unknown>;
  run: (store: ProjectStore) => Promise<StoreResult<object>>;
  isApply?: boolean;
}
const editA = (store: ProjectStore) => store.applyEditBatch(batch('ws-a', 'b1', 0, [del('A')]));
const scenarios: Scenario[] = [
  { name: 'apply (changed)', prepare: async () => undefined, run: editA, isApply: true },
  { name: 'apply (no change)', prepare: async () => undefined, run: s => s.applyEditBatch(batch('ws-a', 'noop', 0, [moveTo('A', 0)])), isApply: true },
  { name: 'undo', prepare: editA, run: s => s.undo('ws-a', 1) },
  { name: 'redo', prepare: async s => { await editA(s); await s.undo('ws-a', 1); }, run: s => s.redo('ws-a', 2) },
  { name: 'freeze', prepare: async s => { await editA(s); await s.writeNotes('ws-a', 0, 'n'); }, run: s => s.freezeSubmission('ws-a') },
  { name: 'promote', prepare: editA, run: s => s.promote('ws-a', 0) },
  { name: 'notes', prepare: async () => undefined, run: s => s.writeNotes('ws-a', 0, 'hello') },
  { name: 'discard', prepare: async () => undefined, run: s => s.discard('ws-a') },
];

for (const scenario of scenarios) {
  test(`12 interruption at every write position: ${scenario.name}`, async () => {
    const template = await tempRoot();
    const roots = [template];
    try {
      const store = await setup(template, ['ws-a', 'ws-b']);
      await scenario.prepare(store);
      await store.close();
      const before = await observe(template);

      const reference = await tempRoot();
      roots.push(reference);
      await cp(template, reference, { recursive: true });
      const counter = faultFs();
      const referenceStore = await reopen(reference, counter.fs);
      const start = counter.writes();
      ok(await scenario.run(referenceStore));
      const writes = counter.writes() - start;
      await referenceStore.close();
      const after = await observe(reference);
      assert.notDeepEqual(after, before);
      assert.ok(writes >= 2, `${scenario.name} performs ${writes} writes`);

      for (let k = 1; k <= writes; k++) {
        const trial = await tempRoot();
        roots.push(trial);
        await cp(template, trial, { recursive: true });
        const faulty = faultFs();
        const crashed = await reopen(trial, faulty.fs);
        faulty.arm(k);
        await scenario.run(crashed);
        assert.ok(faulty.crashed(), `write ${k} was reached`);
        const recovered = await observe(trial);
        const isOld = canonicalSerialize(recovered) === canonicalSerialize(before);
        const isNew = canonicalSerialize(recovered) === canonicalSerialize(after);
        assert.ok(isOld || isNew, `${scenario.name}: crash at write ${k} left a mixed state`);
        if (scenario.name === 'promote' && isNew) {
          const raw = JSON.parse(await readFile(join(projectDir(trial), 'workspaces/ws-a/head.json'), 'utf8'));
          assert.equal(raw.state, 'committed', 'promotion repair on reopen');
        }
        if (scenario.isApply || isOld) {
          const retryStore = await reopen(trial);
          const retry = ok(await scenario.run(retryStore));
          if (scenario.isApply) assert.equal((retry as unknown as { replayed: boolean }).replayed, isNew, `write ${k}: replayed only if committed`);
          await retryStore.close();
          assert.deepEqual(await observe(trial), after, `${scenario.name}: retry after crash at write ${k}`);
        }
      }
    } finally {
      for (const root of roots) await removeRoot(root);
    }
  });
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Independent history model. It uses the pure kernel for content but none of the store's code. */
interface Model {
  revision: number;
  project: ProjectIR;
  undo: { before: ProjectIR; after: ProjectIR }[];
  redo: { before: ProjectIR; after: ProjectIR }[];
  committed: Map<string, { payload: string; changed: boolean }>;
  notes: { revision: number; text: string };
}

test('17 randomized history (seed 0xAE7103, 200 steps) matches an independent model after every fresh load', async () => {
  const seed = 0xAE7103;
  const random = mulberry32(seed);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;
  const frame = (max: number) => Math.floor(random() * (max / 40)) * 40;
  const root = await tempRoot();
  const journal: string[] = [];
  let store = await setup(root, ['ws-a']);
  const model: Model = {
    revision: 0, project: threeClipProject(), undo: [], redo: [], committed: new Map(), notes: { revision: 0, text: '' },
  };
  let counter = 0;

  function randomOperation(operationId: string): EditOperation {
    const clips = model.project.sequence.clips;
    if (clips.length === 0 || random() < 0.05) return del('missing-clip', operationId);
    const clip = pick(clips);
    const length = clip.sourceRange.endMs - clip.sourceRange.startMs;
    const kind = pick(['split', 'trim', 'delete', 'ripple_delete', 'move', 'move'] as const);
    if (kind === 'split' && length > 40) {
      return { type: 'split', clipId: clip.id, operationId, atSourceMs: clip.sourceRange.startMs + 40 + frame(length - 40) };
    }
    if (kind === 'trim' && length > 80) {
      const startMs = clip.sourceRange.startMs + frame(length / 2);
      return { type: 'trim', clipId: clip.id, operationId, sourceRange: { startMs, endMs: startMs + 40 + frame(clip.sourceRange.endMs - startMs - 40) } };
    }
    if (kind === 'delete' || kind === 'ripple_delete') return { type: kind, clipId: clip.id, operationId };
    return moveTo(clip.id, frame(8000), operationId);
  }

  try {
    for (let stepIndex = 0; stepIndex < 200; stepIndex++) {
      const roll = random();
      if (roll < 0.45) {
        const id = `b${counter++}`;
        const operations = Array.from({ length: 1 + Math.floor(random() * 2) }, (_, i) => randomOperation(`${id}-o${i}`));
        const stale = random() < 0.1;
        const value = batch('ws-a', id, model.revision + (stale ? 1 : 0), operations);
        journal.push(`${stepIndex} apply ${canonicalSerialize(value)}`);
        const result = await store.applyEditBatch(value);
        if (stale) { err(result, 'stale_revision'); continue; }
        const expected = executeEditBatch(model.project, value, safety());
        if (!expected.ok) { err(result, 'kernel', expected.error.code); continue; }
        const applied = ok(result);
        assert.equal(applied.replayed, false);
        assert.equal(applied.outcome, expected.changed ? 'applied' : 'no_change');
        model.committed.set(id, { payload: canonicalSerialize(value), changed: expected.changed });
        if (expected.changed) {
          model.undo.push({ before: model.project, after: expected.nextProject });
          model.redo = [];
          model.project = expected.nextProject;
          model.revision++;
        }
      } else if (roll < 0.55 && model.committed.size > 0) {
        const [id, entry] = pick([...model.committed]);
        journal.push(`${stepIndex} retry ${id}`);
        const retry = ok(await store.applyEditBatch(JSON.parse(entry.payload)));
        assert.equal(retry.replayed, true);
        assert.equal(retry.outcome, entry.changed ? 'applied' : 'no_change');
        assert.deepEqual(retry.head, { revision: model.revision, contentHash: hashProjectIR(model.project) });
      } else if (roll < 0.6 && model.committed.size > 0) {
        const [id] = pick([...model.committed]);
        journal.push(`${stepIndex} conflict ${id}`);
        err(await store.applyEditBatch(batch('ws-a', id, model.revision, [del('other-payload', 'x')])), 'batch_id_conflict');
      } else if (roll < 0.75) {
        journal.push(`${stepIndex} undo`);
        const entry = model.undo.pop();
        const result = await store.undo('ws-a', model.revision);
        if (!entry) { err(result, 'nothing_to_undo'); continue; }
        ok(result);
        model.redo.push(entry);
        model.project = entry.before;
        model.revision++;
      } else if (roll < 0.88) {
        journal.push(`${stepIndex} redo`);
        const entry = model.redo.pop();
        const result = await store.redo('ws-a', model.revision);
        if (!entry) { err(result, 'nothing_to_redo'); continue; }
        ok(result);
        model.undo.push(entry);
        model.project = entry.after;
        model.revision++;
      } else {
        const text = `note ${stepIndex}`;
        journal.push(`${stepIndex} notes`);
        ok(await store.writeNotes('ws-a', model.notes.revision, text));
        model.notes = { revision: model.notes.revision + 1, text };
      }

      await store.close();
      store = await reopen(root);
      const { workspace, project } = ok(await store.readWorkspace('ws-a'));
      assert.equal(workspace.head.revision, model.revision);
      assert.equal(workspace.head.contentHash, hashProjectIR(model.project));
      assert.equal(hashProjectIR(project), workspace.head.contentHash);
      assert.equal(workspace.undoReceiptIds.length, model.undo.length);
      assert.equal(workspace.redoReceiptIds.length, model.redo.length);
      assert.equal(workspace.committedBatches.length, model.committed.size);
      assert.deepEqual(ok(await store.readNotes('ws-a')).notes, model.notes);
      assert.deepEqual(ok(await store.replay('ws-a')).report, { ok: true, checkedReceipts: model.undo.length });
    }
    // The sequence must actually exercise history, not just errors.
    assert.ok(model.committed.size >= 30 && model.undo.length + model.redo.length >= 5, `weak sequence: ${model.committed.size} committed`);
  } catch (error) {
    throw new Error(`Randomized history failed (seed 0x${seed.toString(16)}); last steps:\n${journal.slice(-15).join('\n')}`, { cause: error });
  } finally {
    await store.close();
    await removeRoot(root);
  }
});
