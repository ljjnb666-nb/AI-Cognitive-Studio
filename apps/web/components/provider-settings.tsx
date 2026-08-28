"use client";

import { useEffect, useState } from "react";
import { StatusBadge } from "./status-badge";

type Model = { modelId: string; families: string[]; speechFormats?: string[] };
type Provider = { providerKey: string; displayName: string; protocol: string; capabilityProtocols?: Record<string, string>; models: Model[] };
type Connection = { id: string; providerKey: string; protocol: string; displayName: string; endpoint: string | null; region: string | null; status: string; health: string; credential: { id?: string; exists: boolean; displayHint?: string | null; status?: string } };
type Route = { id: string; routeSlot: string; connectionId: string; modelId: string; configuration: Record<string, unknown>; connection: { displayName: string } };
type State = { manifest: { providers: Provider[] }; connections: Connection[]; routes: Route[]; readiness: Record<string, { state: string; missing: string[] }> };

const routeSlots = [
  { slot: "BOOK_CHUNK_ANALYSIS", label: "书籍切块分析 (BOOK_CHUNK_ANALYSIS)" },
  { slot: "BOOK_REDUCTION_ANALYSIS", label: "书籍归纳分析 (BOOK_REDUCTION_ANALYSIS)" },
  { slot: "BOOK_SYNTHESIS", label: "书籍综合理解 (BOOK_SYNTHESIS)" },
  { slot: "EMBEDDING", label: "向量嵌入 (EMBEDDING)" },
  { slot: "PODCAST_SCRIPT", label: "播客脚本生成 (PODCAST_SCRIPT)" },
  { slot: "PODCAST_TTS", label: "播客语音合成 (PODCAST_TTS)" },
  { slot: "SHORT_VIDEO_SCRIPT", label: "短视频脚本生成 (SHORT_VIDEO_SCRIPT)" },
  { slot: "SHORT_VIDEO_TTS", label: "短视频语音合成 (SHORT_VIDEO_TTS)" },
];

const readinessLabels: Record<string, string> = {
  book: "书籍理解",
  podcast: "播客生成",
  podcastAudio: "播客音频",
  shortVideo: "短视频生成",
};

