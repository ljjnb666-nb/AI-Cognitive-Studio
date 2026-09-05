export function BetaOnboardingChecklist({ items }: { items: readonly (readonly [string, boolean])[] }) {
  const completed = items.filter(([, done]) => done).length;
  return <section className="card-panel" aria-label="Closed Beta 入门清单" style={{ marginBottom: 32 }}><div className="section-header"><h2 className="section-title">Closed Beta 入门</h2><span className="font-mono" style={{ fontSize: 12 }}>{completed}/{items.length}</span></div><p className="page-desc">按自己的节奏体验；清单从真实产品活动自动更新。</p><ol style={{ margin: 0, paddingLeft: 20 }}>{items.map(([label, done]) => <li key={label} style={{ color: done ? "var(--primary)" : "var(--on-surface-variant)", marginTop: 8 }}>{done ? "✓ " : "○ "}{label}</li>)}</ol></section>;
}
