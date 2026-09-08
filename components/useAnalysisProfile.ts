"use client";

import { useSyncExternalStore } from "react";
import type { AnalysisProfile } from "../lib/analysis-profile";

const key = "liming.analysisProfile.v1";
const changeEvent = "liming-analysis-profile-change";
let memoryPreference: AnalysisProfile | null = null;

function readPreference(): AnalysisProfile | null {
  try {
    const saved = window.localStorage.getItem(key);
    return saved === "standard" || saved === "max" ? saved : memoryPreference;
  } catch { return memoryPreference; }
}

function subscribe(notify: () => void) {
  window.addEventListener("storage", notify);
  window.addEventListener(changeEvent, notify);
  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener(changeEvent, notify);
  };
}

function updatePreference(profile: AnalysisProfile) {
  memoryPreference = profile;
  try { window.localStorage.setItem(key, profile); } catch { /* Keep this tab usable when browser storage is disabled. */ }
  window.dispatchEvent(new Event(changeEvent));
}

export function useAnalysisProfile(fallback: AnalysisProfile = "standard") {
  const saved = useSyncExternalStore(subscribe, readPreference, () => null);
  return [saved ?? fallback, updatePreference] as const;
}
