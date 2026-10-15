import { createHash } from 'node:crypto';
import type { ToolHost } from '@aether/harness';
import { writeContract, writePlan } from '@aether/harness/orchestration';
import type { ToolResult } from '@aether/tools';
import type { ProjectStore } from '@aether/workspace';

// Scripted adapters for the readiness demo. They exercise the shared tools and accounting; they prove interfaces, not H1.

/** Interview transcript used by the demo: argument, repetition, caveat, tangent, recommendation, sign-off. */
export const demoTranscript = {
  schemaVersion: 1, timeUnit: 'seconds',
  cues: [
    { start: 0, end: 2, text: 'The main argument is careful change.' },
    { start: 2, end: 4, text: 'Careful change matters, careful change matters.' },
    { start: 4, end: 6, text: 'Junior engineers still need supervision.' },
    { start: 6, end: 8, text: 'Anyway, an unrelated tangent about lunch.' },
    { start: 8, end: 10, text: 'My recommendation is pair review.' },
    { start: 10, end: 12, text: 'Thanks for watching.' },
  ],
};

type Data = any;
export interface AdapterRun { outputs: ToolResult[]; recoveredFromStaleRevision: boolean; replayedBatch: boolean }

async function use(host: ToolHost, outputs: ToolResult[], tool: string, input: Record<string, unknown>): Promise<Data> {
  const result = await host.call(tool, { workspaceId: host.workspaceId, ...input });
  outputs.push(result);
  if (!result.ok) throw new Error(`${tool} failed: ${result.error.code}`);
  return result.data;
}
/** Synthetic model call: real accounting path, fake usage. Cache tokens and cost are deliberately unavailable. */
async function think(host: ToolHost, stage: string, step: number): Promise<void> {
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  const recorded = await host.recordModelEvent({
    stage, requestDigest: digest(`${stage}:${step}:request`), responseDigest: digest(`${stage}:${step}:response`),
    latencyMs: 0, inputTokens: 1200, outputTokens: 300, cacheTokens: null, reasoningTokens: null, costUsd: null,
  });
  if (!recorded.ok) throw new Error(`model budget: ${recorded.code}`);
}

async function findSegment(host: ToolHost, outputs: ToolResult[], query: string): Promise<{ segmentId: string; sourceRange: { startMs: number; endMs: number } }> {
  return (await use(host, outputs, 'search_transcript', { query })).matches[0];
}
/** Remove whole transcript segments by splitting at their boundaries and ripple-deleting the pieces. */
async function removeSegments(host: ToolHost, outputs: ToolResult[], ranges: { startMs: number; endMs: number }[]): Promise<Data[]> {
  const sent: Data[] = [];
  const cuts = [...new Set(ranges.flatMap(range => [range.startMs, range.endMs]))].sort((a, b) => a - b);
  for (const time of cuts) {
    const timeline = await use(host, outputs, 'get_timeline', {});
    const clip = timeline.clips.find((item: Data) => item.sourceRange.startMs < time && time < item.sourceRange.endMs);
    if (!clip) continue;
    await use(host, outputs, 'apply_edit_batch', { schemaVersion: 1, batchId: `split-${time}`, expectedRevision: timeline.revision,
      operations: [{ type: 'split', operationId: `split-${time}`, clipId: clip.clipId, atSourceMs: time }] });
  }
  for (const range of ranges) {
    const timeline = await use(host, outputs, 'get_timeline', {});
    const clip = timeline.clips.find((item: Data) => item.sourceRange.startMs === range.startMs);
    const batch = { schemaVersion: 1, batchId: `ripple-${range.startMs}`, expectedRevision: timeline.revision,
      operations: [{ type: 'ripple_delete', operationId: `ripple-${range.startMs}`, clipId: clip.clipId }] };
    sent.push({ ...batch, workspaceId: host.workspaceId });
    await use(host, outputs, 'apply_edit_batch', batch);
  }
  return sent;
}

/**
 * Baseline-style adapter: retrieval, free-form notes, informal planning, and recovery from one deliberate
 * stale-revision error plus one network-style retry of an already-applied batch.
 */
