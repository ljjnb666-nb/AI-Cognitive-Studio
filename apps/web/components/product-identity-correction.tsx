"use client";

import { useRef, useState } from "react";
import {
  canEditProductIdentity,
  identityDraft,
  identityFieldLabel,
  manualIdentityAuditChanges,
  manualIdentityChanges,
  manualIdentityFields,
  manualIdentityFormError,
  manualIdentityOutcomeMessage,
  type ManualIdentityDraft,
  type ProductIdentityPreview,
} from "@/lib/product-identity-view-model";

type Props = {
  preview: ProductIdentityPreview;
  onRecheck: (message: string) => void;
};

function readableTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN");
}
function shown(value: string | null): string {
  return value === null || value.trim() === "" ? "未提供" : value;
}

export function ProductIdentityCorrection({ preview, onRecheck }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const submittingRef = useRef(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ManualIdentityDraft>({
    title: "", language: "", isbn10: "", isbn13: "",
  });
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const product = preview.product;
  const canEdit = canEditProductIdentity(preview);
  const changes = product ? manualIdentityChanges(product, draft) : {};
  const validation = manualIdentityFormError(changes, reason);

  function begin() {
    if (!product || !canEdit || busy) return;
    setDraft(identityDraft(product));
    setReason("");
    setError(null);
    setEditing(true);
  }
  function cancel() {
    if (busy) return;
    dialogRef.current?.close();
    setEditing(false);
    setError(null);
  }
  function requestConfirmation() {
    if (!product || !canEdit || busy || !editing) return;
    if (validation) { setError(validation); return; }
    setError(null);
    dialogRef.current?.showModal();
  }
  async function commit() {
    if (submittingRef.current || !editing || !canEdit || !product ||
        !preview.currentExtractionId || validation) return;
    submittingRef.current = true;
    setBusy(true);
    dialogRef.current?.close();
    setError(null);
    const request = {
      expectedExtractionId: preview.currentExtractionId,
      expectedWorkId: product.workId,
      expectedEditionId: product.editionId,
      expectedWorkUpdatedAt: product.workUpdatedAt,
      expectedEditionUpdatedAt: product.editionUpdatedAt,
      expectedValues: {
        title: product.title,
        language: product.language,
        isbn10: product.isbn10,
        isbn13: product.isbn13,
      },
      values: changes,
      reason: reason.trim(),
    };
    let message = "网络异常，无法确认是否已提交。正在读取正式信息，请检查历史记录后再操作。";
    try {
      const response = await fetch(
        "/api/studio/identity/" + encodeURIComponent(preview.sourceDocumentId) + "/corrections",
        {
          method: "POST", cache: "no-store", credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        },
      );
      let payload: unknown = null;
      try { payload = await response.json(); } catch { /* HTTP status remains authoritative */ }
      const status = payload && typeof payload === "object" && "status" in payload
        ? (payload as { status: unknown }).status : undefined;
      message = manualIdentityOutcomeMessage(status, response.status);
    } catch {
      // A transport failure is an unknown outcome, never a claimed successful write.
    } finally {
      submittingRef.current = false;
      setBusy(false);
      setEditing(false);
      onRecheck(message);
    }
  }

  if (!product) return null;
  const audit = preview.recentCorrections ?? [];
  return (
    <section className="identity-correction" aria-labelledby="identity-correction-heading">
      <h3 id="identity-correction-heading">人工修正正式信息</h3>
      <p className="identity-muted">
        上方 EPUB 候选仅为原始解析证据。这里修改的是已经保存的 Work / Edition 正式身份；
        修改不会更改 EPUB 原始元数据或历史确认记录。
      </p>
      {preview.canWrite ? (
        <button type="button" className="btn btn-secondary" disabled={!canEdit || busy || editing} onClick={begin}>
          编辑正式书籍信息
        </button>
      ) : (
        <p className="identity-muted">当前角色为只读权限，可查看正式信息和历史修正记录，但不能提交修改。</p>
      )}
      {preview.canWrite && !canEdit && (
        <p className="identity-muted">当前文件不满足编辑条件，请切换到最新 EPUB 文件并重新检查解析记录。</p>
      )}
      {editing && (
        <form aria-label="人工修正正式信息" onSubmit={(event) => { event.preventDefault(); requestConfirmation(); }}>
          <div className="identity-correction-form">
            {manualIdentityFields.map(({ field, label }) => (
              <label key={field} htmlFor={"identity-manual-" + field}>
                {label}
                <input
                  id={"identity-manual-" + field}
                  name={field}
                  type="text"
                  autoComplete="off"
                  value={draft[field]}
                  disabled={busy}
                  maxLength={field === "title" ? 255 : 80}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, [field]: event.target.value }));
                    setError(null);
                  }}
                />
              </label>
            ))}
            <label className="identity-correction-wide" htmlFor="identity-manual-reason">
              修正原因（必填，3～500 字符）
              <textarea
                id="identity-manual-reason" name="reason" rows={3}
                value={reason} disabled={busy} maxLength={500}
                onChange={(event) => { setReason(event.target.value); setError(null); }}
                placeholder="例如：与纸质书版权页核对后发现书名有误"
              />
            </label>
          </div>
          <p className="identity-muted">
            只提交发生变化的字段。ISBN、语言等最终有效性以服务端校验为准，不能清空已有字段。
          </p>
          {error && <p role="alert" className="identity-status">{error}</p>}
          <div className="identity-actions">
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={cancel}>取消修改</button>
            <button type="submit" className="btn btn-primary" disabled={busy || !!validation}>核对修改内容</button>
          </div>
        </form>
      )}
      <div className="identity-data-block" aria-labelledby="identity-manual-history-heading">
        <h3 id="identity-manual-history-heading">人工修正历史（最近 10 条）</h3>
        {audit.length === 0 ? (
          <p className="identity-muted">尚无人工修正记录。解析候选和 EPUB 自动确认记录不属于人工修正。</p>
        ) : (
          <ol className="identity-correction-history">
            {audit.map((item) => (
              <li key={item.id}>
                <time dateTime={item.createdAt}>{readableTime(item.createdAt)}</time>
                <p>操作人标识：{item.actorUserId}</p>
                <p>修正原因：{item.reason}</p>
                <dl>
                  {manualIdentityAuditChanges(item.changes).map((entry) => (
                    <div key={entry.field}>
                      <dt>{identityFieldLabel(entry.field)}</dt>
                      <dd>修改前：{shown(entry.before)} → 修改后：{shown(entry.after)}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ol>
        )}
      </div>
      <dialog
        ref={dialogRef}
        className="identity-dialog"
        aria-labelledby="identity-manual-confirm-title"
        aria-describedby="identity-manual-confirm-desc"
        onCancel={(event) => { if (busy) event.preventDefault(); }}
      >
        <div className="identity-dialog-body">
          <p className="page-eyebrow">人工修改正式书籍身份</p>
          <h2 id="identity-manual-confirm-title">确认保存这些人工修正？</h2>
          <p id="identity-manual-confirm-desc">
            请核对修改前后信息。确认后服务端将再次校验权限、解析版本、文件版本和字段快照；
            如果其他人已经修改，则本次不会覆盖。
          </p>
          <ul className="identity-correction-diff">
            {manualIdentityFields.filter(({ field }) => field in changes).map(({ field, label }) => (
              <li key={field}>
                <strong>{label}</strong>：{shown(identityDraft(product)[field])} → {shown(changes[field] ?? null)}
              </li>
            ))}
          </ul>
          <p>修正原因：{reason.trim()}</p>
          <div className="identity-actions">
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => dialogRef.current?.close()}>返回修改</button>
            <button type="button" className="btn btn-primary" disabled={busy || !!validation} onClick={() => void commit()}>确认保存人工修正</button>
          </div>
        </div>
      </dialog>
    </section>
  );
}
