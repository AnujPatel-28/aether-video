import { EditOperationSchema } from './operations.js';
import type { EditOperation } from './operations.js';
import { kernelFailure } from './kernel-results.js';
import type { AlignmentReceipt, KernelFailure, NormalizedOperation, TimeAlignment } from './kernel-results.js';

export const FRAME_MS = 40;

export function alignTimeMs(requested: unknown): ({ ok: true } & TimeAlignment) | KernelFailure {
  if (typeof requested !== 'number' || !Number.isSafeInteger(requested) || requested < 0) {
    return kernelFailure('timing_alignment', 'normalization', 'Timing must be a nonnegative safe integer');
  }
  const requestedMs = requested === 0 ? 0 : requested;
  const remainder = requestedMs % FRAME_MS;
  const earlier = requestedMs - remainder;
  const effectiveMs = remainder <= FRAME_MS / 2 ? earlier : earlier + FRAME_MS;
  if (!Number.isSafeInteger(effectiveMs)) {
    return kernelFailure('timing_alignment', 'normalization', 'Aligned timing exceeds safe integer extent', { requestedMs });
  }
  return { ok: true, requestedMs, effectiveMs, deltaMs: effectiveMs - requestedMs };
}

export function normalizeEditOperation(input: unknown): ({ ok: true } & NormalizedOperation) | KernelFailure {
  const parsed = EditOperationSchema.safeParse(input);
  if (!parsed.success) return kernelFailure('schema_invalid', 'normalization', 'Invalid edit operation');
  const requested = parsed.data;
  const effective: EditOperation = structuredClone(requested);
  const alignments: AlignmentReceipt[] = [];
  const times: [string, number][] = requested.type === 'split' ? [['atSourceMs', requested.atSourceMs]]
    : requested.type === 'trim' ? [['sourceRange.startMs', requested.sourceRange.startMs], ['sourceRange.endMs', requested.sourceRange.endMs]]
      : requested.type === 'move' ? [['destinationTimelineStartMs', requested.destinationTimelineStartMs]] : [];
  for (const [field, time] of times) {
    const alignment = alignTimeMs(time);
    if (!alignment.ok) return alignment;
    const { ok: _, ...record } = alignment;
    alignments.push({ field, ...record });
  }
  if (effective.type === 'split') effective.atSourceMs = alignments[0]!.effectiveMs;
  if (effective.type === 'move') effective.destinationTimelineStartMs = alignments[0]!.effectiveMs;
  if (effective.type === 'trim') {
    effective.sourceRange = { startMs: alignments[0]!.effectiveMs, endMs: alignments[1]!.effectiveMs };
    if (effective.sourceRange.endMs <= effective.sourceRange.startMs) {
      return kernelFailure('timing_alignment', 'normalization', 'Alignment collapses the requested source range', { operationId: requested.operationId });
    }
  }
  return { ok: true, requested, effective, alignments };
}
