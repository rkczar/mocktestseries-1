"use client";

import { MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Standard `wa.me` deep link — no WhatsApp Business API, no credentials, no
 * server round-trip. `text` must be built by the caller from data the
 * viewing student is already entitled to see (their own score); this
 * component never fetches or exposes anything itself, so it can't leak
 * another student's data or a correct-answer key that hasn't been released.
 */
export function WhatsAppShareButton({ text }: { text: string }) {
  const href = `https://wa.me/?text=${encodeURIComponent(text)}`;
  return (
    <Button asChild variant="outline" className="flex-1">
      <a href={href} target="_blank" rel="noopener noreferrer">
        <MessageCircle className="h-4 w-4" aria-hidden /> Share on WhatsApp
      </a>
    </Button>
  );
}
