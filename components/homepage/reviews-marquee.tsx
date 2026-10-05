"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Continuous, seamless review marquee. The cards are server-rendered (two
 * identical groups); this component only moves the track with
 * `transform: translate3d` from one requestAnimationFrame loop, wrapping by
 * exactly one group width so the loop never jumps.
 *
 * Pauses on mouse hover, keyboard focus inside, the Pause button, an
 * off-screen or hidden tab, and while a touch swipe is in progress (the
 * swipe moves the track by hand, then auto-scroll resumes). Under
 * prefers-reduced-motion it never animates: the CSS turns the viewport into
 * a normal horizontally scrollable row and hides the duplicate cards.
 */
export function ReviewsMarquee({
  header,
  children,
  animate,
  speedPx,
  direction,
  compact = false,
}: {
  header: ReactNode;
  children: ReactNode;
  animate: boolean;
  speedPx: number;
  direction: "RTL" | "LTR";
  /** Student Dashboard copy: no page gutter of its own, tighter spacing. */
  compact?: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [userPaused, setUserPaused] = useState(false);
  const userPausedRef = useRef(false);

  useEffect(() => {
    userPausedRef.current = userPaused;
  }, [userPaused]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!animate || !viewport || !track) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduced.matches) return;

    const group = track.firstElementChild as HTMLElement | null;
    let period = group?.offsetWidth ?? 0;
    const sign = direction === "RTL" ? -1 : 1;
    let x = direction === "RTL" ? 0 : -period;
    let hovering = false;
    let focused = false;
    let visible = true;
    let dragging = false;
    let dragX = 0;
    let resumeAt = 0;
    let last = performance.now();
    let frame = 0;

    const wrap = () => {
      if (period <= 0) return;
      while (x <= -period) x += period;
      while (x > 0) x -= period;
    };
    const paint = () => {
      track.style.transform = `translate3d(${x}px,0,0)`;
    };

    const tick = (now: number) => {
      // rAF timestamps can precede `last` on the first frame: never step backwards.
      const dt = Math.min(Math.max(now - last, 0), 100) / 1000;
      last = now;
      const paused = hovering || focused || dragging || !visible || userPausedRef.current || now < resumeAt || document.hidden;
      if (!paused) {
        x += sign * speedPx * dt;
        wrap();
        paint();
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    const onEnter = (e: PointerEvent) => {
      if (e.pointerType === "mouse") hovering = true;
    };
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType === "mouse") hovering = false;
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      dragging = true;
      dragX = e.clientX;
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      x += e.clientX - dragX;
      dragX = e.clientX;
      wrap();
      paint();
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      resumeAt = performance.now() + 2500;
    };
    // Keyboard focus on a card: stop and bring that card fully into view.
    const onFocusIn = (e: FocusEvent) => {
      focused = true;
      const card = (e.target as HTMLElement).closest<HTMLElement>("[data-review-card]");
      if (!card) return;
      const left = card.offsetLeft + x;
      const right = left + card.offsetWidth;
      if (left < 16 || right > viewport.clientWidth - 16) {
        x = -card.offsetLeft + 16;
        wrap();
        paint();
      }
    };
    const onFocusOut = (e: FocusEvent) => {
      if (!viewport.contains(e.relatedTarget as Node | null)) focused = false;
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
    });
    const resize = new ResizeObserver(() => {
      period = group?.offsetWidth ?? 0;
      wrap();
      paint();
    });
    const onReducedChange = () => {
      if (reduced.matches) {
        cancelAnimationFrame(frame);
        track.style.transform = "";
      }
    };

    viewport.addEventListener("pointerenter", onEnter);
    viewport.addEventListener("pointerleave", onLeave);
    viewport.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    viewport.addEventListener("focusin", onFocusIn);
    viewport.addEventListener("focusout", onFocusOut);
    reduced.addEventListener("change", onReducedChange);
    observer.observe(viewport);
    if (group) resize.observe(group);
    paint();

    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("pointerenter", onEnter);
      viewport.removeEventListener("pointerleave", onLeave);
      viewport.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      viewport.removeEventListener("focusin", onFocusIn);
      viewport.removeEventListener("focusout", onFocusOut);
      reduced.removeEventListener("change", onReducedChange);
      observer.disconnect();
      resize.disconnect();
      track.style.transform = "";
    };
  }, [animate, speedPx, direction]);

  return (
    <>
      <div className={compact ? "flex items-center justify-between gap-3" : "mx-auto flex w-full max-w-6xl items-end justify-between gap-4 px-4 sm:px-6"}>
        {header}
        {animate ? (
          <button
            type="button"
            onClick={() => setUserPaused((p) => !p)}
            aria-pressed={userPaused}
            aria-label={userPaused ? "Play reviews auto-scroll" : "Pause reviews auto-scroll"}
            className={`${compact ? "h-8 w-8" : "h-9 w-9"} inline-flex shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-muted-foreground)] transition-colors hover:text-[var(--color-foreground)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] motion-reduce:hidden`}
          >
            {userPaused ? <Play className="h-4 w-4" aria-hidden /> : <Pause className="h-4 w-4" aria-hidden />}
          </button>
        ) : null}
      </div>
      <div
        ref={viewportRef}
        className={cn(
          compact ? "mt-3" : "mt-8 sm:mt-10",
          animate
            ? "overflow-hidden [touch-action:pan-y] [mask-image:linear-gradient(to_right,transparent,#000_4%,#000_96%,transparent)] motion-reduce:snap-x motion-reduce:snap-mandatory motion-reduce:overflow-x-auto motion-reduce:[mask-image:none] motion-reduce:[touch-action:auto]"
            : "snap-x snap-mandatory overflow-x-auto"
        )}
      >
        <div
          ref={trackRef}
          className={cn("relative flex w-max will-change-transform motion-reduce:will-change-auto", compact ? "pl-0" : "pl-4 sm:pl-6")}
        >
          {children}
        </div>
      </div>
    </>
  );
}
