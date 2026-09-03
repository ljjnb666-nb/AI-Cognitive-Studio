import Link from "next/link";

export function SettingsNavigation({ active }: { active: "account" | "providers" }) {
  return <nav className="settings-navigation" aria-label="设置导航"><Link href="/studio/settings/account" aria-current={active === "account" ? "page" : undefined}>账户</Link><Link href="/studio/settings/providers" aria-current={active === "providers" ? "page" : undefined}>Provider</Link></nav>;
}
