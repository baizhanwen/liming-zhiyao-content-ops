"use client";

import { useEffect } from "react";
import { loadClientOrganizations } from "../lib/client-scope";
import { isScopeCancellation } from "../lib/client-scope-request";

export function useWorkspaceInitialization<T extends { id: string }>(input: {
  initialOrganizationId: string; initialProjectId: string;
  setOrganizations: (items: T[]) => void; setOrganizationId: (id: string) => void;
  loadProjects: (organizationId: string, projectId: string) => Promise<void>;
  setError: (message: string) => void; setLoading: (loading: boolean) => void;
  failureMessage?: string;
}) {
  const { initialOrganizationId, initialProjectId, setOrganizations, setOrganizationId, loadProjects, setError, setLoading, failureMessage = "加载失败" } = input;
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const body = await loadClientOrganizations<T>(initialOrganizationId);
        if (!active) return;
        setOrganizations(body.organizations);
        setOrganizationId(body.selected);
        if (body.selected) await loadProjects(body.selected, initialProjectId);
      } catch (reason) {
        if (active && !isScopeCancellation(reason)) setError(reason instanceof Error ? reason.message : failureMessage);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [initialOrganizationId, initialProjectId, setOrganizations, setOrganizationId, loadProjects, setError, setLoading, failureMessage]);
}
