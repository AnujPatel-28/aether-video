import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalSerialize, hashProjectIR } from './canonical.js';
import { EditBatchSchema, EditOperationSchema } from './operations.js';
import type { EditOperation } from './operations.js';
import { ProjectIRSchema } from './project.js';
import type { ProjectIR, TimelineClip } from './project.js';
import { KernelSafetyContextSchema } from './safety.js';
import type { KernelSafetyContext } from './safety.js';
import { kernelFailure } from './kernel-results.js';
import type { KernelFailure, KernelResult, KernelStage, NormalizedOperation, OperationReceipt } from './kernel-results.js';
import { FRAME_MS, normalizeEditOperation } from './timing.js';

const OperationsSchema = z.array(EditOperationSchema).min(1).refine(
  operations => new Set(operations.map(operation => operation.operationId)).size === operations.length);
const duration = (clip: TimelineClip) => clip.sourceRange.endMs - clip.sourceRange.startMs;
const timelineEnd = (clip: TimelineClip) => clip.timelineStartMs + duration(clip);

function structureError(issues: z.core.$ZodIssue[], stage: KernelStage, operationIndex?: number): KernelFailure {
  // Map only our own fixed structural messages. Zod may include unknown field names;
  // those messages/paths are intentionally not returned to the caller.
  const messages = issues.map(issue => issue.message);
  if (messages.includes('Unknown source asset')) return kernelFailure('invalid_reference', stage, 'Unknown source asset', {}, operationIndex);
  if (messages.includes('Source range exceeds playable media extent')) return kernelFailure('source_bounds', stage, 'Source range exceeds playable media extent', {}, operationIndex);
  if (messages.includes('Timeline clips overlap')) return kernelFailure('timeline_overlap', stage, 'Timeline clips overlap', {}, operationIndex);
  if (messages.some(message => message === 'Clip boundaries and positions must align to 40 ms frames' || message === 'Timeline end must be a safe integer')) {
    return kernelFailure('timing_alignment', stage, 'Invalid effective clip timing', {}, operationIndex);
  }
  return kernelFailure('schema_invalid', stage, 'Invalid project structure', {}, operationIndex);
}

function checkLocks(project: ProjectIR, safety: KernelSafetyContext, stage: 'safety' | 'final_locks'): KernelFailure | undefined {
  const asset = project.assets[0]!;
  for (const lock of safety.userLocks) {
    for (const reference of lock.sourceRanges) {
      const evidence = { lockId: lock.id, assetId: reference.assetId, range: { ...reference.range } };
      if (reference.assetId !== asset.id) return kernelFailure('invalid_reference', 'safety', 'Lock refers to an unknown asset', evidence);
      if (reference.range.endMs > asset.durationMs) return kernelFailure('source_bounds', 'safety', 'Lock range exceeds source extent', evidence);
      const intervals = project.sequence.clips.filter(clip => clip.assetId === reference.assetId)
        .map(clip => clip.sourceRange).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
      let coveredUntil = reference.range.startMs;
      for (const interval of intervals) {
        if (interval.endMs <= coveredUntil) continue;
        if (interval.startMs > coveredUntil) break;
        coveredUntil = interval.endMs;
        if (coveredUntil >= reference.range.endMs) break;
      }
      if (coveredUntil < reference.range.endMs) {
        return kernelFailure('lock_violation', stage, 'Genuine user-locked source coverage is incomplete', evidence);
      }
    }
  }
  return undefined;
}

function splitChildId(parent: TimelineClip, operation: Extract<EditOperation, { type: 'split' }>, side: 'left' | 'right'): string {
  const descriptor = {
    domain: 'aether.split-child.v1', parentClipId: parent.id, assetId: parent.assetId,
    parentSourceRange: parent.sourceRange, operationId: operation.operationId,
    effectiveAtSourceMs: operation.atSourceMs, side,
  };
  return `clip-split-${createHash('sha256').update(canonicalSerialize(descriptor), 'utf8').digest('hex')}`;
}

