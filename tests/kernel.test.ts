import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  applyBatch, executeEditBatch, canonicalSerialize, hashProjectIR, ProjectIRSchema,
  serializeProjectIR, timelineContentFingerprint,
} from '@aether/core';
import type { EditOperation, KernelErrorCode, KernelResult, KernelSafetyContext, ProjectIR } from '@aether/core';
import { evaluationFixture, projectFixture, safetyFixture, taskFixture } from './fixtures.js';

function project(): ProjectIR {
  const value = projectFixture();
  value.sequence.clips = ['A', 'B', 'C'].map((id, i) => ({
    id, assetId: value.assets[0]!.id, sourceRange: { startMs: i * 1000, endMs: (i + 1) * 1000 }, timelineStartMs: i * 1000,
  }));
  return ProjectIRSchema.parse(value);
}
function op(type: EditOperation['type'], clipId: string, operationId = 'op'): EditOperation {
  switch (type) {
    case 'split': return { type, clipId, operationId, atSourceMs: 400 };
    case 'trim': return { type, clipId, operationId, sourceRange: { startMs: 200, endMs: 800 } };
    case 'move': return { type, clipId, operationId, destinationTimelineStartMs: 4000 };
    default: return { type, clipId, operationId };
  }
}
function success(result: KernelResult) {
  assert.ok(result.ok, result.ok ? '' : JSON.stringify(result.error));
  ProjectIRSchema.parse(result.nextProject);
  assert.equal(result.afterContentHash, hashProjectIR(result.nextProject));
  return result;
}
function failure(result: KernelResult, code: KernelErrorCode, operationIndex?: number) {
  assert.ok(!result.ok);
  assert.equal(result.error.code, code);
  if (operationIndex !== undefined) assert.equal(result.error.operationIndex, operationIndex);
  assert.deepEqual(Object.keys(result).sort(), ['error', 'ok']);
  return result;
}
function requested(value: ProjectIR, operations: EditOperation[], safety = safetyFixture()) {
  return executeEditBatch(value, { schemaVersion: 1, batchId: 'batch', workspaceId: 'workspace', expectedRevision: 0, operations }, safety);
}
function locks(value: ProjectIR, startMs = 200, endMs = 1800): KernelSafetyContext {
  return { ...safetyFixture(), userLocks: [{ id: 'actual-user-lock', createdBy: 'user', mode: 'retain_source_coverage', provenanceId: 'user-selection',
    sourceRanges: [{ assetId: value.assets[0]!.id, range: { startMs, endMs } }] }] };
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') { Object.freeze(value); for (const nested of Object.values(value)) freeze(nested); }
}

for (const [i, id] of ['A', 'B', 'C'].entries()) {
  test(`split at ${id} (beginning/middle/end) preserves coverage and timeline extent`, () => {
    const before = project();
    const split: EditOperation = { type: 'split', clipId: id, operationId: 'split', atSourceMs: i * 1000 + 400 };
    const result = success(applyBatch(before, [split], safetyFixture()));
    const children = result.clipMappings[id]!;
    assert.equal(children.length, 2);
    assert.deepEqual(result.nextProject.sequence.clips.filter(clip => children.includes(clip.id)).map(clip => [clip.sourceRange, clip.timelineStartMs]), [
      [{ startMs: i * 1000, endMs: i * 1000 + 400 }, i * 1000],
      [{ startMs: i * 1000 + 400, endMs: (i + 1) * 1000 }, i * 1000 + 400],
    ]);
    assert.equal(timelineContentFingerprint(before), timelineContentFingerprint(result.nextProject));
  });
  test(`trim at ${id} anchors the timeline start and leaves the trailing gap`, () => {
    const result = success(applyBatch(project(), [{ type: 'trim', clipId: id, operationId: 'trim', sourceRange: { startMs: i * 1000 + 200, endMs: i * 1000 + 800 } }], safetyFixture()));
    assert.deepEqual(result.nextProject.sequence.clips.find(clip => clip.id === id), {
      id, assetId: project().assets[0]!.id, sourceRange: { startMs: i * 1000 + 200, endMs: i * 1000 + 800 }, timelineStartMs: i * 1000,
    });
    assert.deepEqual(result.nextProject.sequence.clips.filter(clip => clip.id !== id), project().sequence.clips.filter(clip => clip.id !== id));
  });
  test(`delete versus ripple-delete at ${id}`, () => {
    const deleted = success(applyBatch(project(), [op('delete', id)], safetyFixture())).nextProject;
    const rippled = success(applyBatch(project(), [op('ripple_delete', id)], safetyFixture())).nextProject;
    assert.deepEqual(deleted.sequence.clips.map(clip => clip.timelineStartMs), [0, 1000, 2000].filter((_, index) => index !== i));
    assert.deepEqual(rippled.sequence.clips.map(clip => clip.timelineStartMs), [0, 1000]);
    assert.deepEqual(deleted.sequence.clips.map(clip => clip.sourceRange), rippled.sequence.clips.map(clip => clip.sourceRange));
  });
  test(`move at ${id} preserves source content and other starts`, () => {
    const before = project();
    const result = success(applyBatch(before, [op('move', id)], safetyFixture()));
    assert.equal(result.nextProject.sequence.clips.find(clip => clip.id === id)!.timelineStartMs, 4000);
    assert.deepEqual(result.nextProject.sequence.clips.filter(clip => clip.id !== id), before.sequence.clips.filter(clip => clip.id !== id));
  });
}

