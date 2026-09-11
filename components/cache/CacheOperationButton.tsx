"use client";

import { CircleCheck, CircleX, Loader2 } from "lucide-react";
import { useEffect } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

import { useCacheAction } from "./useCacheAction";

type CacheOperationButtonProps = {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  description?: string;
  run: () => Promise<{ ok: boolean; error?: string }>;
  successMessage: string;
  errorMessage: string;
  /** Hard Cache Reset only, per spec — every other operation runs immediately on click. */
  confirmText?: string;
  /** Hard Cache Reset and Browser Cache Reset reload the page after success; Clear Cache does not. */
  reloadOnSuccess?: boolean;
  /** Smaller footer styling instead of the full Admin card layout. */
  compact?: boolean;
};

export function CacheOperationButton({
  icon: Icon,
  label,
  description,
  run,
  successMessage,
  errorMessage,
  confirmText,
  reloadOnSuccess,
  compact,
}: CacheOperationButtonProps) {
  const { status, message, execute, isLoading } = useCacheAction(run, successMessage, errorMessage);

  useEffect(() => {
    if (status !== "success" || !reloadOnSuccess) return;
    const timeout = setTimeout(() => window.location.reload(), 900);
    return () => clearTimeout(timeout);
  }, [status, reloadOnSuccess]);

  const buttonLabel = isLoading ? "Loading…" : label;
  const buttonClassName = cn(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap font-bold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60",
    compact
      ? "rounded-[8px] border border-border-strong px-3 py-1.5 text-[12.5px] text-text-muted hover:bg-accent hover:text-primary"
      : "rounded-[9px] border border-border-strong px-4 py-2.5 text-[14.5px] text-primary hover:bg-accent",
  );

  const buttonContent = (
    <>
      {isLoading ? (
        <Loader2 className={cn("animate-spin", compact ? "size-3.5" : "size-4")} strokeWidth={2.2} />
      ) : (
        <Icon className={compact ? "size-3.5" : "size-4"} strokeWidth={2.2} />
      )}
      {buttonLabel}
    </>
  );

  return (
    <div className={compact ? "flex flex-col gap-1.5" : "rounded-xl border border-border bg-surface p-4.5"}>
      {!compact && (
        <div className="mb-3 flex items-start gap-2.5">
          <span className="flex size-9 flex-none items-center justify-center rounded-[10px] border border-primary-border bg-primary-tint">
            <Icon className="size-[17px] text-primary" strokeWidth={1.9} />
          </span>
          <div className="min-w-0">
            <p className="text-[15px] font-extrabold text-text-heading">{label}</p>
            {description ? <p className="mt-0.5 text-[13px] leading-relaxed text-text-muted">{description}</p> : null}
          </div>
        </div>
      )}

      {confirmText ? (
        <AlertDialog>
          <AlertDialogTrigger className={buttonClassName} disabled={isLoading}>
            {buttonContent}
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{label}</AlertDialogTitle>
              <AlertDialogDescription>{confirmText}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={execute}>Continue</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : (
        <button type="button" onClick={execute} disabled={isLoading} className={buttonClassName}>
          {buttonContent}
        </button>
      )}

      {status === "loading" ? (
        <p className={cn("flex items-center gap-1.5 text-text-faint", compact ? "text-[11.5px]" : "mt-2.5 text-[13px]")}>
          Loading…
        </p>
      ) : null}
      {status === "success" ? (
        <p
          className={cn(
            "flex items-center gap-1.5 font-semibold text-success-text",
            compact ? "text-[11.5px]" : "mt-2.5 text-[13px]",
          )}
        >
          <CircleCheck className="size-3.5 flex-none" strokeWidth={2.2} />
          {message}
        </p>
      ) : null}
      {status === "error" ? (
        <p
          className={cn(
            "flex items-center gap-1.5 font-semibold text-error",
            compact ? "text-[11.5px]" : "mt-2.5 text-[13px]",
          )}
        >
          <CircleX className="size-3.5 flex-none" strokeWidth={2.2} />
          {message}
        </p>
      ) : null}
    </div>
  );
}
