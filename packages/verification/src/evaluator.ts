import { z } from 'zod';
import { DigestSchema, DurationTargetSchema, IdSchema, PositiveIntSchema, SourceRefSchema, UIntSchema } from '@aether/core';
import type { ProjectIR, SourceRef } from '@aether/core';
import { resultFields } from './result-fields.js';

// Trusted evaluator-only contracts. Never re-export through the public entry.
const JsonValueSchema = z.json();
export const EvaluationSpecSchema = z.strictObject({
  schemaVersion: z.literal(1), id: IdSchema, sourceHash: DigestSchema, transcriptHash: DigestSchema,
  targetDuration: DurationTargetSchema,
  retentionCriteria: z.array(z.strictObject({
    id: IdSchema, description: z.string(), referenceRanges: z.array(SourceRefSchema).min(1),
    contextRanges: z.array(SourceRefSchema),
  })),
  semanticRubric: z.array(z.strictObject({ id: IdSchema, description: z.string() })),
});
export const ExperimentConfigSchema = z.strictObject({
  schemaVersion: z.literal(1), id: IdSchema, taskId: IdSchema, evaluationSpecId: IdSchema,
  initialContentHash: DigestSchema, safetyContextHash: DigestSchema,
  model: z.strictObject({ provider: IdSchema, modelId: IdSchema, version: IdSchema }),
  sampling: z.record(z.string(), JsonValueSchema),
  budget: z.strictObject({
    maxTokens: PositiveIntSchema, maxToolCalls: PositiveIntSchema,
    maxRepairAttempts: UIntSchema, timeoutMs: PositiveIntSchema,
  }),
  rendererPresetHash: DigestSchema, evaluatorConfigHash: DigestSchema, trialSeed: UIntSchema,
});
export const EditorialVerificationResultSchema = z.strictObject({
  ...resultFields, scope: z.literal('editorial'),
});
export type EvaluationSpec = z.infer<typeof EvaluationSpecSchema>;
export type ExperimentConfig = z.infer<typeof ExperimentConfigSchema>;
export type EditorialVerificationResult = z.infer<typeof EditorialVerificationResultSchema>;

// ---- Milestone 5: deterministic offline evaluation over frozen submissions (F7). ----

export const EVALUATOR_VERSION = 'evaluator.v1';
/** Delivery tolerance from Milestone 4: one video frame plus one AAC frame. Within it of a boundary → review. */
export const DURATION_REVIEW_US = 40_000 + Math.ceil(1024 * 1_000_000 / 48_000);

export interface FrozenSubmission {
  contentHash: string;
  project: ProjectIR;
  /** Measured delivered duration of the frozen delivery render, or null if it could not be rendered. */
  deliveredDurationUs: number | null;
}

type Status = EditorialVerificationResult['status'];
type Evidence = EditorialVerificationResult['evidence'];

/** True when the union of the timeline's source ranges covers the whole reference range. */
export function coversRange(project: ProjectIR, reference: SourceRef): boolean {
  const intervals = project.sequence.clips.filter(clip => clip.assetId === reference.assetId)
    .map(clip => clip.sourceRange).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  let coveredUntil = reference.range.startMs;
  for (const interval of intervals) {
    if (interval.endMs <= coveredUntil) continue;
    if (interval.startMs > coveredUntil) break;
    coveredUntil = interval.endMs;
    if (coveredUntil >= reference.range.endMs) return true;
  }
  return coveredUntil >= reference.range.endMs;
}

/** Pure and deterministic. Sees only the frozen output and the hidden spec: no arm, trace, notes or plan. */
export function evaluateSubmission(specInput: EvaluationSpec, submission: FrozenSubmission): EditorialVerificationResult[] {
  const spec = EvaluationSpecSchema.parse(specInput);
  const asset = submission.project.assets[0]!;
  if (asset.contentHash !== spec.sourceHash || submission.project.transcriptHash !== spec.transcriptHash) {
    throw new Error('Evaluation spec does not belong to this source');
  }
  const result = (checkId: string, kind: 'deterministic' | 'model_assisted', status: Status, evidence: Evidence): EditorialVerificationResult =>
    EditorialVerificationResultSchema.parse({ schemaVersion: 1, checkId, kind, status, evidence, evaluatedContentHash: submission.contentHash, scope: 'editorial' });

  const results: EditorialVerificationResult[] = [];
  const { minMs, maxMs } = spec.targetDuration;
  const delivered = submission.deliveredDurationUs;
  let durationStatus: Status;
  if (delivered === null) durationStatus = 'fail';
  else if ([minMs, maxMs].some(bound => Math.abs(delivered - bound * 1000) <= DURATION_REVIEW_US)) durationStatus = 'review';
  else durationStatus = delivered >= minMs * 1000 && delivered <= maxMs * 1000 ? 'pass' : 'fail';
  results.push(result('duration', 'deterministic', durationStatus, [{
    message: delivered === null ? 'No delivery render' : `Delivered ${Math.round(delivered / 1000)} ms; target ${minMs}-${maxMs} ms`,
  }]));

  for (const criterion of spec.retentionCriteria) {
    const missing = criterion.referenceRanges.filter(reference => !coversRange(submission.project, reference));
    results.push(result(`retention:${criterion.id}`, 'deterministic', missing.length === 0 ? 'pass' : 'fail',
      missing.length === 0 ? [{ message: 'All reference ranges retained' }]
        : missing.map(source => ({ message: 'Reference range not fully retained', source }))));
  }
  for (const rubric of spec.semanticRubric) {
    results.push(result(`semantic:${rubric.id}`, 'model_assisted', 'review', [{ message: 'No semantic judge configured' }]));
  }
  const hard = results.filter(item => item.checkId === 'duration' || item.checkId.startsWith('retention:'));
  const primary: Status = hard.some(item => item.status === 'fail') ? 'fail' : hard.some(item => item.status === 'review') ? 'review' : 'pass';
  results.push(result('all_hard_criteria', 'deterministic', primary, [{ message: 'Duration and every retention criterion' }]));
  return results;
}