test('ripple-delete preserves pre-existing gaps, including a leading gap', () => {
  const value = project();
  value.sequence.clips.forEach((clip, i) => { clip.timelineStartMs = 200 + i * 1200; });
  const result = success(applyBatch(value, [op('ripple_delete', 'B')], safetyFixture()));
  assert.deepEqual(result.nextProject.sequence.clips.map(clip => clip.timelineStartMs), [200, 1600]);
});
test('split rejects endpoints and source requests outside the clip, without clamping', () => {
  for (const atSourceMs of [0, 1000, 1040, 1001]) {
    failure(requested(project(), [{ type: 'split', clipId: 'A', operationId: 'split', atSourceMs }]), 'source_bounds', 0);
  }
  // A legal raw point can align onto an endpoint; it still fails.
  failure(requested(project(), [{ type: 'split', clipId: 'A', operationId: 'split', atSourceMs: 20 }]), 'source_bounds', 0);
});
test('trim extension is rejected for raw and aligned boundaries; empty ranges fail', () => {
  for (const sourceRange of [{ startMs: 960, endMs: 2000 }, { startMs: 999, endMs: 2000 }, { startMs: 1000, endMs: 2001 }]) {
    failure(requested(project(), [{ type: 'trim', clipId: 'B', operationId: 'trim', sourceRange }]), 'source_bounds', 0);
  }
  failure(applyBatch(project(), [{ type: 'trim', clipId: 'A', operationId: 'trim', sourceRange: { startMs: 400, endMs: 400 } }], safetyFixture()), 'schema_invalid');
});
test('overlap fails at the offending provisional operation even if a later edit would fix it', () => {
  failure(applyBatch(project(), [
    { type: 'move', operationId: 'overlap', clipId: 'A', destinationTimelineStartMs: 1000 }, op('delete', 'B', 'fix'),
  ], safetyFixture()), 'timeline_overlap', 0);
});
test('atomic free-space reorder succeeds and a failure at N returns no partial result', () => {
  const before = project(); const original = serializeProjectIR(before);
  const operations: EditOperation[] = [
    { type: 'move', operationId: 'stage', clipId: 'A', destinationTimelineStartMs: 3000 },
    { type: 'move', operationId: 'B-first', clipId: 'B', destinationTimelineStartMs: 0 },
    { type: 'move', operationId: 'A-second', clipId: 'A', destinationTimelineStartMs: 1000 },
  ];
  freeze(before); freeze(operations);
  const result = success(applyBatch(before, operations, safetyFixture()));
  assert.deepEqual(result.nextProject.sequence.clips.map(clip => clip.id), ['B', 'A', 'C']);
  assert.equal(serializeProjectIR(before), original);
  failure(applyBatch(before, [...operations, { type: 'move', operationId: 'bad', clipId: 'C', destinationTimelineStartMs: 400 }], safetyFixture()), 'timeline_overlap', 3);
  assert.equal(serializeProjectIR(before), original);
  assert.equal(hashProjectIR(result.beforeProject), hashProjectIR(before));
  result.nextProject.sequence.clips[0]!.timelineStartMs = 4000;
  assert.equal(serializeProjectIR(before), original);
  assert.equal(hashProjectIR(result.beforeProject), hashProjectIR(before));
});
test('operations can address deterministic children created earlier in the same batch', () => {
  const before = project(); const split = op('split', 'A');
  const children = success(applyBatch(before, [split], safetyFixture())).clipMappings.A!;
  const result = success(applyBatch(before, [split, { type: 'trim', operationId: 'child-trim', clipId: children[1]!, sourceRange: { startMs: 440, endMs: 960 } }], safetyFixture()));
  assert.equal(result.nextProject.sequence.clips.find(clip => clip.id === children[1])!.sourceRange.startMs, 440);
  failure(applyBatch(before, [split, op('delete', 'A', 'stale-parent')], safetyFixture()), 'invalid_reference', 1);
});
test('split identity derives from the documented descriptor and replay is exact', () => {
  const before = project(); const split = op('split', 'A', 'stable-operation');
  const result = success(applyBatch(before, [split], safetyFixture()));
  const parent = before.sequence.clips[0]!;
  const expected = ['left', 'right'].map(side => 'clip-split-' + createHash('sha256').update(canonicalSerialize({
    domain: 'aether.split-child.v1', parentClipId: parent.id, assetId: parent.assetId,
    parentSourceRange: parent.sourceRange, operationId: 'stable-operation', effectiveAtSourceMs: 400, side,
  })).digest('hex'));
  assert.deepEqual(result.clipMappings.A, expected);
  assert.deepEqual(applyBatch(before, [split], safetyFixture()), result);
  assert.notDeepEqual(success(applyBatch(before, [op('split', 'A', 'different-operation')], safetyFixture())).clipMappings.A, expected);
  const collision = project(); collision.sequence.clips[2]!.id = expected[0]!;
  failure(applyBatch(collision, [split], safetyFixture()), 'identity_collision', 0);
  const opaque = project(); opaque.sequence.clips[0]!.id = '__proto__';
  const mapped = success(applyBatch(opaque, [op('split', '__proto__')], safetyFixture())).clipMappings;
  assert.ok(Object.hasOwn(mapped, '__proto__'));
  assert.equal(Object.getPrototypeOf(mapped), Object.prototype);
});
test('requested batch receipts preserve rounding while direct effective operations reject off-grid times', () => {
  const split: EditOperation = { type: 'split', operationId: 'split', clipId: 'A', atSourceMs: 420 };
  const result = success(requested(project(), [split]));
  assert.deepEqual(result.operationReceipts[0]!.requested, split);
  assert.deepEqual(result.operationReceipts[0]!.effective, { ...split, atSourceMs: 400 });
  assert.deepEqual(result.operationReceipts[0]!.alignments, [{ field: 'atSourceMs', requestedMs: 420, effectiveMs: 400, deltaMs: -20 }]);
  failure(applyBatch(project(), [split], safetyFixture()), 'timing_alignment', 0);
  const replay = success(applyBatch(project(), result.operationReceipts.map(receipt => receipt.effective), safetyFixture()));
  assert.equal(replay.afterContentHash, result.afterContentHash);
  const move = success(requested(project(), [{ type: 'move', operationId: 'move', clipId: 'C', destinationTimelineStartMs: 4021 }]));
  assert.equal(move.nextProject.sequence.clips.at(-1)!.timelineStartMs, 4040);
});
test('no-op trims/moves and net-zero batches explicitly report no change', () => {
  const before = project();
  const operations: EditOperation[] = [
    { type: 'trim', operationId: 'trim', clipId: 'A', sourceRange: { startMs: 0, endMs: 1000 } },
    { type: 'move', operationId: 'move', clipId: 'A', destinationTimelineStartMs: 0 },
  ];
  const result = success(applyBatch(before, operations, safetyFixture()));
  assert.equal(result.changed, false);
  assert.deepEqual(result.operationReceipts.map(receipt => receipt.outcome), ['no_change', 'no_change']);
  const net = success(applyBatch(before, [op('move', 'A', 'out'), { type: 'move', clipId: 'A', operationId: 'back', destinationTimelineStartMs: 0 }], safetyFixture()));
  assert.equal(net.changed, false);
  assert.deepEqual(net.operationReceipts.map(receipt => receipt.outcome), ['applied', 'applied']);
});
test('permissions and batch limits are typed errors and preserve the input', () => {
  const before = project(); const original = serializeProjectIR(before);
  const safety = safetyFixture(); safety.allowedOperations = ['move'];
  failure(applyBatch(before, [op('move', 'A', 'first'), op('delete', 'B', 'forbidden')], safety), 'operation_not_allowed', 1);
  safety.maxOperationsPerBatch = 1;
  failure(applyBatch(before, [op('delete', 'A', 'first'), op('delete', 'B', 'second')], safety), 'batch_limit');
  assert.equal(serializeProjectIR(before), original);
});
test('schema, missing reference, bad source, unknown fields and overflow fail mechanically', () => {
  const before = project();
  failure(applyBatch(before, [], safetyFixture()), 'schema_invalid');
  failure(applyBatch(before, [op('delete', 'A'), op('delete', 'B')], safetyFixture()), 'schema_invalid');
  failure(applyBatch(before, [op('delete', 'missing')], safetyFixture()), 'invalid_reference', 0);
  failure(applyBatch(before, [{ ...op('delete', 'A'), extra: true }], safetyFixture()), 'schema_invalid');
  failure(applyBatch(before, [op('delete', 'A')], { ...safetyFixture(), projectId: 'other' }), 'invalid_reference');
  const bad = project(); bad.sequence.clips[0]!.assetId = 'missing';
  failure(applyBatch(bad, [op('delete', 'A')], safetyFixture()), 'invalid_reference');
  bad.sequence.clips[0]!.assetId = before.assets[0]!.id; bad.sequence.clips[0]!.sourceRange.endMs = 4040;
  failure(applyBatch(bad, [op('delete', 'A')], safetyFixture()), 'source_bounds');
  const nearLimit = Number.MAX_SAFE_INTEGER - Number.MAX_SAFE_INTEGER % 40;
  failure(applyBatch(before, [{ type: 'move', clipId: 'A', operationId: 'overflow', destinationTimelineStartMs: nearLimit }], safetyFixture()), 'timing_alignment', 0);
  failure(requested(before, [{ type: 'move', clipId: 'A', operationId: 'overflow', destinationTimelineStartMs: Number.MAX_SAFE_INTEGER }]), 'timing_alignment', 0);
});
test('genuine locked coverage survives split, trim outside the lock and move', () => {
  const before = project(); const safety = locks(before);
  const split = op('split', 'A');
  const children = success(applyBatch(before, [split], safety)).clipMappings.A!;
  success(applyBatch(before, [split, { type: 'move', clipId: children[0]!, operationId: 'move-locked', destinationTimelineStartMs: 4000 }], safety));
  success(applyBatch(before, [{ type: 'trim', clipId: 'A', operationId: 'trim', sourceRange: { startMs: 200, endMs: 1000 } }], safety));
  const offGridLock = locks(before, 201, 1799);
  success(applyBatch(before, [split], offGridLock));
});
test('any partial locked removal fails only at the completed batch; identical unlocked edit succeeds', () => {
  const before = project(); const original = serializeProjectIR(before); const safety = locks(before);
  const split = op('split', 'A');
  const children = success(applyBatch(before, [split], safetyFixture())).clipMappings.A!;
  const edits: EditOperation[] = [split, op('delete', children[0]!, 'remove-part')];
  const rejected = failure(applyBatch(before, edits, safety), 'lock_violation');
  assert.equal(rejected.error.stage, 'final_locks');
  assert.equal(rejected.error.evidence.lockId, 'actual-user-lock');
  success(applyBatch(before, edits, safetyFixture()));
  for (const range of [{ startMs: 240, endMs: 1000 }, { startMs: 0, endMs: 960 }]) {
    failure(applyBatch(before, [{ type: 'trim', clipId: 'A', operationId: 'trim', sourceRange: range }], safety), 'lock_violation');
  }
  assert.equal(serializeProjectIR(before), original);
});
test('lock checks use union coverage including redundant clips, and reject invalid contexts', () => {
  const before = project(); before.sequence.clips.push({ ...before.sequence.clips[0]!, id: 'A-copy', timelineStartMs: 4000 });
  success(applyBatch(before, [op('delete', 'A')], locks(before)));
  const broken = locks(before); broken.userLocks[0]!.sourceRanges[0]!.assetId = 'missing';
  failure(applyBatch(before, [op('move', 'C')], broken), 'invalid_reference');
  broken.userLocks[0]!.sourceRanges[0]!.assetId = before.assets[0]!.id;
  broken.userLocks[0]!.sourceRanges[0]!.range.endMs = 4040;
  failure(applyBatch(before, [op('delete', 'A')], broken), 'source_bounds');
  failure(applyBatch(project(), [op('delete', 'A')], locks(project(), 3000, 4000)), 'lock_violation');
});
test('unlocked caveat deletion succeeds regardless of separate task/evaluator objects; errors never echo hidden fields', () => {
  const before = projectFixture(); const task = taskFixture(); const evaluation = evaluationFixture();
  const edits: EditOperation[] = [{ type: 'delete', clipId: 'clip-caveat', operationId: 'editorial-failure' }];
  const first = success(applyBatch(before, edits, safetyFixture()));
  task.rawRequest = 'different request'; evaluation.id = 'different-evaluation';
  assert.deepEqual(applyBatch(before, edits, safetyFixture()), first);
  const sentinel = 'hidden-evaluation-sentinel';
  for (const result of [applyBatch({ ...before, [sentinel]: evaluation }, edits, safetyFixture()), applyBatch(before, edits, { ...safetyFixture(), [sentinel]: evaluation })]) {
    failure(result, 'schema_invalid'); assert.equal(JSON.stringify(result).includes(sentinel), false);
  }
});
test('deleting the complete timeline is valid without locks', () => {
  const before = project();
  const result = success(applyBatch(before, before.sequence.clips.map((clip, i) => op('ripple_delete', clip.id, `delete-${i}`)), safetyFixture()));
  assert.deepEqual(result.nextProject.sequence.clips, []);
});

