"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import type { SeoSettings } from "@/lib/seo-settings";
import { saveSeoSettingsAction, type SeoFormState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving…" : "Save SEO Settings"}
    </Button>
  );
}

export function SeoSettingsForm({ settings, canManage }: { settings: SeoSettings; canManage: boolean }) {
  const [state, formAction] = useActionState<SeoFormState, FormData>(saveSeoSettingsAction, {});

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <fieldset disabled={!canManage} className="contents">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="siteName">Site name</Label>
            <Input id="siteName" name="siteName" defaultValue={settings.siteName} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="canonicalBase">Canonical base URL</Label>
            <Input id="canonicalBase" name="canonicalBase" defaultValue={settings.canonicalBase} placeholder="https://mocktestseries.in" />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="titleTemplate">Default title template (must include %s)</Label>
          <Input id="titleTemplate" name="titleTemplate" defaultValue={settings.titleTemplate} />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="defaultMetaDescription">Default meta description</Label>
          <Textarea id="defaultMetaDescription" name="defaultMetaDescription" defaultValue={settings.defaultMetaDescription} rows={3} />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="defaultOgImage">Default OG image URL</Label>
            <Input id="defaultOgImage" name="defaultOgImage" defaultValue={settings.defaultOgImage} placeholder="https://…/og-default.png" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="twitterHandle">Twitter/X handle</Label>
            <Input id="twitterHandle" name="twitterHandle" defaultValue={settings.twitterHandle} placeholder="@mocktestseries" />
          </div>
        </div>

        <div className="flex items-center justify-between rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2.5">
          <div>
            <p className="text-sm font-medium text-[var(--color-foreground)]">Site indexable</p>
            <p className="text-xs text-[var(--color-muted-foreground)]">Off forces noindex sitewide and empties the sitemap — use only if the site should not appear in search.</p>
          </div>
          <Switch name="siteIndexable" defaultChecked={settings.siteIndexable} />
        </div>

        <div className="flex items-center justify-between rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2.5">
          <div>
            <p className="text-sm font-medium text-[var(--color-foreground)]">Sitemap enabled</p>
            <p className="text-xs text-[var(--color-muted-foreground)]">Publishes /sitemap.xml with every indexable public page.</p>
          </div>
          <Switch name="sitemapEnabled" defaultChecked={settings.sitemapEnabled} />
        </div>

        {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
        {state.success ? <p className="text-sm text-[var(--color-success)]">Saved.</p> : null}

        {canManage ? <SubmitButton /> : null}
      </fieldset>
    </form>
  );
}
