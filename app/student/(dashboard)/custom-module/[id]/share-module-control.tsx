"use client";

import { useState, useTransition } from "react";
import { Check, Copy, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { shareCustomModuleAction } from "../builder/actions";

export function ShareModuleControl({ moduleId, existingToken }: { moduleId: string; existingToken: string | null }) {
  const [token, setToken] = useState(existingToken);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const link = token && typeof window !== "undefined" ? `${window.location.origin}/student/custom-module/shared/${token}` : null;

  const handleShare = () => {
    setError(null);
    startTransition(async () => {
      const result = await shareCustomModuleAction(moduleId);
      if ("error" in result) setError(result.error);
      else setToken(result.token);
    });
  };

  const handleCopy = () => {
    if (!link) return;
    navigator.clipboard.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (link) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
          {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
          {copied ? "Copied" : "Copy Share Link"}
        </Button>
        <p className="max-w-[240px] truncate text-right text-xs text-[var(--color-muted-foreground)]">{link}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" variant="outline" size="sm" onClick={handleShare} disabled={isPending}>
        <Share2 className="h-4 w-4" aria-hidden /> {isPending ? "Generating…" : "Share"}
      </Button>
      {error ? <p className="text-xs text-[var(--color-error)]">{error}</p> : null}
    </div>
  );
}
