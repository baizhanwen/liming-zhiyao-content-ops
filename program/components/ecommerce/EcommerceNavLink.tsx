"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ShoppingBag } from "lucide-react";

type Access = { enabled: boolean; canManage: boolean };
// Presentation cache only. Every mount revalidates; API authorization remains authoritative.
const accessCache = new Map<string, Access>();
export function clearEcommerceNavigationCache() { accessCache.clear(); }

/** Mounted by user and scope; same-space navigation retains the last confirmed visibility. */
export function EcommerceNavLink({ userId, organizationId, projectId, active, pagePath }: { userId: string; organizationId: string; projectId: string; active: boolean; pagePath: string }) {
  const cacheKey = JSON.stringify([userId, organizationId, projectId]);
  const [access, setAccess] = useState<Access | null>(() => accessCache.get(cacheKey) ?? null);
  useEffect(() => {
    if (!userId || !organizationId || !projectId) return;
    let active = true;
    const controller = new AbortController();
    const scope = { organizationId, projectId };
    (async () => {
      // Navigation has its own lifecycle, independent of a workspace's loading/reset requests.
      const response = await fetch(`/api/ecommerce/settings?${new URLSearchParams(scope)}`, { signal: controller.signal });
      if (!active) return;
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        accessCache.delete(cacheKey); setAccess(null); return;
      }
      if (!response.ok) return;
      const data = await response.json() as { settings: { enabled: number }; canManage: boolean };
      if (active) {
        const next = { enabled: Boolean(data.settings.enabled), canManage: data.canManage };
        accessCache.set(cacheKey, next); setAccess(next);
      }
    })().catch(() => { /* An unavailable optional module cannot interrupt ordinary content. */ });
    return () => { active = false; controller.abort(); };
  }, [userId, organizationId, projectId, cacheKey, pagePath]);
  if (!access || !access.enabled && !access.canManage) return null;
  return <Link className={active ? "nav-item active" : "nav-item"} href={`/content/ecommerce?${new URLSearchParams({ organizationId, projectId })}`} aria-current={active ? "page" : undefined}><ShoppingBag className="nav-icon" aria-hidden="true" /><strong>电商中心</strong></Link>;
}
