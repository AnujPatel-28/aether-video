import assert from 'node:assert/strict';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ProjectIRSchema } from '@aether/core';
import type { ProjectIR } from '@aether/core';
import { createToolHost } from '@aether/harness';
import type { ToolHost } from '@aether/harness';
import { runDiagnostics, runEvaluation } from '@aether/harness/evaluation';
import { DEFAULT_TOOL_LIMITS } from '@aether/tools';
import type { ToolResult } from '@aether/tools';
import { DURATION_REVIEW_US, evaluateSubmission } from '@aether/verification/evaluator';
import type { EvaluationSpec } from '@aether/verification/evaluator';
import { ingestProject, openProjectStore } from '@aether/workspace';
import type { ProjectStore } from '@aether/workspace';
import { safetyFixture, taskFixture } from './fixtures.js';
import { binaries, makeSource, makeTranscript } from './media-support.js';
import { ok, removeRoot, tempRoot } from './workspace-support.js';

const PROJECT = 'project-harness';
const SENTINEL = 'SENTINEL-GOLD-7f3a';
const transcript = {
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

let media: string;
let sourcePath: string;
let transcriptPath: string;
let evaluations: string;

interface Session { root: string; store: ProjectStore; sourceHash: string; transcriptHash: string; assetId: string }
async function session(): Promise<Session> {
  const root = await tempRoot();
  const { ingestion } = ok(await ingestProject({ storeRoot: root, media: { binaries } },
    { projectId: PROJECT, sourcePath, transcriptPath, safety: { ...safetyFixture(), projectId: PROJECT } }));
  const { store } = ok(await openProjectStore({ storeRoot: root, projectId: PROJECT, media: { binaries } }));
  return { root, store, sourceHash: ingestion.sourceHash, transcriptHash: ingestion.transcriptHash, assetId: `asset-${ingestion.sourceHash}` };
}
function spec(s: Session, marker = SENTINEL): EvaluationSpec {
  const ref = (startMs: number, endMs: number) => ({ assetId: s.assetId, range: { startMs, endMs } });
  return {
    schemaVersion: 1, id: `spec-${marker}`, sourceHash: s.sourceHash, transcriptHash: s.transcriptHash,
    targetDuration: { minMs: 5500, maxMs: 6500 },
    retentionCriteria: [
      { id: `caveat-${marker}`, description: `Caveat ${marker}`, referenceRanges: [ref(4000, 6000)], contextRanges: [ref(2000, 8000)] },
      { id: `recommendation-${marker}`, description: `Recommendation ${marker}`, referenceRanges: [ref(8000, 10000)], contextRanges: [] },
    ],
    semanticRubric: [{ id: `meaning-${marker}`, description: `Meaning ${marker}` }],
  };
}

/** Tool call that must succeed; returns its data. */
async function use(host: ToolHost, tool: string, input: Record<string, unknown>, outputs?: unknown[]): Promise<any> {
  const result = await host.call(tool, { workspaceId: host.workspaceId, ...input });
  outputs?.push(result);
  assert.ok(result.ok, `${tool}: ${JSON.stringify(result)}`);
  return result.data;
}
async function fails(host: ToolHost, tool: string, input: unknown, code: string): Promise<ToolResult> {
  const result = await host.call(tool, input);
  assert.ok(!result.ok, `${tool} should fail with ${code}`);
  assert.equal(result.error.code, code, JSON.stringify(result.error));
  return result;
}

/** Split the clip containing each source time, using only what the tools return. */
async function splitAt(host: ToolHost, times: number[], outputs?: unknown[]) {
  for (const time of times) {
    const timeline = await use(host, 'get_timeline', {}, outputs);
    const clip = timeline.clips.find((item: any) => item.sourceRange.startMs < time && time < item.sourceRange.endMs);
    await use(host, 'apply_edit_batch', { schemaVersion: 1, batchId: `split-${time}`, expectedRevision: timeline.revision,
      operations: [{ type: 'split', operationId: `split-${time}`, clipId: clip.clipId, atSourceMs: time }] }, outputs);
  }
}
async function rippleSources(host: ToolHost, sourceStarts: number[], outputs?: unknown[]) {
  for (const start of sourceStarts) {
    const timeline = await use(host, 'get_timeline', {}, outputs);
    const clip = timeline.clips.find((item: any) => item.sourceRange.startMs === start);
    await use(host, 'apply_edit_batch', { schemaVersion: 1, batchId: `ripple-${start}`, expectedRevision: timeline.revision,
      operations: [{ type: 'ripple_delete', operationId: `ripple-${start}`, clipId: clip.clipId }] }, outputs);
  }
}

type Agent = 'baseline' | 'intended' | 'kept' | 'blind';
/**
 * Scripted agents (F12). baseline keeps the caveat; intended notes the caveat then cuts it;
 * kept reads the caveat but never notes it; blind cuts it without ever reading transcript content.
 */
async function scripted(host: ToolHost, agent: Agent): Promise<unknown[]> {
  const outputs: unknown[] = [];
  await use(host, 'get_task', {}, outputs);
  await use(host, 'get_timeline', {}, outputs);
  if (agent !== 'blind') {
    await use(host, 'search_transcript', { query: 'careful change' }, outputs);
    const caveat = (await use(host, 'search_transcript', { query: 'supervision' }, outputs)).matches[0];
    await use(host, 'inspect_segment', { segmentId: caveat.segmentId, contextMs: 2000 }, outputs);
    const notes = agent === 'kept' ? 'Cut repetition and the tangent.' : `Keep ${caveat.segmentId}. Cut repetition.`;
    await use(host, 'write_notes', { expectedRevision: 0, text: notes }, outputs);
  }
  await splitAt(host, [2000, 4000, 6000, 8000, 10000], outputs);
  await rippleSources(host, agent === 'baseline' ? [2000, 6000, 10000] : [2000, 4000, 6000], outputs);
  if (agent !== 'blind') await use(host, 'preview_range', { timelineRange: { startMs: 0, endMs: 6000 } }, outputs);
  await use(host, 'submit', {}, outputs);
  return outputs;
}

let main: Session;
const hosts = {} as Record<Agent, ToolHost>;
const outputs = {} as Record<Agent, unknown[]>;

before(async () => {
  media = await tempRoot();
  evaluations = await tempRoot();
  sourcePath = await makeSource(media, 'source');
  transcriptPath = await makeTranscript(media, 'transcript', transcript);
  main = await session();
  for (const agent of ['baseline', 'intended', 'kept', 'blind'] as const) {
    ok(await main.store.forkWorkspace(`ws-${agent}`, taskFixture()));
    hosts[agent] = createToolHost({ store: main.store, workspaceId: `ws-${agent}` });
    outputs[agent] = await scripted(hosts[agent], agent);
  }
});
after(async () => {
  await main.store.close();
  for (const root of [main.root, media, evaluations]) await removeRoot(root);
});

test('M5-1 strict tool schemas: unknown fields and tools are rejected without echoing input', async () => {
  ok(await main.store.forkWorkspace('ws-schema', taskFixture()));
  const host = createToolHost({ store: main.store, workspaceId: 'ws-schema' });
  const result = await fails(host, 'get_timeline', { workspaceId: 'ws-schema', hiddenUnexpected: 'reject-me' }, 'invalid_input');
  assert.ok(!JSON.stringify(result).includes('hiddenUnexpected') && !JSON.stringify(result).includes('reject-me'));
  await fails(host, 'rm_rf', { workspaceId: 'ws-schema' }, 'unknown_tool');
  await fails(host, 'search_transcript', { workspaceId: 'ws-schema', query: '' }, 'invalid_input');
  await fails(host, 'preview_range', { workspaceId: 'ws-schema', timelineRange: { startMs: 0, endMs: 1000 }, preset: 'test-lossless-v1' }, 'invalid_input');
});

test('M5-2 binding: every tool rejects another workspace', async () => {
  ok(await main.store.forkWorkspace('ws-bound', taskFixture()));
  const host = createToolHost({ store: main.store, workspaceId: 'ws-bound' });
  const other = { workspaceId: 'ws-baseline' };
  for (const [tool, input] of [
    ['get_timeline', other], ['get_task', other], ['search_transcript', { ...other, query: 'x' }],
    ['inspect_segment', { ...other, segmentId: 's' }], ['preview_range', { ...other, timelineRange: { startMs: 0, endMs: 40 } }],
    ['apply_edit_batch', { schemaVersion: 1, batchId: 'b', workspaceId: 'ws-baseline', expectedRevision: 0, operations: [{ type: 'delete', operationId: 'o', clipId: 'c' }] }],
    ['write_notes', { ...other, expectedRevision: 0, text: 'x' }], ['read_notes', other], ['submit', other],
  ] as const) await fails(host, tool, input, 'workspace_mismatch');
  assert.equal(ok(await main.store.readWorkspace('ws-baseline')).workspace.state, 'frozen');
});

test('M5-3 timeline paging, gaps and duration; task shows locks as ranges only', async () => {
  ok(await main.store.forkWorkspace('ws-timeline', taskFixture()));
  const host = createToolHost({ store: main.store, workspaceId: 'ws-timeline', limits: { ...DEFAULT_TOOL_LIMITS, maxTimelinePage: 1 } });
  await splitAt(host, [4000]);
  const first = await use(host, 'get_timeline', {});
  await use(host, 'apply_edit_batch', { schemaVersion: 1, batchId: 'del', expectedRevision: first.revision,
    operations: [{ type: 'delete', operationId: 'del', clipId: first.clips[0].clipId }] });
  const page = await use(host, 'get_timeline', {});
  assert.deepEqual(page.gaps, [{ startMs: 0, endMs: 4000 }]);
  assert.equal(page.durationMs, 12000);
  assert.equal(page.totalClips, 1);
  const task = await use(host, 'get_task', {});
  assert.deepEqual(task, { task: taskFixture(), locks: [] });
  const paged = createToolHost({ store: main.store, workspaceId: 'ws-baseline', limits: { ...DEFAULT_TOOL_LIMITS, maxTimelinePage: 2 } });
  const firstPage = await use(paged, 'get_timeline', {});
  assert.equal(firstPage.clips.length, 2);
  assert.equal(firstPage.nextCursor, 2);
  assert.equal((await use(paged, 'get_timeline', { cursor: 2 })).clips.length, 1);
});

test('M5-4 search is lexical, deterministic, ranked, paged and bounded', async () => {
  ok(await main.store.forkWorkspace('ws-search', taskFixture()));
  const host = createToolHost({ store: main.store, workspaceId: 'ws-search' });
  const a = await use(host, 'search_transcript', { query: 'Careful CHANGE' });
  const b = await use(host, 'search_transcript', { query: 'careful change' });
  assert.deepEqual(a, b);
  assert.deepEqual(a.matches.map((match: any) => match.excerpt), [transcript.cues[1]!.text, transcript.cues[0]!.text]);
  const paged = await use(host, 'search_transcript', { query: 'careful change', limit: 1 });
  assert.equal(paged.matches.length, 1);
  assert.equal(paged.nextCursor, 1);
  assert.deepEqual((await use(host, 'search_transcript', { query: 'careful change', limit: 1, cursor: 1 })).matches[0].excerpt, transcript.cues[0]!.text);
  assert.deepEqual((await use(host, 'search_transcript', { query: 'zebra' })).matches, []);
  await fails(host, 'search_transcript', { workspaceId: 'ws-search', query: 'x', limit: 21 }, 'limit_exceeded');
  await fails(host, 'search_transcript', { workspaceId: 'ws-search', query: 'x'.repeat(201) }, 'limit_exceeded');
});

test('M5-5 inspect: bounded context and coverage that follows edits', async () => {
  ok(await main.store.forkWorkspace('ws-inspect', taskFixture()));
  const host = createToolHost({ store: main.store, workspaceId: 'ws-inspect' });
  const caveat = (await use(host, 'search_transcript', { query: 'supervision' })).matches[0];
  const view = await use(host, 'inspect_segment', { segmentId: caveat.segmentId, contextMs: 2000 });
  assert.equal(view.segment.coverage, 'full');
  assert.deepEqual(view.context.map((item: any) => item.sourceRange.startMs), [2000, 6000]);
  assert.deepEqual((await use(host, 'inspect_segment', { segmentId: caveat.segmentId })).context, []);
  await splitAt(host, [5000]);
  await rippleSources(host, [5000]);
  assert.equal((await use(host, 'inspect_segment', { segmentId: caveat.segmentId })).segment.coverage, 'partial');
  await fails(host, 'inspect_segment', { workspaceId: 'ws-inspect', segmentId: caveat.segmentId, contextMs: 30_001 }, 'limit_exceeded');
  await fails(host, 'inspect_segment', { workspaceId: 'ws-inspect', segmentId: 'segment-missing' }, 'not_found');
});

test('M5-6 preview: timeline-ordered transcript, measured timing, bounded, no paths', async () => {
  const preview = outputs.baseline.find((item: any) => item.ok && 'transcript' in item.data) as { data: any };
  assert.deepEqual(preview.data.transcript.map((item: any) => [item.timelineRange.startMs, item.text]), [
    [0, transcript.cues[0]!.text], [2000, transcript.cues[2]!.text], [4000, transcript.cues[4]!.text],
  ]);
  assert.equal(preview.data.timing.expectedDurationMs, 6000);
  assert.ok(preview.data.checks.every((check: any) => check.status === 'pass'));
  const text = JSON.stringify(outputs.baseline);
  for (const fragment of [main.root, 'projects', 'artifacts', '.mp4', '.mkv']) assert.ok(!text.includes(fragment), fragment);
  ok(await main.store.forkWorkspace('ws-preview', taskFixture()));
  const host = createToolHost({ store: main.store, workspaceId: 'ws-preview', limits: { ...DEFAULT_TOOL_LIMITS, maxPreviewMs: 1000 } });
  await fails(host, 'preview_range', { workspaceId: 'ws-preview', timelineRange: { startMs: 0, endMs: 2000 } }, 'limit_exceeded');
});

test('M5-7 edits through the host equal the store; replayed batches still count against the budget', async () => {
  ok(await main.store.forkWorkspace('ws-edit', taskFixture()));
  const host = createToolHost({ store: main.store, workspaceId: 'ws-edit' });
  const timeline = await use(host, 'get_timeline', {});
  const batch = { schemaVersion: 1, batchId: 'b1', expectedRevision: 0, operations: [{ type: 'split', operationId: 'o', clipId: timeline.clips[0].clipId, atSourceMs: 3013 }] };
  const applied = await use(host, 'apply_edit_batch', batch);
  assert.deepEqual(applied.head, ok(await main.store.readWorkspace('ws-edit')).workspace.head);
  assert.deepEqual(applied.receipt.alignments, [{ field: 'atSourceMs', requestedMs: 3013, effectiveMs: 3000, deltaMs: -13 }]);
  const calls = host.callsMade();
  assert.equal((await use(host, 'apply_edit_batch', batch)).replayed, true);
  assert.equal(host.callsMade(), calls + 1);
  const rejected = await fails(host, 'apply_edit_batch', { workspaceId: 'ws-edit', ...batch, batchId: 'b2', expectedRevision: 1, operations: [{ type: 'delete', operationId: 'x', clipId: 'missing' }] }, 'kernel');
  assert.ok(!rejected.ok && rejected.error.evidence.kernelCode === 'invalid_reference');
});

test('M5-8 budget exhaustion auto-submits and every later call is refused', async () => {
  ok(await main.store.forkWorkspace('ws-budget', taskFixture()));
  const host = createToolHost({ store: main.store, workspaceId: 'ws-budget', limits: { ...DEFAULT_TOOL_LIMITS, maxToolCalls: 2 } });
  await use(host, 'get_task', {});
  await use(host, 'get_timeline', {});
  await fails(host, 'get_timeline', { workspaceId: 'ws-budget' }, 'budget_exhausted');
  assert.equal(host.submission()?.outcome, 'budget_exhausted');
  assert.ok(host.submission()?.artifactId);
  assert.equal(ok(await main.store.readWorkspace('ws-budget')).workspace.state, 'frozen');
  await fails(host, 'read_notes', { workspaceId: 'ws-budget' }, 'budget_exhausted');
  await fails(hosts.baseline, 'get_timeline', { workspaceId: 'ws-baseline' }, 'submitted');
});

test('M5-9 every call is traced; content-bearing follows Proposal 001; inputs are digests', async () => {
  const { events } = ok(await main.store.readToolTrace('ws-baseline'));
  assert.ok(events.length >= outputs.baseline.length);
  assert.deepEqual(events.map(event => event.sequence), events.map((_, i) => i));
  for (const event of events) {
    assert.match(event.inputDigest, /^[a-f0-9]{64}$/);
    const expected = ['search_transcript', 'inspect_segment', 'preview_range'].includes(event.tool) && event.outcome === 'ok' && event.returnedSourceRanges.length > 0;
    assert.equal(event.contentBearing, expected, event.tool);
  }
  const raw = await readFile(join(main.root, 'projects', PROJECT, 'workspaces', 'ws-baseline', 'tool-trace.jsonl'), 'utf8');
  assert.ok(!raw.includes('Cut repetition'), 'notes text never enters the trace');
  assert.equal(hosts.baseline.traceFailures(), 0);
});

function syntheticProject(s: Session, clips: [number, number, number][]): ProjectIR {
  return ProjectIRSchema.parse({
    schemaVersion: 1, id: 'p', transcriptHash: s.transcriptHash, segments: [],
    assets: [{ id: s.assetId, contentHash: s.sourceHash, mediaPath: `assets/${s.sourceHash}`, durationMs: 12000, frameCount: 300,
      video: { streamIndex: 0, width: 160, height: 90, fpsNumerator: 25, fpsDenominator: 1 }, presentationOriginUs: 0 }],
    sequence: { id: 's', clips: clips.map(([start, end, at], i) => ({ id: `c${i}`, assetId: s.assetId, sourceRange: { startMs: start, endMs: end }, timelineStartMs: at })) },
  });
}

test('M5-10 evaluator: duration bounds and review band, retention with split children, semantic review, truth table', () => {
  const evaluate = (clips: [number, number, number][], deliveredMs: number | null) => Object.fromEntries(
    evaluateSubmission(spec(main), { contentHash: 'c'.repeat(64), project: syntheticProject(main, clips), deliveredDurationUs: deliveredMs === null ? null : deliveredMs * 1000 })
      .map(result => [result.checkId.split(':')[0], result.status]));
  const keepAll: [number, number, number][] = [[4000, 5000, 0], [5000, 6000, 1000], [8000, 10000, 2000]];
  assert.deepEqual(evaluate(keepAll, 6000), { duration: 'pass', retention: 'pass', semantic: 'review', all_hard_criteria: 'pass' });
  assert.equal(evaluate(keepAll, 7000).duration, 'fail');
  assert.equal(evaluate(keepAll, null).duration, 'fail');
  assert.equal(evaluate(keepAll, 6500 + DURATION_REVIEW_US / 1000).duration, 'review');
  assert.equal(evaluate(keepAll, 5500 - 30).all_hard_criteria, 'review');
  const dropped = evaluateSubmission(spec(main), { contentHash: 'c'.repeat(64), project: syntheticProject(main, [[4000, 5960, 0], [8000, 10000, 1960]]), deliveredDurationUs: 6_000_000 });
  assert.equal(dropped.find(result => result.checkId.startsWith(`retention:caveat`))!.status, 'fail');
  assert.equal(dropped.find(result => result.checkId === 'all_hard_criteria')!.status, 'fail');
  assert.throws(() => evaluateSubmission({ ...spec(main), sourceHash: 'f'.repeat(64) }, { contentHash: 'c'.repeat(64), project: syntheticProject(main, keepAll), deliveredDurationUs: 0 }));
});

test('M5-11/12/14 runner is blind and frozen-only; diagnostics assign each stage; results stay hashed', async () => {
  ok(await main.store.forkWorkspace('ws-open', taskFixture()));
  await assert.rejects(runEvaluation({ evaluationRoot: evaluations, runId: 'run-open', store: main.store, spec: spec(main),
    submissions: [{ submissionId: 'submission-x', workspaceId: 'ws-open', outcome: 'submitted' }] }), /frozen/);
  const submissions = (['baseline', 'intended', 'kept', 'blind'] as const).map((agent, i) => ({ submissionId: `submission-${i + 1}`, workspaceId: `ws-${agent}`, outcome: 'submitted' as const }));
  const { results, resultsHash } = await runEvaluation({ evaluationRoot: evaluations, runId: 'run-1', store: main.store, spec: spec(main), submissions });
  const status = (id: string, check: string) => results.submissions.find(item => item.submissionId === id)!.editorial.find(result => result.checkId.startsWith(check))!.status;
  assert.equal(status('submission-1', 'all_hard_criteria'), 'pass', JSON.stringify(results.submissions[0]));
  for (const id of ['submission-2', 'submission-3', 'submission-4']) {
    assert.equal(status(id, 'retention:caveat'), 'fail');
    assert.equal(status(id, 'all_hard_criteria'), 'fail');
  }
  assert.ok(results.submissions.every(item => item.mechanical.every(result => result.status === 'pass')));
  await assert.rejects(runEvaluation({ evaluationRoot: evaluations, runId: 'run-1', store: main.store, spec: spec(main), submissions }));

  const { diagnostics } = await runDiagnostics({ evaluationRoot: evaluations, runId: 'run-1', store: main.store, spec: spec(main), submissions }) as { diagnostics: any };
  const stage = (id: string) => diagnostics.submissions.find((item: any) => item.submissionId === id).stages.map((item: any) => item.stage);
  assert.deepEqual(stage('submission-1'), []);
  assert.deepEqual(stage('submission-2'), ['intended_not_executed']);
  assert.deepEqual(stage('submission-3'), ['retrieved_not_kept']);
  assert.deepEqual(stage('submission-4'), ['not_retrieved']);
  assert.equal((await readFile(join(evaluations, 'run-1', 'results.sha256'), 'utf8')).trim(), resultsHash);

  // Blindness: deleting traces and notes changes nothing the evaluator produces.
  for (const agent of ['baseline', 'intended', 'kept', 'blind']) {
    for (const file of ['tool-trace.jsonl', 'notes.json']) await rm(join(main.root, 'projects', PROJECT, 'workspaces', `ws-${agent}`, file), { force: true });
  }
  const again = await runEvaluation({ evaluationRoot: evaluations, runId: 'run-2', store: main.store, spec: spec(main), submissions });
  assert.deepEqual(again.results.submissions, results.submissions);
});

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));
}

