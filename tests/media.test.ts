import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ProjectIRSchema, timelineContentFingerprint } from '@aether/core';
import type { EditOperation, ProjectIR } from '@aether/core';
import {
  compileRecipe, fileDigest, importTranscript, MAX_SEGMENTS, MediaFailure, planSegments, preflight, probeSource,
  renderArgs, renderToFile, runProcess,
} from '@aether/media';
import type { ProbeFacts, RenderManifest } from '@aether/media';
import { ingestProject, openProjectStore } from '@aether/workspace';
import type { ProjectStore, StoreFs } from '@aether/workspace';
import { safetyFixture, taskFixture } from './fixtures.js';
import { binaries, decodeMarkers, defaultTranscript, frameMarker, makeSource, makeTranscript } from './media-support.js';
import { err, faultFs, ok, removeRoot, tempRoot, tree } from './workspace-support.js';

const PROJECT = 'project-media';
const safety = { ...safetyFixture(), projectId: PROJECT };
let media: string;
const sources: Record<string, string> = {};
let transcriptPath: string;

before(async () => {
  media = await tempRoot();
  sources['std'] = await makeSource(media, 'std');
  sources['noaudio'] = await makeSource(media, 'noaudio', { audio: false });
  transcriptPath = await makeTranscript(media, 'transcript', defaultTranscript);
});
after(() => removeRoot(media));

async function mediaError(action: () => unknown, code: string, reason?: string) {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof MediaFailure, String(error));
    assert.equal(error.detail.code, code, JSON.stringify(error.detail));
    if (reason) assert.equal(error.detail.reason, reason);
    return;
  }
  assert.fail(`Expected media error ${code}`);
}

async function ingested(source = 'std', fs?: StoreFs): Promise<{ root: string; store: ProjectStore }> {
  const root = await tempRoot();
  ok(await ingestProject({ storeRoot: root, media: { binaries }, ...(fs ? { fs } : {}) },
    { projectId: PROJECT, sourcePath: sources[source]!, transcriptPath, safety }));
  const { store } = ok(await openProjectStore({ storeRoot: root, projectId: PROJECT, media: { binaries } }));
  return { root, store };
}
async function withIngested(body: (store: ProjectStore, root: string) => Promise<void>, source = 'std') {
  const { root, store } = await ingested(source);
  try { await body(store, root); } finally { await store.close(); await removeRoot(root); }
}

/** Apply operations one batch at a time, returning the new head project. */
async function edit(store: ProjectStore, workspaceId: string, operations: EditOperation[]): Promise<ProjectIR> {
  let { workspace } = ok(await store.readWorkspace(workspaceId));
  for (const [i, operation] of operations.entries()) {
    const result = ok(await store.applyEditBatch({ schemaVersion: 1, batchId: `${workspaceId}-${workspace.head.revision}-${i}`,
      workspaceId, expectedRevision: workspace.head.revision, operations: [operation] }));
    workspace = { ...workspace, head: result.head };
  }
  return ok(await store.readWorkspace(workspaceId)).project;
}
const clipAt = (project: ProjectIR, sourceMs: number) =>
  project.sequence.clips.find(clip => clip.sourceRange.startMs <= sourceMs && sourceMs < clip.sourceRange.endMs)!;
async function split(store: ProjectStore, workspaceId: string, atSourceMs: number): Promise<ProjectIR> {
  const { project } = ok(await store.readWorkspace(workspaceId));
  return edit(store, workspaceId, [{ type: 'split', operationId: `split-${atSourceMs}`, clipId: clipAt(project, atSourceMs).id, atSourceMs }]);
}
async function render(store: ProjectStore, workspaceId: string, preset: 'test-lossless-v1' | 'delivery-h264-v1' = 'test-lossless-v1', range?: { startMs: number; endMs: number }) {
  const { workspace } = ok(await store.readWorkspace(workspaceId));
  return ok(await store.renderPreview(workspaceId, { contentHash: workspace.head.contentHash, preset, ...(range ? { range } : {}) }));
}

