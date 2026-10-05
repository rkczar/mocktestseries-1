"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { Switch } from "@/components/ui/switch";
import { REVIEW_LIMITS, type ReviewsSectionSettings } from "@/lib/reviews-shared";
import { saveReviewsSettingsAction } from "./actions";

const TOGGLES: { name: keyof ReviewsSectionSettings; label: string; hint: string }[] = [
  { name: "enabled", label: "Reviews section", hint: "Show “What Students Say” on the homepage (hidden automatically when no review is published)." },
  { name: "autoScroll", label: "Auto-scroll", hint: "Continuous scrolling; off = a still, swipeable row." },
  { name: "showRating", label: "Show rating", hint: "Star rating on each card." },
  { name: "showExam", label: "Show exam name", hint: "Exam line under the name." },
  { name: "showVerified", label: "Show Verified badge", hint: "Only ever on genuine student-submitted reviews." },
  { name: "preferFeatured", label: "Prefer Featured reviews", hint: "Featured reviews first, then by display order." },
  { name: "showOnDashboard", label: "Show Reviews on Student Dashboard", hint: "Same published reviews, compact, above Access & Subscription." },
];

/** Homepage display settings, stored in the Setting table (website.reviews_section). */
export function ReviewsSettingsForm({ initial, canManage }: { initial: ReviewsSectionSettings; canManage: boolean }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await saveReviewsSettingsAction(formData);
        setMessage(result.ok ? { tone: "ok", text: result.message ?? "Saved." } : { tone: "error", text: result.error });
      } catch {
        setMessage({ tone: "error", text: "Something went wrong. Please try again." });
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Homepage Display</CardTitle>
        <CardDescription>How the review section looks on the public homepage. Changes apply immediately.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <fieldset disabled={!canManage || pending} className="flex flex-col gap-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reviews-heading">Section heading</Label>
                <Input id="reviews-heading" name="heading" maxLength={REVIEW_LIMITS.headingMax} defaultValue={initial.heading} placeholder="What Students Say" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reviews-subtitle">Subtitle (optional)</Label>
                <Input id="reviews-subtitle" name="subtitle" maxLength={REVIEW_LIMITS.subtitleMax} defaultValue={initial.subtitle} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reviews-max">Maximum reviews shown</Label>
                <Input
                  id="reviews-max"
                  name="maxReviews"
                  type="number"
                  min={REVIEW_LIMITS.maxShownMin}
                  max={REVIEW_LIMITS.maxShownMax}
                  defaultValue={initial.maxReviews}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="reviews-speed">Scroll speed</Label>
                  <SelectNative id="reviews-speed" name="speed" defaultValue={initial.speed}>
                    <option value="SLOW">Slow</option>
                    <option value="NORMAL">Normal</option>
                    <option value="FAST">Fast</option>
                  </SelectNative>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="reviews-direction">Direction</Label>
                  <SelectNative id="reviews-direction" name="direction" defaultValue={initial.direction}>
                    <option value="RTL">Right → Left</option>
                    <option value="LTR">Left → Right</option>
                  </SelectNative>
                </div>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {TOGGLES.map((t) => (
                <label key={t.name} className="flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
                  <Switch name={t.name} defaultChecked={Boolean(initial[t.name])} aria-label={t.label} className="mt-0.5" />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-[var(--color-foreground)]">{t.label}</span>
                    <span className="text-xs text-[var(--color-muted-foreground)]">{t.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {canManage ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : "Save Settings"}
              </Button>
              {message ? (
                <p role="status" className={`text-sm ${message.tone === "ok" ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`}>
                  {message.text}
                </p>
              ) : null}
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
