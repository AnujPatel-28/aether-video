import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import {
  ProjectIRSchema, SourceAssetSchema, MediaSegmentSchema, TimelineClipSchema,
  RangeSchema, SourceRefSchema, DurationTargetSchema, UserLockSchema,
  KernelSafetyContextSchema, EditOperationSchema, EditBatchSchema,
} from '@aether/core';
import { TaskInstructionsSchema } from '@aether/tools';
import { EditContractSchema, EditorialPlanSchema, IntentItemSchema } from '@aether/tools/orchestration';
import { AgentWorkspaceSchema, SnapshotRefSchema } from '@aether/workspace';
import { MechanicalVerificationResultSchema } from '@aether/verification';
import { EvaluationSpecSchema, ExperimentConfigSchema, EditorialVerificationResultSchema } from '@aether/verification/evaluator';
import { fixture, projectFixture, taskFixture, safetyFixture, planFixture, configFixture, evaluationFixture } from './fixtures.js';

const project = projectFixture();
const reference = { assetId: project.assets[0]!.id, range: { startMs: 1200, endMs: 1800 } };
const lock = { id: 'user-lock-1', createdBy: 'user', mode: 'retain_source_coverage', sourceRanges: [reference], provenanceId: 'explicit-user-action-1' };
const snapshot = { revision: 0, contentHash: 'c'.repeat(64) };
const operation = { type: 'split', operationId: 'operation-1', clipId: 'clip-main', atSourceMs: 400 };
const batch = { schemaVersion: 1, batchId: 'batch-1', workspaceId: 'workspace-1', expectedRevision: 0, operations: [operation] };
const result = { schemaVersion: 1, checkId: 'fixture-check', kind: 'deterministic', status: 'review', evidence: [{ message: 'No evaluator implemented.' }], evaluatedContentHash: snapshot.contentHash };
const objects: Array<[string, z.ZodType, unknown]> = [
  ['ProjectIR', ProjectIRSchema, fixture('project')],
  ['SourceAsset', SourceAssetSchema, project.assets[0]],
  ['MediaSegment', MediaSegmentSchema, project.segments[0]],
  ['TimelineClip', TimelineClipSchema, project.sequence.clips[0]],
  ['Range', RangeSchema, reference.range], ['SourceRef', SourceRefSchema, reference],
  ['DurationTarget', DurationTargetSchema, { minMs: 1500, maxMs: 2500 }],
  ['UserLock', UserLockSchema, lock], ['Safety', KernelSafetyContextSchema, fixture('safety')],
  ['Task', TaskInstructionsSchema, fixture('task')], ['IntentItem', IntentItemSchema, { description: 'Caveat', inferredRanges: [] }],
  ['Contract', EditContractSchema, fixture('contract')], ['Plan', EditorialPlanSchema, fixture('plan')],
  ['Operation', EditOperationSchema, operation], ['Batch', EditBatchSchema, batch],
  ['SnapshotRef', SnapshotRefSchema, snapshot],
  ['Workspace', AgentWorkspaceSchema, { schemaVersion: 1, id: 'workspace-1', projectId: project.id,
    base: snapshot, head: snapshot, safetyContextHash: 'd'.repeat(64), state: 'open',
    undoReceiptIds: [], redoReceiptIds: [], proposedBatches: [batch], previewIds: [] }],
  ['Evaluation', EvaluationSpecSchema, fixture('evaluation')], ['ExperimentConfig', ExperimentConfigSchema, fixture('config')],
  ['MechanicalResult', MechanicalVerificationResultSchema, { ...result, scope: 'mechanical' }],
  ['EditorialResult', EditorialVerificationResultSchema, { ...result, scope: 'editorial' }],
];

for (const [name, schema, value] of objects) {
  test(`${name}: deterministic valid fixture and strict unknown-field rejection`, () => {
    assert.equal(schema.safeParse(value).success, true);
    assert.equal(schema.safeParse({ ...(value as object), hiddenUnexpected: 'reject-me' }).success, false);
    assert.equal(schema.safeParse(null).success, false);
    assert.equal(schema.safeParse([]).success, false);
  });
}

