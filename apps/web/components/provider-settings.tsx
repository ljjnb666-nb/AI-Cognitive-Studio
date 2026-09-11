"use client";

import { useEffect, useState } from "react";
import { StatusBadge } from "./status-badge";
import { readableProviderError } from "@/lib/provider-settings-ui-errors";
import { readinessDisplay, type ProviderReadinessView } from "@/lib/provider-readiness-ui";

type Model = { modelId: string; families: string[]; speechFormats?: string[]; embeddingDimensionOptions?: number[] };
type Provider = { providerKey: string; displayName: string; protocol: string; capabilityProtocols?: Record<string, string>; models: Model[] };
type Connection = { id: string; providerKey: string; protocol: string; displayName: string; endpoint: string | null; region: string | null; status: string; health: string; credential: { id?: string; exists: boolean; displayHint?: string | null; status?: string } };
type Route = { id: string; routeSlot: string; connectionId: string; modelId: string; configuration: Record<string, unknown>; connection: { displayName: string; providerKey: string } };
type State = { manifest: { providers: Provider[] }; connections: Connection[]; routes: Route[]; readiness: Record<string, ProviderReadinessView> };

const routeSlots = [
  { slot: "BOOK_CHUNK_ANALYSIS", label: "书籍理解" }, { slot: "BOOK_REDUCTION_ANALYSIS", label: "书籍理解" }, { slot: "BOOK_SYNTHESIS", label: "书籍理解" },
  { slot: "EMBEDDING", label: "向量检索" }, { slot: "THINKING_SESSION", label: "思考" }, { slot: "TEACH_BACK_ASSESSMENT", label: "Teach Back 评估" },
  { slot: "PODCAST_SCRIPT", label: "播客脚本" }, { slot: "PODCAST_TTS", label: "语音合成" }, { slot: "SHORT_VIDEO_SCRIPT", label: "短视频脚本" }, { slot: "SHORT_VIDEO_TTS", label: "短视频语音合成" },
];

const readinessLabels: Record<string, string> = {
  book: "书籍理解",
  podcast: "播客生成",
  podcastAudio: "播客音频",
  shortVideo: "短视频生成",
  thinking: "思考",
};
const readableError = readableProviderError;

