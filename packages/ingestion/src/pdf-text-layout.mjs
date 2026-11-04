/** Reconstruct word/line separators without reordering columns in PDF stream order. */
export function reconstructPdfText(items) {
  let text = "", previous;
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const x = item.transform?.[4], y = item.transform?.[5];
    const height = Math.max(1, Math.abs(item.height ?? item.transform?.[3] ?? 12));
    if (previous && item.str) {
      const sameLine = Number.isFinite(y) && Number.isFinite(previous.y) && Math.abs(y - previous.y) < height * 0.4;
      const gap = Number.isFinite(x) ? x - previous.right : 0;
      if (!sameLine && Number.isFinite(y) && !text.endsWith("\n")) text += "\n";
      else if (sameLine && gap > height * 0.15 && !/\s$/.test(text) && !/^\s/.test(item.str)) text += " ";
    }
    text += item.str;
    if (item.hasEOL && !text.endsWith("\n")) text += "\n";
    previous = { y, right: x + (item.width ?? 0) };
  }
  return text.trimEnd();
}
