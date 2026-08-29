export default function StudioLoading() {
  return (
    <div className="card-panel" aria-busy="true" aria-live="polite" style={{ minHeight: 180, padding: 24 }}>
      <div className="page-eyebrow">正在打开 Studio</div>
      <div className="section-title" style={{ marginTop: 12 }}>正在加载页面内容…</div>
    </div>
  );
}
