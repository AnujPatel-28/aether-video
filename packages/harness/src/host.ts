import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { canonicalSerialize } from '@aether/core';
import type { ProjectIR, Range, SourceRef } from '@aether/core';
import { DEFAULT_TOOL_LIMITS, ToolInputSchemas, ToolLimitsSchema, ToolNameSchema, ToolOutputSchemas } from '@aether/tools';
import type { ToolError, ToolInput, ToolLimits, ToolName, ToolOutput, ToolResult } from '@aether/tools';
import type { ProjectStore, SnapshotRef, StoreResult, WorkspaceError } from '@aether/workspace';

export interface ToolHostOptions { store: ProjectStore; workspaceId: string; limits?: ToolLimits }
export interface SubmissionRecord {
  outcome: 'submitted' | 'budget_exhausted';
  head: SnapshotRef;
  artifactId?: string;
  renderError?: string;
}
export interface ToolHost {
  readonly workspaceId: string;
  readonly limits: ToolLimits;
  /** The only entry point an agent adapter gets. Inputs are untrusted JSON. */
  call(tool: string, input: unknown): Promise<ToolResult>;
  callsMade(): number;
  submission(): SubmissionRecord | undefined;
  /** Trace appends that failed; a non-zero value invalidates the trial's diagnostics. */
  traceFailures(): number;
}

class ToolFailure extends Error {
  constructor(readonly detail: ToolError) { super(detail.message); }
}
const MESSAGES: Record<ToolError['code'], string> = {
  invalid_input: 'Input does not match the tool schema', unknown_tool: 'Unknown tool',
  workspace_mismatch: 'This session is bound to a different workspace', limit_exceeded: 'Request exceeds a tool limit',
  budget_exhausted: 'Tool-call budget exhausted; the current head was submitted', submitted: 'The session has already submitted',
  not_found: 'No such item', stale_revision: 'Revision changed; read the current head and retry',
  batch_id_conflict: 'Batch ID was already used with a different payload', workspace_not_open: 'Workspace is not open',
  kernel: 'Edit rejected by the kernel', media_failed: 'Preview could not be rendered', internal: 'Internal error',
};
function toolFail(code: ToolError['code'], evidence: ToolError['evidence'] = {}): never {
  throw new ToolFailure({ code, message: MESSAGES[code], evidence });
}
function fromStore(error: WorkspaceError): never {
  switch (error.code) {
    case 'stale_revision': return toolFail('stale_revision', { ...(error.evidence.expected !== undefined ? { expected: error.evidence.expected } : {}) });
    case 'batch_id_conflict': case 'workspace_not_open': return toolFail(error.code);
    case 'notes_too_large': return toolFail('limit_exceeded', { ...(error.evidence.expected !== undefined ? { limit: error.evidence.expected } : {}) });
    case 'kernel': return toolFail('kernel', {
      ...(error.kernel ? { kernelCode: error.kernel.code } : {}),
      ...(error.kernel?.operationIndex !== undefined ? { operationIndex: error.kernel.operationIndex } : {}),
    });
    case 'media': return toolFail('media_failed', { ...(error.media ? { mediaCode: error.media.code } : {}) });
    default: return toolFail('internal');
  }
}
function unwrap<T>(result: StoreResult<T>): T {
  if (!result.ok) fromStore(result.error);
  return result;
}

const end = (start: number, range: Range) => start + range.endMs - range.startMs;
const sortedClips = (project: ProjectIR) => [...project.sequence.clips].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
const tokens = (text: string) => text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const inputDigest = (input: unknown) => {
  try { return createHash('sha256').update(canonicalSerialize(input), 'utf8').digest('hex'); } catch { return 'unserializable'; }
};

