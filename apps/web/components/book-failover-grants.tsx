"use client";

import { useEffect, useState } from "react";

export type BookBackupOperation = {
  analysisRunId: string;
  routeSlot: "BOOK_CHUNK_ANALYSIS" | "BOOK_REDUCTION_ANALYSIS" | "BOOK_SYNTHESIS";
  operationHash: string;
  planHash: string;
  expectedRevision: number;
  lastFailureCode: string;
  holdReason: string | null;
  settledOutcome: string | null;
  updatedAt: string;
};

export type BookBackupConsent = {
  analysisRunId: string;
  routeSlot: BookBackupOperation["routeSlot"];
  operationHash: string;
  planHash: string;
  expectedRevision: number;
  maxAdditionalUnits: number;
  expiresInMinutes: number;
  approval: "AUTHORIZE_ONE_ADDITIONAL_MODEL_CALL";
};

const slotLabels: Record<BookBackupOperation["routeSlot"], string> = {
  BOOK_CHUNK_ANALYSIS: "分块理解",
  BOOK_REDUCTION_ANALYSIS: "章节归并",
  BOOK_SYNTHESIS: "全书综合",
};

const keyOf = (operation: BookBackupOperation) =>
  [operation.analysisRunId, operation.routeSlot, operation.operationHash].join(":");

/** Never create a paid-call approval payload without a fresh, explicit user acknowledgement. */
export function prepareBookBackupConsent(
  operation: BookBackupOperation | null,
  units: string,
  expiryMinutes: string,
  acknowledged: boolean,
): BookBackupConsent | null {
  if (!operation || !acknowledged || !/^[1-9][0-9]*$/.test(units) ||
      !/^[1-9][0-9]*$/.test(expiryMinutes)) return null;
  const maxAdditionalUnits = Number(units);
  const expiresInMinutes = Number(expiryMinutes);
  if (!Number.isSafeInteger(maxAdditionalUnits) || maxAdditionalUnits > 1_000_000 ||
      !Number.isSafeInteger(expiresInMinutes) || expiresInMinutes > 60) return null;
  return {
    analysisRunId: operation.analysisRunId,
    routeSlot: operation.routeSlot,
    operationHash: operation.operationHash,
    planHash: operation.planHash,
    expectedRevision: operation.expectedRevision,
    maxAdditionalUnits,
    expiresInMinutes,
    approval: "AUTHORIZE_ONE_ADDITIONAL_MODEL_CALL",
  };
}

