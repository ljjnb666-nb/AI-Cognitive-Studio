"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { sourceReadingLayout } from "@/lib/source-reading-layout";
import styles from "./source-text-reader.module.css";

export type SourceTextPreview = { paginationKind?: "physical" | "blocks"; pageNumber: number; pageCount: number; physicalPageNumber: number | null; truncated: boolean; blocks: Array<{ id: string; ordinal: number; text: string }> };

export function SourceTextReader({ sourceDocumentId, preview }: { sourceDocumentId: string; preview: SourceTextPreview }) {
  const [mode, setMode] = useState<"reading" | "raw">("reading");
  const layout = useMemo(() => sourceReadingLayout(preview.blocks.map(block => block.text).join("\n\n")), [preview.blocks]);
  const href = `/studio/library/${sourceDocumentId}`;
  const byBlocks = preview.paginationKind === "blocks";
  return (
    <section className={styles.reader} aria-label="已提取原文">
      <p className={styles.meta}>{byBlocks ? `正文分段 · 第 ${preview.pageNumber} / ${preview.pageCount} 段（按内容区块分段，非原书页码）` : `PDF 第 ${preview.physicalPageNumber ?? preview.pageNumber} 页 / ${preview.pageCount} 页`}</p>
      <div className={styles.toolbar}>
        <div className={styles.modes} role="group" aria-label="原文显示方式">
          <button type="button" aria-pressed={mode === "reading"} onClick={() => setMode("reading")}>阅读排版</button>
          <button type="button" aria-pressed={mode === "raw"} onClick={() => setMode("raw")}>提取原文</button>
        </div>
        <nav className={styles.navigation} aria-label={byBlocks ? "原文分段导航" : "原文翻页"}>
          {preview.pageNumber > 1 && <Link prefetch={false} href={`${href}?textPage=${preview.pageNumber - 1}`} scroll={false}>{byBlocks ? "上一段" : "上一页"}</Link>}
          <form key={preview.pageNumber} method="get" action={href}>
            <label htmlFor="text-page">{byBlocks ? "段号" : "页码"}</label>
            <input id="text-page" name="textPage" type="number" min="1" max={preview.pageCount} defaultValue={preview.pageNumber} required />
            <button type="submit">跳转</button>
          </form>
          {preview.pageNumber < preview.pageCount && <Link prefetch={false} href={`${href}?textPage=${preview.pageNumber + 1}`} scroll={false}>{byBlocks ? "下一段" : "下一页"}</Link>}
        </nav>
      </div>
      {mode === "raw" ? (
        <div className={styles.raw}>{preview.blocks.map(block => <div key={block.id}>{block.text}</div>)}</div>
      ) : layout.kind === "toc" ? (
        <div>
          <div className={styles.tocHeader}><span>目录条目</span><span>书内页码</span></div>
          <ol className={styles.toc}>{layout.entries.map((entry, index) => <li key={index}><span>{entry.title}</span><span className={styles.pageLabel}>{entry.pageLabel}</span></li>)}</ol>
          <p className={styles.note}>{byBlocks ? "书内页码按目录原文标注，与阅读分段编号不同。" : "书内页码按目录原文标注，可能与上方 PDF 页码不同。"}</p>
        </div>
      ) : (
        <div className={styles.prose}>{layout.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
      )}
      {!preview.blocks.length && <p className={styles.note}>{byBlocks ? "本段没有提取到文字。" : "本页没有提取到文字。"}</p>}
      {preview.truncated && <p className={styles.note}>{byBlocks ? "本段有较长内容，当前显示部分原文。" : "本页内容较长，当前显示部分原文。"}</p>}
    </section>
  );
}
