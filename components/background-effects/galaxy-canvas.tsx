"use client";

import { useEffect, useRef } from "react";
import { BG_WORDMARK } from "@/lib/background-effects";

export interface GalaxyCanvasProps {
  /** Desktop upper limit; fewer are used when the wordmark needs fewer. */
  particles: number;
  /** Phone (< 640px wide) upper limit. */
  mobileParticles: number;
  durationMs: number;
  /** Background opacity (0.01–0.2) — the strength of the finished wordmark. */
  opacity: number;
  dotSize: number;
  dotColors: { dark: string; light: string };
  glowColors: { dark: string; light: string };
  /** null = glow-free mode. */
  glow: { intensity: number; spread: number; trail: boolean } | null;
  /** Vertical center of the wordmark, 0–1. */
  position: number;
  /** Wordmark width as a share of the canvas width. */
  scale: number;
  mode: "auto" | "dark" | "light";
}

type Particle = { sx: number; sy: number; tx: number; ty: number; delay: number; curve: number; tint: number };

const SILVER = "#C8D0DC";
const BLUE = "#7AA2FF";
const MOBILE_BREAKPOINT = 640;
const SPREAD_TIME = 0.35; // share of the duration over which particle starts are staggered

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Evenly spaced points inside the wordmark, drawn once on an offscreen canvas. */
function wordmarkTargets(w: number, h: number, max: number, position: number, scale: number): Array<[number, number]> {
  const off = document.createElement("canvas");
  off.width = Math.max(1, Math.floor(w));
  off.height = Math.max(1, Math.floor(h));
  const ctx = off.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];
  const lines = w < MOBILE_BREAKPOINT ? ["MockTest", "Series.in"] : [BG_WORDMARK];
  const font = (px: number) => `900 ${px}px "Arial Black","Helvetica Neue",Arial,Helvetica,sans-serif`;
  ctx.font = font(100);
  const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const targetWidth = w * (w < MOBILE_BREAKPOINT ? Math.min(0.94, scale + 0.08) : scale);
  const px = Math.min((100 * targetWidth) / widest, (h * 0.8) / (lines.length * 1.1));
  ctx.font = font(px);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lineH = px * 1.1;
  const cy = Math.min(h - (lineH * lines.length) / 2, Math.max((lineH * lines.length) / 2, h * position));
  lines.forEach((l, i) => ctx.fillText(l, w / 2, cy + (i - (lines.length - 1) / 2) * lineH));
  const data = ctx.getImageData(0, 0, off.width, off.height).data;
  const inside = (x: number, y: number) => data[(Math.floor(y) * off.width + Math.floor(x)) * 4 + 3] > 128;

  // Grow the grid step until the point count fits the budget: even spacing
  // keeps the letters readable, unlike random sampling.
  let filled = 0;
  for (let y = 0; y < off.height; y += 2) for (let x = 0; x < off.width; x += 2) if (inside(x, y)) filled += 4;
  let step = Math.max(3, Math.floor(Math.sqrt(filled / Math.max(1, max))));
  for (;;) {
    const pts: Array<[number, number]> = [];
    for (let y = step / 2; y < off.height; y += step) for (let x = step / 2; x < off.width; x += step) if (inside(x, y)) pts.push([x, y]);
    if (pts.length <= max || step > 64) return pts.slice(0, max);
    step += 1;
  }
}

function haloSprite(color: string, size: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = size * 2;
  const g = c.getContext("2d");
  if (g) {
    const grad = g.createRadialGradient(size, size, 0, size, size, size);
    grad.addColorStop(0, color);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, size * 2, size * 2);
  }
  return c;
}

/**
 * Galaxy Particle Formation: scattered white / silver / blue particles glide
 * into the MockTestSeries.in wordmark once, then everything stops and the
 * finished wordmark stays as a still dotted watermark. One rAF loop for the
 * duration only; paused while the tab is hidden; torn down on unmount.
 * Halos are one pre-rendered sprite drawn per particle (no per-particle blur).
 */
