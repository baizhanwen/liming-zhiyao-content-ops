"use client";

import { useLayoutEffect, useRef } from "react";
import { usePathname } from "next/navigation";

// Separate visits to the same URL can have different reading positions.
const positions = new Map<string, number>();
export function historyEntry() {
  const navigation = (window as Window & { navigation?: { currentEntry?: { key: string } } }).navigation;
  return navigation?.currentEntry?.key ?? String(history.state?.__vinext_historyIndex ?? location.href);
}

export function fragmentTarget(hash: string) {
  let id = hash.slice(1);
  try { id = decodeURIComponent(id); } catch { /* A literal percent can be part of an id. */ }
  return document.getElementById(id) ?? document.getElementsByName(id)[0];
}

function trackScroll(panel: HTMLDivElement, workspace: HTMLElement, pathname: string, search: string) {
  const desktop = matchMedia("screen and (min-width: 621px)");
  let active = true;
  let entry = "";
  let retry: (() => boolean) | undefined;
  const resize = new ResizeObserver(restore);
  const mutations = new MutationObserver(restore);

  function stopWaiting() {
    retry = undefined;
    resize.disconnect();
    mutations.disconnect();
  }
  function restore() {
    if (retry?.()) stopWaiting();
  }
  function routeMatches() {
    return pathname === location.pathname && search === new URLSearchParams(location.search).toString();
  }
  function enter() {
    if (!active || !desktop.matches || !routeMatches()) return;
    const key = historyEntry();
    if (entry === key) return;
    entry = key;
    stopWaiting();
    const top = positions.get(key);
    const hash = location.hash;
    if (top !== undefined || !hash || hash === "#top") {
      const offset = top ?? 0;
      retry = () => {
        panel.scrollTop = offset;
        return Math.abs(panel.scrollTop - offset) <= 1;
      };
      resize.observe(workspace);
      restore();
    } else {
      retry = () => {
        const target = fragmentTarget(hash);
        if (!target || !panel.contains(target)) return false;
        target.scrollIntoView({ block: "start", behavior: "instant" });
        return true;
      };
      mutations.observe(workspace, { subtree: true, childList: true });
      restore();
    }
  }
  function afterCommit() {
    // The router writes its history entry during React's layout commit.
    queueMicrotask(enter);
  }
  function remember() {
    if (!desktop.matches || !routeMatches()) return;
    if (entry !== historyEntry()) enter(); // Hash-only links can use pushState.
    if (entry && !retry) positions.set(entry, panel.scrollTop);
  }
  function onMediaChange() {
    if (desktop.matches) afterCommit();
    else { stopWaiting(); entry = ""; }
  }
  afterCommit();
  panel.addEventListener("scroll", remember, { passive: true });
  panel.addEventListener("wheel", stopWaiting, { passive: true });
  panel.addEventListener("touchstart", stopWaiting, { passive: true });
  panel.addEventListener("keydown", stopWaiting);
  desktop.addEventListener("change", onMediaChange);
  window.addEventListener("hashchange", afterCommit);
  window.addEventListener("popstate", afterCommit);
  return () => {
    active = false;
    stopWaiting();
    panel.removeEventListener("scroll", remember);
    panel.removeEventListener("wheel", stopWaiting);
    panel.removeEventListener("touchstart", stopWaiting);
    panel.removeEventListener("keydown", stopWaiting);
    desktop.removeEventListener("change", onMediaChange);
    window.removeEventListener("hashchange", afterCommit);
    window.removeEventListener("popstate", afterCommit);
  };
}

export function useWorkspaceScroll(search: string) {
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = ref.current;
    const workspace = panel?.querySelector<HTMLElement>(".workspace");
    if (panel && workspace) return trackScroll(panel, workspace, pathname, search);
  }, [pathname, search]);
  return ref;
}
