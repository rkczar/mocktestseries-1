"use client";

import { useEffect, useRef, useState } from "react";
import { formatStatNumber, withSuffix, type StatFormat } from "@/lib/homepage-stat-format";

const DURATION_MS = 1400;

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Counts a statistic up from zero the first time it scrolls into view.
 * The server-rendered HTML already holds the final value (SEO, no-JS), the
 * animation only runs when the browser allows motion, and screen readers
 * always get the final value instead of the intermediate frames.
 */
export function StatCountUp({ value, format, suffix }: { value: number; format: StatFormat; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [display, setDisplay] = useState(value);
  const finalText = withSuffix(formatStatNumber(value, format), suffix);

  useEffect(() => {
    const node = ref.current;
    if (!node || value < 10) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof IntersectionObserver === "undefined") return;

    let frame = 0;
    let seen = false;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        if (!entry.isIntersecting) {
          // Still off-screen: park at zero so the count-up is visible later.
          if (!seen) setDisplay(0);
          return;
        }
        if (seen) return;
        seen = true;
        observer.disconnect();
        const start = performance.now();
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / DURATION_MS);
          setDisplay(Math.round(value * easeOutCubic(t)));
          if (t < 1) frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      },
      { threshold: 0.4 }
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      setDisplay(value);
    };
  }, [value]);

  return (
    <span ref={ref}>
      <span aria-hidden>{withSuffix(formatStatNumber(display, format), suffix)}</span>
      <span className="sr-only">{finalText}</span>
    </span>
  );
}