/** Fraction of a source range present in the timeline's union coverage. */
function coverage(project: ProjectIR, range: Range): 'full' | 'partial' | 'none' {
  const merged: Range[] = [];
  for (const clip of [...project.sequence.clips].sort((a, b) => a.sourceRange.startMs - b.sourceRange.startMs)) {
    const last = merged.at(-1);
    if (last && clip.sourceRange.startMs <= last.endMs) last.endMs = Math.max(last.endMs, clip.sourceRange.endMs);
    else merged.push({ ...clip.sourceRange });
  }
  const covered = merged.reduce((total, item) => total + Math.max(0, Math.min(item.endMs, range.endMs) - Math.max(item.startMs, range.startMs)), 0);
  return covered === 0 ? 'none' : covered === range.endMs - range.startMs ? 'full' : 'partial';
}

interface Handled<N extends ToolName> {
  data: ToolOutput<N>;
  ranges?: SourceRef[];
  contentBearing?: boolean;
  receiptId?: string;
  artifactId?: string;
}
type Handlers = { [N in ToolName]: (input: ToolInput<N>) => Promise<Handled<N>> };

/** A trusted host bound to exactly one workspace (F2) with one frozen set of limits (F3). */
export function createToolHost(options: ToolHostOptions): ToolHost {
  const { store, workspaceId } = options;
  const limits = Object.freeze(ToolLimitsSchema.parse(options.limits ?? DEFAULT_TOOL_LIMITS));
  let calls = 0;
  let traceFailures = 0;
  let submitted: SubmissionRecord | undefined;

  const read = async () => unwrap(await store.readWorkspace(workspaceId));
  const segmentView = (project: ProjectIR, segment: ProjectIR['segments'][number]) => ({
    segmentId: segment.id, sourceRange: segment.sourceRange, text: segment.transcriptText,
    ...(segment.speaker ? { speaker: segment.speaker } : {}), coverage: coverage(project, segment.sourceRange),
  });

  async function freezeAndRender(outcome: SubmissionRecord['outcome']): Promise<SubmissionRecord> {
    const frozen = await store.freezeSubmission(workspaceId);
    const { workspace } = await read();
    if (!frozen.ok && workspace.state !== 'frozen') fromStore(frozen.error);
    const head = workspace.head;
    const rendered = await store.renderPreview(workspaceId, { contentHash: head.contentHash, preset: 'delivery-h264-v1' });
    submitted = rendered.ok ? { outcome, head, artifactId: rendered.manifest.artifactId }
      : { outcome, head, renderError: rendered.error.media?.code ?? rendered.error.code };
    return submitted;
  }

  const handlers: Handlers = {
    get_timeline: async ({ cursor = 0 }) => {
      const { workspace, project } = await read();
      const clips = sortedClips(project);
      const gaps: Range[] = [];
      let at = 0;
      for (const clip of clips) {
        if (clip.timelineStartMs > at) gaps.push({ startMs: at, endMs: clip.timelineStartMs });
        at = end(clip.timelineStartMs, clip.sourceRange);
      }
      const page = clips.slice(cursor, cursor + limits.maxTimelinePage);
      const next = cursor + page.length;
      return {
        data: {
          revision: workspace.head.revision, contentHash: workspace.head.contentHash, durationMs: at, frameMs: 40,
          clips: page.map(clip => ({ clipId: clip.id, sourceRange: clip.sourceRange, timelineRange: { startMs: clip.timelineStartMs, endMs: end(clip.timelineStartMs, clip.sourceRange) } })),
          gaps, totalClips: clips.length, ...(next < clips.length ? { nextCursor: next } : {}),
        },
      };
    },

    get_task: async () => {
      const { task } = unwrap(await store.readTask(workspaceId));
      const { safety } = unwrap(await store.readSafety());
      return { data: { task, locks: safety.userLocks.map(lock => ({ lockId: lock.id, sourceRanges: lock.sourceRanges })) } };
    },

    search_transcript: async ({ query, limit, cursor = 0 }) => {
      if (query.length > limits.maxQueryChars) toolFail('limit_exceeded', { limit: limits.maxQueryChars });
      const size = limit ?? 10;
      if (size > limits.maxSearchResults) toolFail('limit_exceeded', { limit: limits.maxSearchResults });
      const { project } = await read();
      const wanted = [...new Set(tokens(query))];
      const scored = project.segments.map(segment => {
        const words = tokens(segment.transcriptText);
        const matched = wanted.filter(token => words.includes(token)).length;
        const frequency = words.filter(word => wanted.includes(word)).length;
        return { segment, matched, frequency };
      }).filter(item => item.matched > 0).sort((a, b) => b.matched - a.matched || b.frequency - a.frequency
        || a.segment.sourceRange.startMs - b.segment.sourceRange.startMs || (a.segment.id < b.segment.id ? -1 : 1));
      const page = scored.slice(cursor, cursor + size);
      const next = cursor + page.length;
      return {
        data: {
          matches: page.map(({ segment, matched }) => ({ segmentId: segment.id, sourceRange: segment.sourceRange, excerpt: segment.transcriptText.slice(0, 500), score: matched })),
          ...(next < scored.length ? { nextCursor: next } : {}),
        },
        ranges: page.map(({ segment }) => ({ assetId: segment.assetId, range: segment.sourceRange })),
        contentBearing: page.length > 0,
      };
    },

    inspect_segment: async ({ segmentId, contextMs = 0 }) => {
      if (contextMs > limits.maxContextMs) toolFail('limit_exceeded', { limit: limits.maxContextMs });
      const { project } = await read();
      const segment = project.segments.find(item => item.id === segmentId) ?? toolFail('not_found');
      const from = segment.sourceRange.startMs - contextMs;
      const to = segment.sourceRange.endMs + contextMs;
      const context = project.segments.filter(item => item.id !== segment.id && item.sourceRange.startMs < to && from < item.sourceRange.endMs)
        .sort((a, b) => a.sourceRange.startMs - b.sourceRange.startMs);
      return {
        data: { segment: segmentView(project, segment), context: context.map(item => segmentView(project, item)) },
        ranges: [segment, ...context].map(item => ({ assetId: item.assetId, range: item.sourceRange })),
        contentBearing: true,
      };
    },

    preview_range: async ({ timelineRange }) => {
      if (timelineRange.endMs - timelineRange.startMs > limits.maxPreviewMs) toolFail('limit_exceeded', { limit: limits.maxPreviewMs });
      const { workspace, project } = await read();
      const { manifest } = unwrap(await store.renderPreview(workspaceId, { contentHash: workspace.head.contentHash, range: timelineRange, preset: 'delivery-h264-v1' }));
      const range = manifest.effectiveRange;
      const transcript: ToolOutput<'preview_range'>['transcript'] = [];
      const ranges: SourceRef[] = [];
      for (const clip of sortedClips(project)) {
        const startMs = Math.max(clip.timelineStartMs, range.startMs);
        const endMs = Math.min(end(clip.timelineStartMs, clip.sourceRange), range.endMs);
        if (endMs <= startMs) continue;
        const offset = clip.sourceRange.startMs - clip.timelineStartMs;
        const source = { startMs: startMs + offset, endMs: endMs + offset };
        ranges.push({ assetId: clip.assetId, range: source });
        for (const segment of project.segments) {
          const s = Math.max(segment.sourceRange.startMs, source.startMs);
          const e = Math.min(segment.sourceRange.endMs, source.endMs);
          if (e <= s) continue;
          transcript.push({ timelineRange: { startMs: s - offset, endMs: e - offset }, sourceRange: { startMs: s, endMs: e }, segmentId: segment.id, text: segment.transcriptText });
        }
      }
      return {
        data: {
          requestedRange: timelineRange, effectiveRange: range, artifactId: manifest.artifactId, transcript,
          timing: { expectedDurationMs: manifest.expected.durationMs, measuredVideoDurationUs: manifest.measured.videoDurationUs, measuredAudioDurationUs: manifest.measured.audioDurationUs },
          checks: manifest.checks.map(check => ({ checkId: check.checkId, status: check.status })),
        },
        ranges, contentBearing: true, artifactId: manifest.artifactId,
      };
    },

    apply_edit_batch: async batch => {
      const result = unwrap(await store.applyEditBatch(batch));
      const receipt = result.receipt;
      return {
        data: {
          outcome: result.outcome, replayed: result.replayed, head: result.head,
          receipt: {
            receiptId: receipt.receiptId, effectiveOperations: receipt.operationReceipts.map(row => row.effective),
            alignments: receipt.operationReceipts.flatMap(row => row.alignments),
            createdClipIds: receipt.operationReceipts.flatMap(row => row.createdClipIds),
            retiredClipIds: receipt.operationReceipts.flatMap(row => row.retiredClipIds),
          },
        },
        receiptId: receipt.receiptId,
      };
    },

    write_notes: async ({ expectedRevision, text }) => ({ data: { revision: unwrap(await store.writeNotes(workspaceId, expectedRevision, text)).notes.revision } }),
    read_notes: async () => ({ data: unwrap(await store.readNotes(workspaceId)).notes }),

    submit: async () => {
      const record = await freezeAndRender('submitted');
      return {
        data: { head: record.head, ...(record.artifactId ? { artifactId: record.artifactId } : {}), ...(record.renderError ? { renderError: record.renderError } : {}) },
        ...(record.artifactId ? { artifactId: record.artifactId } : {}),
      };
    },
  };

  async function trace(tool: string, input: unknown, started: number, result: ToolResult, handled?: Handled<ToolName>) {
    const appended = await store.appendToolEvent(workspaceId, {
      tool, inputDigest: inputDigest(input), outcome: result.ok ? 'ok' : 'error',
      ...(result.ok ? {} : { errorCode: result.error.evidence.kernelCode ?? result.error.code }),
      returnedSourceRanges: handled?.ranges ?? [], contentBearing: handled?.contentBearing ?? false,
      ...(handled?.receiptId ? { receiptId: handled.receiptId } : {}), ...(handled?.artifactId ? { artifactId: handled.artifactId } : {}),
      latencyMs: Math.max(0, performance.now() - started),
    });
    if (!appended.ok) traceFailures++;
  }

  return {
    workspaceId, limits,
    callsMade: () => calls,
    submission: () => submitted,
    traceFailures: () => traceFailures,
    async call(tool, input) {
      const started = performance.now();
      let handled: Handled<ToolName> | undefined;
      let result: ToolResult;
      try {
        if (submitted) toolFail(submitted.outcome === 'budget_exhausted' ? 'budget_exhausted' : 'submitted');
        if (calls >= limits.maxToolCalls) {
          await freezeAndRender('budget_exhausted');
          toolFail('budget_exhausted', { limit: limits.maxToolCalls });
        }
        calls++;
        const name = ToolNameSchema.safeParse(tool);
        if (!name.success) toolFail('unknown_tool');
        const parsed = ToolInputSchemas[name.data].safeParse(input);
        if (!parsed.success) toolFail('invalid_input');
        if (parsed.data.workspaceId !== workspaceId) toolFail('workspace_mismatch');
        handled = await (handlers[name.data] as (value: unknown) => Promise<Handled<ToolName>>)(parsed.data);
        result = { ok: true, data: ToolOutputSchemas[name.data].parse(handled.data) as ToolOutput<ToolName> };
      } catch (error) {
        handled = undefined;
        result = { ok: false, error: error instanceof ToolFailure ? error.detail : { code: 'internal', message: MESSAGES.internal, evidence: {} } };
      }
      await trace(ToolNameSchema.safeParse(tool).success ? tool : 'unknown', input, started, result, handled);
      return result;
    },
  };
}