export function ProviderSettings() {
  const [state, setState] = useState<State | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const response = await fetch("/api/studio/providers", { cache: "no-store" });
    const body = (await response.json()) as State & { error?: string };
    if (!response.ok) throw new Error(readableError(body.error ?? "PROVIDER_SETTINGS_LOAD_FAILED"));
    setState(body);
  };

  useEffect(() => {
    queueMicrotask(() => void refresh().catch(() => setMessage(readableError("PROVIDER_SETTINGS_LOAD_FAILED"))));
  }, []);

  async function submit(payload: Record<string, unknown>) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/studio/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as State & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "PROVIDER_SETTINGS_SAVE_FAILED");
      if ("test" in body) { const state = (body as { test: { state: string } }).test.state; setMessage(state === "VALID" ? "✓ API Key 可用，确认后点击保存 Provider。" : state === "AUTHENTICATION_FAILED" ? "API Key 无效或已失效。" : state === "TIMEOUT" ? "连接超时，请稍后重试。" : state === "UNSUPPORTED_TEST" ? "该自定义服务无法自动验证，可直接保存后测试实际调用。" : "无法连接该服务，请检查地址和网络。"); return; }
      if ("autoConfigure" in body) { const result = (body as { autoConfigure: { bound: string[]; skipped: string[] } }).autoConfigure; setState(body); setMessage(result.bound.length ? `已自动配置 ${result.bound.length} 个推荐用途。${result.skipped.length ? "其余用途需要兼容模型或语音设置。" : ""}` : "当前模型没有可自动配置的用途，请在高级设置中选择兼容模型。"); return; }
      setState(body);
    } catch (error) {
      setMessage(readableError(error instanceof Error ? error.message : "PROVIDER_SETTINGS_SAVE_FAILED"));
    } finally {
      setBusy(false);
    }
  }

  if (!state) {
    return (
      <div className="card-panel">
        <p aria-live="polite" style={{ color: "var(--on-surface-variant)", margin: 0 }}>
          {message || "正在加载 AI Provider 设置…"}
        </p>
      </div>
    );
  }
  const bookProviderKeys = new Set(state.routes.filter(route => ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS", "EMBEDDING"].includes(route.routeSlot)).map(route => route.connection.providerKey));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      {/* 1. Readiness Group */}
      <section className="card-panel">
        <h2 className="section-title" style={{ marginBottom: 20 }}>
          服务可用性
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 16 }}>
          {Object.entries(state.readiness).map(([name, item]) => {
            const detail = readinessDisplay(item);
            return <div
              key={name}
              style={{
                backgroundColor: "var(--surface-container)",
                border: "1px solid var(--surface-container-high)",
                borderRadius: "var(--radius-default)",
                padding: "16px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{readinessLabels[name] ?? name}</span>
                <StatusBadge value={item.state === "READY" ? "已就绪" : "未完成"} />
              </div>
              {detail.summary && <p style={{ fontSize: 13, fontWeight: 600, margin: "0 0 10px" }}>{detail.summary}</p>}
              {detail.rows.map(row => (
                <div key={row.label} style={{ display: "grid", gridTemplateColumns: "16px 1fr", columnGap: 6, fontSize: 12, marginTop: 6 }}>
                  <span aria-hidden="true">{row.configured ? "✓" : "○"}</span>
                  <span><strong>{row.label}</strong><br />{row.detail}</span>
                </div>
              ))}
              {detail.completion && <p style={{ fontSize: 12, color: item.state === "READY" ? "var(--success)" : "var(--muted-terracotta)", margin: "10px 0 0" }}>{detail.completion}</p>}
              {!detail.rows.length && item.missing.length > 0 && (
                <p style={{ fontSize: 12, color: "var(--muted-terracotta)", margin: "8px 0 0 0" }}>
                  需要配置 Provider 并完成所需执行路由。
                </p>
              )}
            </div>;
          })}
        </div>
      </section>

      {/* 2. Create Connection */}
      <section className="card-panel">
        <h2 className="section-title" style={{ marginBottom: 20 }}>
          添加 AI Provider
        </h2>
        <p style={{ color: "var(--on-surface-variant)", fontSize: 14, margin: "0 0 20px" }}>添加你自己的 AI Provider。API Key 会加密保存，之后不会再次显示明文。</p>
        <p style={{ color: "var(--on-surface-variant)", fontSize: 13, margin: "0 0 20px" }}>书籍理解可为分段、归并、综合和向量检索分别选择兼容的 Provider 与模型；混合组合仅作提示，不会阻止保存。</p>
        {bookProviderKeys.size > 1 && <p role="status" style={{ color: "var(--on-surface-variant)", fontSize: 13, margin: "0 0 20px" }}>当前书籍理解使用混合 Provider 组合。请确认各路由的模型、区域和向量维度符合你的工作区要求。</p>}
        <ConnectionForm providers={state.manifest.providers} busy={busy} submit={submit} />
      </section>

      {/* 3. Existing Connections */}
      <section className="card-panel">
        <h2 className="section-title" style={{ marginBottom: 20 }}>
          已配置 Provider
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {state.connections.map((connection) => (
            <div
              key={connection.id}
              style={{
                backgroundColor: "var(--surface-container)",
                border: "1px solid var(--surface-container-high)",
                borderRadius: "var(--radius-lg)",
                padding: "20px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div>
                  <h3 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 4px 0", color: "var(--on-surface)" }}>
                    {connection.displayName}
                  </h3>
                  <div style={{ fontSize: 12, color: "var(--outline)" }}>Provider: {connection.providerKey} · Endpoint: {connection.endpoint ?? "未配置"}{connection.region ? ` · ${connection.region}` : ""}</div>
                </div>
                <StatusBadge value={connection.status === "ACTIVE" ? "已启用" : "已停用"} />
              </div>

              <p style={{ fontSize: 13, color: "var(--on-surface-variant)", margin: "0 0 16px 0" }}>
                API Key: {connection.credential.exists ? `已配置 ${connection.credential.displayHint ?? ""}` : "未配置"}
              </p>

              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
                <CredentialRotation connectionId={connection.id} busy={busy} submit={submit} />
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit({ action: "AUTO_CONFIGURE_ROUTES", connectionId: connection.id })} style={{ height: 36, fontSize: 13 }}>填补未绑定的默认路由</button>

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
                  {connection.status === "ACTIVE" ? "停用 Provider" : "启用 Provider"}
                </button>
              </div>
            </div>
          ))}

          {!state.connections.length && <p style={{ color: "var(--outline)", margin: 0, fontSize: 14 }}>保存后，Provider 会显示在这里；随后可在下方配置执行路由。</p>}
        </div>
      </section>

      {/* Engineering controls remain available, but are intentionally hidden from the normal setup flow. */}
      <details className="card-panel">
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>高级设置</summary>
          <h2 className="section-title" style={{ marginBottom: 20 }}>
          配置用途
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {routeSlots.map(({ slot, label }) => (
            <RouteForm
              key={slot}
              slot={slot}
              slotLabel={label}
              connections={state.connections}
              providers={state.manifest.providers}
              existing={state.routes.find((route) => route.routeSlot === slot)}
              busy={busy}
              submit={submit}
            />
          ))}
        </div>
      </details>

      {message && (
        <p aria-live="polite" className="form-error">
          {message}
        </p>
      )}
    </div>
  );
}

function ConnectionForm({
  providers,
  busy,
  submit,
}: {
  providers: Provider[];
  busy: boolean;
  submit(payload: Record<string, unknown>): Promise<void>;
}) {
  const [providerKey, setProviderKey] = useState(providers[0]?.providerKey ?? "");
  const defaultEndpoints: Record<string, string> = { openai: "https://api.openai.com/v1/responses", anthropic: "https://api.anthropic.com/v1/messages", gemini: "https://generativelanguage.googleapis.com/v1beta", deepseek: "https://api.deepseek.com/chat/completions", zhipu: "https://open.bigmodel.cn/api/paas/v4/chat/completions", minimax: "https://api.minimax.io/v1/text/chatcompletion_v2" };
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [qwenRegion, setQwenRegion] = useState("BEIJING");
  const [qwenWorkspaceId, setQwenWorkspaceId] = useState("");
  const provider = providers.find((item) => item.providerKey === providerKey);
  const qwenEndpoint = `https://${qwenWorkspaceId}.${qwenRegion === "BEIJING" ? "cn-beijing" : "ap-southeast-1"}.maas.aliyuncs.com/compatible-mode/v1/chat/completions`;

  return (
    <form
      action={(form) =>
        void submit({
          action: "CREATE_CONNECTION_WITH_CREDENTIAL",
          providerKey,
          protocol: form.get("protocol"),
          displayName: form.get("displayName"),
          endpoint: providerKey === "qwen" ? qwenEndpoint : form.get("endpoint"),
          secret: form.get("secret"),
          region: form.get("region") || undefined,
          configuration: providerKey === "qwen" ? { ...parseConfiguration(form.get("configuration")), qwenRegion, qwenWorkspaceId } : parseConfiguration(form.get("configuration")),
        })
      }
      style={{ display: "grid", gap: 16, maxWidth: 640 }}
    >
      <div className="form-group">
        <label className="form-label">提供商 (Provider)</label>
        <select className="select-control" value={providerKey} onChange={(e) => { setProviderKey(e.target.value); const endpoint = document.querySelector<HTMLInputElement>('input[name="endpoint"]'); if (endpoint && defaultEndpoints[e.target.value]) endpoint.value = defaultEndpoints[e.target.value]; }}>
          {providers.map((p) => (
            <option value={p.providerKey} key={p.providerKey}>{p.displayName}</option>
          ))}
        </select>
      </div>

      <input type="hidden" name="protocol" value={provider?.protocol ?? ""} />

      <div className="form-group">
        <label className="form-label">名称</label>
        <input className="input-control" name="displayName" required maxLength={160} placeholder="例如：我的 DeepSeek" />
      </div>

      <div className="form-group">
        <label className="form-label">Base URL</label>
        <input className="input-control font-mono" name="endpoint" type="url" required readOnly={Boolean(defaultEndpoints[providerKey]) || providerKey === "qwen"} value={providerKey === "qwen" ? qwenEndpoint : undefined} defaultValue={providerKey === "qwen" ? undefined : defaultEndpoints[providerKey] ?? ""} placeholder="https://api.example.com/v1" />
      </div>

      {providerKey === "qwen" && <>
        <div className="form-group"><label className="form-label">百炼区域</label><select className="select-control" value={qwenRegion} onChange={event => setQwenRegion(event.target.value)}><option value="BEIJING">北京</option><option value="SINGAPORE">新加坡</option></select></div>
        <div className="form-group"><label className="form-label">百炼工作区 ID</label><input className="input-control" value={qwenWorkspaceId} onChange={event => setQwenWorkspaceId(event.target.value)} required pattern="[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9]|[A-Za-z0-9]" placeholder="workspace-id" /></div>
      </>}

      <div className="form-group">
        <label className="form-label">API Key</label>
        <input className="input-control" name="secret" type="password" autoComplete="new-password" required placeholder="输入 API Key" />
      </div>

      <div className="form-group">
        <label className="form-label">区域 (Region / 可选)</label>
        <input className="input-control" name="region" placeholder="例如: us-east-1" />
      </div>

      <div style={{ margin: "4px 0" }}>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setShowAdvanced(!showAdvanced)}
          style={{ height: 32, fontSize: 12 }}
        >
          {showAdvanced ? "隐藏高级配置 JSON" : "展开高级配置 JSON"}
        </button>
      </div>

      {showAdvanced && (
        <div className="form-group">
          <label className="form-label">安全配置 JSON</label>
          <textarea
            className="input-control font-mono"
            name="configuration"
            defaultValue="{}"
            rows={4}
            style={{ height: "auto", padding: 12 }}
          />
        </div>
      )}

      <div style={{ display: "flex", gap: 12 }}>
        <button type="button" className="btn btn-secondary" disabled={busy || !provider} onClick={(event) => { const form = event.currentTarget.form; if (!form || !form.reportValidity()) return; void submit({ action: "TEST_CONNECTION", providerKey, protocol: new FormData(form).get("protocol"), endpoint: new FormData(form).get("endpoint"), secret: new FormData(form).get("secret") }); }}>测试连接</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !provider}>{busy ? "保存中…" : "保存 Provider"}</button>
      </div>
    </form>
  );
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
  connections,
  providers,
  existing,
  busy,
  submit,
}: {
  slot: string;
  slotLabel: string;
  connections: Connection[];
  providers: Provider[];
  existing?: Route;
  busy: boolean;
  submit(payload: Record<string, unknown>): Promise<void>;
}) {
  const [selectedConnectionId, setSelectedConnectionId] = useState(existing?.connectionId ?? "");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [qwenRegion, setQwenRegion] = useState(String(existing?.configuration.qwenRegion ?? "BEIJING"));
  const [qwenWorkspaceId, setQwenWorkspaceId] = useState(String(existing?.configuration.qwenWorkspaceId ?? ""));
  const [qwenDimension, setQwenDimension] = useState(String(existing?.configuration.embeddingDimensions ?? 1024));
  const connectionId = connections.some((c) => c.id === selectedConnectionId) ? selectedConnectionId : existing?.connectionId ?? connections[0]?.id ?? "";
  const connection = connections.find((c) => c.id === connectionId);
  const provider = providers.find((p) => p.providerKey === connection?.providerKey);

  const capability = slot === "EMBEDDING" ? "EMBEDDING" : slot.endsWith("TTS") ? "SPEECH" : "TEXT_GENERATION";
  const models = provider?.models.filter((m) => m.families.includes(capability)) ?? [];

  return (
    <form
      action={(form) =>
        void submit({
          action: "SET_ROUTE",
          routeSlot: slot,
          connectionId,
          modelId: form.get("modelId"),
          configuration: connection?.providerKey === "qwen" ? { ...parseConfiguration(form.get("configuration")), qwenRegion, qwenWorkspaceId, ...(capability === "EMBEDDING" ? { embeddingDimensions: Number(qwenDimension) } : {}) } : parseConfiguration(form.get("configuration")),
        })
      }
      style={{
        backgroundColor: "var(--surface-container)",
        border: "1px solid var(--surface-container-high)",
        borderRadius: "var(--radius-lg)",
        padding: "20px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <h4 style={{ fontSize: 14, fontWeight: 600, color: "var(--on-surface)", margin: 0 }}>
          {slotLabel} ({slot})
        </h4>
        {existing && <StatusBadge value="已绑定" />}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <div className="form-group">
          <label className="form-label">连接 (Connection)</label>
          <select className="select-control" value={connectionId} onChange={(e) => setSelectedConnectionId(e.target.value)}>
            {connections.map((c) => (
              <option value={c.id} key={c.id}>
                {c.displayName} ({c.protocol})
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label className="form-label">模型</label>
          {connection?.providerKey === "openai-compatible" ? <input className="input-control" name="modelId" required defaultValue={existing?.modelId} placeholder="输入服务商提供的模型 ID" /> : <select className="select-control" name="modelId" defaultValue={existing?.modelId}>{models.map((m) => <option value={m.modelId} key={m.modelId}>{m.modelId}</option>)}</select>}
        </div>
      </div>

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
        保存路由
      </button>
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
