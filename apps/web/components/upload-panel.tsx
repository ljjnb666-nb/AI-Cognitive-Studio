"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

const typeFor = (file: File) =>
  file.type ||
  (file.name.endsWith(".md")
    ? "text/markdown"
    : file.name.endsWith(".txt")
    ? "text/plain"
    : file.name.endsWith(".epub")
    ? "application/epub+zip"
    : "application/pdf");

export function UploadPanel() {
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function upload(file?: File) {
    if (!file) return;
    setBusy(true);
    setMessage(`正在上传 ${file.name}…`);
    try {
      const start = await fetch("/api/studio/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: file.name, mediaType: typeFor(file), sizeBytes: file.size }),
      });
      const intent = await start.json();
      if (!start.ok) throw new Error(intent.error);

      const put = await fetch(intent.upload.url, {
        method: "PUT",
        headers: intent.upload.headers,
        body: file,
      });
      if (!put.ok) throw new Error("UPLOAD_FAILED");

      const complete = await fetch("/api/studio/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: intent.sessionId }),
      });
      const result = await complete.json();
      if (!complete.ok) throw new Error(result.error);

      router.push(`/studio/library/${result.sourceDocumentId}`);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? `上传失败：${error.message}` : "上传失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="upload-card"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void upload(e.dataTransfer.files[0]);
      }}
    >
      <div>
        <h2 className="font-serif" style={{ fontSize: 22, fontWeight: 600, color: "var(--on-surface)", margin: "0 0 8px 0" }}>
          添加新文献
        </h2>
        <div className="font-mono" style={{ fontSize: 12, color: "var(--outline)" }}>
          支持 PDF、EPUB、TXT、Markdown · 单文件最大 100 MB
        </div>
        {message && (
          <p aria-live="polite" style={{ fontSize: 13, color: "var(--muted-amber)", margin: "8px 0 0 0" }}>
            {message}
          </p>
        )}
      </div>

      <input
        ref={input}
        type="file"
        accept=".pdf,.epub,.md,.txt,text/plain,text/markdown,application/pdf,application/epub+zip"
        onChange={(e) => void upload(e.target.files?.[0])}
        hidden
      />

      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => input.current?.click()}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        {busy ? "上传中…" : "上传内容"}
      </button>
    </div>
  );
}
