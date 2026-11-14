"use client";

import { useState } from "react";

export type FailoverChoice = {
  routeSlot: string; connectionId: string; modelId: string; providerKey: string;
  displayName: string; configuration: Record<string, unknown>;
};
export type FailoverPreference = {
  routeSlot: string; requestedEnabled: boolean; maxSwitches: number;
  candidates: { connectionId: string; modelId: string; configuration: Record<string, unknown> }[];
  revision: number; preferenceHash: string; executionEnabled: false;
};
const keyOf = (item: Pick<FailoverChoice, "connectionId" | "modelId">) =>
  JSON.stringify([item.connectionId, item.modelId]);

type SavedCandidate = FailoverPreference["candidates"][number];

/** A persisted custom model uses the connection's placeholder only as a UI choice. */
export function selectedFailoverChoiceKey(candidate: SavedCandidate, choices: readonly FailoverChoice[]): string {
  const exact = choices.find(choice => keyOf(choice) === keyOf(candidate));
  if (exact) return keyOf(exact);
  const custom = choices.find(choice =>
    choice.connectionId === candidate.connectionId &&
    choice.providerKey === "openai-compatible" && choice.modelId === "custom-model");
  return custom ? keyOf(custom) : keyOf(candidate);
}

/** Preserve the saved configuration when merely changing the enabled intent or order. */
export function candidateFromFailoverChoice(
  selection: string,
  customModelId: string,
  choices: readonly FailoverChoice[],
  previous: readonly SavedCandidate[] = [],
): SavedCandidate | null {
  const choice = choices.find(item => keyOf(item) === selection);
  if (!choice) return null;
  const isCustom = choice.providerKey === "openai-compatible" && choice.modelId === "custom-model";
  const modelId = isCustom ? customModelId.trim() : choice.modelId;
  if (!modelId || modelId === "custom-model" || modelId.length > 200 || /\s/u.test(modelId)) return null;
  const saved = previous.find(candidate => candidate.connectionId === choice.connectionId && candidate.modelId === modelId);
  return {
    connectionId: choice.connectionId,
    modelId,
    configuration: saved?.configuration ?? choice.configuration,
  };
}

export function FailoverPreferencesEditor(props: {
  preferences: FailoverPreference[]; choices: FailoverChoice[]; busy: boolean;
  submit(payload: Record<string, unknown>): Promise<void>;
  routeSlots: { slot: string; label: string }[];
}) {
  const [routeSlot, setRouteSlot] = useState("BOOK_CHUNK_ANALYSIS");
  const existing = props.preferences.find(pref => pref.routeSlot === routeSlot);
  return <details className="card-panel" style={{ marginTop: 16 }}>
    <summary style={{ cursor: "pointer", fontWeight: 600 }}>备用模型顺序（预配置）</summary>
    <p className="muted" style={{ marginTop: 12 }}>
      按用途保存备用顺序。当前只保存意向，不自动调用备用模型或产生费用。
      未来实际启用需要 Worker 接线、独立预算授权和账单对账。
    </p>
    <label className="form-label">用途
      <select className="select-control" value={routeSlot}
        onChange={event => setRouteSlot(event.target.value)}>
        {props.routeSlots.map(item => <option key={item.slot} value={item.slot}>{item.label}</option>)}
      </select>
    </label>
    <FailoverSlotEditor key={routeSlot + ":" + (existing?.revision ?? 0)}
      routeSlot={routeSlot} existing={existing}
      choices={props.choices.filter(choice => choice.routeSlot === routeSlot)}
      busy={props.busy} submit={props.submit}/>
  </details>;
}

