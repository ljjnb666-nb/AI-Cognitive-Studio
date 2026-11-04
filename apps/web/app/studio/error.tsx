"use client";

export default function StudioError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <section className="card-panel" role="alert"><h2>暂时无法加载</h2><p>数据读取失败。请检查连接后重试。</p><button className="btn btn-primary" onClick={retry}>重新加载</button></section>;
}
