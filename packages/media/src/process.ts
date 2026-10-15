import { spawn } from 'node:child_process';
import { mediaFail } from './schemas.js';
import type { BinaryVersions } from './schemas.js';

export interface Binaries { ffmpeg: string; ffprobe: string }
export interface ProcessOptions { timeoutMs?: number; maxStdoutBytes?: number }
export interface ProcessOutput { code: number | null; stdout: Buffer; stderr: string; timedOut: boolean }

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_STDOUT = 64 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;

/** Run a fixed executable with an argument array: never a shell string. */
export function runProcess(executable: string, args: readonly string[], options: ProcessOptions = {}): Promise<ProcessOutput> {
  const limit = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let timedOut = false;
    let overflow = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { overflow = true; child.kill('SIGKILL'); return; }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8'); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (overflow) { reject(new Error('Process output exceeded its bound')); return; }
      resolve({ code, stdout: Buffer.concat(chunks), stderr, timedOut });
    });
  });
}

/** Binaries come from AETHER_FFMPEG / AETHER_FFPROBE, otherwise PATH (E2). */
export function resolveBinaries(env: NodeJS.ProcessEnv = process.env): Binaries {
  return { ffmpeg: env['AETHER_FFMPEG'] || 'ffmpeg', ffprobe: env['AETHER_FFPROBE'] || 'ffprobe' };
}

async function versionLine(executable: string): Promise<string> {
  let output: ProcessOutput;
  try {
    output = await runProcess(executable, ['-hide_banner', '-version'], { timeoutMs: 15_000 });
  } catch {
    return mediaFail('ffmpeg_missing', 'FFmpeg binary is not available');
  }
  if (output.code !== 0) mediaFail('ffmpeg_missing', 'FFmpeg binary did not report a version');
  return output.stdout.toString('utf8').split(/\r?\n/)[0]!.trim();
}

const preflightCache = new Map<string, Promise<BinaryVersions>>();

/** Confirm both binaries run and record their version lines. Successful results are cached per binary pair. */
export function preflight(binaries: Binaries): Promise<BinaryVersions> {
  const key = JSON.stringify([binaries.ffmpeg, binaries.ffprobe]);
  let pending = preflightCache.get(key);
  if (!pending) {
    pending = (async () => ({ ffmpeg: await versionLine(binaries.ffmpeg), ffprobe: await versionLine(binaries.ffprobe) }))();
    preflightCache.set(key, pending);
    pending.catch(() => preflightCache.delete(key));
  }
  return pending;
}
