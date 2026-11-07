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
  const [first, setFirst] = useState(props.existing?.candidates[0] ? keyOf(props.existing.candidates[0]) : "");
  const [second, setSecond] = useState(props.existing?.candidates[1] ? keyOf(props.existing.candidates[1]) : "");
  const [requestedEnabled, setRequestedEnabled] = useState(props.existing?.requestedEnabled ?? false);
  const [maxSwitches, setMaxSwitches] = useState(props.existing?.maxSwitches || 1);
  const candidates = [first,second].filter(Boolean).flatMap(value => {
    const choice=props.choices.find(item => keyOf(item) === value);
    return choice ? [{connectionId:choice.connectionId,modelId:choice.modelId,configuration:choice.configuration}] : [];
  });
  const invalid = (requestedEnabled && (!first || maxSwitches > candidates.length)) ||
    (second !== "" && first === "") || (first !== "" && first === second) ||
    candidates.length !== [first,second].filter(Boolean).length;
  return <div style={{ display:"grid", gap:12, marginTop:16 }}>
    {([1,2] as const).map(rank => <label className="form-label" key={rank}>
      第 {rank} 备用模型
      <select className="select-control" value={rank===1 ? first : second} disabled={props.busy}
        onChange={e => (rank===1 ? setFirst : setSecond)(e.target.value)}>
        <option value="">不配置</option>
        {props.choices.map(item => <option key={keyOf(item)} value={keyOf(item)}>
          {item.displayName} · {item.modelId}
        </option>)}
      </select>
    </label>)}
    <label className="form-label">最多跨模型切换次数
      <select className="select-control" value={maxSwitches} disabled={props.busy}
        onChange={e => setMaxSwitches(Number(e.target.value))}>
        <option value={1}>1 次</option><option value={2}>2 次</option>
      </select>
    </label>
    <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13}}>
      <input type="checkbox" checked={requestedEnabled} disabled={props.busy}
        onChange={e => setRequestedEnabled(e.target.checked)}/>
      记录未来启用此用途自动降级的意向（当前不会生效，也不构成付费授权）
    </label>
    <p className="muted" style={{fontSize:12,margin:0}}>
      {props.existing ? "配置版本 "+props.existing.revision+" · " : ""}
      自动切换执行：未启用。向量、TTS、视觉及独立审校还需专用兼容性和授权验收。
    </p>
    <button type="button" className="btn btn-secondary" disabled={props.busy || invalid}
      onClick={() => void props.submit({
        action:"SET_FAILOVER_PREFERENCE",routeSlot:props.routeSlot,requestedEnabled,
        maxSwitches:Math.min(maxSwitches,candidates.length),candidates,
        expectedRevision:props.existing?.revision ?? null,
      })}>保存备用模型方案（不执行调用）</button>
  </div>;
}
