import { createHash } from 'node:crypto';
import { canonicalSerialize } from './canonical.js';
import { ProjectIRSchema } from './project.js';
import type { Range } from './primitives.js';

// Content schedule identity for this CFR profile; not a decoded-render equivalence proof.
export function timelineContentFingerprint(input: unknown): string {
  const project = ProjectIRSchema.parse(input);
  const asset = project.assets[0]!;
  const media = {
    contentHash: asset.contentHash, video: asset.video,
    ...(asset.audio ? { audio: asset.audio } : {}), presentationOriginUs: asset.presentationOriginUs,
  };
  const schedule: { timelineStartMs: number; sourceRange: Range }[] = [];
  for (const clip of [...project.sequence.clips].sort((a, b) => a.timelineStartMs - b.timelineStartMs)) {
    const last = schedule.at(-1);
    if (last && last.sourceRange.endMs === clip.sourceRange.startMs
      && last.timelineStartMs + (last.sourceRange.endMs - last.sourceRange.startMs) === clip.timelineStartMs) {
      last.sourceRange.endMs = clip.sourceRange.endMs;
    } else schedule.push({ timelineStartMs: clip.timelineStartMs, sourceRange: { ...clip.sourceRange } });
  }
  const descriptor = { domain: 'aether.timeline-content.v1', media: schedule.length ? media : null, schedule };
  return createHash('sha256').update(canonicalSerialize(descriptor), 'utf8').digest('hex');
}
