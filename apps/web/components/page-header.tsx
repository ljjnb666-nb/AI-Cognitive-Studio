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
    <div className="page-header">
      <div>
        {eyebrow && <div className="page-eyebrow">{eyebrow}</div>}
        <h1 className="page-title">
          {title}
        </h1>
        {description && <p className="page-desc">{description}</p>}
      </div>
      {(action || children) && <div className="page-header-actions">{action || children}</div>}
    </div>
  );
}
