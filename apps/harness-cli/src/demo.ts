import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalSerialize, timelineContentFingerprint } from '@aether/core';
import { preflight } from '@aether/media';
import { createToolHost } from '@aether/harness';
import type { ToolHost } from '@aether/harness';
import { hashJson, runDiagnostics, runEvaluation, writeRunManifest } from '@aether/harness/evaluation';
import { readPlan, writePlan } from '@aether/harness/orchestration';
import { DEFAULT_TOOL_LIMITS } from '@aether/tools';
import { DIAGNOSTICS_VERSION } from '@aether/verification/diagnostics';
import { EVALUATOR_VERSION } from '@aether/verification/evaluator';
import type { EvaluationSpec } from '@aether/verification/evaluator';
import { ingestProject, openProjectStore } from '@aether/workspace';
import type { ProjectStore } from '@aether/workspace';
import { aetherAdapter, baselineAdapter, demoTranscript } from './adapters.js';
import { binaries, makeSource, makeTranscript } from './fixtures.js';

export interface ReadinessCheck { id: string; status: 'pass' | 'fail'; detail: string }
export interface ReadinessReport { schemaVersion: 1; checks: ReadinessCheck[]; passed: boolean }

const PROJECT = 'project-demo';
const SENTINEL = 'SENTINEL-DEMO-GOLD';
const TASK = {
  schemaVersion: 1, id: 'task-demo',
  rawRequest: 'Shorten this interview to about 6 seconds. Keep the main argument, the caveat about junior engineers and the recommendation. Remove repetition.',
  userProvidedDurationTarget: { minMs: 5500, maxMs: 6500 }, userProvidedSourceSelections: [],
};
const SAFETY = { schemaVersion: 1, projectId: PROJECT, allowedOperations: ['split', 'trim', 'delete', 'ripple_delete', 'move'], maxOperationsPerBatch: 50, userLocks: [] };

function must<T>(result: { ok: true } & T | { ok: false; error: { code: string } }): T {
  if (!result.ok) throw new Error(`store: ${result.error.code}`);
  return result;
}
async function projectFiles(directory: string): Promise<Record<string, string>> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  const result: Record<string, string> = {};
  for (const entry of entries.filter(item => item.isFile()).sort((a, b) => join(a.parentPath, a.name) < join(b.parentPath, b.name) ? -1 : 1)) {
    const path = join(entry.parentPath, entry.name);
    if (/\.(mp4|mkv)$/.test(path) || /[\\/]assets[\\/]/.test(path)) continue;
    result[path.slice(directory.length + 1).replaceAll('\\', '/')] = await readFile(path, 'utf8');
  }
  return result;
}
/** Receipt IDs are workspace-scoped by design (they hash the workspace ID), so equality checks mask only them. */
const comparable = (value: unknown) => JSON.stringify(value).replace(/receipt-[a-f0-9]{64}/g, 'receipt-*');

/**
 * End-to-end readiness demonstration on generated media: no model account, no network.
 * Every check is recorded; a thrown step fails its check and the run continues where possible.
 */
