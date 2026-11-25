"use client";

import type { ComponentProps, ReactNode } from "react";
import Link from "next/link";
import { useContext } from "react";
import { NavigationScope, scopedNavigationHref } from "./AppShell";

type ModuleTab = {
  href: string;
  label: string;
  active: boolean;
};

export function ModuleLink({ href, ...props }: Omit<ComponentProps<typeof Link>, "href"> & { href: string }) {
  const scope = useContext(NavigationScope);
  return <Link {...props} href={scopedNavigationHref(href, scope)} />;
}

export function ModuleHeader({ title, titleHint, tabs, actions }: {
  title: string;
  titleHint?: string;
  tabs?: ModuleTab[];
  actions?: ReactNode;
}) {
  return (
    <header className="module-header">
      <div className="module-heading">
        <h1 className="page-title" title={titleHint}>{title}</h1>
        {actions && <div className="module-heading-actions">{actions}</div>}
      </div>
      {tabs?.length ? (
        <nav className="module-tabs" aria-label={`${title}视图`}>
          {tabs.map(({ href, label, active }) => (
            <ModuleLink key={href} href={href} aria-current={active ? "page" : undefined}>
              {label}
            </ModuleLink>
          ))}
        </nav>
      ) : null}
    </header>
  );
}
