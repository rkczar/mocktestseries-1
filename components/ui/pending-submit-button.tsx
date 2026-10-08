"use client";

import { useEffect, useRef, type ComponentProps, type MouseEvent } from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Submit button for a plain `<form action={serverAction}>` (also usable from
 * Server Components): disabled with a small spinner while the form is
 * pending, and a second click that lands before React re-renders is dropped,
 * so a double-click never submits twice. Server-side idempotency still
 * applies regardless.
 */
export function PendingSubmitButton({
  children,
  pendingLabel,
  disabled,
  onClick,
  ...props
}: Omit<ComponentProps<typeof Button>, "type"> & { pendingLabel?: string }) {
  const { pending } = useFormStatus();
  const clicked = useRef(false);
  useEffect(() => {
    if (!pending) clicked.current = false;
  }, [pending]);

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (clicked.current || pending) {
      e.preventDefault();
      return;
    }
    onClick?.(e);
    // An invalid form never submits, so it must not lock the button.
    if (!e.defaultPrevented && e.currentTarget.form?.checkValidity() !== false) clicked.current = true;
  };

  return (
    <Button type="submit" disabled={pending || disabled} aria-busy={pending || undefined} onClick={handleClick} {...props}>
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
      {pending && pendingLabel ? pendingLabel : children}
    </Button>
  );
}
