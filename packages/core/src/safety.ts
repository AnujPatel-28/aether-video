import { z } from 'zod';
import { IdSchema, PositiveIntSchema, SourceRefSchema } from './primitives.js';

export const OperationKindSchema = z.enum(['split', 'trim', 'delete', 'ripple_delete', 'move']);
export const UserLockSchema = z.strictObject({
  id: IdSchema, createdBy: z.literal('user'), mode: z.literal('retain_source_coverage'),
  sourceRanges: z.array(SourceRefSchema).min(1), provenanceId: IdSchema,
});
export const KernelSafetyContextSchema = z.strictObject({
  schemaVersion: z.literal(1), projectId: IdSchema,
  allowedOperations: z.array(OperationKindSchema), maxOperationsPerBatch: PositiveIntSchema,
  userLocks: z.array(UserLockSchema),
}).superRefine((safety, context) => {
  if (new Set(safety.allowedOperations).size !== safety.allowedOperations.length) {
    context.addIssue({ code: 'custom', path: ['allowedOperations'], message: 'Duplicate operation permission' });
  }
  if (new Set(safety.userLocks.map(lock => lock.id)).size !== safety.userLocks.length) {
    context.addIssue({ code: 'custom', path: ['userLocks'], message: 'Duplicate lock identity' });
  }
});

export type OperationKind = z.infer<typeof OperationKindSchema>;
export type UserLock = z.infer<typeof UserLockSchema>;
export type KernelSafetyContext = z.infer<typeof KernelSafetyContextSchema>;
