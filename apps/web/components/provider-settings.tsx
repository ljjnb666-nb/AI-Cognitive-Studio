"use client";

import { useEffect, useRef, useState } from "react";
import { podcastConfigurationFromForm, routeFormConfiguration } from "@/lib/provider-route-form";
import { ModelPicker } from "./model-picker";
import { StatusBadge } from "./status-badge";
import styles from "./provider-settings.module.css";
import { readableProviderError, providerKeyTestMessage } from "@/lib/provider-settings-ui-errors";
import { readinessDisplay, type ProviderReadinessView } from "@/lib/provider-readiness-ui";

type Model = { modelId: string; families: string[]; visionInput?:boolean; speechFormats?: string[]; embeddingDimensionOptions?: number[] };
type Provider = { providerKey: string; displayName: string; protocol: string; capabilityProtocols?: Record<string, string>; models: Model[] };
type Connection = { managedCapabilities?: string[]; id: string; providerKey: string; protocol: string; displayName: string; endpoint: string | null; region: string | null; status: string; health: string; credential: { id?: string; exists: boolean; displayHint?: string | null; status?: string } };
type Route = { id: string; routeSlot: string; connectionId: string; modelId: string; configuration: Record<string, unknown>; connection: { displayName: string; providerKey: string } };
type RouteFeedback = { tone: "pending" | "success" | "error"; message: string };
type State = { speechVoices: Record<string, string[]>; manifest: { providers: Provider[] }; connections: Connection[]; routes: Route[]; routeModels: Record<string, Record<string, Model[]>>; readiness: Record<string, ProviderReadinessView> };

const routeSlots = [
  { slot: "PDF_OCR", label: "扫描 PDF 文字识别（GLM-OCR，按需授权）" },
  { slot: "PDF_VISUAL_STRUCTURE", label: "PDF 页面模型审核（按需授权）" },
  { slot: "BOOK_CHUNK_ANALYSIS", label: "书籍理解 · 分块理解" }, { slot: "BOOK_REDUCTION_ANALYSIS", label: "书籍理解 · 归并分析" }, { slot: "BOOK_SYNTHESIS", label: "书籍理解 · 全书综合" },
  { slot: "EMBEDDING", label: "向量检索" }, { slot: "THINKING_SESSION", label: "思考" }, { slot: "TEACH_BACK_ASSESSMENT", label: "理解验证（复述评估）" },
  { slot: "PODCAST_SCRIPT", label: "播客脚本" }, { slot: "PODCAST_TTS", label: "语音合成" }, { slot: "SHORT_VIDEO_SCRIPT", label: "短视频脚本" }, { slot: "SHORT_VIDEO_TTS", label: "短视频语音合成" },
];

const readinessLabels: Record<string, string> = {
  ocr: "扫描书文字识别",
  book: "书籍理解",
  podcast: "播客生成",
  podcastAudio: "播客音频",
  shortVideo: "短视频生成",
  thinking: "思考",
  mastery: "理解验证",
};
const readableError = readableProviderError;

function normalizeProviderState(body: State): State {
  const routeModels = body.routeModels ?? Object.fromEntries(body.connections.map(connection => {
    const provider = body.manifest.providers.find(p => p.providerKey === connection.providerKey);
    return [connection.id, Object.fromEntries(routeSlots.map(({slot}) => [slot, provider?.models.filter(model =>
      model.families.includes(slot === "PDF_OCR" ? "OCR" : slot === "EMBEDDING" ? "EMBEDDING" : slot.endsWith("TTS") ? "SPEECH" : "TEXT_GENERATION") && (slot !== "PDF_VISUAL_STRUCTURE" || (connection.providerKey === "zhipu" && model.visionInput === true))) ?? []]))];
  }));
  return {...body,routeModels,speechVoices:body.speechVoices??{zhipu:["tongtong","xiaochen"],openai:["alloy","echo","fable","onyx","nova","shimmer"]}};
}

