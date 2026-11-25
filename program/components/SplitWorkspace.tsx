"use client";

import { useLayoutEffect, useRef, type ComponentPropsWithoutRef } from "react";
import { fragmentTarget, historyEntry } from "./useWorkspaceScroll";
import "./split-workspace.css";

// A browser Back navigation can remount the workspace after its data has loaded.
const readingPositions = new Map<string, [number, number]>();

/** Keep both panes within the visible paper, including when notices or toolbars above them grow. */
export function SplitWorkspace({ className = "", ...props }: ComponentPropsWithoutRef<"div">) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const grid = ref.current;
    const paper = grid?.closest<HTMLElement>(".shell-paper");
    if (!grid || !paper) return;
    const header = paper.querySelector<HTMLElement>(".topbar");
    let frame = 0;
    const positionKey = () => JSON.stringify([historyEntry(), location.pathname, location.search, className]);
    let pending = readingPositions.get(positionKey())?.slice();
    let fragment = pending ? "" : location.hash;
    const content = new MutationObserver(schedule);
    if (pending || fragment) content.observe(grid, { childList: true, subtree: true });

    function stopRestoring() {
      pending = undefined;
      fragment = "";
      content.disconnect();
    }
    function scrollPane(column: Element) {
      return column.matches(".record-sidebar:not(:has(> .record-sidebar-tools))")
        ? column.querySelector(".record-sidebar-items") ?? column : column;
    }
    function remember(event: Event) {
      if (!grid?.hasAttribute("data-independent-scroll") || pending) return;
      const panes = Array.from(grid.children).slice(0, 2).map(scrollPane);
      if (panes.some(pane => pane === event.target)) readingPositions.set(positionKey(), [panes[0].scrollTop, panes[1].scrollTop]);
    }
    function measure() {
      frame = 0;
      if (!grid || !paper) return;
      const tracks = getComputedStyle(grid).gridTemplateColumns;
      const top = Math.max(grid.getBoundingClientRect().top, header?.getBoundingClientRect().bottom ?? 0);
      const bottom = Math.min(paper.getBoundingClientRect().bottom, document.documentElement.clientHeight);
      const height = Math.floor(bottom - top - 4);
      // A block below a long form stays in normal flow until it reaches the viewport.
      const enabled = tracks.split(" ").length === 2 && grid.childElementCount >= 2 && height >= 200;
      grid.toggleAttribute("data-independent-scroll", enabled);
      if (enabled) grid.style.setProperty("--split-available-height", height + "px");
      else grid.style.removeProperty("--split-available-height");
      if (enabled && pending) {
        const panes = Array.from(grid.children).slice(0, 2).map(scrollPane);
        const offsets = pending;
        panes.forEach((pane, index) => { pane.scrollTop = offsets[index]; });
        if (panes.every((pane, index) => Math.abs(pane.scrollTop - offsets[index]) <= 1)) stopRestoring();
      } else if (enabled && fragment) {
        const target = fragmentTarget(fragment);
        if (location.hash !== fragment || (target && !grid.contains(target))) stopRestoring();
        else if (target) {
          const targetTop = target.getBoundingClientRect().top;
          if (targetTop < top || targetTop > bottom - 44) {
            const column = Array.from(grid.children).find(pane => pane.contains(target));
            if (column) column.scrollTop += targetTop - top - 8;
          }
        }
      }
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(measure);
    }
    const resize = new ResizeObserver(schedule);
    // A sibling above the grid can resize even when the shell's own height stays fixed.
    for (let node: Element | null = grid; node && node !== paper; node = node.parentElement) {
      resize.observe(node);
      for (let before = node.previousElementSibling; before; before = before.previousElementSibling) resize.observe(before);
    }
    resize.observe(paper);
    measure();
    grid.addEventListener("scroll", remember, true);
    paper.addEventListener("wheel", stopRestoring, { passive: true });
    paper.addEventListener("pointerdown", stopRestoring);
    paper.addEventListener("keydown", stopRestoring);
    window.addEventListener("resize", schedule);
    paper.addEventListener("scroll", schedule, { passive: true });
    return () => {
      resize.disconnect();
      content.disconnect();
      cancelAnimationFrame(frame);
      grid.removeEventListener("scroll", remember, true);
      paper.removeEventListener("wheel", stopRestoring);
      paper.removeEventListener("pointerdown", stopRestoring);
      paper.removeEventListener("keydown", stopRestoring);
      paper.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [className]);
  return <div {...props} ref={ref} className={`workspace-split ${className}`} />;
}
