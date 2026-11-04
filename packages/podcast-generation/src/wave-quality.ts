/** Measures decoded PCM, not intended pauses or provider metadata. */
export function measurePcm16(pcm: Uint8Array, sampleRate: number, channels: number) {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const frames = Math.floor(pcm.byteLength / (2 * channels));
  let firstAudible = -1, lastAudible = -1;
  let silent = 0, run = 0, longest = 0, peak = 0, clipped = 0;
  for (let frame = 0; frame < frames; frame++) {
    let amplitude = 0;
    for (let channel = 0; channel < channels; channel++) amplitude = Math.max(amplitude, Math.abs(view.getInt16((frame * channels + channel) * 2, true)) / 32768);
    if (amplitude >= Math.pow(10, -50 / 20)) { if (firstAudible < 0) firstAudible = frame; lastAudible = frame; }
    peak = Math.max(peak, amplitude);
    if (amplitude >= .999) clipped++;
    if (amplitude < .001) { silent++; run++; longest = Math.max(longest, run); } else run = 0;
  }
  return { leadingSilenceMs: (firstAudible < 0 ? frames : firstAudible) * 1000 / sampleRate, trailingSilenceMs: (lastAudible < 0 ? frames : frames - lastAudible - 1) * 1000 / sampleRate, silenceRatio: silent / Math.max(1, frames), maxSilenceGapMs: longest * 1000 / sampleRate, samplePeakDb: 20 * Math.log10(Math.max(peak, 1e-10)), clippedFrameRatio: clipped / Math.max(1, frames) };
}