export function ProviderSettings() {
  const [state, setState] = useState<State | null>(null);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"neutral" | "success" | "error">("neutral");
  const [busy, setBusy] = useState(false);
  const [routeFeedback, setRouteFeedback] = useState<Record<string, RouteFeedback>>({});

  const refresh = async () => {
    const response = await fetch("/api/studio/providers", { cache: "no-store" });
    const body = (await response.json()) as State & { error?: string };
    if (!response.ok) throw new Error(readableError(body.error ?? "PROVIDER_SETTINGS_LOAD_FAILED"));
    setState(normalizeProviderState(body));
  };

  useEffect(() => {
    queueMicrotask(() => void refresh().catch(() => setMessage(readableError("PROVIDER_SETTINGS_LOAD_FAILED"))));
  }, []);

  async function submit(payload: Record<string, unknown>) {
    const slot = payload.action === "SET_ROUTE" ? String(payload.routeSlot) : undefined;
    const feedback = (value: RouteFeedback) => { if (slot) setRouteFeedback(previous => ({ ...previous, [slot]: value })); };
    feedback({ tone: "pending", message: "正在保存配置…" });
    setBusy(true);
    setMessage(payload.action === "TEST_CONNECTION" ? "正在验证 API Key…" : "");
    setMessageTone("neutral");
    try {
      const response = await fetch("/api/studio/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as State & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "PROVIDER_SETTINGS_SAVE_FAILED");
      if ("test" in body) {
        const testState = (body as { test: { state: string } }).test.state;
        const providerName = state?.manifest.providers.find(provider => provider.providerKey === payload.providerKey)?.displayName ?? "该服务商";
        setMessage(providerKeyTestMessage(testState, providerName));
        setMessageTone(testState === "VALID" ? "success" : testState === "UNSUPPORTED_TEST" ? "neutral" : "error");
        return;
      }
      setState(normalizeProviderState(body));
      setMessageTone("success");
      const success = payload.action === "DELETE_CONNECTION" ? "服务商已删除，相关用途已解除绑定。" : slot ? "用途配置已保存。" : "配置已保存。";
      setMessage(success);
      feedback({ tone: "success", message: payload.applyToBookStages ? "三个理解阶段已统一保存；向量检索配置未改变。" : slot === "PODCAST_TTS" ? "语音模型、主持人音色和语速已保存；保存设置不会生成音频。" : "用途配置已保存。" });
    } catch (error) {
      setMessageTone("error");
      const failure = readableError(error instanceof Error ? error.message : "PROVIDER_SETTINGS_SAVE_FAILED");
      setMessage(failure);
      feedback({ tone: "error", message: failure });
    } finally {
      setBusy(false);
    }
  }

  if (!state) {
    return (
      <div className="card-panel">
        <p aria-live="polite" style={{ color: "var(--on-surface-variant)", margin: 0 }}>
          {message || "正在加载服务商设置…"}
        </p>
      </div>
    );
  }

  return (
    <div className={styles.settings}>
      <nav className={styles.sectionNav} aria-label="服务商页内导航">
        <a href="#provider-overview">服务状态</a>
        <a href="#provider-connections">服务商管理 <span>{state.connections.length}</span></a>
        <a href="#provider-models">模型与用途</a>
      </nav>
      {/* 1. Readiness Group */}
      <section id="provider-overview" className={styles.overview}>
        <div className={styles.sectionHeading}>
          <div><h2 className="section-title">服务可用性</h2><p>查看各功能的配置情况；实际调用状态以任务结果为准。</p></div>
          <span className={styles.total}>{Object.values(state.readiness).filter(item => item.state === "READY").length} / {Object.keys(state.readiness).length} 项已就绪</span>
        </div>
        <div className={styles.readinessGrid}>
          {Object.entries(state.readiness).map(([name, item]) => {
            const detail = readinessDisplay(item);
            return <div
              key={name}
              className={styles.readinessCard}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{readinessLabels[name] ?? name}</span>
                <StatusBadge value={item.state === "READY" ? "已就绪" : "未完成"} />
              </div>
              {detail.summary && <p style={{ fontSize: 13, fontWeight: 600, margin: "0 0 10px" }}>{detail.summary}</p>}
              {detail.rows.length > 0 && <details className={styles.readinessDetails}><summary>查看配置明细</summary>{detail.rows.map(row => (
                <div key={row.label} style={{ display: "grid", gridTemplateColumns: "16px 1fr", columnGap: 6, fontSize: 12, marginTop: 6 }}>
                  <span aria-hidden="true">{row.configured ? "✓" : "○"}</span>
                  <span><strong>{row.label}</strong><br />{row.detail}</span>
                </div>
              ))}</details>}
              {name === "ocr" && <a className="btn btn-secondary" style={{ marginTop: 12, height: 32, fontSize: 12 }} href="#route-PDF_OCR" onClick={() => { const form = document.getElementById("route-PDF_OCR"); const panel = form?.closest("details"); if (panel) panel.open = true; form?.scrollIntoView({ block: "start", behavior: "smooth" }); }}>设置扫描书识别</a>}
              {name === "podcastAudio" && <a className="btn btn-secondary" style={{ marginTop: 12, height: 32, fontSize: 12 }} href="#route-PODCAST_TTS" onClick={() => { const form = document.getElementById("route-PODCAST_TTS"); const panel = form?.closest("details"); if (panel) panel.open = true; form?.scrollIntoView({ block: "start", behavior: "smooth" }); }}>设置播客音频</a>}
              {detail.completion && detail.completion !== "已就绪" && <p className={styles.completion}>{detail.completion}</p>}
              {!detail.rows.length && item.missing.length > 0 && (
                <p style={{ fontSize: 12, color: "var(--muted-terracotta)", margin: "8px 0 0 0" }}>
                  请先配置服务商，并为所需用途选择模型。
                </p>
              )}
            </div>;
          })}
        </div>
      </section>

      <div id="provider-connections" className={styles.connectionsLayout}>
      {/* 3. Existing Connections */}
      <section className={styles.connectionList}>
        <div className={styles.sectionHeading}><div><h2 className="section-title">已配置服务商</h2><p>管理密钥与启用状态，模型按用途单独配置。</p></div><span className={styles.total}>{state.connections.length} 个服务商</span></div>
        <div className={styles.connectionCards}>
          {state.connections.map((connection) => (
            <div
              key={connection.id}
              className={styles.connectionCard}
            >
              <div className={styles.connectionHeading}>
                <div>
                  <h3 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 4px 0", color: "var(--on-surface)" }}>
                    {connection.displayName}
                  </h3>
                  <div className={styles.endpoint}>{state.manifest.providers.find(provider => provider.providerKey === connection.providerKey)?.displayName ?? connection.providerKey} · {connection.endpoint ?? "未配置服务地址"}{connection.region ? ` · ${connection.region}` : ""}</div>
                </div>
                <StatusBadge value={connection.status === "ACTIVE" ? "已启用" : "已停用"} />
              </div>

              <p style={{ fontSize: 13, color: "var(--on-surface-variant)", margin: "0 0 16px 0" }}>
                API Key: {connection.credential.exists ? `已配置 ${connection.credential.displayHint ?? ""}` : "未配置"}
              </p>

              {Boolean(connection.managedCapabilities?.length) && <p className="muted" style={{fontSize:12,margin:"0 0 14px"}}>已配置用途接口：{connection.managedCapabilities!.join("、")}。密钥与启用状态由此服务商统一管理。</p>}
              <div className={styles.connectionActions}>
                <CredentialRotation connectionId={connection.id} busy={busy} submit={submit} />

                {connection.credential.id && connection.credential.status === "ACTIVE" && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() => void submit({ action: "REVOKE_CREDENTIAL", credentialVersionId: connection.credential.id })}
                    style={{ height: 36, fontSize: 13 }}
                  >
                    撤销 API Key
                  </button>
                )}

                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => void submit({ action: "SET_ENABLED", connectionId: connection.id, enabled: connection.status !== "ACTIVE" })}
                  style={{ height: 36, fontSize: 13 }}
                >
                  {connection.status === "ACTIVE" ? "停用服务商" : "启用服务商"}
                </button>
                <DeleteService connection={connection} routes={state.routes.filter(route => route.connectionId === connection.id)} busy={busy} submit={submit} />
              </div>
            </div>
          ))}

          {!state.connections.length && <p style={{ color: "var(--outline)", margin: 0, fontSize: 14 }}>保存后，服务商会显示在这里；随后可在下方为功能选择模型。</p>}
        </div>
      </section>

      {/* 2. Create Connection */}
      <section className={`card-panel ${styles.createPanel}`}>
        <div className={styles.sectionHeading}><div><h2 className="section-title">添加服务商</h2><p>选择服务商并保存 API Key。密钥加密保管，模型在「模型与用途配置」中设置。</p></div></div>
        <ConnectionForm providers={state.manifest.providers} busy={busy} submit={submit} />
      </section>

      </div>

      <section id="provider-models" className={styles.routingSection}>
        <div className={styles.sectionHeading}><div><h2 className="section-title">模型与用途</h2><p>为每个功能选择服务商及兼容模型。</p></div></div>

      {/* Engineering controls remain available, but are intentionally hidden from the normal setup flow. */}
      <details className="card-panel">
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>模型与用途配置（高级设置）</summary>
        <p className="muted">模型只在这里按用途选择，列表由官方模型目录与功能要求筛选。实际调用权限以服务商账户为准。保存服务商不会自动绑定模型。</p>
          <h2 className="section-title" style={{ marginBottom: 20 }}>
          配置用途
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {routeSlots.filter(({slot}) => slot !== "PDF_OCR" || state.manifest.providers.some(p => p.models.some(m => m.families.includes("OCR")))).map(({ slot, label }) => (
            <RouteForm
              key={`${slot}:${state.routes.find(route => route.routeSlot === slot)?.connectionId ?? ""}:${state.routes.find(route => route.routeSlot === slot)?.modelId ?? ""}:${JSON.stringify(state.routes.find(route => route.routeSlot === slot)?.configuration ?? {})}`}
              slot={slot}
              slotLabel={label}
              feedback={routeFeedback[slot]}
              speechVoices={state.speechVoices}
              connections={state.connections}
              providers={state.manifest.providers}
              routeModels={state.routeModels}
              existing={state.routes.find((route) => route.routeSlot === slot)}
              busy={busy}
              submit={submit}
            />
          ))}
        </div>
      </details>
      </section>

      {message && (
        <p aria-live="polite" data-tone={messageTone} className={`form-error ${styles.feedback}`}>
          {message}
        </p>
      )}
    </div>
  );
}

