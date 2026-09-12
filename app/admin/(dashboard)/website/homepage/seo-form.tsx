"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateSeoAction, type SeoFormState } from "./actions";

interface Seo {
  title?: string;
  metaDescription?: string;
  canonicalUrl?: string;
  ogTitle?: string;
  ogDescription?: string;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Save SEO"}</Button>;
}

export function SeoForm({ seo }: { seo: Seo }) {
  const [state, formAction] = useActionState<SeoFormState, FormData>(updateSeoAction, {});

  return (
    <form action={formAction} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="title">Page title</Label>
        <Input id="title" name="title" defaultValue={seo.title} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="canonicalUrl">Canonical URL</Label>
        <Input id="canonicalUrl" name="canonicalUrl" defaultValue={seo.canonicalUrl} placeholder="https://mocktestseries.in/" />
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor="metaDescription">Meta description</Label>
        <Input id="metaDescription" name="metaDescription" defaultValue={seo.metaDescription} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ogTitle">Social sharing title</Label>
        <Input id="ogTitle" name="ogTitle" defaultValue={seo.ogTitle} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ogDescription">Social sharing description</Label>
        <Input id="ogDescription" name="ogDescription" defaultValue={seo.ogDescription} />
      </div>
      <div className="flex items-end gap-3">
        <SubmitButton />
        {state.success ? <span className="text-sm text-[var(--color-success)]">Saved.</span> : null}
      </div>
    </form>
  );
}
