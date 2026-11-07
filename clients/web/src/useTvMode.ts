import { useEffect, useState } from "react";

const STORAGE_KEY = "weave.tv_mode";

// UA substrings for Chrome-based Android TV/Google TV (the primary target —
// see useTvMode's own callers) plus Tizen/webOS/other smart-TV browsers,
// kept cheap to check even though they're not the primary target, since a
// false negative there just means falling back to the `?tv=1` override.
const TV_UA_PATTERNS = [
  /\bTizen\b/i,
  /\bWeb0S\b|\bwebOS\b/i,
  /\bGoogleTV\b/i,
  /\bCrKey\b/i,
  /\bAFT[A-Z]?\b/i, // Amazon Fire TV
  /\bSMART-TV\b|\bSmartTV\b/i,
  /\bBRAVIA\b/i,
  /\bHbbTV\b/i,
  /\bAndroid TV\b/i,
];

function detectTvUserAgent(): boolean {
  return TV_UA_PATTERNS.some((pattern) => pattern.test(navigator.userAgent));
}

// TV detection has no reliable single source of truth across the
// fragmented smart-TV browser landscape, so this layers two: a UA
// heuristic as the default, and an explicit `?tv=1`/`?tv=0` query param
// (persisted to localStorage, then stripped from the URL) as a guaranteed
// escape hatch independent of whether the heuristic matches a given
// device's exact browser string — the TV just needs to be launched with
// `?tv=1` once.
export function useTvMode(): boolean {
  const [isTv] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const override = params.get("tv");
    if (override === "1") {
      localStorage.setItem(STORAGE_KEY, "1");
      return true;
    }
    if (override === "0") {
      localStorage.removeItem(STORAGE_KEY);
      return false;
    }
    if (localStorage.getItem(STORAGE_KEY) === "1") return true;
    return detectTvUserAgent();
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("tv")) {
      params.delete("tv");
      const query = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (query ? `?${query}` : ""));
    }
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("tv-mode", isTv);
  }, [isTv]);

  return isTv;
}