test('unknown fields are rejected inside nested project, task, safety, plan and evaluation objects', () => {
  const asset = project.assets[0]!;
  assert.equal(ProjectIRSchema.safeParse({ ...project, assets: [{ ...asset, video: { ...asset.video, hiddenScore: 1 } }] }).success, false);
  assert.equal(TaskInstructionsSchema.safeParse({ ...taskFixture(), userProvidedSourceSelections: [{ ...reference, goldLabel: 'hidden' }] }).success, false);
  assert.equal(KernelSafetyContextSchema.safeParse({ ...safetyFixture(), userLocks: [{ ...lock, annotationId: 'hidden' }] }).success, false);
  assert.equal(EditorialPlanSchema.safeParse({ ...planFixture(), reorderings: [{ segmentId: 'a', beforeSegmentId: null, goldScore: 1 }] }).success, false);
  const evaluation = evaluationFixture();
  assert.equal(EvaluationSpecSchema.safeParse({ ...evaluation, retentionCriteria: [{ ...evaluation.retentionCriteria[0], leaked: true }] }).success, false);
  assert.equal(ExperimentConfigSchema.safeParse({ ...configFixture(), model: { provider: 'x', modelId: 'y', version: 'z', unexpected: true } }).success, false);
});

test('project has no task, policy, safety, lock or evaluator fields', () => {
  for (const field of ['taskId', 'rawRequest', 'policy', 'userLocks', 'safetyContext', 'evaluationSpec', 'experimentId', 'evaluationSpecHash']) {
    assert.equal(ProjectIRSchema.safeParse({ ...project, [field]: 'not-project-content' }).success, false, field);
  }
});

test('malformed scalar values, missing required fields and unsupported versions are rejected', () => {
  for (const startMs of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '0']) {
    assert.equal(RangeSchema.safeParse({ startMs, endMs: 2000 }).success, false);
  }
  assert.equal(RangeSchema.safeParse({ startMs: 40, endMs: 40 }).success, false);
  assert.equal(RangeSchema.safeParse({ startMs: 80, endMs: 40 }).success, false);
  assert.equal(DurationTargetSchema.safeParse({ minMs: 2000, maxMs: 1000 }).success, false);
  assert.equal(TaskInstructionsSchema.safeParse({ ...taskFixture(), rawRequest: undefined }).success, false);
  assert.equal(ProjectIRSchema.safeParse({ ...project, schemaVersion: 2 }).success, false);
  assert.equal(ExperimentConfigSchema.safeParse({ ...configFixture(), sampling: { temperature: NaN } }).success, false);
  assert.equal(ExperimentConfigSchema.safeParse({ ...configFixture(), budget: { ...configFixture().budget, maxTokens: -1 } }).success, false);
});

test('canonical asset reference excludes absolute, traversing, alternate-spelling and mismatched paths', () => {
  const asset = project.assets[0]!;
  for (const mediaPath of ['C:/Users/Alice/source.mp4', 'D:\\Bob\\source.mp4', '/tmp/source.mp4', '../assets/file', 'assets/../file', `assets\\${asset.contentHash}`, `./assets/${asset.contentHash}`, `assets/${'d'.repeat(64)}`]) {
    assert.equal(SourceAssetSchema.safeParse({ ...asset, mediaPath }).success, false, mediaPath);
  }
  assert.equal(SourceAssetSchema.safeParse({ ...asset, id: 'wrong-content-id' }).success, false);
});