/** Independent expectation: which source frame (or gap, -1) each output frame shows. */
function expectedFrames(project: ProjectIR, startMs: number, endMs: number): number[] {
  const result: number[] = [];
  for (let frame = startMs / 40; frame < endMs / 40; frame++) {
    const clip = project.sequence.clips.find(item => item.timelineStartMs / 40 <= frame
      && frame < (item.timelineStartMs + item.sourceRange.endMs - item.sourceRange.startMs) / 40);
    result.push(clip ? clip.sourceRange.startMs / 40 + frame - clip.timelineStartMs / 40 : -1);
  }
  return result;
}
async function assertExactRender(manifest: RenderManifest, mediaPath: string, project: ProjectIR, audio = true) {
  assert.deepEqual(manifest.checks.map(check => check.status), ['pass', 'pass'], JSON.stringify(manifest.checks));
  const sourceFrames = expectedFrames(project, manifest.effectiveRange.startMs, manifest.effectiveRange.endMs);
  const decoded = await decodeMarkers(mediaPath);
  assert.equal(decoded.frames.length, sourceFrames.length);
  sourceFrames.forEach((source, i) => {
    const frame = decoded.frames[i]!;
    if (source < 0) assert.ok(frame.top === frame.bottom && frame.bottom < 100, `frame ${i} should be black`);
    else assert.deepEqual(frame, frameMarker(source), `frame ${i}`);
  });
  assert.equal(decoded.samples.length, sourceFrames.length * 1920);
  sourceFrames.forEach((source, i) => {
    for (const j of [0, 1, 959, 1919]) {
      const expected = source < 0 || !audio ? -1 : source * 1920 + j;
      assert.equal(decoded.samples[i * 1920 + j], expected, `sample ${i * 1920 + j}`);
    }
  });
  if (audio) {
    for (let i = 1; i < decoded.samples.length; i++) {
      const previous = decoded.samples[i - 1]!;
      const current = decoded.samples[i]!;
      if (i % 1920 !== 0 && previous >= 0) assert.equal(current, previous + 1, `audio continuity at ${i}`);
    }
  }
}

test('M4-1 preflight reports versions; a bad binary path is ffmpeg_missing', async () => {
  const versions = await preflight(binaries);
  assert.match(versions.ffmpeg, /^ffmpeg version /);
  assert.match(versions.ffprobe, /^ffprobe version /);
  await mediaError(() => preflight({ ffmpeg: join(media, 'no-such-ffmpeg'), ffprobe: binaries.ffprobe }), 'ffmpeg_missing');
});

test('M4-2 probe accepts the controlled profile exactly, including a non-zero origin and H.264/AAC', async () => {
  const facts = await probeSource(binaries, sources['std']!);
  assert.deepEqual(facts, {
    video: { streamIndex: 0, codec: 'ffv1', pixFmt: 'gray', width: 160, height: 90, frameCount: 300 },
    audio: { streamIndex: 1, codec: 'pcm_f32le', channels: 1, sampleCount: 576000 },
    presentationOriginUs: 0, formatDurationUs: 12_000_000,
  });
  const origin = await probeSource(binaries, await makeSource(media, 'origin', { originSeconds: 2 }));
  assert.equal(origin.presentationOriginUs, 2_000_000);
  assert.equal(origin.video.frameCount, 300);
  const realistic = await probeSource(binaries, await makeSource(media, 'realistic', { realistic: true }));
  assert.equal(realistic.video.frameCount, 300);
  assert.ok(realistic.audio!.sampleCount >= 576000);
  assert.equal((await probeSource(binaries, sources['noaudio']!)).audio, undefined);
});

