import { z } from 'zod';
import { DigestSchema, DurationTargetSchema, IdSchema, PositiveIntSchema, SourceRefSchema, UIntSchema } from '@aether/core';
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
