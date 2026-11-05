/** Conservative Unicode wrapping keeps text inside the 9:16 safe area. */
export function wrapCardText(text: string, columns: number, maxLines: number): string {
  const lines: string[] = []; let line = "", width = 0;
  for (const character of text.replace(/\r/g, "")) {
    const cost = /[\x20-\x7e]/.test(character) ? 0.55 : 1;
    if (character === "\n" || width + cost > columns) { lines.push(line); line = ""; width = 0; }
    if (character !== "\n") { line += character; width += cost; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) throw new Error("VIDEO_CARD_TEXT_EXCEEDS_SAFE_AREA");
  return lines.join("\n");
}

const layouts: Record<string, { background: string; accent: string; titleY: number; detailY: number; align: "left" | "center"; panel: boolean }> = {
  QUESTION_CARD: { background: "0x172554", accent: "0x38bdf8", titleY: .28, detailY: .60, align: "center", panel: false },
  CLAIM_CARD: { background: "0x0f172a", accent: "0xfbbf24", titleY: .22, detailY: .58, align: "left", panel: false },
  CONTRAST: { background: "0x312e81", accent: "0xc4b5fd", titleY: .20, detailY: .62, align: "left", panel: true },
  EVIDENCE_CARD: { background: "0x134e4a", accent: "0x5eead4", titleY: .27, detailY: .61, align: "left", panel: true },
  CONCEPT_CARD: { background: "0x1e1b4b", accent: "0xa5b4fc", titleY: .30, detailY: .64, align: "center", panel: true },
  ENDING_CARD: { background: "0x3f1d2e", accent: "0xfda4af", titleY: .35, detailY: .65, align: "center", panel: false },
};
export function sceneVisualFilter(input: { width: number; height: number; fps: number; duration: number; layoutTemplate: string; motionPreset?: string; transitionIntent: string; primaryPath: string; secondaryPath: string }) {
  const layout = layouts[input.layoutTemplate];
  if (!layout) throw new Error("VIDEO_LAYOUT_UNSUPPORTED");
  const { width: w, height: h, duration: d } = input, margin = Math.round(w * .09);
  const path = (value: string) => value.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
  const x = layout.align === "center" ? "(w-text_w)/2" : String(margin);
  const titleX = input.motionPreset === "SLIDE" ? `'${x}+${w}*max(0,1-t/0.4)'` : x;
  const alpha = input.motionPreset === "REVEAL" ? ":alpha='min(1,t/0.4)'" : "";
  const fontSize = Math.max(18, Math.floor(w / 13));
  // Changing drawtext fontsize every frame can segfault FFmpeg's font renderer
  // on Linux. Keep glyph rasterization stable and zoom the finished card instead.
  const titleSize = String(fontSize);
  const filters = [`color=c=${layout.background}:s=${w}x${h}:r=${input.fps}:d=${d}`];
  if (layout.panel) filters.push(`drawbox=x=${margin / 2}:y=${h * .16}:w=${w - margin}:h=${h * .60}:color=white@0.06:t=fill`);
  filters.push(`drawbox=x=${margin}:y=${h * .15}:w=${w - margin * 2}:h=${Math.max(3, w * .008)}:color=${layout.accent}:t=fill`);
  filters.push(`drawtext=textfile='${path(input.primaryPath)}':expansion=none:fontcolor=white:fontsize=${titleSize}:x=${titleX}:y=h*${layout.titleY}:line_spacing=12${alpha}`);
  filters.push(`drawtext=textfile='${path(input.secondaryPath)}':expansion=none:fontcolor=${layout.accent}:fontsize=${Math.max(12, Math.floor(w / 24))}:x=${x}:y=h*${layout.detailY}:line_spacing=8`);
  if (input.transitionIntent === "FADE") filters.push(`fade=t=in:st=0:d=0.2`, `fade=t=out:st=${Math.max(0, d - .2)}:d=0.2`);
  if (input.transitionIntent === "WIPE") filters.push(`format=gbrp,geq=r='if(lt(X,W*(1-min(1,T/0.25))),0,r(X,Y))':g='if(lt(X,W*(1-min(1,T/0.25))),0,g(X,Y))':b='if(lt(X,W*(1-min(1,T/0.25))),0,b(X,Y))',format=yuv420p`);
  if (input.motionPreset === "ZOOM") {
    // pzoom carries the previous input frame's zoom when d=1; using only zoom
    // would reset each frame and yield a visually static output.
    filters.push(`zoompan=z='min(max(zoom,pzoom)+0.003,1.06)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}:fps=${input.fps}`);
  }
  return filters.join(",");
}