test('M4-3 probe rejects each unsupported variant with its reason', async () => {
  const cases: [string, Parameters<typeof makeSource>[2], string][] = [
    ['fps30', { fps: 30 }, 'frame_rate'], ['vfr', { vfr: true }, 'vfr'], ['a44', { sampleRate: 44100 }, 'audio_rate'],
    ['two', { twoVideo: true }, 'stream_ambiguous'], ['rot', { rotate: true }, 'rotation'], ['hdr', { hdr: true }, 'hdr'],
    ['short', { audioSeconds: 11.8 }, 'av_mapping'],
  ];
  for (const [name, options, reason] of cases) {
    const path = await makeSource(media, name, options);
    await mediaError(() => probeSource(binaries, path), 'unsupported_source', reason);
  }
  await writeFile(join(media, 'not-media.mkv'), 'not a video');
  await mediaError(() => probeSource(binaries, join(media, 'not-media.mkv')), 'probe_failed');
});

test('M4-4 transcript import: units, tie rounding, validation, deterministic segment IDs', () => {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const context = { assetId: 'asset-x', durationMs: 12000 };
  const seconds = importTranscript(bytes({ schemaVersion: 1, timeUnit: 'seconds', cues: [{ start: 0.0005, end: 1.0015, text: 'a' }] }), context);
  assert.deepEqual([seconds.transcript.cues[0]!.startMs, seconds.transcript.cues[0]!.endMs], [0, 1001]);
  const ms = importTranscript(bytes({ schemaVersion: 1, timeUnit: 'milliseconds', cues: [{ start: 10.5, end: 20, text: 'a' }, { start: 30, end: 40, text: 'b' }] }), context);
  assert.deepEqual(ms.segments.map(segment => segment.sourceRange), [{ startMs: 10, endMs: 20 }, { startMs: 30, endMs: 40 }]);
  const again = importTranscript(bytes({ schemaVersion: 1, timeUnit: 'milliseconds', cues: [{ start: 10.5, end: 20, text: 'a' }, { start: 30, end: 40, text: 'b' }] }), context);
  assert.deepEqual(again.segments.map(segment => segment.id), ms.segments.map(segment => segment.id));
  const shifted = importTranscript(bytes({ schemaVersion: 1, timeUnit: 'milliseconds', cues: [{ start: 10.5, end: 21, text: 'a' }, { start: 30, end: 40, text: 'b' }] }), context);
  assert.notEqual(shifted.segments[0]!.id, ms.segments[0]!.id);
  assert.notEqual(shifted.segments[1]!.id, ms.segments[1]!.id, 'digest change alters every segment ID');
  const invalid = [
    { schemaVersion: 1, timeUnit: 'seconds', cues: [{ start: 2, end: 2, text: 'empty' }] },
    { schemaVersion: 1, timeUnit: 'seconds', cues: [{ start: 3, end: 4, text: 'b' }, { start: 1, end: 2, text: 'a' }] },
    { schemaVersion: 1, timeUnit: 'seconds', cues: [{ start: 1, end: 3, text: 'a' }, { start: 2, end: 4, text: 'b' }] },
    { schemaVersion: 1, timeUnit: 'seconds', cues: [{ start: 11, end: 12.5, text: 'late' }] },
    { schemaVersion: 1, timeUnit: 'minutes', cues: [] },
  ];
  for (const value of invalid) assert.throws(() => importTranscript(bytes(value), context), MediaFailure);
  assert.throws(() => importTranscript(new Uint8Array([0xff, 0xfe]), context), MediaFailure);
});

