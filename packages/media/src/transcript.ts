import { createHash } from 'node:crypto';
import { canonicalSerialize, ProjectIRSchema } from '@aether/core';
import type { MediaSegment, ProjectIR } from '@aether/core';
import { mediaFail, NormalizedTranscriptSchema, SAMPLE_RATE, TranscriptInputSchema } from './schemas.js';
import type { NormalizedTranscript, ProbeFacts } from './schemas.js';

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** Nearest millisecond, exact ties earlier (matches frame alignment). Converted once. */
const toMs = (value: number, unit: 'seconds' | 'milliseconds') => Math.ceil((unit === 'seconds' ? value * 1000 : value) - 0.5);

export function importTranscript(bytes: Uint8Array, context: { assetId: string; durationMs: number }): { transcript: NormalizedTranscript; segments: MediaSegment[] } {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return mediaFail('transcript_invalid', 'Transcript is not UTF-8'); }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return mediaFail('transcript_invalid', 'Transcript is not JSON'); }
  const parsed = TranscriptInputSchema.safeParse(raw);
  if (!parsed.success) mediaFail('transcript_invalid', 'Transcript does not match the schema');
  const sourceDigest = sha256(bytes);
  let previousEnd = 0;
  const cues = parsed.data.cues.map((cue, index) => {
    const startMs = toMs(cue.start, parsed.data.timeUnit);
    const endMs = toMs(cue.end, parsed.data.timeUnit);
    const fail = (message: string) => mediaFail('transcript_invalid', message, { evidence: { index } });
    if (endMs <= startMs) fail('Cue is empty or reversed');
    if (startMs < previousEnd) fail('Cues are unordered or overlapping');
    if (endMs > context.durationMs) fail('Cue extends beyond the source');
    previousEnd = endMs;
    return { index, startMs, endMs, text: cue.text, ...(cue.speaker ? { speaker: cue.speaker } : {}) };
  });
  const transcript = NormalizedTranscriptSchema.parse({ schemaVersion: 1, sourceDigest, cues });
  const segments: MediaSegment[] = cues.map(cue => ({
    id: 'segment-' + sha256(canonicalSerialize({
      domain: 'aether.segment.v1', assetId: context.assetId, transcriptDigest: sourceDigest,
      cueIndex: cue.index, startMs: cue.startMs, endMs: cue.endMs,
    })),
    assetId: context.assetId, sourceRange: { startMs: cue.startMs, endMs: cue.endMs }, transcriptText: cue.text,
    ...(cue.speaker ? { speaker: cue.speaker } : {}),
  }));
  return { transcript, segments };
}

/** Full-source initial project: one clip covering every frame. */
export function buildInitialProject(input: {
  projectId: string; sourceHash: string; transcriptHash: string; probe: ProbeFacts; segments: MediaSegment[];
}): ProjectIR {
  const { probe, sourceHash } = input;
  const assetId = `asset-${sourceHash}`;
  const durationMs = probe.video.frameCount * 40;
  return ProjectIRSchema.parse({
    schemaVersion: 1, id: input.projectId, transcriptHash: input.transcriptHash, segments: input.segments,
    assets: [{
      id: assetId, contentHash: sourceHash, mediaPath: `assets/${sourceHash}`, durationMs, frameCount: probe.video.frameCount,
      video: { streamIndex: probe.video.streamIndex, width: probe.video.width, height: probe.video.height, fpsNumerator: 25, fpsDenominator: 1 },
      ...(probe.audio ? { audio: { streamIndex: probe.audio.streamIndex, sampleRate: SAMPLE_RATE, channels: probe.audio.channels } } : {}),
      presentationOriginUs: probe.presentationOriginUs,
    }],
    sequence: { id: 'sequence-1', clips: [{ id: 'clip-source', assetId, sourceRange: { startMs: 0, endMs: durationMs }, timelineStartMs: 0 }] },
  });
}