function FailoverSlotEditor(props: {
  routeSlot: string; existing?: FailoverPreference; choices: FailoverChoice[];
  busy: boolean; submit(payload: Record<string, unknown>): Promise<void>;
}) {
  const savedCandidates = props.existing?.candidates ?? [];
  const [first, setFirst] = useState(savedCandidates[0] ? selectedFailoverChoiceKey(savedCandidates[0], props.choices) : "");
  const [second, setSecond] = useState(savedCandidates[1] ? selectedFailoverChoiceKey(savedCandidates[1], props.choices) : "");
  const [firstCustomModel, setFirstCustomModel] = useState(savedCandidates[0]?.modelId ?? "");
  const [secondCustomModel, setSecondCustomModel] = useState(savedCandidates[1]?.modelId ?? "");
  const [requestedEnabled, setRequestedEnabled] = useState(props.existing?.requestedEnabled ?? false);
  const [maxSwitches, setMaxSwitches] = useState(props.existing?.maxSwitches || 1);

  const chosen = [first, second] as const;
  const resolved = [
    first ? candidateFromFailoverChoice(first, firstCustomModel, props.choices, savedCandidates) : null,
    second ? candidateFromFailoverChoice(second, secondCustomModel, props.choices, savedCandidates) : null,
  ];
  const candidates = resolved.filter((item): item is SavedCandidate => item !== null);
  const sameProviderModel = candidates.length === 2 && (() => {
    const provider = (connectionId: string) => props.choices.find(choice => choice.connectionId === connectionId)?.providerKey;
    return provider(candidates[0]!.connectionId) === provider(candidates[1]!.connectionId)
      && candidates[0]!.modelId === candidates[1]!.modelId;
  })();
  const invalid = (requestedEnabled && (!first || maxSwitches > candidates.length)) ||
    (second !== "" && first === "") || sameProviderModel ||
    candidates.length !== chosen.filter(Boolean).length;

  const choose = (rank: 1 | 2, value: string) => {
    const choice = props.choices.find(item => keyOf(item) === value);
    const saved = savedCandidates[rank - 1];
    const savedCustomId = choice?.providerKey === "openai-compatible" && choice.modelId === "custom-model"
      && saved?.connectionId === choice.connectionId ? saved.modelId : "";
    if (rank === 1) { setFirst(value); setFirstCustomModel(savedCustomId); }
    else { setSecond(value); setSecondCustomModel(savedCustomId); }
  };

  return <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
    {([1, 2] as const).map(rank => {
      const value = rank === 1 ? first : second;
      const choice = props.choices.find(item => keyOf(item) === value);
      const isCustom = choice?.providerKey === "openai-compatible" && choice.modelId === "custom-model";
      return <div key={rank}>
        <label className="form-label">第 {rank} 备用模型
          <select className="select-control" value={value} disabled={props.busy}
            onChange={event => choose(rank, event.target.value)}>
            <option value="">不配置</option>
            {props.choices.map(item => <option key={keyOf(item)} value={keyOf(item)}>
              {item.displayName} · {item.providerKey === "openai-compatible" && item.modelId === "custom-model" ? "自定义模型 ID" : item.modelId}
            </option>)}
          </select>
        </label>
        {isCustom && <label className="form-label" style={{ marginTop: 8 }}>
          实际模型 ID（非 custom-model 占位符）
          <input className="input-control" type="text" maxLength={200} required
            placeholder="填写 OpenAI 兼容端点实际支持的模型 ID"
            autoComplete="off" disabled={props.busy}
            value={rank === 1 ? firstCustomModel : secondCustomModel}
            onChange={event => (rank === 1 ? setFirstCustomModel : setSecondCustomModel)(event.target.value)}/>
        </label>}
      </div>;
    })}
    <label className="form-label">最多跨模型切换次数
      <select className="select-control" value={maxSwitches} disabled={props.busy}
        onChange={event => setMaxSwitches(Number(event.target.value))}>
        <option value={1}>1 次</option><option value={2}>2 次</option>
      </select>
    </label>
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
      <input type="checkbox" checked={requestedEnabled} disabled={props.busy}
        onChange={event => setRequestedEnabled(event.target.checked)}/>
      记录未来启用此用途自动降级的意向（当前不会生效，也不构成付费授权）
    </label>
    <p className="muted" style={{ fontSize: 12, margin: 0 }}>
      {props.existing ? "配置版本 " + props.existing.revision + " · " : ""}
      自动切换执行：未启用。向量、TTS、视觉及独立审校还需专用兼容性和授权验收。
    </p>
    <button type="button" className="btn btn-secondary" disabled={props.busy || invalid}
      onClick={() => void props.submit({
        action: "SET_FAILOVER_PREFERENCE", routeSlot: props.routeSlot, requestedEnabled,
        maxSwitches: Math.min(maxSwitches, candidates.length), candidates,
        expectedRevision: props.existing?.revision ?? null,
      })}>保存备用模型方案（不执行调用）</button>
  </div>;
}
