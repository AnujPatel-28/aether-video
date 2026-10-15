import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { runProcess } from './process.js';
import type { Binaries } from './process.js';
import { renderArgs } from './recipe.js';
import type { Recipe } from './recipe.js';
import { mediaFail, SAMPLE_RATE } from './schemas.js';
import type { RenderManifest, TimingCheck } from './schemas.js';

export const DELIVERY_AUDIO_FRAME_US = Math.ceil(1024 * 1_000_000 / SAMPLE_RATE);
const VIDEO_FRAME_US = 40_000;

export async function renderToFile(binaries: Binaries, recipe: Recipe, inputPath: string, outputPath: string, timeoutMs = 120_000): Promise<void> {
  let output;
  try {
    output = await runProcess(binaries.ffmpeg, renderArgs(recipe, inputPath, outputPath), { timeoutMs, maxStdoutBytes: 1024 * 1024 });
  } catch {
    return mediaFail('ffmpeg_missing', 'FFmpeg is not available');
  }
  if (output.timedOut) mediaFail('render_failed', 'Render timed out', { reason: 'timeout' });
  if (output.code !== 0) mediaFail('render_failed', 'FFmpeg exited with an error', { reason: 'exit_code', evidence: { actual: output.code ?? -1 } });
}

interface FrameList { frames?: { pts?: number; nb_samples?: number }[] }
interface StreamList { streams?: { index: number; codec_type?: string; time_base?: string }[]; format?: { duration?: string } }

async function probe(binaries: Binaries, args: string[], timeoutMs: number): Promise<unknown> {
  const output = await runProcess(binaries.ffprobe, ['-v', 'error', '-print_format', 'json', ...args], { timeoutMs });
  if (output.code !== 0) mediaFail('render_failed', 'Could not measure the rendered output', { reason: 'exit_code' });
  return JSON.parse(output.stdout.toString('utf8'));
}
function toUs(pts: number, timeBase: string | undefined): number {
  const [num, den] = (timeBase ?? '1/1').split('/').map(Number) as [number, number];
  return pts * num * 1_000_000 / den;
}

export type Measured = RenderManifest['measured'];

/** Measure decoded frames/samples and timestamps of a rendered file. */
export async function measureOutput(binaries: Binaries, path: string, timeoutMs = 120_000): Promise<Measured> {
  const info = await probe(binaries, ['-show_streams', '-show_format', path], timeoutMs) as StreamList;
  const video = info.streams?.find(stream => stream.codec_type === 'video');
  const audio = info.streams?.find(stream => stream.codec_type === 'audio');
  if (!video || !audio) mediaFail('render_failed', 'Rendered output lacks a stream');
  const frames = async (index: number) => ((await probe(binaries, ['-select_streams', `${index}`, '-show_entries', 'frame=pts,nb_samples', path], timeoutMs)) as FrameList).frames ?? [];
  const videoFrames = await frames(video.index);
  const audioFrames = await frames(audio.index);
  const videoPts = videoFrames.map(frame => toUs(frame.pts ?? 0, video.time_base)).sort((a, b) => a - b);
  const samples = audioFrames.reduce((total, frame) => total + (frame.nb_samples ?? 0), 0);
  const videoStart = videoPts[0] ?? 0;
  const audioStart = audioFrames.length ? Math.min(...audioFrames.map(frame => toUs(frame.pts ?? 0, audio.time_base))) : 0;
  return {
    frames: videoFrames.length, samples,
    videoDurationUs: videoPts.length ? videoPts.at(-1)! - videoStart + VIDEO_FRAME_US : 0,
    audioDurationUs: samples * 1_000_000 / SAMPLE_RATE,
    containerDurationUs: Math.round(Number(info.format?.duration ?? 0) * 1_000_000),
    avOffsetUs: audioStart - videoStart,
  };
}

/** Lossless output must be exact; delivery output must stay within one video frame plus one AAC frame (E6). */
export function timingChecks(recipe: Recipe, measured: Measured): TimingCheck[] {
  const check = (checkId: TimingCheck['checkId'], expected: number, actual: number, tolerance: number): TimingCheck =>
    ({ checkId, expected, measured: actual, tolerance, status: Math.abs(actual - expected) <= tolerance ? 'pass' : 'fail' });
  const nominalUs = recipe.expected.durationMs * 1000;
  if (recipe.preset === 'test-lossless-v1') {
    return [check('video_frames', recipe.expected.frames, measured.frames, 0), check('audio_samples', recipe.expected.samples, measured.samples, 0)];
  }
  return [
    check('video_duration', nominalUs, measured.videoDurationUs, VIDEO_FRAME_US),
    check('audio_duration', nominalUs, measured.audioDurationUs, VIDEO_FRAME_US + DELIVERY_AUDIO_FRAME_US),
  ];
}

export function fileDigest(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}
