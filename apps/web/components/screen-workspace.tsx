"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/** Keep the application frame fixed and let only its bounded content region scroll. */
export function ScreenWorkspace({ children }: { children: React.ReactNode }) {
  const pathname = usePathname(), query = useSearchParams();
  return <WorkspaceContent key={`${pathname}?${query.toString()}`}>{children}</WorkspaceContent>;
}

function WorkspaceContent({ children }: { children: React.ReactNode }) {
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let observer: MutationObserver;
    const jumpToHash = () => {
      let id: string;
      try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
      if (!id) { observer.disconnect(); return; }
      const target = id ? document.getElementById(id) : null;
      if (target && region.current?.contains(target)) { target.scrollIntoView({ block: "start", behavior: "instant" }); observer.disconnect(); }
    };
    observer = new MutationObserver(jumpToHash);
    const onHash = () => { if (region.current) observer.observe(region.current, { childList: true, subtree: true }); jumpToHash(); };
    const frame = requestAnimationFrame(onHash);
    window.addEventListener("hashchange", onHash);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("hashchange", onHash); };
  }, []);
  return <div className="screen-workspace">
    <div ref={region} className="screen-viewport" role="region" aria-label="工作区内容" tabIndex={0}>
      <div className="screen-paper">{children}</div>
    </div>
  </div>;
}
