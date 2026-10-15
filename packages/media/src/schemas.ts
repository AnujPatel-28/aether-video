import { z } from 'zod';
import { DigestSchema, IdSchema, MsSchema, RangeSchema, UIntSchema } from '@aether/core';

export const FRAME_SAMPLES = 1920;
export const SAMPLE_RATE = 48000;

export const TranscriptInputSchema = z.strictObject({
  schemaVersion: z.literal(1), timeUnit: z.enum(['seconds', 'milliseconds']),
  cues: z.array(z.strictObject({
    start: z.number().finite().nonnegative(), end: z.number().finite().nonnegative(),
    text: z.string(), speaker: z.string().min(1).optional(),
  })),
});
export const NormalizedCueSchema = z.strictObject({
  index: UIntSchema, startMs: MsSchema, endMs: MsSchema, text: z.string(), speaker: z.string().optional(),
});
export const NormalizedTranscriptSchema = z.strictObject({
  schemaVersion: z.literal(1), sourceDigest: DigestSchema, cues: z.array(NormalizedCueSchema),
});

export const BinaryVersionsSchema = z.strictObject({ ffmpeg: z.string(), ffprobe: z.string() });
export const ProbeFactsSchema = z.strictObject({
  video: z.strictObject({
    streamIndex: UIntSchema, codec: z.string(), pixFmt: z.string(), width: z.number().int().positive(),
    height: z.number().int().positive(), frameCount: z.number().int().positive(),
  }),
  audio: z.strictObject({
    streamIndex: UIntSchema, codec: z.string(), channels: z.union([z.literal(1), z.literal(2)]), sampleCount: UIntSchema,
  }).optional(),
  presentationOriginUs: z.number().int(),
  formatDurationUs: z.number().int().nonnegative(),
});
export const IngestionRecordSchema = z.strictObject({
  schemaVersion: z.literal(1), sourceHash: DigestSchema, transcriptHash: DigestSchema,
  probe: ProbeFactsSchema, binaries: BinaryVersionsSchema,
});

export const RenderPresetSchema = z.enum(['test-lossless-v1', 'delivery-h264-v1']);
export const RenderRequestSchema = z.strictObject({
  contentHash: DigestSchema, range: RangeSchema.optional(), preset: RenderPresetSchema,
});
export const TimingCheckSchema = z.strictObject({
  checkId: z.enum(['video_frames', 'audio_samples', 'video_duration', 'audio_duration']),
  status: z.enum(['pass', 'fail']), expected: z.number(), measured: z.number(), tolerance: z.number().nonnegative(),
});
export const RenderManifestSchema = z.strictObject({
  schemaVersion: z.literal(1), artifactId: IdSchema, contentHash: DigestSchema, timelineContentFingerprint: DigestSchema,
  requestedRange: RangeSchema.optional(), effectiveRange: RangeSchema, preset: RenderPresetSchema,
  binaries: BinaryVersionsSchema, mediaFile: z.enum(['media.mkv', 'media.mp4']),
  expected: z.strictObject({ frames: UIntSchema, samples: UIntSchema, durationMs: MsSchema }),
  measured: z.strictObject({
    frames: UIntSchema, samples: UIntSchema, videoDurationUs: z.number(), audioDurationUs: z.number(),
    containerDurationUs: z.number(), avOffsetUs: z.number(),
  }),
  checks: z.array(TimingCheckSchema), outputDigest: DigestSchema,
});

export type TranscriptInput = z.infer<typeof TranscriptInputSchema>;
export type NormalizedTranscript = z.infer<typeof NormalizedTranscriptSchema>;
export type BinaryVersions = z.infer<typeof BinaryVersionsSchema>;
export type ProbeFacts = z.infer<typeof ProbeFactsSchema>;
export type IngestionRecord = z.infer<typeof IngestionRecordSchema>;
export type RenderPreset = z.infer<typeof RenderPresetSchema>;
export type RenderRequest = z.infer<typeof RenderRequestSchema>;
export type TimingCheck = z.infer<typeof TimingCheckSchema>;
export type RenderManifest = z.infer<typeof RenderManifestSchema>;

export type UnsupportedReason = 'vfr' | 'frame_rate' | 'audio_rate' | 'audio_layout' | 'stream_ambiguous' | 'rotation'
  | 'hdr' | 'duration_contradiction' | 'av_mapping';
export type MediaErrorCode = 'ffmpeg_missing' | 'probe_failed' | 'unsupported_source' | 'transcript_invalid'
  | 'render_failed' | 'render_out_of_bounds' | 'timing_mismatch';
export interface MediaError {
  code: MediaErrorCode;
  message: string;
  reason?: UnsupportedReason | 'timeout' | 'exit_code';
  evidence: { index?: number; expected?: number; actual?: number; field?: string };
}
export type MediaResult<T> = ({ ok: true } & T) | { ok: false; error: MediaError };

export class MediaFailure extends Error {
  constructor(readonly detail: MediaError) { super(detail.message); }
}
export function mediaFail(code: MediaErrorCode, message: string, extra: Partial<Pick<MediaError, 'reason' | 'evidence'>> = {}): never {
  throw new MediaFailure({ code, message, evidence: {}, ...extra });
}
