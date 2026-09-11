"use client";

import { useFormStatus } from "react-dom";

import { cn } from "@/lib/utils";

export function SubmitButton({ children, className }: { children: React.ReactNode; className?: string }) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className={cn(
        "inline-flex w-full items-center justify-center rounded-[9px] bg-primary px-4 py-3 text-[15px] font-bold text-primary-foreground transition-colors duration-150 hover:bg-primary-hover disabled:opacity-60",
        className,
      )}
    >
      {pending ? "Please wait…" : children}
    </button>
  );
}
