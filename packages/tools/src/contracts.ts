import { z } from 'zod';
import { DigestSchema, EditBatchSchema, EditOperationSchema, IdSchema, MsSchema, PositiveIntSchema, RangeSchema, SourceRefSchema, UIntSchema } from '@aether/core';
import { TaskInstructionsSchema } from './task.js';

// Shared agent surface: identical for every experimental arm. Schemas only; the trusted host implements them.
export const TOOL_NAMES = [
  'get_timeline', 'get_task', 'search_transcript', 'inspect_segment', 'preview_range',
  'apply_edit_batch', 'write_notes', 'read_notes', 'submit',
] as const;
export const ToolNameSchema = z.enum(TOOL_NAMES);

export const ToolLimitsSchema = z.strictObject({
  maxTimelinePage: PositiveIntSchema, maxSearchResults: PositiveIntSchema, maxQueryChars: PositiveIntSchema,
  maxContextMs: UIntSchema, maxPreviewMs: PositiveIntSchema, maxToolCalls: PositiveIntSchema, maxTokens: PositiveIntSchema,
});
export const DEFAULT_TOOL_LIMITS: ToolLimits = Object.freeze({
  maxTimelinePage: 200, maxSearchResults: 20, maxQueryChars: 200, maxContextMs: 30_000, maxPreviewMs: 60_000, maxToolCalls: 60, maxTokens: 200_000,
});

const workspace = { workspaceId: IdSchema };
export const ToolInputSchemas = {
  get_timeline: z.strictObject({ ...workspace, cursor: UIntSchema.optional() }),
  get_task: z.strictObject(workspace),
  search_transcript: z.strictObject({ ...workspace, query: z.string().min(1), limit: PositiveIntSchema.optional(), cursor: UIntSchema.optional() }),
  inspect_segment: z.strictObject({ ...workspace, segmentId: IdSchema, contextMs: UIntSchema.optional() }),
  preview_range: z.strictObject({ ...workspace, timelineRange: RangeSchema }),
  apply_edit_batch: EditBatchSchema,
  write_notes: z.strictObject({ ...workspace, expectedRevision: UIntSchema, text: z.string() }),
  read_notes: z.strictObject(workspace),
  submit: z.strictObject(workspace),
} satisfies Record<ToolName, z.ZodType>;

const Coverage = z.enum(['full', 'partial', 'none']);
const SegmentView = z.strictObject({
  segmentId: IdSchema, sourceRange: RangeSchema, text: z.string(), speaker: z.string().optional(), coverage: Coverage,
});
const AlignmentView = z.strictObject({ field: z.string(), requestedMs: MsSchema, effectiveMs: MsSchema, deltaMs: z.number().int() });
const Head = z.strictObject({ revision: UIntSchema, contentHash: DigestSchema });

export const ToolOutputSchemas = {
  get_timeline: z.strictObject({
    revision: UIntSchema, contentHash: DigestSchema, assetId: IdSchema, durationMs: MsSchema, frameMs: z.literal(40),
    clips: z.array(z.strictObject({ clipId: IdSchema, sourceRange: RangeSchema, timelineRange: RangeSchema })),
    gaps: z.array(RangeSchema), totalClips: UIntSchema, nextCursor: UIntSchema.optional(),
  }),
  get_task: z.strictObject({
    task: TaskInstructionsSchema, locks: z.array(z.strictObject({ lockId: IdSchema, sourceRanges: z.array(SourceRefSchema) })),
  }),
  search_transcript: z.strictObject({
    matches: z.array(z.strictObject({ segmentId: IdSchema, sourceRange: RangeSchema, excerpt: z.string(), score: UIntSchema })),
    nextCursor: UIntSchema.optional(),
  }),
  inspect_segment: z.strictObject({ segment: SegmentView, context: z.array(SegmentView) }),
  preview_range: z.strictObject({
    requestedRange: RangeSchema, effectiveRange: RangeSchema, artifactId: IdSchema,
    transcript: z.array(z.strictObject({ timelineRange: RangeSchema, sourceRange: RangeSchema, segmentId: IdSchema, text: z.string() })),
    timing: z.strictObject({ expectedDurationMs: MsSchema, measuredVideoDurationUs: z.number(), measuredAudioDurationUs: z.number() }),
    checks: z.array(z.strictObject({ checkId: z.string(), status: z.enum(['pass', 'fail']) })),
  }),
  apply_edit_batch: z.strictObject({
    outcome: z.enum(['applied', 'no_change']), replayed: z.boolean(), head: Head,
    receipt: z.strictObject({
      receiptId: IdSchema, effectiveOperations: z.array(EditOperationSchema), alignments: z.array(AlignmentView),
      createdClipIds: z.array(IdSchema), retiredClipIds: z.array(IdSchema),
    }),
  }),
  write_notes: z.strictObject({ revision: UIntSchema }),
  read_notes: z.strictObject({ revision: UIntSchema, text: z.string() }),
  submit: z.strictObject({ head: Head, artifactId: IdSchema.optional(), renderError: z.string().optional() }),
} satisfies Record<ToolName, z.ZodType>;

export const ToolErrorCodeSchema = z.enum([
  'invalid_input', 'unknown_tool', 'workspace_mismatch', 'limit_exceeded', 'budget_exhausted', 'submitted',
  'not_found', 'stale_revision', 'batch_id_conflict', 'workspace_not_open', 'kernel', 'media_failed', 'internal',
]);
export const ToolErrorSchema = z.strictObject({
  code: ToolErrorCodeSchema, message: z.string(),
  // Mechanical evidence only (kernel error code, operation index, limits); never hidden data or raw input.
  evidence: z.strictObject({
    kernelCode: z.string().optional(), operationIndex: UIntSchema.optional(), limit: UIntSchema.optional(),
    expected: UIntSchema.optional(), actual: UIntSchema.optional(), mediaCode: z.string().optional(),
  }),
});

export type ToolName = (typeof TOOL_NAMES)[number];
export type ToolLimits = z.infer<typeof ToolLimitsSchema>;
export type ToolInput<N extends ToolName> = z.infer<(typeof ToolInputSchemas)[N]>;
export type ToolOutput<N extends ToolName> = z.infer<(typeof ToolOutputSchemas)[N]>;
export type ToolError = z.infer<typeof ToolErrorSchema>;
export type ToolResult<N extends ToolName = ToolName> = { ok: true; data: ToolOutput<N> } | { ok: false; error: ToolError };