export function ProviderSettings() {
  const [state, setState] = useState<State | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const response = await fetch("/api/studio/providers", { cache: "no-store" });
    const body = (await response.json()) as State & { error?: string };
    if (!response.ok) throw new Error(body.error ?? "PROVIDER_SETTINGS_LOAD_FAILED");
    setState(body);
  };

  useEffect(() => {
    queueMicrotask(() => void refresh().catch((error) => setMessage(error instanceof Error ? error.message : "PROVIDER_SETTINGS_LOAD_FAILED")));
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
      setState(body);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "PROVIDER_SETTINGS_SAVE_FAILED");
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      {/* 1. Readiness Group */}
      <section className="card-panel">
        <h2 className="section-title" style={{ marginBottom: 20 }}>
          服务可用性
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 16 }}>
          {Object.entries(state.readiness).map(([name, item]) => (
            <div
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
                <StatusBadge value={item.state === "READY" ? "理解完成" : "未准备就绪"} />
              </div>
              {item.missing.length > 0 && (
                <p style={{ fontSize: 12, color: "var(--muted-terracotta)", margin: "8px 0 0 0" }}>
                  缺失配置: {item.missing.join(", ")}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* 2. Create Connection */}
      <section className="card-panel">
        <h2 className="section-title" style={{ marginBottom: 20 }}>
          添加 AI Provider 连接
        </h2>
        <ConnectionForm providers={state.manifest.providers} busy={busy} submit={submit} />
      </section>

      {/* 3. Existing Connections */}
      <section className="card-panel">
        <h2 className="section-title" style={{ marginBottom: 20 }}>
          已保存的连接与密钥
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
                  <div className="font-mono" style={{ fontSize: 12, color: "var(--outline)" }}>
                    {connection.providerKey} · 协议: {connection.protocol}
                    {connection.endpoint ? ` · ${connection.endpoint}` : ""}
                    {connection.region ? ` (${connection.region})` : ""}
                  </div>
                </div>
                <StatusBadge value={connection.status === "ACTIVE" ? "已启用" : "已停用"} />
              </div>

              <p style={{ fontSize: 13, color: "var(--on-surface-variant)", margin: "0 0 16px 0" }}>
                密钥状态: {connection.credential.exists ? `已配置 (${connection.credential.displayHint ?? "密钥已加密"})` : "未配置密钥"}
              </p>

              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
                <form
                  style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 280 }}
                  action={(form) => void submit({ action: "SET_CREDENTIAL", connectionId: connection.id, secret: form.get("secret") })}
                >
                  <input
                    className="input-control"
                    name="secret"
                    type="password"
                    autoComplete="new-password"
                    placeholder="输入新的 API 密钥"
                    required
                    style={{ height: 36, fontSize: 13 }}
                  />
                  <button type="submit" className="btn btn-secondary" disabled={busy} style={{ height: 36, fontSize: 13 }}>
                    保存/轮换密钥
                  </button>
                </form>

                {connection.credential.id && connection.credential.status === "ACTIVE" && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() => void submit({ action: "REVOKE_CREDENTIAL", credentialVersionId: connection.credential.id })}
                    style={{ height: 36, fontSize: 13 }}
                  >
                    撤销密钥
                  </button>
                )}

                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => void submit({ action: "SET_ENABLED", connectionId: connection.id, enabled: connection.status !== "ACTIVE" })}
                  style={{ height: 36, fontSize: 13 }}
                >
                  {connection.status === "ACTIVE" ? "停用连接" : "启用连接"}
                </button>
              </div>
            </div>
          ))}

          {!state.connections.length && (
            <p style={{ color: "var(--outline)", margin: 0, fontSize: 14 }}>
              暂未添加 AI Provider 连接。
            </p>
          )}
        </div>
      </section>

      {/* 4. Route Bindings (All 8 Slots) */}
      <section className="card-panel">
        <h2 className="section-title" style={{ marginBottom: 20 }}>
          执行路由绑定 (All 8 Slots)
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
      </section>

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
  const [showAdvanced, setShowAdvanced] = useState(false);
  const provider = providers.find((item) => item.providerKey === providerKey);
  const protocols = provider ? [...new Set([provider.protocol, ...Object.values(provider.capabilityProtocols ?? {})])] : [];

  return (
    <form
      action={(form) =>
        void submit({
          action: "CREATE_CONNECTION",
          providerKey,
          protocol: form.get("protocol"),
          displayName: form.get("displayName"),
          endpoint: form.get("endpoint"),
          region: form.get("region") || undefined,
          configuration: parseConfiguration(form.get("configuration")),
        })
      }
      style={{ display: "grid", gap: 16, maxWidth: 640 }}
    >
      <div className="form-group">
        <label className="form-label">提供商 (Provider)</label>
        <select className="select-control" value={providerKey} onChange={(e) => setProviderKey(e.target.value)}>
          {providers.map((p) => (
            <option value={p.providerKey} key={p.providerKey}>
              {p.displayName} ({p.providerKey})
            </option>
          ))}
        </select>
      </div>

      <div className="form-group">
        <label className="form-label">协议 (Protocol)</label>
        <select className="select-control" name="protocol">
          {protocols.map((proto) => (
            <option value={proto} key={proto}>
              {proto}
            </option>
          ))}
        </select>
      </div>

      <div className="form-group">
        <label className="form-label">显示名称</label>
        <input className="input-control" name="displayName" required maxLength={160} placeholder="例如: 生产模型 Gateway" />
      </div>

      <div className="form-group">
        <label className="form-label">HTTPS 执行端点 (必填)</label>
        <input className="input-control font-mono" name="endpoint" type="url" required placeholder="https://api.example.com/v1" />
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

      <button type="submit" className="btn btn-primary" disabled={busy || !provider} style={{ justifySelf: "start" }}>
        {busy ? "创建中…" : "创建连接"}
      </button>
    </form>
  );
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
          configuration: parseConfiguration(form.get("configuration")),
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
          {slotLabel}
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
          <label className="form-label">模型 (Model ID)</label>
          <select className="select-control font-mono" name="modelId" defaultValue={existing?.modelId}>
            {models.map((m) => (
              <option value={m.modelId} key={m.modelId}>
                {m.modelId}
              </option>
            ))}
          </select>
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
