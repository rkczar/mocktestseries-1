"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, MessageCircle, Send, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { telegramShareHref, whatsappShareHref } from "@/lib/live-cbt-core";

/**
 * Live CBT "Share" (Student Dashboard card + test page). `url` is the public
 * invitation page and `message` is built on the server from the test's own
 * details (lib/live-cbt-core.ts#buildLiveCbtShareMessage) — nothing about
 * the student. On phones the native share sheet opens first; WhatsApp,
 * Telegram and Copy Link are always available as the fallback menu
 * (desktop, a cancelled sheet, or a browser without navigator.share).
 */
export function LiveCbtShareButton({ url, message, title, className }: { url: string; message: string; title: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const onShare = async () => {
    const touch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
    if (touch && typeof navigator.share === "function") {
      try {
        await navigator.share({ title, text: message });
        return;
      } catch (error) {
        // A dismissed sheet is not an error; anything else falls back to the menu.
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    setOpen((v) => !v);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const area = document.createElement("textarea");
      area.value = url;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const item =
    "flex w-full items-center gap-2 rounded-[var(--radius-button)] px-3 py-2 text-left text-sm text-[var(--color-foreground)] hover:bg-[var(--color-primary)]/10 focus-visible:bg-[var(--color-primary)]/10 focus-visible:outline-none";
  return (
    <div ref={wrap} className={`relative ${className ?? ""}`} data-testid="live-cbt-share">
      <Button type="button" variant="outline" className="w-full" onClick={onShare} aria-haspopup="menu" aria-expanded={open} data-testid="live-cbt-share-button">
        <Share2 className="h-4 w-4" aria-hidden /> Share
      </Button>
      {open ? (
        <div
          role="menu"
          aria-label="Share this Live CBT"
          className="absolute right-0 z-20 mt-1 w-56 max-w-[calc(100vw-2rem)] rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-lg"
          data-testid="live-cbt-share-menu"
        >
          <a role="menuitem" className={item} href={whatsappShareHref(message)} target="_blank" rel="noopener noreferrer" data-testid="share-whatsapp" onClick={() => setOpen(false)}>
            <MessageCircle className="h-4 w-4" aria-hidden /> WhatsApp
          </a>
          <a role="menuitem" className={item} href={telegramShareHref(url, message)} target="_blank" rel="noopener noreferrer" data-testid="share-telegram" onClick={() => setOpen(false)}>
            <Send className="h-4 w-4" aria-hidden /> Telegram
          </a>
          <button role="menuitem" type="button" className={item} onClick={copy} data-testid="share-copy">
            {copied ? <Check className="h-4 w-4 text-[var(--color-success)]" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
            {copied ? "Link copied" : "Copy Link"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