function execute(projectInput: unknown, rows: NormalizedOperation[], safetyInput: unknown): KernelResult {
  const projectParse = ProjectIRSchema.safeParse(projectInput);
  if (!projectParse.success) return structureError(projectParse.error.issues, 'project');
  const safetyParse = KernelSafetyContextSchema.safeParse(safetyInput);
  if (!safetyParse.success) return kernelFailure('schema_invalid', 'safety', 'Invalid kernel safety context');
  const beforeProject = projectParse.data;
  const safety = safetyParse.data;
  if (safety.projectId !== beforeProject.id) return kernelFailure('invalid_reference', 'safety', 'Safety context belongs to another project');
  if (rows.length > safety.maxOperationsPerBatch) {
    return kernelFailure('batch_limit', 'operations', 'Batch exceeds operation limit', { count: rows.length, limit: safety.maxOperationsPerBatch });
  }
  const initialLockError = checkLocks(beforeProject, safety, 'safety');
  if (initialLockError) return initialLockError;
  let provisional = structuredClone(beforeProject);
  const operationReceipts: OperationReceipt[] = [];
  const mappings = new Map<string, string[]>();
  for (const [operationIndex, row] of rows.entries()) {
    const operation = row.effective;
    const evidence = { operationId: operation.operationId, clipId: operation.clipId };
    const fail = (code: Parameters<typeof kernelFailure>[0], message: string) =>
      kernelFailure(code, 'operation', message, evidence, operationIndex);
    if (!safety.allowedOperations.includes(operation.type)) return fail('operation_not_allowed', 'Operation is not permitted');
    const clips = provisional.sequence.clips;
    const index = clips.findIndex(clip => clip.id === operation.clipId);
    const clip = clips[index];
    if (!clip) return fail('invalid_reference', 'Clip does not exist in provisional state');
    const times = operation.type === 'split' ? [operation.atSourceMs]
      : operation.type === 'trim' ? [operation.sourceRange.startMs, operation.sourceRange.endMs]
        : operation.type === 'move' ? [operation.destinationTimelineStartMs] : [];
    if (times.some(time => time % FRAME_MS !== 0)) return fail('timing_alignment', 'Effective operation timing must be frame-aligned');
    // Check raw bounds as well as aligned bounds: rounding must never rescue an
    // out-of-range request or silently extend/clamp a source selection.
    for (const candidate of [row.requested, operation]) {
      if (candidate.type === 'split' && (candidate.atSourceMs <= clip.sourceRange.startMs || candidate.atSourceMs >= clip.sourceRange.endMs)) {
        return fail('source_bounds', 'Split must be strictly inside the current clip source range');
      }
      if (candidate.type === 'trim' && (candidate.sourceRange.startMs < clip.sourceRange.startMs || candidate.sourceRange.endMs > clip.sourceRange.endMs)) {
        return fail('source_bounds', 'Trim cannot extend the current clip source range');
      }
    }
    const previousHash = hashProjectIR(provisional);
    const createdClipIds: string[] = [];
    const retiredClipIds: string[] = [];
    switch (operation.type) {
      case 'split': {
        const leftId = splitChildId(clip, operation, 'left');
        const rightId = splitChildId(clip, operation, 'right');
        if (clips.some(existing => existing.id === leftId || existing.id === rightId)) return fail('identity_collision', 'Split child identity already exists');
        const left: TimelineClip = { ...clip, id: leftId, sourceRange: { startMs: clip.sourceRange.startMs, endMs: operation.atSourceMs } };
        const right: TimelineClip = { ...clip, id: rightId, sourceRange: { startMs: operation.atSourceMs, endMs: clip.sourceRange.endMs }, timelineStartMs: clip.timelineStartMs + duration(left) };
        clips.splice(index, 1, left, right);
        createdClipIds.push(leftId, rightId); retiredClipIds.push(clip.id);
        mappings.set(clip.id, [leftId, rightId]);
        break;
      }
      case 'trim': clip.sourceRange = { ...operation.sourceRange }; break;
      case 'move':
        if (!Number.isSafeInteger(operation.destinationTimelineStartMs + duration(clip))) return fail('timing_alignment', 'Timeline end exceeds safe integer extent');
        clip.timelineStartMs = operation.destinationTimelineStartMs;
        break;
      case 'delete': clips.splice(index, 1); retiredClipIds.push(clip.id); break;
      case 'ripple_delete': {
        const end = timelineEnd(clip);
        const shift = duration(clip);
        clips.splice(index, 1);
        for (const later of clips) if (later.timelineStartMs >= end) later.timelineStartMs -= shift;
        retiredClipIds.push(clip.id);
        break;
      }
    }
    clips.sort((a, b) => a.timelineStartMs - b.timelineStartMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const validated = ProjectIRSchema.safeParse(provisional);
    if (!validated.success) return structureError(validated.error.issues, 'operation', operationIndex);
    provisional = validated.data;
    operationReceipts.push({ ...row, operationIndex, createdClipIds, retiredClipIds,
      outcome: hashProjectIR(provisional) === previousHash ? 'no_change' : 'applied' });
  }
  const finalLockError = checkLocks(provisional, safety, 'final_locks');
  if (finalLockError) return finalLockError;
  const beforeContentHash = hashProjectIR(beforeProject);
  const afterContentHash = hashProjectIR(provisional);
  return { ok: true, changed: beforeContentHash !== afterContentHash, beforeProject, nextProject: provisional,
    beforeContentHash, afterContentHash, operationReceipts, clipMappings: Object.fromEntries(mappings) };
}

/** Pure reducer. Inputs are effective operations; off-grid times are rejected. */
export function applyBatch(project: unknown, effectiveOperations: unknown, safety: unknown): KernelResult {
  const parsed = OperationsSchema.safeParse(effectiveOperations);
  if (!parsed.success) return kernelFailure('schema_invalid', 'operations', 'Invalid effective operation array');
  return execute(project, parsed.data.map(operation => ({ requested: structuredClone(operation), effective: operation, alignments: [] })), safety);
}

/** Normalize requested commands once, then execute privately and publish atomically.
 * workspaceId/expectedRevision are validated correlation data only here; the later
 * workspace owner must enforce revision/ownership before calling this pure API. */
export function executeEditBatch(project: unknown, batch: unknown, safety: unknown): KernelResult {
  const parsed = EditBatchSchema.safeParse(batch);
  if (!parsed.success) return kernelFailure('schema_invalid', 'batch', 'Invalid edit batch');
  const rows: NormalizedOperation[] = [];
  for (const [operationIndex, operation] of parsed.data.operations.entries()) {
    const normalized = normalizeEditOperation(operation);
    if (!normalized.ok) return { ok: false, error: { ...normalized.error, operationIndex } };
    const { ok: _, ...row } = normalized;
    rows.push(row);
  }
  return execute(project, rows, safety);
}