test('M4-5 ingestion: byte-identical asset, untouched source, full-source project, already_exists, spec-independent', async () => {
  const sourceBefore = await fileDigest(sources['std']!);
  const { root, store } = await ingested();
  try {
    const { project } = ok(await store.readAcceptedHead());
    const asset = project.assets[0]!;
    assert.equal(asset.contentHash, sourceBefore);
    assert.equal(await fileDigest(join(root, 'projects', PROJECT, 'assets', asset.contentHash)), sourceBefore);
    assert.equal(await fileDigest(sources['std']!), sourceBefore);
    assert.deepEqual(project.sequence.clips, [{ id: 'clip-source', assetId: asset.id, sourceRange: { startMs: 0, endMs: 12000 }, timelineStartMs: 0 }]);
    assert.equal(project.segments.length, 3);
    assert.equal(asset.durationMs, 12000);
    await store.close();
    err(await ingestProject({ storeRoot: root, media: { binaries } }, { projectId: PROJECT, sourcePath: sources['std']!, transcriptPath, safety }), 'already_exists');
    const other = await tempRoot();
    try {
      await mkdir(join(other, 'evaluations', 'run-1'), { recursive: true });
      await writeFile(join(other, 'evaluations', 'run-1', 'evaluation-spec.json'), '{"hidden":true}');
      ok(await ingestProject({ storeRoot: other, media: { binaries } }, { projectId: PROJECT, sourcePath: sources['std']!, transcriptPath, safety }));
      const files = (dir: string) => readFile(join(dir, 'projects', PROJECT, 'accepted-head.json'), 'utf8');
      assert.equal(await files(other), await files(root));
    } finally { await removeRoot(other); }
  } finally { await removeRoot(root); }
});

test('M4-5b ingestion crash at every write position leaves no project or a complete one', async () => {
  const reference = await tempRoot();
  const counter = faultFs();
  ok(await ingestProject({ storeRoot: reference, fs: counter.fs, media: { binaries } }, { projectId: PROJECT, sourcePath: sources['std']!, transcriptPath, safety }));
  const writes = counter.writes();
  const complete = await tree(join(reference, 'projects', PROJECT));
  await removeRoot(reference);
  for (let k = 1; k <= writes; k++) {
    const root = await tempRoot();
    try {
      const faulty = faultFs();
      faulty.arm(k);
      await ingestProject({ storeRoot: root, fs: faulty.fs, media: { binaries } }, { projectId: PROJECT, sourcePath: sources['std']!, transcriptPath, safety });
      await rm(join(root, 'projects', PROJECT, 'owner.lock'), { force: true });
      const opened = await openProjectStore({ storeRoot: root, projectId: PROJECT });
      if (opened.ok) {
        await opened.store.close();
        const files = await tree(join(root, 'projects', PROJECT));
        for (const [path, content] of Object.entries(complete)) assert.equal(files[path], content, `write ${k}: ${path}`);
      } else {
        assert.equal(opened.error.code, 'project_not_found', `write ${k}`);
        ok(await ingestProject({ storeRoot: root, media: { binaries } }, { projectId: PROJECT, sourcePath: sources['std']!, transcriptPath, safety }));
      }
    } finally { await removeRoot(root); }
  }
});

const probeFacts: ProbeFacts = {
  video: { streamIndex: 0, codec: 'ffv1', pixFmt: 'gray', width: 160, height: 90, frameCount: 300 },
  audio: { streamIndex: 1, codec: 'pcm_f32le', channels: 1, sampleCount: 576000 }, presentationOriginUs: 0, formatDurationUs: 12_000_000,
};
function syntheticProject(clips: [number, number, number][]): ProjectIR {
  const hash = 'a'.repeat(64);
  return ProjectIRSchema.parse({
    schemaVersion: 1, id: 'p', transcriptHash: 'b'.repeat(64), segments: [],
    assets: [{ id: `asset-${hash}`, contentHash: hash, mediaPath: `assets/${hash}`, durationMs: 12000, frameCount: 300,
      video: { streamIndex: 0, width: 160, height: 90, fpsNumerator: 25, fpsDenominator: 1 },
      audio: { streamIndex: 1, sampleRate: 48000, channels: 1 }, presentationOriginUs: 0 }],
    sequence: { id: 's', clips: clips.map(([start, end, at], i) => ({ id: `c${i}`, assetId: `asset-${hash}`, sourceRange: { startMs: start, endMs: end }, timelineStartMs: at })) },
  });
}

