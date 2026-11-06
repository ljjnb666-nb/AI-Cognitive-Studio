"use client";

import { useId } from "react";

export function ModelPicker({ name, label = "模型", models, defaultValue, allowCustom = false, disabled = false }: { name: string; label?: string; models: readonly { modelId: string }[]; defaultValue?: string | null; allowCustom?: boolean; disabled?: boolean }) {
  const id = useId();
  const options = allowCustom ? models.filter(model => model.modelId !== "custom-model") : models;
  return <div className="form-group" style={{ minWidth: 0, marginBottom: 0 }}>
    <label className="form-label" htmlFor={id}>{label}</label>
    {allowCustom ? <>
      <input className="input-control" id={id} name={name} list={`${id}-models`} defaultValue={defaultValue ?? ""} disabled={disabled} required maxLength={200} pattern="[^\s]+" placeholder="选择或填写服务商提供的模型 ID" autoComplete="off" />
      <datalist id={`${id}-models`}>{options.map(model => <option key={model.modelId} value={model.modelId} />)}</datalist>
      <small className="muted">支持 OpenAI 兼容的文本模型；填写准确型号，不代表已验证可用。</small>
    </> : <select className="select-control" id={id} name={name} defaultValue={defaultValue ?? ""} disabled={disabled || !options.length} required>
      <option value="" disabled>{options.length ? "请选择模型" : "暂无兼容模型"}</option>
      {defaultValue && !options.some(model => model.modelId === defaultValue) && <option value={defaultValue} disabled>{defaultValue}（不在当前可选列表中）</option>}
      {options.map(model => <option key={model.modelId} value={model.modelId}>{model.modelId}</option>)}
    </select>}
  </div>;
}