export async function runFoundationDemo(workDirectory: string): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = [];
  const check = async (id: string, body: () => Promise<string>) => {
    try { checks.push({ id, status: 'pass', detail: await body() }); } catch (error) {
      checks.push({ id, status: 'fail', detail: error instanceof Error ? error.message : String(error) });
    }
  };
  const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
  const storeRoot = join(workDirectory, 'store');
  const evaluationRoot = join(workDirectory, 'evaluations');
  let store: ProjectStore | undefined;
  const hosts: Record<string, ToolHost> = {};

  await check('preflight', async () => {
    const versions = await preflight(binaries);
    return `${versions.ffmpeg} | ${versions.ffprobe}`;
  });
  let ingestion: { sourceHash: string; transcriptHash: string } | undefined;
  await check('ingest', async () => {
    const sourcePath = await makeSource(workDirectory, 'interview');
    const transcriptPath = await makeTranscript(workDirectory, 'interview-transcript', demoTranscript);
    const ingested = must(await ingestProject({ storeRoot, media: { binaries } }, { projectId: PROJECT, sourcePath, transcriptPath, safety: SAFETY }));
    ingestion = ingested.ingestion;
    store = must(await openProjectStore({ storeRoot, projectId: PROJECT, media: { binaries } })).store;
    for (const id of ['ws-equal-a', 'ws-equal-b', 'ws-history', 'ws-baseline', 'ws-aether', 'ws-dropper', 'ws-budget']) {
      must(await store.forkWorkspace(id, TASK));
      hosts[id] = createToolHost({ store, workspaceId: id });
    }
    return `300 frames ingested; source ${ingested.ingestion.sourceHash.slice(0, 12)}`;
  });
  if (!store) return finish(checks);
  const s = store;

  await check('equal_operations', async () => {
    const run = async (host: ToolHost) => {
      const results: unknown[] = [];
      const timeline = await host.call('get_timeline', { workspaceId: host.workspaceId });
      assert(timeline.ok, 'timeline');
      const clipId = (timeline as any).data.clips[0].clipId;
      for (const [batchId, operations] of [
        ['b1', [{ type: 'split', operationId: 'o1', clipId, atSourceMs: 3013 }]],
      ] as const) results.push(await host.call('apply_edit_batch', { schemaVersion: 1, batchId, workspaceId: host.workspaceId, expectedRevision: 0, operations }));
      const after = (await host.call('get_timeline', { workspaceId: host.workspaceId })) as any;
      results.push(after);
      results.push(await host.call('apply_edit_batch', { schemaVersion: 1, batchId: 'b2', workspaceId: host.workspaceId, expectedRevision: after.data.revision,
        operations: [{ type: 'ripple_delete', operationId: 'o2', clipId: after.data.clips[0].clipId }] }));
      results.push(await host.call('preview_range', { workspaceId: host.workspaceId, timelineRange: { startMs: 0, endMs: 9000 } }));
      return results;
    };
    const a = await run(hosts['ws-equal-a']!);
    const b = await run(hosts['ws-equal-b']!);
    assert(comparable(a) === comparable(b), 'equal operations produced different tool outputs');
    const headA = must(await s.readWorkspace('ws-equal-a')).workspace.head;
    const headB = must(await s.readWorkspace('ws-equal-b')).workspace.head;
    assert(headA.contentHash === headB.contentHash, 'equal operations produced different content');
    return `identical outputs, content ${headA.contentHash.slice(0, 12)}, preview timing identical`;
  });

  await check('history_isolation', async () => {
    const directory = join(storeRoot, 'projects', PROJECT);
    const others = (files: Record<string, string>) => Object.fromEntries(Object.entries(files)
      .filter(([path]) => !path.startsWith('workspaces/ws-history/') && !path.startsWith('snapshots/') && !path.startsWith('artifacts/')));
    const before = others(await projectFiles(directory));
    const host = hosts['ws-history']!;
    const timeline = (await host.call('get_timeline', { workspaceId: 'ws-history' })) as any;
    const edit = await host.call('apply_edit_batch', { schemaVersion: 1, batchId: 'h1', workspaceId: 'ws-history', expectedRevision: 0,
      operations: [{ type: 'split', operationId: 'h1', clipId: timeline.data.clips[0].clipId, atSourceMs: 6000 }] });
    assert(edit.ok, 'edit');
    must(await s.undo('ws-history', 1));
    must(await s.redo('ws-history', 2));
    const replay = must(await s.replay('ws-history')).report;
    assert(replay.ok && replay.checkedReceipts === 1, 'replay');
    const after = others(await projectFiles(directory));
    assert(canonicalSerialize(after) === canonicalSerialize(before), 'another workspace or the accepted head changed');
    return 'edit, undo, redo and replay left the accepted head and every other workspace byte-identical';
  });

  let baselineRun: Awaited<ReturnType<typeof baselineAdapter>> | undefined;
  await check('baseline_adapter', async () => {
    baselineRun = await baselineAdapter(hosts['ws-baseline']!);
    assert(baselineRun.recoveredFromStaleRevision, 'stale revision was not reported');
    assert(baselineRun.replayedBatch, 'retried batch was not deduplicated');
    assert(hosts['ws-baseline']!.submission()?.outcome === 'submitted', 'not submitted');
    return `${hosts['ws-baseline']!.callsMade()} tool calls; recovered from stale_revision; retry deduplicated`;
  });

  await check('aether_adapter', async () => {
    await aetherAdapter(hosts['ws-aether']!, s);
    const plan = await readPlan(s, 'ws-aether');
    assert(plan?.selectedSegments.length === 3, 'plan not stored');
    const stale = await writePlan(s, 'ws-baseline', { ...plan, baseContentHash: 'f'.repeat(64) });
    assert(!stale.ok, 'a plan for a frozen or different head was accepted');
    return 'contract and plan stored in the trusted slot; compiled to shared operations';
  });

  await check('arms_same_schedule', async () => {
    const a = timelineContentFingerprint(must(await s.readWorkspace('ws-baseline')).project);
    const b = timelineContentFingerprint(must(await s.readWorkspace('ws-aether')).project);
    assert(a === b, 'baseline and AETHER adapters reached different schedules');
    return `both arms reached schedule ${a.slice(0, 12)}`;
  });

  await check('caveat_dropper', async () => {
    await baselineAdapter(hosts['ws-dropper']!, { dropCaveat: true });
    return 'valid edits removed the unlocked caveat; submission accepted mechanically';
  });

  await check('token_budget', async () => {
    const host = createToolHost({ store: s, workspaceId: 'ws-budget', limits: { ...DEFAULT_TOOL_LIMITS, maxTokens: 2000 } });
    const first = await host.recordModelEvent({ stage: 'reasoning', requestDigest: 'a'.repeat(64), latencyMs: 1, inputTokens: 1500, outputTokens: 400 });
    const second = await host.recordModelEvent({ stage: 'reasoning', requestDigest: 'b'.repeat(64), latencyMs: 1, inputTokens: 1500, outputTokens: 400 });
    assert(first.ok && !second.ok && second.code === 'budget_exhausted', 'token budget not enforced');
    assert(host.submission()?.outcome === 'budget_exhausted', 'not auto-submitted');
    const refused = await host.recordModelEvent({ stage: 'reasoning', requestDigest: 'c'.repeat(64), latencyMs: 1 });
    assert(!refused.ok, 'events accepted after exhaustion');
    return `auto-submitted at ${host.tokensUsed()} tokens`;
  });

  await check('usage_ledger', async () => {
    const { events } = must(await s.readLedger('ws-baseline'));
    const { events: trace } = must(await s.readToolTrace('ws-baseline'));
    const model = events.filter(event => event.kind === 'model');
    const tools = events.filter(event => event.kind === 'tool');
    assert(model.length === 3, `expected 3 model events, saw ${model.length}`);
    assert(model.every(event => event.kind === 'model' && event.cacheTokens === null && event.unavailable.includes('cacheTokens') && event.costUsd === null), 'unavailable usage not flagged');
    assert(tools.length === trace.length, 'every tool call needs one ledger entry');
    assert(tools.filter(event => event.kind === 'tool' && event.replayed).length === 1, 'replayed request must be counted once and flagged');
    assert(events.some(event => event.kind === 'submission' && event.outcome === 'submitted'), 'submission missing');
    return `${model.length} model, ${tools.length} tool, 1 submission event; unavailable usage recorded as null`;
  });

  const spec: EvaluationSpec | undefined = ingestion && {
    schemaVersion: 1, id: `spec-${SENTINEL}`, sourceHash: ingestion.sourceHash, transcriptHash: ingestion.transcriptHash,
    targetDuration: { minMs: 5500, maxMs: 6500 },
    retentionCriteria: [
      { id: `caveat-${SENTINEL}`, description: SENTINEL, referenceRanges: [{ assetId: `asset-${ingestion.sourceHash}`, range: { startMs: 4000, endMs: 6000 } }], contextRanges: [] },
      { id: `recommendation-${SENTINEL}`, description: SENTINEL, referenceRanges: [{ assetId: `asset-${ingestion.sourceHash}`, range: { startMs: 8000, endMs: 10000 } }], contextRanges: [] },
    ],
    semanticRubric: [{ id: `meaning-${SENTINEL}`, description: SENTINEL }],
  };
  const submissions = [
    { submissionId: 'submission-1', workspaceId: 'ws-baseline', outcome: 'submitted' as const, arm: 'baseline' },
    { submissionId: 'submission-2', workspaceId: 'ws-aether', outcome: 'submitted' as const, arm: 'aether' },
    { submissionId: 'submission-3', workspaceId: 'ws-dropper', outcome: 'submitted' as const, arm: 'baseline-dropper' },
  ];

  await check('run_manifest', async () => {
    assert(spec && ingestion, 'no spec');
    const { workspace } = must(await s.readWorkspace('ws-baseline'));
    const versions = await preflight(binaries);
    const hash = await writeRunManifest(evaluationRoot, {
      schemaVersion: 1, runId: 'run-demo',
      project: { projectId: PROJECT, sourceHash: ingestion!.sourceHash, transcriptHash: ingestion!.transcriptHash, initialContentHash: workspace.base.contentHash },
      taskHash: hashJson(TASK), safetyHash: workspace.safetyContextHash, toolLimitsHash: hashJson(DEFAULT_TOOL_LIMITS),
      versions: { tools: 'tools.v1', evaluator: EVALUATOR_VERSION, diagnostics: DIAGNOSTICS_VERSION },
      render: { presets: ['delivery-h264-v1'], binaries: versions },
      model: { provider: 'scripted', modelId: 'readiness-demo', version: '1' }, sampling: {},
      promptRule: 'No arm preloads the full transcript; retrieval only through shared tools.',
      conditions: submissions.map(({ submissionId, workspaceId, arm }) => ({ submissionId, workspaceId, arm })),
      specHash: hashJson(spec),
    });
    return `manifest ${hash.slice(0, 12)} written under the evaluation root`;
  });

  await check('offline_evaluation', async () => {
    assert(spec, 'no spec');
    const callsBefore = hosts['ws-dropper']!.callsMade();
    const { results } = await runEvaluation({ evaluationRoot, runId: 'run-demo', store: s, spec: spec!,
      submissions: submissions.map(({ submissionId, workspaceId, outcome }) => ({ submissionId, workspaceId, outcome })) });
    const status = (id: string, prefix: string) => results.submissions.find(item => item.submissionId === id)!.editorial.find(result => result.checkId.startsWith(prefix))!.status;
    assert(status('submission-1', 'all_hard_criteria') === 'pass', 'baseline should pass');
    assert(status('submission-2', 'all_hard_criteria') === 'pass', 'AETHER should pass');
    assert(status('submission-3', 'retention:caveat') === 'fail' && status('submission-3', 'all_hard_criteria') === 'fail', 'dropped caveat should fail');
    assert(results.submissions.every(item => item.mechanical.length > 0 && item.mechanical.every(result => result.status === 'pass')), 'mechanical checks');
    assert(hosts['ws-dropper']!.callsMade() === callsBefore && must(await s.readWorkspace('ws-dropper')).workspace.state === 'frozen', 'grading caused a repair');
    return 'baseline pass, AETHER pass, caveat-dropper fail; no repair after freeze';
  });

  await check('diagnostics', async () => {
    assert(spec, 'no spec');
    const plan = await readPlan(s, 'ws-aether');
    const { diagnostics } = await runDiagnostics({ evaluationRoot, runId: 'run-demo', store: s, spec: spec!, submissions: [
      { submissionId: 'submission-1', workspaceId: 'ws-baseline' },
      { submissionId: 'submission-2', workspaceId: 'ws-aether', ...(plan ? { planSelectedSegmentIds: plan.selectedSegments } : {}) },
      { submissionId: 'submission-3', workspaceId: 'ws-dropper' },
    ] }) as { diagnostics: { submissions: { submissionId: string; stages: { stage: string }[] }[] } };
    const dropper = diagnostics.submissions.find(item => item.submissionId === 'submission-3')!.stages.map(item => item.stage);
    assert(dropper.join() === 'intended_not_executed', `dropper stage ${dropper.join()}`);
    return 'caveat-dropper: intended_not_executed (noted, then cut)';
  });

  await check('noninterference', async () => {
    const files = await projectFiles(join(storeRoot, 'projects'));
    const leaked = Object.keys(files).filter(path => files[path]!.includes('SENTINEL'));
    assert(leaked.length === 0, `sentinel in ${leaked.join(', ')}`);
    return `${Object.keys(files).length} agent-reachable files scanned; no hidden data`;
  });

  await s.close();
  return finish(checks);
}

function finish(checks: ReadinessCheck[]): ReadinessReport {
  const sorted = [...checks].sort((a, b) => (a.id < b.id ? -1 : 1));
  return { schemaVersion: 1, checks: sorted, passed: sorted.length > 0 && sorted.every(item => item.status === 'pass') };
}

export const reportDigest = (report: ReadinessReport) => createHash('sha256').update(canonicalSerialize(report.checks.map(({ id, status }) => ({ id, status })))).digest('hex');