test('CFR metadata, integer frame alignment and static project structure are validated without editing behavior', () => {
  const asset = project.assets[0]!;
  assert.equal(SourceAssetSchema.safeParse({ ...asset, durationMs: 4001 }).success, false);
  assert.equal(SourceAssetSchema.safeParse({ ...asset, frameCount: Number.MAX_SAFE_INTEGER }).success, false);
  assert.equal(SourceAssetSchema.safeParse({ ...asset, video: { ...asset.video, fpsNumerator: 30 } }).success, false);
  assert.equal(SourceAssetSchema.safeParse({ ...asset, audio: { ...asset.audio, sampleRate: 44100 } }).success, false);
  const first = project.sequence.clips[0]!;
  assert.equal(TimelineClipSchema.safeParse({ ...first, timelineStartMs: 1 }).success, false);
  assert.equal(ProjectIRSchema.safeParse({ ...project, sequence: { ...project.sequence, clips: [first, first] } }).success, false);
  assert.equal(ProjectIRSchema.safeParse({ ...project, segments: [project.segments[0], project.segments[0]] }).success, false);
  assert.equal(ProjectIRSchema.safeParse({ ...project, segments: [{ ...project.segments[0], assetId: 'missing' }] }).success, false);
  assert.equal(ProjectIRSchema.safeParse({ ...project, segments: [{ ...project.segments[0], sourceRange: { startMs: 10, endMs: 5000 } }] }).success, false);
  assert.equal(ProjectIRSchema.safeParse({ ...project, sequence: { ...project.sequence, clips: [first, { ...project.sequence.clips[1], timelineStartMs: 400 }] } }).success, false);
  assert.equal(ProjectIRSchema.safeParse({ ...project, sequence: { ...project.sequence, clips: [] } }).success, true);
  // Transcript times intentionally differ from legal cut-grid boundaries.
  assert.equal(MediaSegmentSchema.safeParse(project.segments[0]).success, true);
});

test('genuine locks require explicit user provenance; task/contract schemas do not grant lock authority', () => {
  assert.equal(UserLockSchema.safeParse({ ...lock, createdBy: 'model' }).success, false);
  assert.equal(UserLockSchema.safeParse({ ...lock, provenanceId: undefined }).success, false);
  assert.equal(UserLockSchema.safeParse({ ...lock, sourceRanges: [] }).success, false);
  assert.equal(TaskInstructionsSchema.safeParse({ ...taskFixture(), userLocks: [lock] }).success, false);
  assert.equal(KernelSafetyContextSchema.safeParse({ ...safetyFixture(), userLocks: [lock, lock] }).success, false);
});

test('all five operation command shapes parse as strict data contracts', () => {
  const variants = [operation,
    { type: 'trim', operationId: 'trim-1', clipId: 'clip-main', sourceRange: { startMs: 40, endMs: 800 } },
    { type: 'delete', operationId: 'delete-1', clipId: 'clip-main' },
    { type: 'ripple_delete', operationId: 'ripple-1', clipId: 'clip-main' },
    { type: 'move', operationId: 'move-1', clipId: 'clip-main', destinationTimelineStartMs: 3000 }];
  for (const value of variants) assert.equal(EditOperationSchema.safeParse(value).success, true);
  assert.equal(EditOperationSchema.safeParse({ ...operation, type: 'overwrite' }).success, false);
  assert.equal(EditBatchSchema.safeParse({ ...batch, operations: [operation, operation] }).success, false);
});

test('plan choices must be disjoint, unique and acyclic', () => {
  const plan = planFixture();
  assert.equal(EditorialPlanSchema.safeParse({ ...plan, removedSegments: ['segment-main'] }).success, false);
  assert.equal(EditorialPlanSchema.safeParse({ ...plan, selectedSegments: ['a', 'a'] }).success, false);
  assert.equal(EditorialPlanSchema.safeParse({ ...plan, reorderings: [{ segmentId: 'a', beforeSegmentId: 'b' }, { segmentId: 'b', beforeSegmentId: 'a' }] }).success, false);
});

test('public mechanical result schema cannot carry editorial results', () => {
  assert.equal(MechanicalVerificationResultSchema.safeParse({ ...result, scope: 'editorial' }).success, false);
  assert.equal(EditorialVerificationResultSchema.safeParse({ ...result, scope: 'mechanical' }).success, false);
});