function QwenStableFields({ region, workspaceId, setRegion, setWorkspaceId }: { region: string; workspaceId: string; setRegion(value: string): void; setWorkspaceId(value: string): void }) {
  return <><label className="form-label">百炼区域<select className="select-control" value={region} onChange={event => setRegion(event.target.value)}><option value="BEIJING">北京</option><option value="SINGAPORE">新加坡</option></select></label><label className="form-label">百炼工作区 ID<input className="input-control" value={workspaceId} onChange={event => setWorkspaceId(event.target.value)} required pattern="[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9]|[A-Za-z0-9]" placeholder="workspace-id" /></label></>;
}

function ConnectionForm({ providers, busy, submit }: { providers: Provider[]; busy: boolean; submit(payload: Record<string, unknown>): Promise<void> }) {
  const [providerKey, setProviderKey] = useState(providers[0]?.providerKey ?? "");
  const [customEndpoint, setCustomEndpoint] = useState("");
  const [minimaxSite, setMinimaxSite] = useState("CN");
  const [qwenRegion, setQwenRegion] = useState("BEIJING");
  const [qwenWorkspaceId, setQwenWorkspaceId] = useState("");
  const provider = providers.find(item => item.providerKey === providerKey);
  const defaultEndpoints: Record<string, string> = { openai: "https://api.openai.com/v1/responses", anthropic: "https://api.anthropic.com/v1/messages", gemini: "https://generativelanguage.googleapis.com/v1beta", deepseek: "https://api.deepseek.com/chat/completions", zhipu: "https://open.bigmodel.cn/api/paas/v4/chat/completions", minimax: minimaxSite === "CN" ? "https://api.minimax.cn/v1/chat/completions" : "https://api.minimax.io/v1/text/chatcompletion_v2", cohere: "https://api.cohere.com/v2/embed", voyage: "https://api.voyageai.com/v1/embeddings" };
  const endpoint = providerKey === "qwen" ? `https://${qwenWorkspaceId}.${qwenRegion === "BEIJING" ? "cn-beijing" : "ap-southeast-1"}.maas.aliyuncs.com/compatible-mode/v1/chat/completions` : defaultEndpoints[providerKey] ?? customEndpoint;
  return <form className={styles.createForm} data-minimax={providerKey === "minimax"} action={form => void submit({ action: "CREATE_CONNECTION_WITH_CREDENTIAL", providerKey, protocol: provider?.protocol, displayName: String(form.get("displayName") ?? "").trim() || provider?.displayName, endpoint, secret: form.get("secret"), region: form.get("region") || undefined, configuration: { ...parseConfiguration(form.get("configuration")), ...(providerKey === "qwen" ? { qwenRegion, qwenWorkspaceId } : {}) } })}>
    <div className="form-group"><label className="form-label" htmlFor="new-provider">服务商</label><select id="new-provider" className="select-control" value={providerKey} onChange={event => setProviderKey(event.target.value)} disabled={busy}>{providers.map(item => <option key={item.providerKey} value={item.providerKey}>{item.displayName}</option>)}</select></div>
    {providerKey === "minimax" && <div className="form-group"><label className="form-label" htmlFor="minimax-site">密钥所属站点</label><select id="minimax-site" className="select-control" value={minimaxSite} onChange={event => setMinimaxSite(event.target.value)} disabled={busy}><option value="CN">国内站</option><option value="GLOBAL">国际站</option></select><small className="muted">验证和模型调用使用同一站点，密钥不跨站通用。</small></div>}
    <div className="form-group"><label className="form-label" htmlFor="new-provider-key">API Key</label><input key={providerKey} id="new-provider-key" className="input-control" name="secret" type="password" autoComplete="new-password" required placeholder="输入服务商的 API Key" disabled={busy} /></div>
    {!defaultEndpoints[providerKey] && providerKey !== "qwen" && <div className="form-group"><label className="form-label" htmlFor="new-provider-url">API 地址</label><input id="new-provider-url" className="input-control" type="url" required value={customEndpoint} onChange={event => setCustomEndpoint(event.target.value)} placeholder="https://api.example.com/v1/chat/completions" /><small className="muted">自定义服务需要完整的 Chat Completions 接口地址。</small></div>}
    {providerKey === "qwen" && <QwenStableFields region={qwenRegion} workspaceId={qwenWorkspaceId} setRegion={setQwenRegion} setWorkspaceId={setQwenWorkspaceId} />}
    <input type="hidden" name="endpoint" value={endpoint} /><input type="hidden" name="protocol" value={provider?.protocol ?? ""} />
    <details className={styles.createAdvanced}><summary className={styles.summary}>更多服务商设置（可选）</summary><div className={styles.content}>
      <div className="form-group"><label className="form-label" htmlFor="new-provider-name">服务商备注名称</label><input key={providerKey} id="new-provider-name" className="input-control" name="displayName" maxLength={160} placeholder={provider?.displayName ?? "服务商名称"} /><small className="muted">留空使用服务商名称；配置多把密钥时可填写不同备注。</small></div>
      {defaultEndpoints[providerKey] && <p className="muted" style={{ overflowWrap: "anywhere" }}>官方接口：{endpoint}</p>}
      <div className="form-group"><label className="form-label" htmlFor="new-provider-region">区域（可选）</label><input id="new-provider-region" className="input-control" name="region" placeholder="例如：us-east-1" /></div>
      <div className="form-group"><label className="form-label" htmlFor="new-provider-configuration">高级配置 JSON</label><textarea id="new-provider-configuration" className="input-control font-mono" name="configuration" defaultValue="{}" rows={3} /></div>
    </div></details>
    <div className={styles.createActions}><button type="button" className="btn btn-secondary" disabled={busy || !provider} onClick={event => { const form = event.currentTarget.form; if (!form || !form.reportValidity()) return; void submit({ action: "TEST_CONNECTION", providerKey, protocol: provider?.protocol, endpoint, secret: new FormData(form).get("secret") }); }}>验证 API Key</button><button type="submit" className="btn btn-primary" disabled={busy || !provider}>{busy ? "保存中…" : "保存服务商"}</button></div>
  </form>;
}

