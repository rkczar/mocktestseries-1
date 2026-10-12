"use client";

import { useEffect, useState } from "react";
import { postAiCostAction } from "@/app/admin/(dashboard)/instagram/studio-actions";
import { formatInr } from "@/lib/ai-engine/config";

interface Cost {
  requests: number;
  text: number;
  image: number;
  diagram: number;
  regeneration: number;
  total: number;
  uncosted: number;
}

/** "AI cost for this post" — provider-reported costs recorded against this carousel (refreshes after each change). */
export function PostAiCost({ postId, revision }: { postId: string; revision: number }) {
  const [c, setC] = useState<Cost | null>(null);
  useEffect(() => {
    let live = true;
    postAiCostAction(postId).then((r) => live && r.ok && setC(r.data));
    return () => {
      live = false;
    };
  }, [postId, revision]);
  if (!c) return null;
  return (
    <div className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-xs" data-testid="post-ai-cost" data-total={c.total}>
      <p className="text-sm font-semibold">AI cost for this post</p>
      {c.requests === 0 ? (
        <p className="text-[var(--color-muted-foreground)]">No AI request recorded for this post yet.</p>
      ) : (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          <dt className="text-[var(--color-muted-foreground)]">Text AI</dt>
          <dd>{formatInr(c.text, 4)}</dd>
          <dt className="text-[var(--color-muted-foreground)]">Image AI</dt>
          <dd>{formatInr(c.image, 4)}</dd>
          <dt className="text-[var(--color-muted-foreground)]">Diagram</dt>
          <dd>{formatInr(c.diagram, 4)}</dd>
          <dt className="text-[var(--color-muted-foreground)]">Regenerations</dt>
          <dd>{formatInr(c.regeneration, 4)}</dd>
          <dt className="font-medium">Total actual AI cost</dt>
          <dd className="font-medium" data-testid="post-ai-cost-total">
            {formatInr(c.total, 4)}
          </dd>
          {c.uncosted ? (
            <>
              <dt className="text-[var(--color-muted-foreground)]">Without reported cost</dt>
              <dd>{`${c.uncosted} request(s) on a legacy provider`}</dd>
            </>
          ) : null}
        </dl>
      )}
    </div>
  );
}
