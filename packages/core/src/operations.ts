import { z } from 'zod';
import { IdSchema, MsSchema, RangeSchema, UIntSchema } from './primitives.js';

// Command data contracts only. No operation execution or kernel in Milestone 1.
const fields = { operationId: IdSchema };
export const EditOperationSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...fields, type: z.literal('split'), clipId: IdSchema, atSourceMs: MsSchema }),
  z.strictObject({ ...fields, type: z.literal('trim'), clipId: IdSchema, sourceRange: RangeSchema }),
  z.strictObject({ ...fields, type: z.literal('delete'), clipId: IdSchema }),
  z.strictObject({ ...fields, type: z.literal('ripple_delete'), clipId: IdSchema }),
  z.strictObject({ ...fields, type: z.literal('move'), clipId: IdSchema, destinationTimelineStartMs: MsSchema }),
]);
export const EditBatchSchema = z.strictObject({
  schemaVersion: z.literal(1), batchId: IdSchema, workspaceId: IdSchema,
  expectedRevision: UIntSchema, operations: z.array(EditOperationSchema).min(1),
}).refine(batch => new Set(batch.operations.map(operation => operation.operationId)).size === batch.operations.length,
  'Operation identities must be unique within a batch');

export type EditOperation = z.infer<typeof EditOperationSchema>;
export type EditBatch = z.infer<typeof EditBatchSchema>;