function DeleteService({ connection, routes, busy, submit }: { connection: Connection; routes: Route[]; busy: boolean; submit(payload: Record<string, unknown>): Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const titleId = `delete-service-${connection.id}`;
  return <>
    <button type="button" className={`btn btn-secondary ${styles.deleteButton}`} disabled={busy} onClick={() => dialog.current?.showModal()}>删除服务商</button>
    <dialog ref={dialog} className={styles.deleteDialog} aria-labelledby={titleId}>
      <h2 id={titleId}>删除服务商？</h2>
      <p className={styles.deleteName}>{connection.displayName}</p>
      <p>此服务商及其关联的语音、向量接口将从配置列表中移除，保存在应用内的 API Key 将被撤销。</p>
      {routes.length ? <><p>以下 {routes.length} 项用途将解除绑定，需要重新配置：</p><ul>{routes.map(route => <li key={route.routeSlot}>{routeSlots.find(item => item.slot === route.routeSlot)?.label ?? route.routeSlot}</li>)}</ul></> : <p>此服务商没有绑定用途。</p>}
      <p>历史调用记录和已生成内容会保留。已发出的请求可能继续完成；服务商账户中的密钥不会被删除。</p>
      <div className={styles.dialogActions}>
        <button type="button" autoFocus className="btn btn-secondary" onClick={() => dialog.current?.close()}>取消</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => {
          if (submitting.current) return;
          submitting.current = true;
          dialog.current?.close();
          void submit({ action: "DELETE_CONNECTION", connectionId: connection.id, expectedRouteSlots: routes.map(route => route.routeSlot), expectedCredentialVersionId: connection.credential.status === "ACTIVE" ? connection.credential.id ?? null : null }).finally(() => { submitting.current = false; });
        }}>确认删除</button>
      </div>
    </dialog>
  </>;
}

