"use client";

import { useRef, useState } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

const ACCEPT = "image/webp,image/png,image/jpeg";

/**
 * Upload/preview/replace/remove control for Question.imageUrl and
 * QuestionOption.imageUrl. Uploads happen immediately (POST
 * /api/admin/questions/images) rather than waiting for the surrounding
 * form's submit — the resulting URL is carried into the form via a plain
 * hidden input, so `question-form.tsx`'s existing server action needs no
 * knowledge of how the URL got there.
 */
export function ImageUploadField({
  label,
  name,
  target,
  questionId,
  defaultUrl,
}: {
  label: string;
  name: string;
  target: "question" | "A" | "B" | "C" | "D";
  questionId?: string;
  defaultUrl?: string | null;
}) {
  const [url, setUrl] = useState<string | null>(defaultUrl ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("target", target);
      if (questionId) body.set("questionId", questionId);
      if (url) body.set("previousUrl", url);

      const res = await fetch("/api/admin/questions/images", { method: "POST", body });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Upload failed");
        return;
      }
      setUrl(data.url);
    } catch {
      setError("Upload failed");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleRemove() {
    if (!url) return;
    setBusy(true);
    setError(null);
    try {
      await fetch("/api/admin/questions/images", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, questionId, target }),
      });
    } catch {
      // Best-effort; still clear locally so the form no longer references it.
    } finally {
      setUrl(null);
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <input type="hidden" name={name} value={url ?? ""} />
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />

      {url ? (
        <div className="flex items-start gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt=""
            className="h-20 w-20 rounded-[var(--radius-card)] border border-[var(--color-border)] object-cover"
          />
          <div className="flex flex-col gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              Replace
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={handleRemove}>
              <X className="h-3.5 w-3.5" aria-hidden /> Remove
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="w-fit"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <ImagePlus className="h-3.5 w-3.5" aria-hidden />
          )}
          Upload image
        </Button>
      )}

      {error ? <p className="text-xs text-[var(--color-error)]">{error}</p> : null}
      <p className="text-xs text-[var(--color-muted-foreground)]">WEBP, PNG, or JPG — up to 2MB.</p>
    </div>
  );
}
