"use client";
import { useEffect, useRef, useState } from "react";
import styles from "./library-delete-dialog.module.css";
type Preview = { sourceId: string; fileName: string; versionCount: number; updatedAt: string; deleted: boolean };
export function LibraryDeleteDialog({ item, onClose, onDeleted }: { item: { id: string; title: string }; onClose(): void; onDeleted(ids: string[]): void }) {
  const dialog = useRef<HTMLDialogElement>(null), submitting = useRef(false);
  const [preview, setPreview] = useState<Preview | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/studio/library/${item.id}`, { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("无法读取删除范围，请检查权限后重试。");
      const body = await response.json() as Preview;
      if (!controller.signal.aborted) setPreview(body);
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "读取失败，请重试。"); });
    return () => controller.abort();
  }, [item.id, revision]);
  async function remove() {
    if (!preview || submitting.current) return;
    submitting.current = true; setBusy(true); setError("");
    try {
      const response = await fetch(`/api/studio/library/${item.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceId: preview.sourceId, versionCount: preview.versionCount, updatedAt: preview.updatedAt }) });
      if (!response.ok) throw new Error(response.status === 409 ? "书籍信息或文件版本已变化，请重新检查后确认。" : response.status === 403 ? "当前账户无权删除这本书。" : "删除未完成，请重新检查后重试。");
      const result = await response.json() as { documentIds: string[] };
      onDeleted(result.documentIds); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "删除未完成，请重试。"); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="library-delete-title" onClose={onClose} onCancel={event => { if (busy) event.preventDefault(); }}>
    <h2 id="library-delete-title">从知识库删除书籍？</h2><p className={styles.title}>{item.title}</p>
    {!preview && !error && <p role="status">正在检查删除范围…</p>}
    {preview && <><p>将移除这本书的全部 {preview.versionCount} 个文件版本。删除后，它们不再出现在知识库和新建播客、短视频的选书列表中。</p><p>原文件、历史提取与理解证据、已生成的播客和视频会保留。</p><p>已提交的后台任务不会因移出知识库而自动取消，可能继续执行。</p></>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.actions}><button type="button" autoFocus className="btn btn-secondary" disabled={busy} onClick={() => dialog.current?.close()}>取消</button>{error && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { setError(""); setPreview(null); setRevision(value => value + 1); }}>重新检查</button>}<button type="button" className="btn btn-primary" disabled={!preview || busy || Boolean(error)} onClick={() => void remove()}>{busy ? "删除中…" : "确认删除"}</button></div>
  </dialog>;
}
