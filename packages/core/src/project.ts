import { z } from 'zod';
import { DigestSchema, IdSchema, MsSchema, PositiveIntSchema, RangeSchema, UIntSchema } from './primitives.js';

export const SourceAssetSchema = z.strictObject({
  id: IdSchema,
  contentHash: DigestSchema,
  // Logical reference only. Host paths belong in a later trusted resolver.
  mediaPath: z.string().regex(/^assets\/[a-f0-9]{64}$/, 'Canonical project-relative asset reference'),
  durationMs: PositiveIntSchema,
  frameCount: PositiveIntSchema,
  video: z.strictObject({
    streamIndex: UIntSchema, width: PositiveIntSchema, height: PositiveIntSchema,
    fpsNumerator: z.literal(25), fpsDenominator: z.literal(1),
  }),
  audio: z.strictObject({
    streamIndex: UIntSchema, sampleRate: z.literal(48000), channels: PositiveIntSchema,
  }).optional(),
  presentationOriginUs: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
}).superRefine((asset, context) => {
  if (asset.mediaPath !== `assets/${asset.contentHash}`) {
    context.addIssue({ code: 'custom', path: ['mediaPath'], message: 'Asset reference must match source digest' });
  }
  if (asset.id !== `asset-${asset.contentHash}`) {
    context.addIssue({ code: 'custom', path: ['id'], message: 'Asset ID must derive from source digest' });
  }
  if (!Number.isSafeInteger(asset.frameCount * 40) || asset.durationMs !== asset.frameCount * 40) {
    context.addIssue({ code: 'custom', path: ['durationMs'], message: 'Duration must equal 25 fps frame extent' });
  }
  if (asset.audio?.streamIndex === asset.video.streamIndex) {
    context.addIssue({ code: 'custom', path: ['audio', 'streamIndex'], message: 'Audio/video streams must differ' });
  }
});

export const MediaSegmentSchema = z.strictObject({
  id: IdSchema, assetId: IdSchema, sourceRange: RangeSchema,
  transcriptText: z.string(), speaker: z.string().optional(),
});

export const TimelineClipSchema = z.strictObject({
  id: IdSchema, assetId: IdSchema, sourceRange: RangeSchema, timelineStartMs: MsSchema,
}).superRefine((clip, context) => {
  if ([clip.sourceRange.startMs, clip.sourceRange.endMs, clip.timelineStartMs].some(time => time % 40 !== 0)) {
    context.addIssue({ code: 'custom', message: 'Clip boundaries and positions must align to 40 ms frames' });
  }
  if (!Number.isSafeInteger(clip.timelineStartMs + (clip.sourceRange.endMs - clip.sourceRange.startMs))) {
    context.addIssue({ code: 'custom', message: 'Timeline end must be a safe integer' });
  }
});

export const ProjectIRSchema = z.strictObject({
  schemaVersion: z.literal(1), id: IdSchema,
  assets: z.array(SourceAssetSchema).length(1), transcriptHash: DigestSchema,
  segments: z.array(MediaSegmentSchema),
  sequence: z.strictObject({ id: IdSchema, clips: z.array(TimelineClipSchema) }),
}).superRefine((project, context) => {
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  for (const [collection, items] of [
    ['segments', project.segments], ['clips', project.sequence.clips],
  ] as const) {
    const ids = new Set<string>();
    items.forEach((item, index) => {
      const path = collection === 'clips' ? ['sequence', 'clips', index] : ['segments', index];
      if (ids.has(item.id)) context.addIssue({ code: 'custom', path, message: 'Duplicate identity' });
      ids.add(item.id);
      const asset = assets.get(item.assetId);
      if (!asset) context.addIssue({ code: 'custom', path, message: 'Unknown source asset' });
      else if (item.sourceRange.endMs > asset.durationMs) {
        context.addIssue({ code: 'custom', path, message: 'Source range exceeds playable media extent' });
      }
    });
  }
  const clips = [...project.sequence.clips].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  let previousEnd = 0;
  for (const clip of clips) {
    if (clip.timelineStartMs < previousEnd) {
      context.addIssue({ code: 'custom', path: ['sequence', 'clips'], message: 'Timeline clips overlap' });
    }
    previousEnd = clip.timelineStartMs + (clip.sourceRange.endMs - clip.sourceRange.startMs);
  }
});

export type SourceAsset = z.infer<typeof SourceAssetSchema>;
export type MediaSegment = z.infer<typeof MediaSegmentSchema>;
export type TimelineClip = z.infer<typeof TimelineClipSchema>;
export type ProjectIR = z.infer<typeof ProjectIRSchema>;
