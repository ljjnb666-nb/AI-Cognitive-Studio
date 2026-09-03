"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Item = { href: string; label: string; icon: string; matches?: string[] };
const groups: Array<{ label: string; items: Item[] }> = [
  { label: "学习", items: [{ href: "/studio", label: "首页", icon: "home" }, { href: "/studio/library", label: "知识库", icon: "library" }] },
  { label: "理解", items: [{ href: "/studio/cognitions", label: "我的认知", icon: "cognition" }, { href: "/studio/thinking", label: "思考", icon: "thinking" }, { href: "/studio/mastery", label: "理解", icon: "mastery" }] },
  { label: "表达", items: [{ href: "/studio/podcasts", label: "播客", icon: "podcast" }, { href: "/studio/videos", label: "短视频", icon: "video" }] },
  { label: "系统", items: [{ href: "/studio/activity", label: "活动", icon: "activity" }, { href: "/studio/settings/account", label: "设置", icon: "settings" }] },
];
const mobile: Item[] = [groups[0]!.items[0]!, groups[0]!.items[1]!, { href: "/studio/cognitions", label: "认知", icon: "cognition", matches: ["/studio/cognitions", "/studio/thinking", "/studio/mastery"] }, { href: "/studio/podcasts", label: "表达", icon: "podcast", matches: ["/studio/podcasts", "/studio/videos"] }, { href: "/studio/settings/account", label: "更多", icon: "more", matches: ["/studio/activity", "/studio/settings"] }];
function active(pathname: string, href: string) { return href === "/studio" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`); }
function itemActive(pathname: string, item: Item) { return (item.matches ?? [item.href]).some((href) => active(pathname, href)); }
export function StudioNavigation({ mobile: isMobile = false }: { mobile?: boolean }) {
  const pathname = usePathname(); const items = isMobile ? mobile : groups.flatMap(group => group.items);
  if (isMobile) return <nav className="mobile-nav" aria-label="移动端主导航">{items.map(item => <NavLink key={item.href} item={item} active={itemActive(pathname, item)} mobile />)}</nav>;
  return <nav className="sidebar-nav" aria-label="主导航">{groups.map(group => <div className="nav-group" key={group.label}><p>{group.label}</p>{group.items.map(item => <NavLink key={item.href} item={item} active={active(pathname, item.href)} />)}</div>)}</nav>;
}
function NavLink({ item, active: isActive, mobile }: { item: Item; active: boolean; mobile?: boolean }) { return <Link href={item.href} aria-current={isActive ? "page" : undefined} className={`${mobile ? "mobile-nav-item" : "sidebar-nav-item"}${isActive ? " active" : ""}`}><NavIcon name={item.icon} /><span>{item.label}</span></Link>; }
function NavIcon({ name }: { name: string }) { const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8 }; if (name === "home") return <svg {...common}><path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M9 22v-8h6v8"/></svg>; if (name === "library") return <svg {...common}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/></svg>; if (name === "podcast") return <svg {...common}><rect x="7" y="2" width="10" height="14" rx="5"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8"/></svg>; if (name === "video") return <svg {...common}><rect x="2" y="5" width="15" height="14" rx="2"/><path d="m17 10 5-3v10l-5-3Z"/></svg>; if (name === "settings") return <svg {...common}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.1h-4v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1-2.8-2.8.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3v-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 2.8-2.8.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V3h4v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 2.8 2.8-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>; return <svg {...common}><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>; }
