"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { submitContactMessageAction, type CommunicationFormState } from "@/lib/communications-actions";

const INITIAL_STATE: CommunicationFormState = {};

export function MessageUsForm({ initialName, initialEmail }: { initialName: string; initialEmail: string }) {
  const [state, formAction, isPending] = useActionState(submitContactMessageAction, INITIAL_STATE);

  if (state.success) {
    return (
      <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center">
        <p className="text-sm text-[var(--color-success)]">
          Thanks — your message has been received. Your reference ID is{" "}
          <span className="font-mono font-medium text-[var(--color-foreground)]">{state.referenceId}</span>. Keep it
          for your records if you follow up.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="msg-name">Name</Label>
          <Input id="msg-name" name="name" required minLength={2} maxLength={100} defaultValue={initialName} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="msg-email">Email</Label>
          <Input id="msg-email" name="email" type="email" required maxLength={254} defaultValue={initialEmail} />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="msg-phone">Phone (optional)</Label>
        <Input id="msg-phone" name="phone" type="tel" maxLength={20} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="msg-subject">Subject</Label>
        <Input id="msg-subject" name="subject" required minLength={2} maxLength={150} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="msg-message">Message</Label>
        <Textarea id="msg-message" name="message" rows={5} required minLength={10} maxLength={3000} />
      </div>
      {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
      <Button type="submit" disabled={isPending} className="self-start">
        {isPending ? "Sending…" : "Send Message"}
      </Button>
    </form>
  );
}
