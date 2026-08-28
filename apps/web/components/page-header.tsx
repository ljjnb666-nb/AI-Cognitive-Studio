import React from "react";

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 32, gap: 16, flexWrap: "wrap" }}>
      <div>
        {eyebrow && <div className="page-eyebrow" style={{ marginBottom: 4 }}>{eyebrow}</div>}
        <h1 className="font-serif" style={{ fontSize: 32, fontWeight: 600, color: "var(--on-surface)", margin: 0 }}>
          {title}
        </h1>
        {description && <p style={{ color: "var(--on-surface-variant)", fontSize: 14, margin: "6px 0 0 0" }}>{description}</p>}
      </div>
      {(action || children) && <div style={{ display: "flex", gap: 12, alignItems: "center" }}>{action || children}</div>}
    </div>
  );
}