export function BookFailoverGrantPanel() {
  const [operations, setOperations] = useState<BookBackupOperation[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [units, setUnits] = useState("");
  const [expiryMinutes, setExpiryMinutes] = useState("15");
  const [acknowledged, setAcknowledged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/studio/book-failover-grants", {
          cache: "no-store", credentials: "same-origin", signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (response.status === 403) { setDenied(true); return; }
        if (!response.ok) throw new Error("LOAD_FAILED");
        const body = await response.json() as { operations?: BookBackupOperation[] };
        if (!controller.signal.aborted) {
          setOperations(Array.isArray(body.operations) ? body.operations : []);
        }
      } catch {
        if (!controller.signal.aborted) setLoadFailed(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  // Non-owners do not see the panel at all; the API separately enforces OWNER.
  if (denied) return null;

  const selected = operations.find(item => keyOf(item) === selectedKey) ?? null;
  const consent = prepareBookBackupConsent(selected, units, expiryMinutes, acknowledged);

  async function authorize() {
    if (!consent || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/studio/book-failover-grants", {
        method: "POST", cache: "no-store", credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(consent),
      });
      if (!response.ok) {
        setMessage(response.status === 409
          ? "状态已经变化，或尚无法证明原调用未发送。没有签发授权，请重新核对。"
          : response.status === 403
            ? "当前账号没有此操作的 OWNER 授权权限。"
            : "授权请求未通过校验；没有签发授权。");
        return;
      }
      // The endpoint records only a grant, never a remote provider call.
      const result = await response.json() as { status?: string };
      if (result.status !== "CONSENT_RECORDED_NO_PROVIDER_CALL") {
        setMessage("服务器未返回预期的授权确认，请勿重复提交，先核对审计记录。");
        return;
      }
      setOperations(previous => previous.filter(item => keyOf(item) !== selectedKey));
      setSelectedKey("");
      setUnits("");
      setAcknowledged(false);
      setMessage("一次性授权已记录；备用模型执行仍关闭，没有发起模型请求。");
    } catch {
      setMessage("网络响应不确定。请先核对授权记录，勿重复提交。");
    } finally {
      setBusy(false);
    }
  }

  return <section className="card-panel" aria-labelledby="book-backup-grants-title" style={{ marginTop: 16 }}>
    <h2 id="book-backup-grants-title" className="section-title">书籍理解：单次备用模型授权</h2>
    <p className="muted">
      这里仅展示当前工作区正在运行的书籍理解故障摘要。候选记录不代表可安全收费；
      每次提交仍由服务端验证租约、原请求未发送证明、模型凭据和账本状态。
    </p>
    <p className="muted">
      <strong>当前备用模型执行仍关闭。</strong> 授权只创建一条限时记录，不会立即调用模型。
      将来如启用执行器，授权有效期内的一次额外调用可能产生费用。
      下方资源单位可能是 Token 或字符，并非人民币或美元，也不是价格预估。
    </p>
    {loading ? <p role="status">正在读取授权候选…</p>
      : loadFailed ? <p role="alert">授权候选读取失败，请稍后刷新页面。</p>
      : operations.length === 0 ? <p className="muted">暂无可展示的待核对故障记录。</p>
      : <div style={{ display: "grid", gap: 12 }}>
        <label className="form-label">选择本次授权的单个故障操作
          <select className="select-control" value={selectedKey} disabled={busy}
            onChange={event => {
              setSelectedKey(event.target.value);
              setAcknowledged(false);
              setMessage("");
            }}>
            <option value="">请手动选择（默认不授权）</option>
            {operations.map(item => <option key={keyOf(item)} value={keyOf(item)}>
              {slotLabels[item.routeSlot]} · 任务 {item.analysisRunId.slice(0, 8)} · 故障 {item.lastFailureCode}
            </option>)}
          </select>
        </label>
        {selected && <div className="muted" style={{ fontSize: 12 }}>
          <p>故障代码：{selected.lastFailureCode}；暂停原因：{selected.holdReason ?? "未记录"}；
            远端结果：{selected.settledOutcome ?? "未确认"}。</p>
          <p>账本版本：{selected.expectedRevision}；操作摘要：{selected.operationHash.slice(0, 12)}…。
            此处展示仅供判断，不保证符合最终授权条件。</p>
        </div>}
        <label className="form-label">本次额外调用的资源单位上限（不是金额）
          <input className="input-control" type="number" min="1" max="1000000" step="1"
            placeholder="手动填写，1～1000000" value={units} disabled={busy}
            onChange={event => { setUnits(event.target.value); setAcknowledged(false); }} />
        </label>
        <label className="form-label">授权有效期
          <select className="select-control" value={expiryMinutes} disabled={busy}
            onChange={event => { setExpiryMinutes(event.target.value); setAcknowledged(false); }}>
            <option value="5">5 分钟</option>
            <option value="15">15 分钟</option>
            <option value="30">30 分钟</option>
            <option value="60">60 分钟</option>
          </select>
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <input type="checkbox" checked={acknowledged} disabled={busy || !selected}
            onChange={event => setAcknowledged(event.target.checked)} />
          我确认只为所选任务的一次额外模型调用签发授权，并理解可能产生费用；
          当前不会立即发送备用模型请求。
        </label>
        <button type="button" className="btn btn-secondary" disabled={!consent || busy}
          onClick={() => void authorize()}>
          {busy ? "正在核验授权…" : "记录本次明确授权（不执行调用）"}
        </button>
      </div>}
    {message && <p role="status" aria-live="polite">{message}</p>}
  </section>;
}
