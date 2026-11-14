"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * Distraction-free exam mode helpers (Phase 10). Fullscreen is a browser feature the page can only ASK for, and
 * only inside a user gesture (a click / form submit) — so the request happens in the Start Test handler, and the
 * player offers an "Enter full screen" button whenever it is off. Nothing here touches answers, the timer or the
 * attempt: losing fullscreen (Esc, browser UI, a reload, iPhone Safari, a denied permission) never stops a test.
 */

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

export type FullscreenResult = "ok" | "denied" | "unsupported";

export function fullscreenSupported(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.documentElement as FsEl;
  return Boolean(document.fullscreenEnabled !== false && (el.requestFullscreen || el.webkitRequestFullscreen));
}

export function isFullscreen(): boolean {
  if (typeof document === "undefined") return false;
  const d = document as FsDoc;
  return Boolean(d.fullscreenElement ?? d.webkitFullscreenElement);
}

/** Call synchronously from a click/submit handler (user-gesture rule). Never throws. */
export function requestExamFullscreen(): Promise<FullscreenResult> {
  try {
    if (typeof document === "undefined") return Promise.resolve("unsupported");
    if (isFullscreen()) return Promise.resolve("ok");
    const el = document.documentElement as FsEl;
    if (el.requestFullscreen) return el.requestFullscreen({ navigationUI: "hide" }).then(() => "ok" as const, () => "denied" as const);
    if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
      return Promise.resolve("ok");
    }
  } catch {
    return Promise.resolve("denied");
  }
  return Promise.resolve("unsupported");
}

export function exitExamFullscreen(): void {
  try {
    const d = document as FsDoc;
    if (d.fullscreenElement && d.exitFullscreen) void d.exitFullscreen().catch(() => {});
    else if (d.webkitFullscreenElement && d.webkitExitFullscreen) void d.webkitExitFullscreen();
  } catch {
    // Leaving fullscreen is best-effort.
  }
}

/** Fullscreen state (follows Esc / browser exits via fullscreenchange); null until read on the client. */
export function useFullscreen(): boolean | null {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    const sync = () => setOn(isFullscreen());
    sync();
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);
  return on;
}

/** The instructions page's Start Test link: asks for fullscreen in the same click, then navigates as before. */
export function StartTestLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} onClick={() => void requestExamFullscreen()} data-testid="start-test-link">
      {children}
    </Link>
  );
}
