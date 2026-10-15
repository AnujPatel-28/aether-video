import { ProjectIRSchema } from '@aether/core';
import type { Range } from '@aether/core';
import { FRAME_SAMPLES, mediaFail, RenderPresetSchema } from './schemas.js';
import type { ProbeFacts, RenderPreset } from './schemas.js';

export const MAX_SEGMENTS = 400;
const FRAME_MS = 40;

export type RenderSegment =
  | { kind: 'clip'; sourceStartFrame: number; frames: number }
  | { kind: 'gap'; frames: number };
export interface Recipe {
  preset: RenderPreset;
  mediaFile: 'media.mkv' | 'media.mp4';
  segments: RenderSegment[];
  filterGraph: string;
  outputArgs: string[];
  expected: { frames: number; samples: number; durationMs: number };
}

const PRESETS = {
  'test-lossless-v1': {
    mediaFile: 'media.mkv' as const, sampleFormat: 'flt',
    args: ['-c:v', 'ffv1', '-c:a', 'pcm_f32le', '-f', 'matroska'],
  },
  'delivery-h264-v1': {
    mediaFile: 'media.mp4' as const, sampleFormat: 'fltp',
    args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-g', '25',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-movflags', '+faststart', '-f', 'mp4'],
  },
};

/** Sequence duration (ms) is the maximum clip end, including gaps. */
export function sequenceDurationMs(projectInput: unknown): number {
  const project = ProjectIRSchema.parse(projectInput);
  return Math.max(0, ...project.sequence.clips.map(clip => clip.timelineStartMs + clip.sourceRange.endMs - clip.sourceRange.startMs));
}

/** Turn a frame-aligned timeline range into ordered clip pieces and gaps, in integer frames. */
export function planSegments(projectInput: unknown, range: Range): RenderSegment[] {
  const project = ProjectIRSchema.parse(projectInput);
  if ([range.startMs, range.endMs].some(time => time % FRAME_MS !== 0)) mediaFail('render_out_of_bounds', 'Render range must be frame-aligned');
  const end = sequenceDurationMs(project);
  if (range.startMs >= range.endMs || range.endMs > end) mediaFail('render_out_of_bounds', 'Render range is outside the sequence', { evidence: { expected: end, actual: range.endMs } });
  const first = range.startMs / FRAME_MS;
  const last = range.endMs / FRAME_MS;
  const segments: RenderSegment[] = [];
  const push = (segment: RenderSegment) => {
    const previous = segments.at(-1);
    if (segment.kind === 'gap' && previous?.kind === 'gap') previous.frames += segment.frames;
    else if (segment.kind === 'clip' && previous?.kind === 'clip' && previous.sourceStartFrame + previous.frames === segment.sourceStartFrame) {
      previous.frames += segment.frames;
    } else segments.push(segment);
  };
  let cursor = first;
  for (const clip of [...project.sequence.clips].sort((a, b) => a.timelineStartMs - b.timelineStartMs)) {
    const clipStart = clip.timelineStartMs / FRAME_MS;
    const clipEnd = clipStart + (clip.sourceRange.endMs - clip.sourceRange.startMs) / FRAME_MS;
    const from = Math.max(clipStart, first);
    const to = Math.min(clipEnd, last);
    if (to <= from) continue;
    if (from > cursor) push({ kind: 'gap', frames: from - cursor });
    push({ kind: 'clip', sourceStartFrame: clip.sourceRange.startMs / FRAME_MS + (from - clipStart), frames: to - from });
    cursor = to;
  }
  if (cursor < last) push({ kind: 'gap', frames: last - cursor });
  return segments;
}

/** Pure: the only place FFmpeg filter text is produced. Callers choose a preset, never arguments (E5, E6). */
export function compileRecipe(projectInput: unknown, range: Range, presetInput: RenderPreset, probe: ProbeFacts): Recipe {
  const preset = RenderPresetSchema.parse(presetInput);
  const settings = PRESETS[preset];
  const segments = planSegments(projectInput, range);
  if (segments.length > MAX_SEGMENTS) mediaFail('render_out_of_bounds', 'Too many render segments', { evidence: { expected: MAX_SEGMENTS, actual: segments.length } });
  const { width, height, streamIndex: videoIndex } = probe.video;
  const pixFmt = preset === 'delivery-h264-v1' ? 'yuv420p' : probe.video.pixFmt;
  const layout = probe.audio?.channels === 2 ? 'stereo' : 'mono';
  const videoTail = `setpts=PTS-STARTPTS,format=${pixFmt},setsar=1`;
  const audioTail = `asetpts=PTS-STARTPTS,aformat=sample_fmts=${settings.sampleFormat}:sample_rates=48000:channel_layouts=${layout}`;
  const parts: string[] = [];
  const pads: string[] = [];
  segments.forEach((segment, i) => {
    const samples = segment.frames * FRAME_SAMPLES;
    if (segment.kind === 'clip') {
      const startFrame = segment.sourceStartFrame;
      parts.push(`[0:${videoIndex}]trim=start_frame=${startFrame}:end_frame=${startFrame + segment.frames},${videoTail}[v${i}]`);
      parts.push(probe.audio
        ? `[0:${probe.audio.streamIndex}]atrim=start_sample=${startFrame * FRAME_SAMPLES}:end_sample=${startFrame * FRAME_SAMPLES + samples},${audioTail}[a${i}]`
        : `anullsrc=r=48000:cl=${layout},atrim=end_sample=${samples},${audioTail}[a${i}]`);
    } else {
      parts.push(`color=c=black:s=${width}x${height}:r=25,trim=end_frame=${segment.frames},${videoTail}[v${i}]`);
      parts.push(`anullsrc=r=48000:cl=${layout},atrim=end_sample=${samples},${audioTail}[a${i}]`);
    }
    pads.push(`[v${i}][a${i}]`);
  });
  parts.push(`${pads.join('')}concat=n=${segments.length}:v=1:a=1[vout][aout]`);
  const frames = (range.endMs - range.startMs) / FRAME_MS;
  return {
    preset, mediaFile: settings.mediaFile, segments, filterGraph: parts.join(';'),
    outputArgs: ['-map', '[vout]', '-map', '[aout]', '-map_metadata', '-1', '-threads', '1', ...settings.args],
    expected: { frames, samples: frames * FRAME_SAMPLES, durationMs: frames * FRAME_MS },
  };
}

/** Full argument array for one render. Paths come only from the trusted store. */
export function renderArgs(recipe: Recipe, inputPath: string, outputPath: string): string[] {
  return ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', inputPath, '-filter_complex_threads', '1',
    '-filter_complex', recipe.filterGraph, ...recipe.outputArgs, outputPath];
}