test('M5-13 noninterference: no sentinel reaches agent-visible data, and a different spec changes no visible byte', async () => {
  const runs: { outputs: unknown[]; trace: string; root: string }[] = [];
  for (const marker of [SENTINEL, 'SENTINEL-GOLD-0b1d']) {
    const s = await session();
    try {
      // Grade a frozen workspace first, so evaluation side effects exist before the agent session starts.
      ok(await s.store.forkWorkspace('ws-pre', taskFixture()));
      ok(await s.store.freezeSubmission('ws-pre'));
      const root = await tempRoot();
      await runEvaluation({ evaluationRoot: root, runId: 'run-pre', store: s.store, spec: spec(s, marker), submissions: [{ submissionId: 'submission-1', workspaceId: 'ws-pre', outcome: 'submitted' }] });
      await removeRoot(root);
      ok(await s.store.forkWorkspace('ws-a', taskFixture()));
      const result = await scripted(createToolHost({ store: s.store, workspaceId: 'ws-a' }), 'intended');
      const trace = (await readFile(join(s.root, 'projects', PROJECT, 'workspaces', 'ws-a', 'tool-trace.jsonl'), 'utf8')).replace(/"latencyMs":[0-9.e-]+/g, '"latencyMs":0');
      for (const file of await files(join(s.root, 'projects'))) {
        if (/\.(mp4|mkv)$|assets[\\/]/.test(file)) continue;
        assert.ok(!(await readFile(file, 'utf8')).includes('SENTINEL'), `sentinel leaked into ${file}`);
      }
      assert.ok(!JSON.stringify(result).includes('SENTINEL'));
      runs.push({ outputs: result, trace, root: s.root });
    } finally { await s.store.close(); await removeRoot(s.root); }
  }
  assert.deepEqual(runs[0]!.outputs, runs[1]!.outputs);
  assert.equal(runs[0]!.trace, runs[1]!.trace);
});
