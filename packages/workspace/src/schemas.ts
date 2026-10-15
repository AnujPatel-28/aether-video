import { z } from 'zod';
import { DigestSchema, EditBatchSchema, EditOperationSchema, IdSchema, MsSchema, UIntSchema } from '@aether/core';
import type { KernelError } from '@aether/core';
import type { MediaError } from '@aether/media';

const RESERVED_NAMES = new Set(['con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]);

/** The only caller-chosen IDs that become directory names: projectId and workspaceId (D3). */
export const StoreSegmentSchema = z.string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, 'Lowercase [a-z0-9-], 1-64 characters')
  .refine(value => !RESERVED_NAMES.has(value), 'Reserved device name');

export const SnapshotRefSchema = z.strictObject({ revision: UIntSchema, contentHash: DigestSchema });
export const WorkspaceStateSchema = z.enum(['open', 'frozen', 'committed', 'discarded']);
export const AgentWorkspaceSchema = z.strictObject({
  schemaVersion: z.literal(1), id: IdSchema, projectId: IdSchema,
  base: SnapshotRefSchema, head: SnapshotRefSchema, safetyContextHash: DigestSchema,
  taskId: IdSchema.optional(), state: WorkspaceStateSchema,
  undoReceiptIds: z.array(IdSchema), redoReceiptIds: z.array(IdSchema),
  proposedBatches: z.array(EditBatchSchema), previewIds: z.array(IdSchema),
});

export const CommittedBatchSchema = z.strictObject({ batchId: IdSchema, payloadDigest: DigestSchema, receiptId: IdSchema });
export const SubmissionSchema = z.strictObject({ revision: UIntSchema, contentHash: DigestSchema, notesRevision: UIntSchema });
export const WorkspaceHeadSchema = AgentWorkspaceSchema.extend({
  committedBatches: z.array(CommittedBatchSchema),
  submission: SubmissionSchema.optional(),
}).superRefine((head, context) => {
  if ((head.state === 'frozen') !== (head.submission !== undefined)) {
    context.addIssue({ code: 'custom', path: ['submission'], message: 'Submission is present exactly when frozen' });
  }
  if (new Set(head.committedBatches.map(entry => entry.batchId)).size !== head.committedBatches.length) {
    context.addIssue({ code: 'custom', path: ['committedBatches'], message: 'Duplicate batch identity' });
  }
});

export const PromotionSchema = z.strictObject({ revision: UIntSchema, workspaceId: IdSchema, workspaceRevision: UIntSchema });
export const AcceptedHeadSchema = z.strictObject({
  schemaVersion: z.literal(1), revision: UIntSchema, contentHash: DigestSchema, promotions: z.array(PromotionSchema),
});

const AlignmentReceiptSchema = z.strictObject({ field: z.string(), requestedMs: MsSchema, effectiveMs: MsSchema, deltaMs: z.number().int() });
export const OperationReceiptSchema = z.strictObject({
  requested: EditOperationSchema, effective: EditOperationSchema, alignments: z.array(AlignmentReceiptSchema),
  operationIndex: UIntSchema, outcome: z.enum(['applied', 'no_change']),
  createdClipIds: z.array(IdSchema), retiredClipIds: z.array(IdSchema),
});
/** Validated in place, not rebuilt: z.record would drop opaque keys such as `__proto__`. */
const ClipMappingsSchema = z.custom<Record<string, string[]>>(value =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  && Object.values(value).every(ids => Array.isArray(ids) && ids.every(id => IdSchema.safeParse(id).success)),
'Invalid clip mappings');
export const BatchReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1), receiptId: IdSchema, workspaceId: IdSchema, batchId: IdSchema, payloadDigest: DigestSchema,
  fromRevision: UIntSchema, toRevision: UIntSchema,
  beforeContentHash: DigestSchema, afterContentHash: DigestSchema, safetyContextHash: DigestSchema,
  operationReceipts: z.array(OperationReceiptSchema).min(1),
  clipMappings: ClipMappingsSchema, changed: z.boolean(),
});

export const AttemptKindSchema = z.enum(['edit', 'undo', 'redo', 'promote', 'discard', 'freeze', 'notes']);
export const AttemptRecordSchema = z.strictObject({
  sequence: UIntSchema, kind: AttemptKindSchema, outcome: z.enum(['ok', 'replayed', 'no_change', 'error']),
  errorCode: z.string().optional(), receiptId: IdSchema.optional(), elapsedMs: z.number().nonnegative(),
});

export const NOTES_MAX_BYTES = 16 * 1024;
export const NotesSchema = z.strictObject({ revision: UIntSchema, text: z.string() });

export type SnapshotRef = z.infer<typeof SnapshotRefSchema>;
export type AgentWorkspace = z.infer<typeof AgentWorkspaceSchema>;
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;
export type WorkspaceHead = z.infer<typeof WorkspaceHeadSchema>;
export type AcceptedHead = z.infer<typeof AcceptedHeadSchema>;
export type BatchReceipt = z.infer<typeof BatchReceiptSchema>;
export type AttemptKind = z.infer<typeof AttemptKindSchema>;
export type AttemptRecord = z.infer<typeof AttemptRecordSchema>;
export type Notes = z.infer<typeof NotesSchema>;

export type WorkspaceErrorCode = 'stale_revision' | 'workspace_mismatch' | 'workspace_not_open' | 'batch_id_conflict'
  | 'stale_base' | 'safety_changed' | 'store_corrupt' | 'owner_locked' | 'nothing_to_undo' | 'nothing_to_redo'
  | 'notes_too_large' | 'invalid_segment' | 'kernel'
  // Additions recorded in the implementation record.
  | 'already_exists' | 'project_not_found' | 'empty_timeline' | 'invalid_input' | 'io_failed'
  // Milestone 4.
  | 'media' | 'media_unavailable' | 'stale_content';
export interface WorkspaceError {
  code: WorkspaceErrorCode;
  message: string;
  // Public mechanical evidence only; never raw caller input.
  evidence: { workspaceId?: string; receiptId?: string; expected?: number; actual?: number; file?: string };
  kernel?: KernelError;
  media?: MediaError;
}
export type StoreResult<T> = ({ ok: true } & T) | { ok: false; error: WorkspaceError };