test('fixed-seed randomized operations preserve structure, exact replay and rollback', () => {
  const seed = 0xAE7102; let state = seed;
  function random(max: number): number { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % max; }
  let current = project();
  const journal: EditOperation[] = [];
  let accepted = 0; let rejected = 0;
  for (let i = 0; i < 250; i++) {
    if (!current.sequence.clips.length) current = project();
    const clip = current.sequence.clips[random(current.sequence.clips.length)]!;
    const kind = ['split', 'trim', 'delete', 'ripple_delete', 'move'][random(5)]! as EditOperation['type'];
    let edit = op(kind, clip.id, `seed-${i}`);
    if (kind === 'split') edit = { type: kind, clipId: clip.id, operationId: `seed-${i}`, atSourceMs: clip.sourceRange.startMs + random((clip.sourceRange.endMs - clip.sourceRange.startMs) / 40 + 1) * 40 };
    if (kind === 'trim') {
      const startMs = clip.sourceRange.startMs + random((clip.sourceRange.endMs - clip.sourceRange.startMs) / 40) * 40;
      edit = { type: kind, clipId: clip.id, operationId: `seed-${i}`, sourceRange: { startMs, endMs: clip.sourceRange.endMs } };
    }
    if (kind === 'move') edit = { type: kind, clipId: clip.id, operationId: `seed-${i}`, destinationTimelineStartMs: random(151) * 40 };
    journal.push(edit); const original = serializeProjectIR(current);
    const result = applyBatch(current, [edit], safetyFixture());
    const evidence = `seed=${seed}; step=${i}; journal=${JSON.stringify(journal)}`;
    assert.deepEqual(applyBatch(current, [edit], safetyFixture()), result, evidence);
    assert.equal(serializeProjectIR(current), original, evidence);
    if (result.ok) {
      accepted++; ProjectIRSchema.parse(result.nextProject);
      assert.equal(hashProjectIR(result.beforeProject), hashProjectIR(current), evidence);
      current = result.nextProject;
    } else { rejected++; assert.deepEqual(Object.keys(result).sort(), ['error', 'ok'], evidence); }
  }
  assert.ok(accepted > 100 && rejected > 10, `seed=${seed}, accepted=${accepted}, rejected=${rejected}`);
});
