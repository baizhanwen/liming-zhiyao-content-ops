"use client";
import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { scopeChangeEvent } from "../lib/client-scope";
import { NavigationScope, scopedNavigationHref } from "./AppShell";
import { ModuleHeader } from "./ModuleHeader";

type Scope = { organizationId: string; projectId: string };
export type InsightsView = "overview" | "reports" | "imports" | "matches" | "performance";

export function InsightsHeader({ view, initialScope }: { view: InsightsView; initialScope: Scope }) {
  const [scope, setScope] = useState(initialScope);
  useEffect(() => {
    function onScopeChange(event: Event) {
      const next = (event as CustomEvent<Scope>).detail;
      if (next?.organizationId) setScope(next);
    }
    window.addEventListener(scopeChangeEvent, onScopeChange);
    return () => window.removeEventListener(scopeChangeEvent, onScopeChange);
  }, []);

  return <NavigationScope.Provider value={scope}>
    <ModuleHeader title="数据报告" actions={
      <a className="secondary-button link-button" href="https://creator.douyin.com/creator-micro/data/stats/overview"
        target="_blank" rel="noopener noreferrer">
        打开抖音数据后台<ExternalLink aria-hidden="true" /><span className="sr-only">（在新标签页打开）</span>
      </a>
    } tabs={[
      { href: scopedNavigationHref("/insights?view=overview", scope), label: "数据概览", active: view === "overview" },
      { href: scopedNavigationHref("/insights?view=reports", scope), label: "周期报告", active: view !== "overview" },
    ]} />
  </NavigationScope.Provider>;
}
