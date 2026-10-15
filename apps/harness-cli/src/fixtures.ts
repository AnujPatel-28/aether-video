import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveBinaries, runProcess } from '@aether/media';

// Trusted fixture generation (G2): controlled marker media for the readiness demo and the tests.
export const binaries = resolveBinaries();
export const WIDTH = 160;
export const HEIGHT = 90;
const HALF = HEIGHT / 2;

export interface SourceOptions {
  seconds?: number;
  fps?: number;
  sampleRate?: number;
  audio?: boolean;
  audioSeconds?: number;
  originSeconds?: number;
  twoVideo?: boolean;
  vfr?: boolean;
  rotate?: boolean;
  hdr?: boolean;
  /** Realistic H.264/AAC in MP4 instead of the lossless marker source. */
  realistic?: boolean;
}

async function ffmpeg(args: string[]): Promise<void> {
  const output = await runProcess(binaries.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], { timeoutMs: 120_000 });
  if (output.code !== 0) throw new Error(`ffmpeg failed: ${output.stderr}`);
}

/**
 * Marker source: the top half of frame N has luma N mod 256 and the bottom half 100 + floor(N/256);
 * audio sample n has value (n + 1) / 2^20, so 0.0 only ever means synthesized silence.
 */
export async function makeSource(directory: string, name: string, options: SourceOptions = {}): Promise<string> {
  const seconds = options.seconds ?? 12;
  const fps = options.fps ?? 25;
  const path = join(directory, `${name}.${options.realistic || options.rotate || options.hdr ? 'mp4' : 'mkv'}`);
  const video = `color=c=black:s=${WIDTH}x${HEIGHT}:r=${fps}:d=${seconds},format=gray,geq=lum='if(lt(Y\\,${HALF})\\,mod(N\\,256)\\,100+floor(N/256))'`;
  const args = ['-f', 'lavfi', '-i', video];
  if (options.audio !== false) {
    args.push('-f', 'lavfi', '-i', `aevalsrc=exprs='(n+1)/1048576':s=${options.sampleRate ?? 48000}:d=${options.audioSeconds ?? seconds}`);
  }
  args.push('-map', '0:v');
  if (options.twoVideo) args.push('-map', '0:v');
  if (options.audio !== false) args.push('-map', '1:a');
  if (options.vfr) args.push('-vf', "setpts='(N+if(eq(mod(N,10),5),0.25,0))/25/TB'", '-fps_mode', 'passthrough');
  if (options.realistic || options.rotate || options.hdr) {
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', `${options.sampleRate ?? 48000}`);
    if (options.hdr) args.push('-vf', 'setparams=color_trc=smpte2084:color_primaries=bt2020:colorspace=bt2020nc');
  } else {
    args.push('-c:v', 'ffv1', '-c:a', 'pcm_f32le');
  }
  if (options.originSeconds) args.push('-output_ts_offset', `${options.originSeconds}`);
  await ffmpeg([...args, path]);
  if (options.rotate) {
    // Rotation is container metadata: FFmpeg 7+ uses -display_rotation, older releases the rotate tag.
    const rotated = join(directory, `${name}-rotated.mp4`);
    const modern = await runProcess(binaries.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-display_rotation', '90', '-i', path, '-c', 'copy', rotated]);
    if (modern.code !== 0) await ffmpeg(['-i', path, '-c', 'copy', '-metadata:s:v:0', 'rotate=90', rotated]);
    return rotated;
  }
  return path;
}

export async function makeTranscript(directory: string, name: string, value: unknown): Promise<string> {
  const path = join(directory, `${name}.json`);
  await writeFile(path, JSON.stringify(value));
  return path;
}
export const defaultTranscript = {
  schemaVersion: 1, timeUnit: 'seconds',
  cues: [
    { start: 0.0, end: 3.5, text: 'The main argument is to make changes carefully.', speaker: 'speaker-1' },
    { start: 4.0, end: 7.25, text: 'Junior engineers still need supervision.' },
    { start: 8.0, end: 11.9, text: 'So my recommendation is pair review.' },
  ],
};