test('M4-6 recipe compiler is pure, exact in frames/samples, bounded, and emits no caller strings', () => {
  const project = syntheticProject([[400, 800, 0], [0, 400, 800], [800, 1200, 1200]]);
  assert.deepEqual(planSegments(project, { startMs: 0, endMs: 1600 }), [
    { kind: 'clip', sourceStartFrame: 10, frames: 10 }, { kind: 'gap', frames: 10 }, { kind: 'clip', sourceStartFrame: 0, frames: 10 },
    { kind: 'clip', sourceStartFrame: 20, frames: 10 },
  ]);
  assert.deepEqual(planSegments(project, { startMs: 200, endMs: 1000 }), [
    { kind: 'clip', sourceStartFrame: 15, frames: 5 }, { kind: 'gap', frames: 10 }, { kind: 'clip', sourceStartFrame: 0, frames: 5 },
  ]);
  const contiguous = syntheticProject([[0, 400, 0], [400, 800, 400]]);
  assert.deepEqual(planSegments(contiguous, { startMs: 0, endMs: 800 }), [{ kind: 'clip', sourceStartFrame: 0, frames: 20 }]);
  const recipe = compileRecipe(project, { startMs: 0, endMs: 1600 }, 'test-lossless-v1', probeFacts);
  assert.deepEqual(recipe.expected, { frames: 40, samples: 76800, durationMs: 1600 });
  assert.match(recipe.filterGraph, /atrim=start_sample=19200:end_sample=38400/);
  const silent = compileRecipe(project, { startMs: 0, endMs: 1600 }, 'test-lossless-v1', { ...probeFacts, audio: undefined } as unknown as ProbeFacts);
  assert.ok(!silent.filterGraph.includes('[0:1]'));
  for (const range of [{ startMs: 0, endMs: 1700 }, { startMs: 20, endMs: 400 }, { startMs: 400, endMs: 400 }]) {
    assert.throws(() => compileRecipe(project, range, 'test-lossless-v1', probeFacts), MediaFailure);
  }
  assert.throws(() => compileRecipe(syntheticProject([]), { startMs: 0, endMs: 40 }, 'test-lossless-v1', probeFacts), MediaFailure);
  const many = syntheticProject(Array.from({ length: MAX_SEGMENTS / 2 + 1 }, (_, i) => [i * 40, i * 40 + 20 * 0 + 40, i * 80] as [number, number, number]));
  assert.throws(() => compileRecipe(many, { startMs: 0, endMs: (MAX_SEGMENTS / 2 + 1) * 80 - 40 }, 'test-lossless-v1', probeFacts), MediaFailure);
  assert.throws(() => compileRecipe(project, { startMs: 0, endMs: 1600 }, 'custom' as never, probeFacts));
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let trial = 0; trial < 50; trial++) {
    const clips: [number, number, number][] = [];
    let at = 0;
    for (let i = 0; i < 1 + Math.floor(random() * 8); i++) {
      const start = Math.floor(random() * 250) * 40;
      const length = (1 + Math.floor(random() * 40)) * 40;
      at += Math.floor(random() * 3) * 40;
      clips.push([start, Math.min(12000, start + length), at]);
      at += Math.min(12000, start + length) - start;
    }
    const value = compileRecipe(syntheticProject(clips), { startMs: 0, endMs: at }, random() < 0.5 ? 'test-lossless-v1' : 'delivery-h264-v1', probeFacts);
    assert.match(value.filterGraph, /^[[\]A-Za-z0-9_:=,;.-]+$/, 'filter graph uses only the fixed grammar');
    const args = renderArgs(value, 'IN', 'OUT');
    assert.deepEqual(args.filter(arg => arg === 'IN' || arg === 'OUT'), ['IN', 'OUT']);
    assert.equal(value.segments.reduce((total, segment) => total + segment.frames, 0), at / 40);
  }
});