function CredentialRotation({ connectionId, busy, submit }: { connectionId: string; busy: boolean; submit(payload: Record<string, unknown>): Promise<void> }) {
  const [editing, setEditing] = useState(false);
  if (!editing) return <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setEditing(true)} style={{ height: 36, fontSize: 13 }}>更新 API Key</button>;
  return <form style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 280 }} action={async (form) => { await submit({ action: "SET_CREDENTIAL", connectionId, secret: form.get("secret") }); setEditing(false); }}>
    <input className="input-control" name="secret" type="password" autoComplete="new-password" placeholder="输入新的 API Key" required style={{ height: 36, fontSize: 13 }} />
    <button type="submit" className="btn btn-secondary" disabled={busy} style={{ height: 36, fontSize: 13 }}>保存 API Key</button>
    <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setEditing(false)} style={{ height: 36, fontSize: 13 }}>取消</button>
  </form>;
}

function RouteForm({
  slot,
  slotLabel,
  feedback,
  speechVoices,
  connections,
  providers,
  routeModels,
  existing,
  busy,
  submit,
}: {
  slot: string;
  slotLabel: string;
  feedback?: RouteFeedback;
  speechVoices: State["speechVoices"];
  connections: Connection[];
  providers: Provider[];
  routeModels: State["routeModels"];
  existing?: Route;
  busy: boolean;
  submit(payload: Record<string, unknown>): Promise<void>;
}) {
  const [selectedConnectionId, setSelectedConnectionId] = useState(existing?.connectionId ?? "");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [applyToBookStages, setApplyToBookStages] = useState(false);
  const [configurationError, setConfigurationError] = useState(false);
  const [validationError, setValidationError] = useState("");
  const [qwenRegion, setQwenRegion] = useState(String(existing?.configuration.qwenRegion ?? "BEIJING"));
  const [qwenWorkspaceId, setQwenWorkspaceId] = useState(String(existing?.configuration.qwenWorkspaceId ?? ""));
  const [qwenDimension, setQwenDimension] = useState(String(existing?.configuration.embeddingDimensions ?? 1024));
  const connectionId = connections.some((c) => c.id === selectedConnectionId) ? selectedConnectionId : existing?.connectionId ?? connections[0]?.id ?? "";
  const connection = connections.find((c) => c.id === connectionId);
  const provider = providers.find((p) => p.providerKey === connection?.providerKey);

  const capability = slot === "PDF_OCR" ? "OCR" : slot === "EMBEDDING" ? "EMBEDDING" : slot.endsWith("TTS") ? "SPEECH" : "TEXT_GENERATION";
  const models = routeModels[connectionId]?.[slot] ?? [];

  const voiceIds = speechVoices[connection?.providerKey ?? ""] ?? [];
  const voiceLabels: Record<string, string> = { tongtong: "彤彤", xiaochen: "小陈", chuichui: "锤锤" };
  const savedVoices = Array.isArray(existing?.configuration.hostVoices) ? existing.configuration.hostVoices as Array<Record<string, unknown>> : [];
  return (
    <form
      id={`route-${slot}`}
      onInvalidCapture={event => {
        const field = event.currentTarget.querySelector<HTMLInputElement | HTMLSelectElement>("input:invalid, select:invalid, textarea:invalid");
        if (!field) return;
        setValidationError(field.name === "modelId" ? "请先选择模型，再保存配置。" : field.name.startsWith("hostVoice") ? "请填写两位主持人的音色 ID。" : field.name.startsWith("hostRate") ? "请填写有效语速，并检查允许范围。" : "请完整填写必填项，再保存配置。");
      }}
      onSubmit={async event => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setValidationError("");
        let configuration: Record<string, unknown>;
        try {
          configuration = routeFormConfiguration(form.get("configuration"), existing?.connectionId === connectionId ? existing.configuration : {});
          if (slot === "PODCAST_TTS" && !form.has("configuration")) configuration = podcastConfigurationFromForm(form, configuration);
        } catch { setConfigurationError(true); return; }
        setConfigurationError(false);
        await submit({ action: "SET_ROUTE", routeSlot: slot, ...(slot === "BOOK_CHUNK_ANALYSIS" && applyToBookStages ? { applyToBookStages: true } : {}), connectionId, modelId: form.get("modelId"), configuration: connection?.providerKey === "qwen" ? { ...configuration, qwenRegion, qwenWorkspaceId, ...(capability === "EMBEDDING" ? { embeddingDimensions: Number(qwenDimension) } : {}) } : configuration });
      }}
      style={{
        backgroundColor: "var(--surface-container)",
        border: "1px solid var(--surface-container-high)",
        borderRadius: "var(--radius-lg)",
        padding: "20px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <h4 style={{ fontSize: 14, fontWeight: 600, color: "var(--on-surface)", margin: 0 }}>
          {slotLabel}
        </h4>
        {existing && <StatusBadge value="已绑定" />}
      </div>

      {slot === "BOOK_CHUNK_ANALYSIS" && <div className={styles.sharedBookModel}>
        <label><input type="checkbox" checked={applyToBookStages} disabled={busy} onChange={event => setApplyToBookStages(event.target.checked)} />三个理解阶段使用相同模型</label>
        <p>{applyToBookStages ? "保存将统一修改分块理解、归并分析和全书综合的服务商、模型及高级设置。向量检索仍单独配置。" : "默认只保存分块理解。勾选后可将所选模型同时用于三个理解阶段。"}</p>
      </div>}
      <div className={styles.routeFields}>
        <div className="form-group">
          <label className="form-label" htmlFor={`route-connection-${slot}`}>服务商</label>
          <select id={`route-connection-${slot}`} className="select-control" value={connectionId} onChange={(e) => setSelectedConnectionId(e.target.value)}>
            {connections.map((c) => (
              <option value={c.id} key={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>
        </div>

        <ModelPicker key={`${connectionId}:${existing?.modelId ?? ""}`} name="modelId" models={models} defaultValue={existing?.connectionId === connectionId ? existing.modelId : undefined} allowCustom={connection?.providerKey === "openai-compatible" && capability === "TEXT_GENERATION" && slot !== "PDF_VISUAL_STRUCTURE" && slot !== "TEACH_BACK_ASSESSMENT"} disabled={busy} />
      </div>

      {slot === "PODCAST_TTS" && <fieldset className={styles.group} disabled={busy || showAdvanced} style={{ marginBottom: 20 }}>
        <legend>主持人音色与语速</legend>
        <p className="muted" style={{ fontSize: 12, margin: "0 0 16px" }}>语音模型绑定后，还需要设置每位主持人的音色。本机播客输出为 WAV；保存设置不会生成音频。{voiceIds.length > 0 && ` 当前服务商提供 ${voiceIds.length} 个系统音色，请从列表中选择。`}</p>
        <div className={styles.fields}>
          {[1, 2].map(ordinal => {
            const voice = savedVoices.find(voice => voice.ordinal === ordinal);
            return <div key={ordinal} className="form-group">
              <label className="form-label" htmlFor={`host-voice-${ordinal}`}>主持人 {ordinal === 1 ? "A" : "B"} 音色</label>
              {voiceIds.length ? <select key={`${connectionId}:${ordinal}`} className="select-control" id={`host-voice-${ordinal}`} name={`hostVoice${ordinal}`} defaultValue={String(voice?.providerVoiceId ?? "")} required>
                <option value="" disabled>请选择音色</option>
                {voice && !voiceIds.includes(String(voice.providerVoiceId)) && <option value={String(voice.providerVoiceId)} disabled>{String(voice.providerVoiceId)}（不支持，请重新选择）</option>}
                {voiceIds.map(id => <option key={id} value={id}>{voiceLabels[id] ? `${voiceLabels[id]}（${id}）` : id}</option>)}
              </select> : <input key={`${connectionId}:${ordinal}`} className="input-control" id={`host-voice-${ordinal}`} name={`hostVoice${ordinal}`} defaultValue={String(voice?.providerVoiceId ?? "")} placeholder="服务商提供的音色 ID" required maxLength={160} />}
              <label className="form-label" htmlFor={`host-rate-${ordinal}`}>主持人 {ordinal === 1 ? "A" : "B"} 语速</label>
              <input className="input-control" id={`host-rate-${ordinal}`} name={`hostRate${ordinal}`} type="number" step="0.05" min={connection?.providerKey === "zhipu" ? 0.5 : 0.25} max={connection?.providerKey === "zhipu" ? 2 : 4} defaultValue={Number(voice?.speakingRate ?? 1)} required />
            </div>;
          })}
        </div>
        {showAdvanced && <p className="muted">当前使用下方高级 JSON 配置。</p>}
      </fieldset>}
      {configurationError && <p className="error" role="alert">高级配置必须是有效的 JSON 对象，尚未保存任何更改。</p>}
      <div style={{ marginBottom: 16 }}>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setShowAdvanced(!showAdvanced)}
          style={{ height: 30, fontSize: 12, padding: "0 10px" }}
        >
          {showAdvanced ? "隐藏高级路由配置" : "展开高级路由配置 JSON"}
        </button>
      </div>

      {connection?.providerKey === "qwen" && <div style={{ display: "grid", gridTemplateColumns: capability === "EMBEDDING" ? "1fr 1fr 1fr" : "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <div className="form-group"><label className="form-label">百炼区域</label><select className="select-control" value={qwenRegion} onChange={event => setQwenRegion(event.target.value)}><option value="BEIJING">北京</option><option value="SINGAPORE">新加坡</option></select></div>
        <div className="form-group"><label className="form-label">百炼工作区 ID</label><input className="input-control" value={qwenWorkspaceId} onChange={event => setQwenWorkspaceId(event.target.value)} required placeholder="workspace-id" /></div>
        {capability === "EMBEDDING" && <div className="form-group"><label className="form-label">向量维度</label><select className="select-control" value={qwenDimension} onChange={event => setQwenDimension(event.target.value)}>{(models[0]?.embeddingDimensionOptions ?? [1024]).map(dimension => <option key={dimension} value={dimension}>{dimension}</option>)}</select></div>}
      </div>}

      {showAdvanced && (
        <div className="form-group" style={{ marginBottom: 16 }}>
          <label className="form-label">高级路由配置 JSON</label>
          <textarea
            className="input-control font-mono"
            name="configuration"
            defaultValue={JSON.stringify(existing?.configuration ?? {}, null, 2)}
            rows={4}
            style={{ height: "auto", padding: 12 }}
          />
        </div>
      )}

      <button type="submit" className="btn btn-secondary" disabled={busy || !connection || !models.length} style={{ height: 36 }}>
        {feedback?.tone === "pending" ? "正在保存…" : applyToBookStages ? "保存三个理解阶段" : "保存路由"}
      </button>
      {validationError ? <p className={styles.routeFeedback} data-tone="error" role="alert">{validationError}</p> : feedback && <p className={styles.routeFeedback} data-tone={feedback.tone} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.message}</p>}

    </form>
  );
}

function parseConfiguration(value: FormDataEntryValue | null): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
