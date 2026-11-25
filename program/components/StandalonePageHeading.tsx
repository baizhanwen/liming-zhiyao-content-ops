import type { ReactNode } from "react";
import "./standalone-page.css";

export function StandalonePageHeading({ title, actions }: { title: string; actions?: ReactNode }) {
  return <header className="standalone-heading">
    <h1 className="page-title">{title}</h1>
    {actions}
  </header>;
}
