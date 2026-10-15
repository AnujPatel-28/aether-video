import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBinaries, runProcess } from '@aether/media';

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
  assert.equal(output.code, 0, `ffmpeg failed: ${output.stderr}`);
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

export interface DecodedFrame { top: number; bottom: number }
/** Decode a lossless render in one FFmpeg run: per-frame markers and every audio sample's marker index (-1 = silence). */
export async function decodeMarkers(path: string): Promise<{ frames: DecodedFrame[]; samples: Int32Array }> {
  const directory = await mkdtemp(join(tmpdir(), 'aether-decode-'));
  try {
    const videoPath = join(directory, 'video.raw');
    const audioPath = join(directory, 'audio.raw');
    const output = await runProcess(binaries.ffmpeg, ['-v', 'error', '-i', path, '-map', '0:v', '-f', 'rawvideo', '-pix_fmt', 'gray', videoPath,
      '-map', '0:a', '-ac', '1', '-f', 'f32le', audioPath]);
    assert.equal(output.code, 0, output.stderr);
    const video = await readFile(videoPath);
    const size = WIDTH * HEIGHT;
    const frames: DecodedFrame[] = [];
    for (let offset = 0; offset + size <= video.length; offset += size) {
      frames.push({ top: video[offset]!, bottom: video[offset + (HEIGHT - 1) * WIDTH]! });
    }
    const audio = await readFile(audioPath);
    const floats = new Float32Array(audio.buffer, audio.byteOffset, audio.length / 4);
    const samples = new Int32Array(floats.length);
    for (let i = 0; i < floats.length; i++) samples[i] = Math.round(floats[i]! * 1048576) - 1;
    return { frames, samples };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export const frameMarker = (index: number): DecodedFrame => ({ top: index % 256, bottom: 100 + Math.floor(index / 256) });