test('M4-7 lossless renders are frame- and sample-exact: full, split, trim, reorder, gaps, sub-range', () => withIngested(async store => {
  ok(await store.forkWorkspace('ws-a', taskFixture()));
  let rendered = await render(store, 'ws-a');
  let { project } = ok(await store.readWorkspace('ws-a'));
  await assertExactRender(rendered.manifest, rendered.mediaPath, project);
  project = await split(store, 'ws-a', 4013);
  project = await split(store, 'ws-a', 8000);
  rendered = await render(store, 'ws-a');
  await assertExactRender(rendered.manifest, rendered.mediaPath, project);
  const middle = clipAt(project, 5000);
  const last = clipAt(project, 9000);
  const first = clipAt(project, 100);
  project = await edit(store, 'ws-a', [
    { type: 'trim', operationId: 'trim', clipId: first.id, sourceRange: { startMs: 400, endMs: 4000 } },
    { type: 'delete', operationId: 'del', clipId: middle.id },
    { type: 'move', operationId: 'move', clipId: last.id, destinationTimelineStartMs: 4000 },
  ]);
  rendered = await render(store, 'ws-a');
  await assertExactRender(rendered.manifest, rendered.mediaPath, project);
  rendered = await render(store, 'ws-a', 'test-lossless-v1', { startMs: 1013, endMs: 6020 });
  assert.deepEqual(rendered.manifest.effectiveRange, { startMs: 1000, endMs: 6000 });
  assert.deepEqual(rendered.manifest.requestedRange, { startMs: 1013, endMs: 6020 });
  await assertExactRender(rendered.manifest, rendered.mediaPath, project);
}));

test('M4-7b a source without audio renders synthesized silence', () => withIngested(async store => {
  ok(await store.forkWorkspace('ws-a', taskFixture()));
  const project = await split(store, 'ws-a', 6000);
  const moved = await edit(store, 'ws-a', [{ type: 'move', operationId: 'm', clipId: clipAt(project, 7000).id, destinationTimelineStartMs: 12400 }]);
  const rendered = await render(store, 'ws-a');
  await assertExactRender(rendered.manifest, rendered.mediaPath, moved, false);
}, 'noaudio'));

test('M4-8 accumulation: 1, 10 and 100 off-grid cuts stay exact (lossless) and within the global bound (delivery)', () => withIngested(async store => {
  for (const cuts of [1, 10, 100]) {
    const id = `ws-${cuts}`;
    ok(await store.forkWorkspace(id, taskFixture()));
    let project: ProjectIR | undefined;
    for (let k = 0; k < cuts; k++) project = await split(store, id, (2 * k + 3) * 40 + 13);
    const pieces = [...project!.sequence.clips].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
    const removals: EditOperation[] = pieces.filter((_, i) => i % 3 === 1).map((clip, i) => ({ type: 'ripple_delete', operationId: `r${i}`, clipId: clip.id }));
    project = await edit(store, id, removals);
    const end = Math.max(...project.sequence.clips.map(clip => clip.timelineStartMs + clip.sourceRange.endMs - clip.sourceRange.startMs));
    const firstClip = [...project.sequence.clips].sort((a, b) => a.timelineStartMs - b.timelineStartMs)[0]!;
    project = await edit(store, id, [{ type: 'move', operationId: 'reorder', clipId: firstClip.id, destinationTimelineStartMs: end }]);
    const lossless = await render(store, id);
    await assertExactRender(lossless.manifest, lossless.mediaPath, project);
    const delivery = await render(store, id, 'delivery-h264-v1');
    assert.ok(delivery.manifest.checks.every(check => check.status === 'pass'), `${cuts} cuts: ${JSON.stringify(delivery.manifest.checks)}`);
    assert.equal(delivery.manifest.measured.frames, delivery.manifest.expected.frames, `${cuts} cuts: video frame count`);
  }
}));

