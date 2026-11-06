"use client";

export default function LibraryError({ reset }: { reset: () => void }) {
  return <section className="source-empty-state" role="alert">
    <h2>暂时无法读取书籍</h2>
    <p>书籍列表或处理状态加载失败，请检查本机服务后重试。</p>
    <button type="button" className="btn btn-secondary" onClick={reset}>重新加载</button>
  </section>;
}
