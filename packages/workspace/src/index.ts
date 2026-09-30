import { z } from 'zod';
import { DigestSchema, EditBatchSchema, IdSchema, UIntSchema } from '@aether/core';

// State shapes only: no history, persistence or lifecycle behavior in Milestone 1.
export const SnapshotRefSchema = z.strictObject({ revision: UIntSchema, contentHash: DigestSchema });
export const AgentWorkspaceSchema = z.strictObject({
  schemaVersion: z.literal(1), id: IdSchema, projectId: IdSchema,
  base: SnapshotRefSchema, head: SnapshotRefSchema, safetyContextHash: DigestSchema,
  taskId: IdSchema.optional(), state: z.enum(['open', 'committed', 'discarded']),
  undoReceiptIds: z.array(IdSchema), redoReceiptIds: z.array(IdSchema),
  proposedBatches: z.array(EditBatchSchema), previewIds: z.array(IdSchema),
});
export type SnapshotRef = z.infer<typeof SnapshotRefSchema>;
export type AgentWorkspace = z.infer<typeof AgentWorkspaceSchema>;
