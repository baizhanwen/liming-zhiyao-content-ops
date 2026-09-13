"use client";

import { useEffect, useState } from "react";
import { scopedFetch } from "../../lib/client-scope";
import "./ecommerce.css";

/** Optional navigation only; the existing content workspace owns its scope. */
export function EcommerceEntry({ organizationId, projectId }: { organizationId: string; projectId: string }) {
  const [access, setAccess] = useState<{ enabled: boolean; canManage: boolean } | null>(null);
  useEffect(() => {
    if (!organizationId || !projectId) return;
    let active = true;
    const scope = { organizationId, projectId };
    (async () => {
      const response = await scopedFetch(`/api/ecommerce/settings?${new URLSearchParams(scope)}`, {}, scope);
      if (!response.ok) return;
      const data = await response.json() as { settings: { enabled: number }; canManage: boolean };
      if (active) setAccess({ enabled: Boolean(data.settings.enabled), canManage: data.canManage });
    })().catch(() => { /* An unavailable optional module cannot interrupt ordinary content. */ });
    return () => { active = false; };
  }, [organizationId, projectId]);
  if (!access || !access.enabled && !access.canManage) return null;
  return <nav className="ec-entry" aria-label="内容任务类型"><span aria-current="page">普通内容</span><a href={`/content/ecommerce?${new URLSearchParams({ organizationId, projectId })}`}>{access.enabled ? "电商素材" : "电商素材设置"}</a></nav>;
}
