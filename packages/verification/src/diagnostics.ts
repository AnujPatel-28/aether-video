import { z } from 'zod';
import { IdSchema, SourceRefSchema } from '@aether/core';
import type { MediaSegment, SourceRef } from '@aether/core';
import { EditorialVerificationResultSchema, EvaluationSpecSchema } from './evaluator.js';
import type { EditorialVerificationResult, EvaluationSpec } from './evaluator.js';

// Trusted, post-freeze failure-stage diagnostics (Proposal 001 P1). Never reaches agents; never changes results.
export const DIAGNOSTICS_VERSION = 'diagnostics.v1';

export const FailureStageSchema = z.enum(['not_retrieved', 'retrieved_not_kept', 'intended_not_executed']);
export const DiagnosticsSchema = z.strictObject({
  schemaVersion: z.literal(1), rules: z.literal(DIAGNOSTICS_VERSION),
  stages: z.array(z.strictObject({ criterionId: IdSchema, stage: FailureStageSchema })),
});
export type FailureStage = z.infer<typeof FailureStageSchema>;
export type Diagnostics = z.infer<typeof DiagnosticsSchema>;

export interface DiagnosticsInput {
  spec: EvaluationSpec;
  /** Frozen editorial results for one submission. */
  results: EditorialVerificationResult[];
  /** Tool trace events: only content-bearing reads count as retrieval. */
  trace: { contentBearing: boolean; returnedSourceRanges: SourceRef[] }[];
  /** Persistent free-form notes; only segment IDs in them count as durable intent. */
  notesText: string;
  /** AETHER EditorialPlan.selectedSegments, when the arm has one. */
  planSelectedSegmentIds?: string[];
  /** The project's transcript segments, to resolve segment IDs to source ranges. */
  segments: MediaSegment[];
}

const SEGMENT_ID = /segment-[a-f0-9]{64}/g;
const overlaps = (a: SourceRef, b: SourceRef) =>
  a.assetId === b.assetId && a.range.startMs < b.range.endMs && b.range.startMs < a.range.endMs;

/**
 * Rules (diagnostics.v1), applied to each failed retention criterion:
 * 1. not_retrieved: no content-bearing read returned a range overlapping a reference range.
 * 2. intended_not_executed: retrieved, and a plan selection or a segment ID in the notes overlaps a reference range.
 * 3. retrieved_not_kept: retrieved, with no such durable intent.
 */
export function diagnose(input: DiagnosticsInput): Diagnostics {
  const spec = EvaluationSpecSchema.parse(input.spec);
  const results = z.array(EditorialVerificationResultSchema).parse(input.results);
  const ranges = new Map(input.segments.map(segment => [segment.id, { assetId: segment.assetId, range: segment.sourceRange }]));
  const intended = [...new Set([...(input.notesText.match(SEGMENT_ID) ?? []), ...(input.planSelectedSegmentIds ?? [])])]
    .map(id => ranges.get(id)).filter((ref): ref is SourceRef => ref !== undefined);
  const retrieved = input.trace.filter(event => event.contentBearing)
    .flatMap(event => z.array(SourceRefSchema).parse(event.returnedSourceRanges));
  const failed = new Set(results.filter(item => item.status === 'fail' && item.checkId.startsWith('retention:'))
    .map(item => item.checkId.slice('retention:'.length)));
  const stages = spec.retentionCriteria.filter(criterion => failed.has(criterion.id)).map(criterion => {
    const hits = (refs: SourceRef[]) => refs.some(ref => criterion.referenceRanges.some(reference => overlaps(ref, reference)));
    const stage: FailureStage = !hits(retrieved) ? 'not_retrieved' : hits(intended) ? 'intended_not_executed' : 'retrieved_not_kept';
    return { criterionId: criterion.id, stage };
  });
  return DiagnosticsSchema.parse({ schemaVersion: 1, rules: DIAGNOSTICS_VERSION, stages });
}
