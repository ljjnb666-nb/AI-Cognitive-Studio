export type SourceReadingLayout =
  | { kind: "toc"; entries: Array<{ title: string; pageLabel: string }> }
  | { kind: "text"; paragraphs: string[] };

/** Presentation only. Never changes stored text, evidence offsets or page locators. */
export function sourceReadingLayout(text: string): SourceReadingLayout {
  const leaders = [...text.matchAll(/(?:[.．·]{3,}|…{2,})/gu)];
  if (leaders.length >= 4) {
    const entries: Array<{ title: string; pageLabel: string }> = [];
    let cursor = 0, previousPage = -1, valid = true;
    const pageToken = /\s*(\d{1,4})(?!\d)/uy;
    for (const leader of leaders) {
      pageToken.lastIndex = leader.index! + leader[0].length;
      const pageMatch = pageToken.exec(text);
      if (!pageMatch) { valid = false; break; }
      let title = text.slice(cursor, leader.index).trim();
      if (!entries.length) title = title.replace(/^目\s*录\s*/u, "");
      const pageLabel = pageMatch[1]!, page = Number(pageLabel);
      if (!title || title.length > 180 || page < previousPage) { valid = false; break; }
      entries.push({ title, pageLabel });
      cursor = pageToken.lastIndex;
      previousPage = page;
    }
    // A partial match must never silently discard the rest of a page.
    if (valid && !text.slice(cursor).trim()) return { kind: "toc", entries };
  }
  const sentences = text.match(/[^。！？!?]*[。！？!?]+[”’」』】）)]*|[^。！？!?]+$/gu) ?? [];
  const paragraphs: string[] = [];
  let paragraph = "", sentenceCount = 0;
  for (const sentence of sentences) {
    if (paragraph && (paragraph.length + sentence.length > 220 || sentenceCount >= 3)) {
      paragraphs.push(paragraph); paragraph = ""; sentenceCount = 0;
    }
    paragraph += sentence; sentenceCount++;
  }
  if (paragraph) paragraphs.push(paragraph);
  return { kind: "text", paragraphs };
}
