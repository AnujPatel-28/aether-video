import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeEditBatch, hashProjectIR, ProjectIRSchema, timelineContentFingerprint } from '@aether/core';
import { projectFixture, safetyFixture } from './fixtures.js';

test('exact state identity includes opaque IDs while content fingerprint ignores administrative IDs and transcript', () => {
  const before = projectFixture(); const alternate = projectFixture();
  alternate.id = 'another-project'; alternate.sequence.id = 'another-sequence';
  alternate.sequence.clips.forEach((clip, i) => { clip.id = `another-clip-${i}`; });
  alternate.segments.forEach((segment, i) => { segment.id = `another-segment-${i}`; segment.transcriptText = 'another transcription'; });
  alternate.transcriptHash = 'c'.repeat(64);
  assert.notEqual(hashProjectIR(before), hashProjectIR(alternate));
  assert.equal(timelineContentFingerprint(before), timelineContentFingerprint(alternate));
  alternate.sequence.clips.reverse();
  assert.equal(timelineContentFingerprint(before), timelineContentFingerprint(alternate));
});
test('fingerprint includes source bytes, selected streams, presentation origin, cuts, gaps and ordering', () => {
  const before = projectFixture(); const original = timelineContentFingerprint(before);
  const variants = [
    () => { const p = projectFixture(); p.assets[0]!.video.streamIndex = 2; return p; },
    () => { const p = projectFixture(); delete p.assets[0]!.audio; return p; },
    () => { const p = projectFixture(); p.assets[0]!.audio!.channels = 2; return p; },
    () => { const p = projectFixture(); p.assets[0]!.presentationOriginUs = 1000; return p; },
    () => { const p = projectFixture(); p.sequence.clips[1]!.timelineStartMs = 1040; return p; },
    () => { const p = projectFixture(); p.sequence.clips[0]!.sourceRange.endMs = 960; return p; },
    () => { const p = projectFixture(); p.sequence.clips[0]!.timelineStartMs = 1000; p.sequence.clips[1]!.timelineStartMs = 0; return p; },
    () => {
      const p = projectFixture(); const oldId = p.assets[0]!.id; const hash = 'd'.repeat(64);
      p.assets[0]!.id = `asset-${hash}`; p.assets[0]!.contentHash = hash; p.assets[0]!.mediaPath = `assets/${hash}`;
      [...p.segments, ...p.sequence.clips].forEach(item => { if (item.assetId === oldId) item.assetId = `asset-${hash}`; });
      return p;
    },
  ];
  for (const variant of variants) assert.notEqual(timelineContentFingerprint(variant()), original);
  const invalid = projectFixture(); invalid.sequence.clips[0]!.timelineStartMs = 1;
  assert.throws(() => timelineContentFingerprint(invalid));
});
test('empty timeline content fingerprint is independent of unused media/metadata', () => {
  const first = projectFixture(); const second = projectFixture();
  first.sequence.clips = []; second.sequence.clips = []; second.assets[0]!.video.width = 1280;
  assert.equal(timelineContentFingerprint(first), timelineContentFingerprint(second));
});
for (const count of [1, 10, 100]) {
  test(`${count} off-grid splits retain exact aggregate nominal extent and content schedule`, () => {
    let project = projectFixture();
    project.assets[0]!.frameCount = 300; project.assets[0]!.durationMs = 12000;
    project.sequence.clips = [{ id: 'whole', assetId: project.assets[0]!.id, sourceRange: { startMs: 0, endMs: 12000 }, timelineStartMs: 0 }];
    ProjectIRSchema.parse(project);
    const original = timelineContentFingerprint(project);
    let currentClipId = 'whole';
    for (let i = 0; i < count; i++) {
      const requestedMs = (i + 1) * 80 + 13;
      const result = executeEditBatch(project, {
        schemaVersion: 1, workspaceId: 'workspace', expectedRevision: 0, batchId: `split-${i}`,
        operations: [{ type: 'split', operationId: `split-${i}`, clipId: currentClipId, atSourceMs: requestedMs }],
      }, safetyFixture());
      assert.ok(result.ok);
      assert.equal(result.operationReceipts[0]!.alignments[0]!.effectiveMs, (i + 1) * 80);
      assert.equal(result.operationReceipts[0]!.alignments[0]!.requestedMs, requestedMs);
      currentClipId = result.clipMappings[currentClipId]![1]!;
      project = result.nextProject;
    }
    assert.equal(project.sequence.clips.reduce((sum, clip) => sum + clip.sourceRange.endMs - clip.sourceRange.startMs, 0), 12000);
    assert.equal(timelineContentFingerprint(project), original);
    assert.equal(project.sequence.clips.length, count + 1);
    const last = project.sequence.clips.at(-1)!;
    assert.equal(last.timelineStartMs + (last.sourceRange.endMs - last.sourceRange.startMs), 12000);
  });
}
