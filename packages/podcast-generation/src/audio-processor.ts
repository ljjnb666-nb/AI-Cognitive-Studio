import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_STDERR = 64 * 1024;

/** Narrow, fixed-argument FFmpeg boundary. Source bytes are never interpreted as URLs. */
export class FfmpegAudioProcessor {
  constructor(private readonly executable = "ffmpeg") {}

  async canonicalize(input: Uint8Array, config: { sampleRate: number; channels: number; targetLufs: number; truePeakLimitDb: number; normalizeLoudness: boolean; trimLeadingSilence: boolean; trimTrailingSilence: boolean }): Promise<{ bytes: Uint8Array; integratedLufs?: number; truePeakDb?: number; loudnessRange?: number }> {
    const directory = await mkdtemp(join(tmpdir(), "ai-cognitive-audio-")); const source = join(directory, "input.wav"); const output = join(directory, "output.wav");
    try { await writeFile(source, input); const filters: string[] = []; if (config.trimLeadingSilence || config.trimTrailingSilence) filters.push(`silenceremove=start_periods=${config.trimLeadingSilence ? 1 : 0}:start_threshold=-50dB:stop_periods=${config.trimTrailingSilence ? 1 : 0}:stop_threshold=-50dB`); if (config.normalizeLoudness) filters.push(`loudnorm=I=${config.targetLufs}:TP=${config.truePeakLimitDb}:LRA=11:print_format=json`); const args = ["-nostdin", "-hide_banner", "-y", "-i", source, "-ar", String(config.sampleRate), "-ac", String(config.channels), "-c:a", "pcm_s16le", ...(filters.length ? ["-af", filters.join(",")] : []), output]; const { stderr } = await execFileAsync(this.executable, args, { timeout: 30_000, maxBuffer: MAX_STDERR, windowsHide: true }); const bytes = new Uint8Array(await readFile(output)); const match = stderr.match(/\{\s*"input_i"[\s\S]*?\}/); const metrics = match ? JSON.parse(match[0]) as Record<string, string> : {}; return { bytes, integratedLufs: metrics.output_i ? Number(metrics.output_i) : undefined, truePeakDb: metrics.output_tp ? Number(metrics.output_tp) : undefined, loudnessRange: metrics.output_lra ? Number(metrics.output_lra) : undefined }; }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}
