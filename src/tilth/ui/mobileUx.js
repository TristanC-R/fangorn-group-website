import { useEffect, useRef, useState } from "react";

export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const mq = window.matchMedia(query);
    const apply = () => setMatches(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [query]);

  return matches;
}

export function useBringIntoView(enabled, options = {}) {
  const ref = useRef(null);
  const { focusSelector, delay = 60 } = options;

  useEffect(() => {
    if (!enabled) return undefined;
    const timer = window.setTimeout(() => {
      ref.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
      if (focusSelector) {
        ref.current?.querySelector?.(focusSelector)?.focus?.({ preventScroll: true });
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [delay, enabled, focusSelector]);

  return ref;
}
