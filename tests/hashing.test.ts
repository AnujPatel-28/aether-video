import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { canonicalSerialize, hashProjectIR, serializeProjectIR, KernelSafetyContextSchema } from '@aether/core';
import { TaskInstructionsSchema } from '@aether/tools';
import { EvaluationSpecSchema } from '@aether/verification/evaluator';
import { projectFixture, taskFixture, safetyFixture, evaluationFixture } from './fixtures.js';

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]));
  }
  return value;
}

test('identical logical projects serialize/hash identically despite object/entity insertion order', () => {
  const original = projectFixture();
  const reordered = { ...original, segments: [...original.segments].reverse(), sequence: { ...original.sequence, clips: [...original.sequence.clips].reverse() } };
  assert.equal(serializeProjectIR(original), serializeProjectIR(reverseKeys(reordered)));
  assert.equal(hashProjectIR(original), hashProjectIR(reverseKeys(reordered)));
  assert.deepEqual(JSON.parse(serializeProjectIR(original)), JSON.parse(serializeProjectIR(reordered)));
});

test('canonical serialization is UTF-8 SHA-256, deterministic and does not mutate input', () => {
  const project = projectFixture();
  const before = structuredClone(project);
  const serialized = serializeProjectIR(project);
  assert.equal(hashProjectIR(project), createHash('sha256').update(serialized, 'utf8').digest('hex'));
  assert.deepEqual(project, before);
  assert.match(hashProjectIR(project), /^[a-f0-9]{64}$/);
  assert.equal(serializeProjectIR(JSON.parse(serialized)), serialized);
});

test('changing agent-visible TaskInstructions leaves canonical project identity unchanged', () => {
  const project = projectFixture();
  const first = { project, task: taskFixture() };
  const second = { ...first, task: TaskInstructionsSchema.parse({ ...first.task, rawRequest: 'Keep the full interview instead.', userProvidedDurationTarget: { minMs: 3000, maxMs: 4000 } }) };
  assert.notDeepEqual(first.task, second.task);
  assert.equal(hashProjectIR(first.project), hashProjectIR(second.project));
});

test('changing KernelSafetyContext/user locks leaves canonical project identity unchanged', () => {
  const project = projectFixture();
  const first = { project, safety: safetyFixture() };
  const second = { ...first, safety: KernelSafetyContextSchema.parse({ ...first.safety, maxOperationsPerBatch: 1, allowedOperations: ['split'], userLocks: [{ id: 'real-lock', createdBy: 'user', mode: 'retain_source_coverage', sourceRanges: [{ assetId: project.assets[0]!.id, range: { startMs: 1200, endMs: 1800 } }], provenanceId: 'user-action' }] }) };
  assert.notDeepEqual(first.safety, second.safety);
  assert.equal(hashProjectIR(first.project), hashProjectIR(second.project));
});

test('changing hidden EvaluationSpec leaves canonical project identity unchanged', () => {
  const project = projectFixture();
  const first = { project, evaluation: evaluationFixture() };
  const second = { ...first, evaluation: EvaluationSpecSchema.parse({ ...first.evaluation, targetDuration: { minMs: 500, maxMs: 1000 }, retentionCriteria: [], semanticRubric: [{ id: 'different-gold', description: 'A different hidden rubric.' }] }) };
  assert.notDeepEqual(first.evaluation, second.evaluation);
  assert.equal(hashProjectIR(first.project), hashProjectIR(second.project));
  assert.equal(serializeProjectIR(project).includes('hidden-gold-caveat'), false);
});

test('relocating trusted host storage does not affect logical asset reference or project identity', () => {
  const project = projectFixture();
  const first = { project: structuredClone(project), localStorageRoot: 'C:/Users/Alice/projects' };
  const second = { project: structuredClone(project), localStorageRoot: '/home/bob/projects' };
  assert.equal(hashProjectIR(first.project), hashProjectIR(second.project));
  assert.equal(serializeProjectIR(first.project).includes(first.localStorageRoot), false);
  assert.equal(serializeProjectIR(second.project).includes(second.localStorageRoot), false);
  // No location resolver is implemented; the host field exists only in this test envelope.
});

test('project hash rejects whole run envelopes and unknown metadata rather than silently hiding mistakes', () => {
  const project = projectFixture();
  assert.throws(() => hashProjectIR({ project, task: taskFixture() }));
  assert.throws(() => hashProjectIR({ ...project, localStorageRoot: '/home/host' }));
  assert.throws(() => hashProjectIR({ ...project, evaluationSpec: evaluationFixture() }));
});

test('meaningful source/timeline/transcript changes produce different identities', () => {
  const project = projectFixture();
  assert.notEqual(hashProjectIR(project), hashProjectIR({ ...project, transcriptHash: 'f'.repeat(64) }));
  assert.notEqual(hashProjectIR(project), hashProjectIR({ ...project, sequence: { ...project.sequence, clips: [project.sequence.clips[0]] } }));
  assert.notEqual(hashProjectIR(project), hashProjectIR({ ...project, segments: project.segments.map(segment => ({ ...segment, transcriptText: segment.transcriptText + ' Changed.' })) }));
});

test('canonical JSON preserves meaningful array order and byte-exact Unicode while normalizing optional absence', () => {
  assert.equal(canonicalSerialize({ z: [2, 1], a: 'é', absent: undefined }), '{"a":"é","z":[2,1]}');
  assert.notEqual(canonicalSerialize([1, 2]), canonicalSerialize([2, 1]));
  assert.notEqual(canonicalSerialize('é'), canonicalSerialize('e\u0301'));
  assert.equal(canonicalSerialize({ n: -0 }), canonicalSerialize({ n: 0 }));
  const project = projectFixture();
  assert.equal(hashProjectIR(project), hashProjectIR({ ...project, segments: project.segments.map(segment => segment.speaker ? segment : { ...segment, speaker: undefined }) }));
});

test('non-JSON data and cycles cannot silently collapse into a canonical identity', () => {
  const cyclic: Record<string, unknown> = {}; cyclic['self'] = cyclic;
  for (const value of [NaN, Infinity, undefined, 1n, () => 1, [undefined], Array(1), new Date(0), cyclic, { [Symbol('hidden')]: 1 }]) {
    assert.throws(() => canonicalSerialize(value));
  }
});
