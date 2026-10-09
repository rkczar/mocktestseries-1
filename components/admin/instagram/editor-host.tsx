"use client";

import { createContext, useContext, useState } from "react";
import { CarouselEditor, type EditorTarget } from "@/components/admin/instagram/carousel-editor";
import { cn } from "@/lib/utils";

const OpenContext = createContext<(t: EditorTarget) => void>(() => {});

/** Wraps a server-rendered list so any row can open the Carousel Preview modal. */
export function EditorHost({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<EditorTarget | null>(null);
  return (
    <OpenContext.Provider value={setTarget}>
      {children}
      <CarouselEditor key={target?.questionId ?? "closed"} target={target} onClose={() => setTarget(null)} />
    </OpenContext.Provider>
  );
}

/** A clickable question row / button that opens the editor for one question. */
export function OpenInEditor({ target, children, className, testId }: { target: EditorTarget; children: React.ReactNode; className?: string; testId?: string }) {
  const open = useContext(OpenContext);
  return (
    <button type="button" onClick={() => open(target)} className={cn("text-left", className)} data-testid={testId} data-question-id={target.questionId}>
      {children}
    </button>
  );
}
