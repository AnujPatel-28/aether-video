import { runProcess } from './process.js';
import type { Binaries } from './process.js';
import { FRAME_SAMPLES, mediaFail, ProbeFactsSchema, SAMPLE_RATE } from './schemas.js';
import type { ProbeFacts, UnsupportedReason } from './schemas.js';

interface Stream {
  index: number; codec_type?: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number;
  r_frame_rate?: string; avg_frame_rate?: string; time_base?: string; sample_rate?: string; channels?: number;
  color_transfer?: string; disposition?: { attached_pic?: number }; tags?: Record<string, string>;
  side_data_list?: { rotation?: number }[];
}

async function probeJson(binaries: Binaries, args: string[], timeoutMs: number): Promise<unknown> {
  let output;
  try {
    output = await runProcess(binaries.ffprobe, ['-v', 'error', '-print_format', 'json', ...args], { timeoutMs });
  } catch {
    return mediaFail('ffmpeg_missing', 'ffprobe is not available');
  }
  if (output.code !== 0) mediaFail('probe_failed', 'ffprobe could not read the source');
  try { return JSON.parse(output.stdout.toString('utf8')); } catch { return mediaFail('probe_failed', 'ffprobe returned invalid JSON'); }
}

function timeBase(value: string | undefined): [bigint, bigint] {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '');
  if (!match || match[2] === '0') return mediaFail('probe_failed', 'Missing stream time base');
  return [BigInt(match[1]!), BigInt(match[2]!)];
}
/** Exact microseconds for an integer timestamp, or undefined when not representable. */
function exactUs(pts: bigint, [num, den]: [bigint, bigint]): number | undefined {
  const scaled = pts * num * 1_000_000n;
  return scaled % den === 0n ? Number(scaled / den) : undefined;
}
function unsupported(reason: UnsupportedReason, message: string): never {
  return mediaFail('unsupported_source', message, { reason });
}

/** Verify the controlled 25 fps CFR / 48 kHz profile from actual timestamps (E8: probe, never transcode). */
export async function probeSource(binaries: Binaries, path: string, timeoutMs = 120_000): Promise<ProbeFacts> {
  const info = await probeJson(binaries, ['-show_streams', '-show_format', path], timeoutMs) as { streams?: Stream[]; format?: { duration?: string } };
  const streams = info.streams ?? [];
  const videos = streams.filter(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1);
  const audios = streams.filter(stream => stream.codec_type === 'audio');
  if (videos.length !== 1 || audios.length > 1) unsupported('stream_ambiguous', 'Source must have one video stream and at most one audio stream');
  const video = videos[0]!;
  if (video.r_frame_rate !== '25/1') unsupported('frame_rate', 'Source frame rate must be exactly 25 fps');
  const rotated = (video.side_data_list ?? []).some(entry => (entry.rotation ?? 0) % 360 !== 0) || (video.tags?.['rotate'] ?? '0') !== '0';
  if (rotated) unsupported('rotation', 'Rotated sources are not supported');
  if (video.color_transfer === 'smpte2084' || video.color_transfer === 'arib-std-b67') unsupported('hdr', 'HDR sources are not supported');
  if (!video.width || !video.height || !video.pix_fmt) mediaFail('probe_failed', 'Missing video geometry');

  const videoBase = timeBase(video.time_base);
  const packets = await probeJson(binaries, ['-select_streams', `${video.index}`, '-show_entries', 'packet=pts', path], timeoutMs) as { packets?: { pts?: number }[] };
  const pts = (packets.packets ?? []).map(packet => packet.pts);
  if (pts.length === 0 || pts.some(value => typeof value !== 'number')) unsupported('vfr', 'Video packets lack timestamps');
  const sorted = (pts as number[]).map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const [num, den] = videoBase;
  for (let i = 1; i < sorted.length; i++) {
    // CFR is proven from every timestamp step: delta * timeBase must equal exactly 1/25 s.
    if ((sorted[i]! - sorted[i - 1]!) * num * 25n !== den) unsupported('vfr', 'Video timestamps are not constant 40 ms steps');
  }
  if (video.avg_frame_rate !== '25/1') unsupported('vfr', 'Average frame rate differs from 25 fps');
  const presentationOriginUs = exactUs(sorted[0]!, videoBase);
  if (presentationOriginUs === undefined) unsupported('av_mapping', 'Presentation origin is not an exact microsecond');
  const frameCount = sorted.length;
  const nominalUs = frameCount * 40_000;

  let audio: ProbeFacts['audio'];
  let audioFrameUs = 0;
  if (audios.length === 1) {
    const stream = audios[0]!;
    if (stream.sample_rate !== `${SAMPLE_RATE}`) unsupported('audio_rate', 'Audio must be 48 kHz');
    if (stream.channels !== 1 && stream.channels !== 2) unsupported('audio_layout', 'Audio must be mono or stereo');
    const frames = await probeJson(binaries, ['-select_streams', `${stream.index}`, '-show_entries', 'frame=pts,nb_samples', path], timeoutMs) as { frames?: { pts?: number; nb_samples?: number }[] };
    const list = frames.frames ?? [];
    if (list.length === 0 || typeof list[0]!.pts !== 'number') unsupported('av_mapping', 'Audio frames lack timestamps');
    const sampleCount = list.reduce((total, frame) => total + (frame.nb_samples ?? 0), 0);
    const largestFrame = Math.max(...list.map(frame => frame.nb_samples ?? 0));
    audioFrameUs = Math.ceil(largestFrame * 1_000_000 / SAMPLE_RATE);
    if (exactUs(BigInt(list[0]!.pts!), timeBase(stream.time_base)) !== presentationOriginUs) {
      unsupported('av_mapping', 'Audio must start at the video presentation origin');
    }
    // Every video frame needs its 1920 samples; trailing audio beyond one codec frame plus one video frame is suspect.
    const required = frameCount * FRAME_SAMPLES;
    if (sampleCount < required || sampleCount - required >= largestFrame + FRAME_SAMPLES) {
      mediaFail('unsupported_source', 'Audio length does not match the video frame count', { reason: 'av_mapping', evidence: { expected: required, actual: sampleCount } });
    }
    audio = { streamIndex: stream.index, codec: stream.codec_name ?? 'unknown', channels: stream.channels, sampleCount };
  }

  // Some containers (Matroska) report the end time rather than the span, so accept either reading.
  const formatDurationUs = Math.round(Number(info.format?.duration ?? 'NaN') * 1_000_000);
  const tolerance = 40_000 + audioFrameUs;
  const matches = (span: number) => Math.abs(span - nominalUs) <= tolerance;
  if (!Number.isFinite(formatDurationUs) || !(matches(formatDurationUs) || matches(formatDurationUs - presentationOriginUs))) {
    unsupported('duration_contradiction', 'Container duration contradicts the frame count');
  }
  return ProbeFactsSchema.parse({
    video: { streamIndex: video.index, codec: video.codec_name ?? 'unknown', pixFmt: video.pix_fmt, width: video.width, height: video.height, frameCount },
    ...(audio ? { audio } : {}), presentationOriginUs, formatDurationUs,
  });
}
