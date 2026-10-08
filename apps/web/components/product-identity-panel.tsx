"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  canConfirmProductIdentity,
  identityFieldLabel,
  identityIgnoredReason,
  isProductIdentityOutcome,
  outcomeCopy,
  plannedIdentityChanges,
  previewStateCopy,
  productIdentityHttpMessage,
  type ProductIdentityPreview,
} from "@/lib/product-identity-view-model";

type PromotionEvidence = {
  status?: string;
  appliedFields?: unknown;
  conflicts?: unknown;
  ignoredFields?: unknown;
  reasonCode?: string | null;
};

function textRows(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function structuredRows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item))
    : [];
}

function display(value: string | null | undefined): string {
  return value?.trim() || "未提供";
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const result: unknown = await response.json();
    if (result && typeof result === "object" && !Array.isArray(result)) return result as Record<string, unknown>;
  } catch {
    // The HTTP boundary is authoritative even when error JSON is unavailable.
  }
  return {};
}

/**
 * Advisory identity preview; mutates nothing unless the user opens a native
 * modal and explicitly confirms the exact observed extraction.
 */
export function ProductIdentityPanel({ sourceDocumentId, sourceFileName }: {
  sourceDocumentId: string;
  sourceFileName: string;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const submitLock = useRef(false);
  const [reloadIndex, setReloadIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<ProductIdentityPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastOutcome, setLastOutcome] = useState<PromotionEvidence | null>(null);

  const endpoint = "/api/studio/identity/" + encodeURIComponent(sourceDocumentId);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setPreview(null);
    void (async () => {
      try {
        const response = await fetch(endpoint, {
          method: "GET",
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        const payload = await readJson(response);
        if (!response.ok) {
          throw new Error(productIdentityHttpMessage(response.status, typeof payload.error === "string" ? payload.error : undefined));
        }
        if (payload.sourceDocumentId !== sourceDocumentId ||
            typeof payload.state !== "string" ||
            !Object.hasOwn(previewStateCopy, payload.state)) {
          throw new Error("书籍身份数据校验失败，请重新检查。");
        }
        if (!controller.signal.aborted) setPreview(payload as ProductIdentityPreview);
      } catch (error) {
        if (!controller.signal.aborted) {
          setLoadError(error instanceof Error && error.name !== "AbortError"
            ? error.message : "暂时无法获取书籍身份，请重试。");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [endpoint, sourceDocumentId, reloadIndex]);

  function reload() {
    if (submitting) return;
    setNotice(null);
    setLastOutcome(null);
    setPreview(null);
    setLoading(true);
    setReloadIndex((n) => n + 1);
  }

  function openConfirmation() {
    if (!submitting && canConfirmProductIdentity(preview)) dialogRef.current?.showModal();
  }

  async function confirm() {
    const observed = preview;
    if (submitLock.current || !canConfirmProductIdentity(observed)) return;
    // A synchronous ref guard prevents duplicate POST even before React rerenders.
    submitLock.current = true;
    dialogRef.current?.close();
    setSubmitting(true);
    setPreview(null);
    setNotice(null);
    setLastOutcome(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedExtractionId: observed.currentExtractionId }),
      });
      const result = await readJson(response);
      if (isProductIdentityOutcome(result.status)) {
        setNotice(outcomeCopy[result.status]);
        if (result.promotion && typeof result.promotion === "object" && !Array.isArray(result.promotion)) {
          setLastOutcome(result.promotion as PromotionEvidence);
        }
      } else {
        setNotice(productIdentityHttpMessage(response.status, typeof result.error === "string" ? result.error : undefined));
      }
    } catch {
      setNotice("网络连接异常，提交结果尚未确认，请刷新查看记录后再操作。");
    } finally {
      // Every outcome, including HTTP 409/422 or network uncertainty, must
      // re-read durable authority. No old preview can immediately submit again.
      setLoading(true);
      setReloadIndex((n) => n + 1);
      setSubmitting(false);
      submitLock.current = false;
      router.refresh();
    }
  }

  const possibleToConfirm = !loading && !submitting && canConfirmProductIdentity(preview);
  const audit = lastOutcome ?? preview?.promotion ?? null;
  const applied = audit ? textRows(audit.appliedFields) : [];
  const conflicts = audit ? structuredRows(audit.conflicts) : [];
  const ignored = audit ? structuredRows(audit.ignoredFields) : [];

  return (
    <section className="identity-panel card-panel" aria-labelledby="identity-heading">
      <div className="identity-heading">
        <div>
          <p className="page-eyebrow">EPUB · 身份识别</p>
          <h2 className="identity-title" id="identity-heading">书籍身份核对</h2>
        </div>
        <span className="status-badge">人工确认</span>
      </div>
      <p className="identity-description">
        解析出的书名等信息仅供参考。确认前不会创建或修改正式书籍身份，已有人工维护的信息也不会自动覆盖。
      </p>
      <p className="identity-file"><strong>源文件：</strong>{sourceFileName}</p>

      <div role="status" aria-live="polite" className="identity-status">
        {submitting ? "正在提交确认，请勿重复操作…" : loading ? "正在获取当前解析结果…" :
          loadError ?? notice ?? (preview ? previewStateCopy[preview.state] : "暂无书籍身份信息。")}
      </div>

      {preview && (
        <>
          <div className="identity-data-block">
            <h3>解析候选信息 <span className="identity-muted">（EPUB 原始证据）</span></h3>
            <dl className="identity-fields">
              <div><dt>书名 · dc:title</dt><dd>{display(preview.candidate?.title?.value)}</dd></div>
              <div><dt>语言 · dc:language</dt><dd>{display(preview.candidate?.language?.value)}</dd></div>
              <div><dt>原始标识 · dc:identifier</dt><dd>{display(preview.candidate?.identifier?.value)}</dd></div>
            </dl>
            <p className="identity-muted">原始标识并不必然是 ISBN，只有服务端通过类型及校验位核验后才可能写入。</p>
          </div>

          <div className="identity-data-block">
            <h3>现有正式书籍信息 <span className="identity-muted">（以已保存记录为准）</span></h3>
            {preview.product ? (
              <dl className="identity-fields">
                <div><dt>正式书名</dt><dd>{preview.product.title}</dd></div>
                <div><dt>语言</dt><dd>{display(preview.product.language)}</dd></div>
                <div><dt>ISBN-10</dt><dd>{display(preview.product.isbn10)}</dd></div>
                <div><dt>ISBN-13</dt><dd>{display(preview.product.isbn13)}</dd></div>
              </dl>
            ) : <p className="identity-muted">当前文件尚未关联正式 Work / Edition 记录。</p>}
          </div>

          <p className="identity-muted">
            {preview.canWrite ? "当前角色具有提交资格，最终以服务端再次校验为准。" : "当前角色仅可查看，不具备写入权限。"}
          </p>
        </>
      )}

      {audit && (
        <div className="identity-audit">
          <h3>保存记录与冲突说明</h3>
          <p>{audit.status && Object.hasOwn(outcomeCopy, audit.status)
            ? outcomeCopy[audit.status as keyof typeof outcomeCopy]
            : "已存在可追溯的书籍身份处理记录。"}</p>
          {applied.length > 0 && <p>已写入：{applied.map(identityFieldLabel).join("、")}</p>}
          {conflicts.length > 0 && (
            <ul>
              {conflicts.map((entry, index) => (
                <li key={index}>{identityFieldLabel(String(entry.field ?? ""))}：已有“{String(entry.existing ?? "")}”，候选“{String(entry.candidate ?? "")}”（保留已有值）</li>
              ))}
            </ul>
          )}
          {ignored.length > 0 && (
            <ul>
              {ignored.map((entry, index) => (
                <li key={index}>{identityFieldLabel(String(entry.field ?? ""))}未写入：{identityIgnoredReason(String(entry.reason ?? ""))}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="identity-actions">
        <button className="btn btn-secondary" type="button" disabled={loading || submitting} onClick={reload}>
          重新检查
        </button>
        <button className="btn btn-primary" type="button" disabled={!possibleToConfirm} onClick={openConfirmation}>
          核对并确认写入
        </button>
      </div>

      <dialog
        ref={dialogRef}
        className="identity-dialog"
        aria-labelledby="identity-confirm-title"
        aria-describedby="identity-confirm-desc"
        onCancel={(event) => { if (submitting) event.preventDefault(); }}
      >
        <div className="identity-dialog-body">
          <p className="page-eyebrow">写入正式书籍身份</p>
          <h2 id="identity-confirm-title">确认使用当前 EPUB 解析结果？</h2>
          <p id="identity-confirm-desc">
            这不是自动修改。服务端会再次核查当前版本、解析结果和权限，若已有字段冲突将整体拒绝写入。
          </p>
          {preview && (
            <>
              <p className="identity-file">源文件：{sourceFileName}</p>
              <ul className="identity-plan">
                {plannedIdentityChanges(preview).map((item, index) => <li key={index}>{item}</li>)}
              </ul>
              <p className="identity-muted">书名候选：{display(preview.candidate?.title?.value)}。本次只确认当前所见的解析记录。</p>
            </>
          )}
          <div className="identity-actions">
            <button className="btn btn-secondary" type="button" disabled={submitting} onClick={() => dialogRef.current?.close()}>
              取消
            </button>
            <button className="btn btn-primary" type="button" disabled={submitting || !canConfirmProductIdentity(preview)} onClick={() => void confirm()}>
              明确确认写入
            </button>
          </div>
        </div>
      </dialog>
    </section>
  );
}