test('M4-9 history equivalence: split keeps frames; undo restores; equal fingerprints decode identically', () => withIngested(async store => {
  ok(await store.forkWorkspace('ws-a', taskFixture()));
  ok(await store.forkWorkspace('ws-b', taskFixture()));
  const original = await render(store, 'ws-a');
  const splitProject = await split(store, 'ws-b', 2000);
  const { project: base } = ok(await store.readWorkspace('ws-a'));
  assert.equal(timelineContentFingerprint(splitProject), timelineContentFingerprint(base));
  const splitRender = await render(store, 'ws-b');
  assert.notEqual(splitRender.manifest.artifactId, original.manifest.artifactId);
  assert.equal(splitRender.manifest.measured.frames, original.manifest.measured.frames);
  assert.deepEqual(await decodeMarkers(splitRender.mediaPath), await decodeMarkers(original.mediaPath));
  ok(await store.undo('ws-b', 1));
  const undone = await render(store, 'ws-b');
  assert.equal(undone.manifest.contentHash, original.manifest.contentHash);
  assert.equal(undone.reused, true, 'same content and preset reuse one artifact');
  assert.deepEqual(await decodeMarkers(undone.mediaPath), await decodeMarkers(original.mediaPath));
}));

test('M4-10 artifacts: idempotent, stale content rejected, orphan re-rendered, heads untouched, needs media', () => withIngested(async (store, root) => {
  ok(await store.forkWorkspace('ws-a', taskFixture()));
  const dir = join(root, 'projects', PROJECT);
  const before = Object.fromEntries(Object.entries(await tree(dir)).filter(([path]) => !path.startsWith('artifacts/')));
  const first = await render(store, 'ws-a');
  const second = await render(store, 'ws-a');
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.deepEqual(second.manifest, first.manifest);
  const after = Object.fromEntries(Object.entries(await tree(dir)).filter(([path]) => !path.startsWith('artifacts/')));
  assert.deepEqual(after, before, 'rendering changes no head, receipt or snapshot');
  err(await store.renderPreview('ws-a', { contentHash: 'f'.repeat(64), preset: 'test-lossless-v1' }), 'stale_content');
  err(await store.renderPreview('ws-a', { contentHash: first.manifest.contentHash, preset: 'custom' }), 'invalid_input');
  const outOfRange = await store.renderPreview('ws-a', { contentHash: first.manifest.contentHash, preset: 'test-lossless-v1', range: { startMs: 0, endMs: 20000 } });
  assert.ok(!outOfRange.ok && outOfRange.error.media?.code === 'render_out_of_bounds');
  await rm(join(dir, 'artifacts', first.manifest.artifactId, 'manifest.json'));
  const rerendered = await render(store, 'ws-a');
  assert.equal(rerendered.reused, false);
  assert.equal(rerendered.manifest.artifactId, first.manifest.artifactId);
  ok(await store.freezeSubmission('ws-a'));
  assert.equal((await render(store, 'ws-a')).reused, true, 'frozen workspaces can still be rendered');

  const plain = await tempRoot();
  const { setup } = await import('./workspace-support.js');
  const m3 = await setup(plain, ['ws-a']);
  try {
    const { workspace } = ok(await m3.readWorkspace('ws-a'));
    err(await m3.renderPreview('ws-a', { contentHash: workspace.head.contentHash, preset: 'test-lossless-v1' }), 'media_unavailable');
  } finally { await m3.close(); await removeRoot(plain); }
}));

test('M4-12 timeouts kill the process and report render_failed/timeout', async () => {
  const started = Date.now();
  const output = await runProcess(binaries.ffmpeg, ['-v', 'error', '-re', '-f', 'lavfi', '-i', 'color=s=16x16:r=25', '-f', 'null', '-'], { timeoutMs: 1000 });
  assert.equal(output.timedOut, true);
  assert.ok(Date.now() - started < 10_000);
  const recipe = compileRecipe(syntheticProject([[0, 12000, 0]]), { startMs: 0, endMs: 12000 }, 'delivery-h264-v1', probeFacts);
  await mediaError(() => renderToFile(binaries, recipe, sources['std']!, join(media, 'timeout.mp4'), 1), 'render_failed', 'timeout');
});