export async function baselineAdapter(host: ToolHost, options: { dropCaveat?: boolean } = {}): Promise<AdapterRun> {
  const outputs: ToolResult[] = [];
  await think(host, 'baseline-reasoning', 0);
  await use(host, outputs, 'get_task', {});
  const repetition = await findSegment(host, outputs, 'careful change matters');
  const caveat = await findSegment(host, outputs, 'supervision');
  await use(host, outputs, 'inspect_segment', { segmentId: caveat.segmentId, contextMs: 2000 });
  const tangent = await findSegment(host, outputs, 'tangent lunch');
  const signOff = await findSegment(host, outputs, 'thanks watching');
  await use(host, outputs, 'write_notes', { expectedRevision: 0, text: `Keep ${caveat.segmentId}. Remove repetition, tangent, sign-off.` });
  await think(host, 'baseline-reasoning', 1);

  const timeline = await use(host, outputs, 'get_timeline', {});
  const stale = await host.call('apply_edit_batch', { schemaVersion: 1, batchId: 'stale-attempt', workspaceId: host.workspaceId,
    expectedRevision: timeline.revision + 5, operations: [{ type: 'split', operationId: 'stale', clipId: timeline.clips[0].clipId, atSourceMs: 2000 }] });
  outputs.push(stale);
  const recoveredFromStaleRevision = !stale.ok && stale.error.code === 'stale_revision';

  const removed = options.dropCaveat ? [repetition, caveat, tangent] : [repetition, tangent, signOff];
  const sent = await removeSegments(host, outputs, removed.map(segment => segment.sourceRange));
  // A network-style retry of the last batch, exactly as first sent: deduplication returns the original receipt.
  const replay = await host.call('apply_edit_batch', sent.at(-1));
  outputs.push(replay);
  const current = await use(host, outputs, 'get_timeline', {});
  await use(host, outputs, 'preview_range', { timelineRange: { startMs: 0, endMs: current.durationMs } });
  await think(host, 'baseline-reasoning', 2);
  await use(host, outputs, 'submit', {});
  return { outputs, recoveredFromStaleRevision, replayedBatch: replay.ok && (replay.data as Data).replayed === true };
}

/** AETHER-shaped adapter: typed contract → plan → compiled shared operations. Same tools, same kernel. */
export async function aetherAdapter(host: ToolHost, store: ProjectStore): Promise<AdapterRun> {
  const outputs: ToolResult[] = [];
  await think(host, 'aether-contract', 0);
  const { task } = await use(host, outputs, 'get_task', {});
  const main = await findSegment(host, outputs, 'main argument');
  const repetition = await findSegment(host, outputs, 'careful change matters');
  const caveat = await findSegment(host, outputs, 'supervision');
  const tangent = await findSegment(host, outputs, 'tangent lunch');
  const recommendation = await findSegment(host, outputs, 'recommendation');
  const signOff = await findSegment(host, outputs, 'thanks watching');
  const timeline = await use(host, outputs, 'get_timeline', {});
  // Only shared-tool information is used: the same view every arm gets.
  const assetId: string = timeline.assetId;
  const ref = (segment: typeof main) => ({ assetId, range: segment.sourceRange });
  const contract = {
    schemaVersion: 1, id: 'contract-1', taskId: task.id, objective: 'Shorten while keeping the argument, caveat and recommendation.',
    ...(task.userProvidedDurationTarget ? { targetDuration: task.userProvidedDurationTarget } : {}),
    preserve: [{ description: 'Main argument', inferredRanges: [ref(main)] }, { description: 'Recommendation', inferredRanges: [ref(recommendation)] }],
    protect: [{ description: 'Caveat about junior engineers', inferredRanges: [ref(caveat)] }],
    allow: ['remove repetition', 'remove tangents'], avoid: ['changing meaning'], autonomy: 'edit_candidate',
    successCriteria: [{ id: 'criterion-1', description: 'Caveat and recommendation retained' }],
  };
  if (!(await writeContract(store, host.workspaceId, contract)).ok) throw new Error('contract rejected');
  await think(host, 'aether-plan', 1);
  const plan = {
    schemaVersion: 1, id: 'plan-1', contractId: contract.id, baseContentHash: timeline.contentHash,
    selectedSegments: [main.segmentId, caveat.segmentId, recommendation.segmentId],
    removedSegments: [repetition.segmentId, tangent.segmentId, signOff.segmentId],
    reorderings: [], rationale: 'Keep protected and preserved segments; remove repetition, tangent and sign-off.', unresolvedQuestions: [], estimatedDurationMs: 6000,
  };
  if (!(await writePlan(store, host.workspaceId, plan)).ok) throw new Error('plan rejected');
  // Compiler: the plan's removals become ordinary shared operations.
  await removeSegments(host, outputs, [repetition, tangent, signOff].map(segment => segment.sourceRange));
  const final = await use(host, outputs, 'get_timeline', {});
  await use(host, outputs, 'preview_range', { timelineRange: { startMs: 0, endMs: final.durationMs } });
  await use(host, outputs, 'submit', {});
  return { outputs, recoveredFromStaleRevision: false, replayedBatch: false };
}
