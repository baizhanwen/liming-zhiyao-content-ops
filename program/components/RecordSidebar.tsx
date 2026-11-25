import type { ReactNode } from "react";
import "./record-sidebar.css";

type RecordSidebarProps = {
  title: string;
  count?: number;
  action?: ReactNode;
  tools?: ReactNode;
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
};

export function RecordSidebar({ title, count, action, tools, children, footer, className = "" }: RecordSidebarProps) {
  return (
    <aside aria-label={title} className={`record-sidebar ${className}`.trim()}>
      <header className="record-sidebar-head">
        <h2>{title}{count !== undefined && <span className="record-sidebar-count">{count}</span>}</h2>
        {action}
      </header>
      {tools && <div className="record-sidebar-tools">{tools}</div>}
      <div className="record-sidebar-items">{children}</div>
      {footer && <footer className="record-sidebar-footer">{footer}</footer>}
    </aside>
  );
}

type RecordSidebarItemProps = {
  title: string;
  version?: number;
  status?: ReactNode;
  meta?: ReactNode;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

export function RecordSidebarItem({ title, version, status, meta, selected, disabled, onSelect }: RecordSidebarItemProps) {
  return (
    <button type="button" className="record-sidebar-row" aria-current={selected || undefined} disabled={disabled} onClick={onSelect}>
      <span className="record-sidebar-row-head">
        <strong className="record-sidebar-title" title={title}>{title}</strong>
        {version !== undefined && <span className="record-sidebar-version">v{version}</span>}
      </span>
      {(status || meta) && <span className="record-sidebar-details">
        {status && <span className="record-sidebar-status">{status}</span>}
        {meta && <span className="record-sidebar-meta">{meta}</span>}
      </span>}
    </button>
  );
}
