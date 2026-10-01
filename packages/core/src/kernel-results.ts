import type { EditOperation } from './operations.js';
import type { ProjectIR } from './project.js';
import type { Range } from './primitives.js';

export type KernelErrorCode = 'schema_invalid' | 'invalid_reference' | 'source_bounds'
  | 'timing_alignment' | 'timeline_overlap' | 'operation_not_allowed' | 'batch_limit'
  | 'lock_violation' | 'identity_collision';
export type KernelStage = 'project' | 'safety' | 'operations' | 'batch'
  | 'normalization' | 'operation' | 'final_locks';
export interface KernelError {
  code: KernelErrorCode;
  stage: KernelStage;
  message: string;
  operationIndex?: number;
  // Only known public/mechanical fields. Never forward raw inputs or Zod messages.
  evidence: {
    clipId?: string; assetId?: string; lockId?: string; operationId?: string;
    field?: string; requestedMs?: number; effectiveMs?: number;
    range?: Range; limit?: number; count?: number;
  };
}
export interface KernelFailure { ok: false; error: KernelError }
export interface TimeAlignment { requestedMs: number; effectiveMs: number; deltaMs: number }
export interface AlignmentReceipt extends TimeAlignment { field: string }
export interface NormalizedOperation {
  requested: EditOperation;
  effective: EditOperation;
  alignments: AlignmentReceipt[];
}
export interface OperationReceipt extends NormalizedOperation {
  operationIndex: number;
  outcome: 'applied' | 'no_change';
  createdClipIds: string[];
  retiredClipIds: string[];
}
export interface KernelSuccess {
  ok: true;
  changed: boolean;
  // Detached snapshots support exact restoration by a later workspace owner.
  beforeProject: ProjectIR;
  nextProject: ProjectIR;
  beforeContentHash: string;
  afterContentHash: string;
  operationReceipts: OperationReceipt[];
  clipMappings: Record<string, string[]>;
}
export type KernelResult = KernelSuccess | KernelFailure;

export function kernelFailure(code: KernelErrorCode, stage: KernelStage, message: string,
  evidence: KernelError['evidence'] = {}, operationIndex?: number): KernelFailure {
  return { ok: false, error: { code, stage, message, evidence,
    ...(operationIndex === undefined ? {} : { operationIndex }) } };
}
