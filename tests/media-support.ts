import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '@aether/media';
import { binaries, HEIGHT, WIDTH } from '@aether/harness-cli';

export { binaries, defaultTranscript, HEIGHT, makeSource, makeTranscript, WIDTH } from '@aether/harness-cli';
export type { SourceOptions } from '@aether/harness-cli';

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
