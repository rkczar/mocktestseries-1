"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { updateEmailPreferenceAction } from "./actions";

export function PreferencesForm({ token, promotionalOptOut }: { token: string; promotionalOptOut: boolean }) {
  const [optedOut, setOptedOut] = useState(promotionalOptOut);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function update(next: boolean) {
    startTransition(async () => {
      const result = await updateEmailPreferenceAction(token, next);
      if (result.ok) {
        setOptedOut(next);
        setMessage(next ? "You have been unsubscribed from announcements and promotional emails." : "You are subscribed to announcements again.");
      } else {
        setMessage(result.error ?? "Something went wrong. Please try again.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-[var(--color-border)] p-4">
        <p className="font-medium text-[var(--color-foreground)]">Announcements and promotional emails</p>
        <p className="mt-1 text-[var(--color-muted-foreground)]">
          New tests, exam updates and offers. Status: <strong>{optedOut ? "Unsubscribed" : "Subscribed"}</strong>
        </p>
        <div className="mt-3">
          {optedOut ? (
            <Button onClick={() => update(false)} disabled={pending}>
              Subscribe again
            </Button>
          ) : (
            <Button variant="outline" onClick={() => update(true)} disabled={pending}>
              Unsubscribe
            </Button>
          )}
        </div>
      </div>
      {message ? (
        <p role="status" className="text-[var(--color-foreground)]">
          {message}
        </p>
      ) : null}
    </div>
  );
}