export default function GalaxyCanvas(props: GalaxyCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const p = props;
    const host = canvas.parentElement as HTMLElement;

    let width = 0;
    let height = 0;
    let particles: Particle[] = [];
    let raf = 0;
    let startedAt = 0;
    let elapsedBeforePause = 0;
    let done = false;

    const isLight = () => (p.mode === "auto" ? document.documentElement.dataset.theme === "light" : p.mode === "light");
    let palette = { dot: "", glow: "", halo: null as HTMLCanvasElement | null };
    const buildPalette = () => {
      const light = isLight();
      const dot = light ? p.dotColors.light : p.dotColors.dark;
      const glow = light ? p.glowColors.light : p.glowColors.dark;
      palette = { dot, glow, halo: p.glow ? haloSprite(glow, 32) : null };
    };
    const tints = () => (isLight() ? [palette.dot, "#64748B", "#1D4ED8"] : [palette.dot, SILVER, BLUE]);

    const layout = () => {
      const rect = host.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const max = width < MOBILE_BREAKPOINT ? p.mobileParticles : p.particles;
      const targets = wordmarkTargets(width, height, max, p.position, p.scale);
      particles = targets.map(([tx, ty]) => ({
        sx: Math.random() * width,
        sy: Math.random() * height,
        tx,
        ty,
        delay: Math.random() * SPREAD_TIME,
        curve: (Math.random() - 0.5) * 0.6,
        tint: Math.floor(Math.random() * 3),
      }));
    };

    const finalAlpha = Math.min(1, p.opacity * 4);
    const glowSize = p.glow ? 3 + 5 * p.glow.spread : 0;

    const draw = (t: number) => {
      const colors = tints();
      const trail = !!p.glow?.trail && t < 1;
      if (trail) {
        ctx.globalCompositeOperation = "destination-out";
        ctx.fillStyle = "rgba(0,0,0,0.28)";
        ctx.fillRect(0, 0, width, height);
      } else {
        ctx.clearRect(0, 0, width, height);
      }
      const size = p.dotSize;
      for (const q of particles) {
        const local = t >= 1 ? 1 : Math.min(1, Math.max(0, (t - q.delay) / (1 - SPREAD_TIME)));
        const e = easeInOutCubic(local);
        // A gentle arc instead of a straight line — the "galaxy" swirl.
        const dx = q.tx - q.sx;
        const dy = q.ty - q.sy;
        const arc = Math.sin(Math.PI * e) * q.curve;
        const x = q.sx + dx * e - dy * arc;
        const y = q.sy + dy * e + dx * arc;
        // Brighter in flight, settling to the subtle watermark strength.
        const alpha = t >= 1 ? finalAlpha : Math.min(1, finalAlpha * (1.8 - 0.8 * e) + 0.15 * (1 - e));
        if (palette.halo && p.glow) {
          ctx.globalCompositeOperation = "lighter";
          // The glow grows slightly as particles reach the wordmark.
          ctx.globalAlpha = Math.min(1, p.glow.intensity * (0.25 + 0.35 * e) * (isLight() ? 0.6 : 1));
          const r = glowSize * (0.8 + 0.4 * e);
          ctx.drawImage(palette.halo, x - r, y - r, r * 2, r * 2);
        }
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = alpha;
        ctx.fillStyle = q.tint === 0 ? colors[0] : colors[q.tint];
        ctx.beginPath();
        ctx.arc(x, y, size / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    };

    const frame = (now: number) => {
      const t = Math.min(1, (elapsedBeforePause + now - startedAt) / p.durationMs);
      draw(t);
      if (t < 1) raf = requestAnimationFrame(frame);
      else {
        done = true;
        raf = 0;
        canvas.dataset.state = "done";
      }
    };

    const start = () => {
      startedAt = performance.now();
      raf = requestAnimationFrame(frame);
    };

    const onVisibility = () => {
      if (done) return;
      if (document.hidden) {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        elapsedBeforePause += performance.now() - startedAt;
      } else if (!raf) start();
    };

    buildPalette();
    layout();
    canvas.dataset.state = "running";
    canvas.dataset.particles = String(particles.length);
    if (document.hidden) {
      document.addEventListener("visibilitychange", onVisibility);
    } else {
      start();
      document.addEventListener("visibilitychange", onVisibility);
    }

    // After the formation, a resize or theme change redraws ONE still frame.
    let resizeTimer = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        const rect = host.getBoundingClientRect();
        if (Math.abs(rect.width - width) < 1 && Math.abs(rect.height - height) < 1) return;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        done = true;
        layout();
        canvas.dataset.particles = String(particles.length);
        canvas.dataset.state = "done";
        draw(1);
      }, 150);
    });
    ro.observe(host);
    const mo = new MutationObserver(() => {
      buildPalette();
      if (done) draw(1);
    });
    if (p.mode === "auto") mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.clearTimeout(resizeTimer);
      ro.disconnect();
      mo.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // Runs once per mount: the renderer re-keys this component whenever a
    // setting changes, so a new formation always starts from scratch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={ref} data-bgfx-layer="galaxy" />;
}
