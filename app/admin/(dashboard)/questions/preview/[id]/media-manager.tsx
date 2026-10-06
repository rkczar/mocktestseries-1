"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

/**
 * Minimum admin authoring path for RICH_V1 media (NEET Phase 2) — not the
 * full editor. Talks to /api/admin/questions/[id]/{assets,rich}, which enforce
 * QUESTIONS_MANAGE and create every storage key server-side.
 * Remove/replace only change this question's references: image files are
 * immutable and are never deleted, so past attempts keep their images.
 */

export interface ManagedAsset {
  id: string;
  role: "QUESTION" | "OPTION" | "EXPLANATION" | "LIST_ITEM";
  optionLabel: string | null;
  /** LIST_ITEM only (NEET Phase 4): "I:A" / "II:III". */
  listKey?: string | null;
  order: number;
  url: string | null;
  alt: string;
  caption: string | null;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  darkBacking: boolean;
}

const input = "h-9 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-card)] px-2 text-sm text-[var(--color-foreground)]";

async function call(url: string, init: RequestInit) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

export function MediaManager(props: {
  questionId: string;
  status: string;
  contentFormat: "PLAIN" | "RICH_V1";
  explanation: string | null;
  optionLabels: string[];
  /** MATCH_THE_FOLLOWING only: the entries a list image can belong to ("I:A", …). */
  listKeys?: string[];
  assets: ManagedAsset[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const base = `/api/admin/questions/${props.questionId}`;

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage({ ok: true, text: ok });
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "Failed" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-4" data-testid="media-manager">
      <h2 className="text-sm font-semibold text-[var(--color-foreground)]">Rich content &amp; media (test authoring)</h2>
      {message ? (
        <p role="status" data-testid="media-manager-message" className={message.ok ? "text-sm text-[var(--color-success)]" : "text-sm text-[var(--color-error)]"}>
          {message.text}
        </p>
      ) : null}

      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          void run(
            () =>
              call(`${base}/rich`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contentFormat: fd.get("contentFormat"), explanation: fd.get("explanation") }),
              }),
            "Saved."
          );
        }}
      >
        <label className="flex items-center gap-2 text-sm">
          Format
          <select name="contentFormat" defaultValue={props.contentFormat} className={input} disabled={props.status !== "DRAFT"}>
            <option value="PLAIN">PLAIN</option>
            <option value="RICH_V1">RICH_V1</option>
          </select>
          {props.status !== "DRAFT" ? <span className="text-xs text-[var(--color-muted-foreground)]">Only a DRAFT question can change format.</span> : null}
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Explanation (shown to students only after the answer is revealed)
          <textarea name="explanation" defaultValue={props.explanation ?? ""} rows={4} className={`${input} h-auto py-2 font-mono`} />
        </label>
        <div>
          <Button type="submit" size="sm" disabled={busy}>
            Save text
          </Button>
        </div>
      </form>

      {props.contentFormat !== "RICH_V1" ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">Images can be attached once the question is RICH_V1.</p>
      ) : (
        <>
          <ul className="flex flex-col gap-3" data-testid="managed-assets">
            {props.assets.map((a) => (
              <AssetRow key={a.id} asset={a} busy={busy} base={base} run={run} />
            ))}
          </ul>
          <UploadForm base={base} busy={busy} run={run} optionLabels={props.optionLabels} listKeys={props.listKeys ?? []} />
        </>
      )}
    </section>
  );
}

type Run = (fn: () => Promise<unknown>, ok: string) => Promise<void>;

function AltFields({ alt, decorative }: { alt: string; decorative: boolean }) {
  const [isDecorative, setDecorative] = useState(decorative);
  return (
    <>
      <input name="alt" defaultValue={alt} placeholder="Describe the image (alt text)" className={`${input} min-w-0 flex-1`} disabled={isDecorative} />
      <label className="flex items-center gap-1 text-xs">
        <input type="checkbox" name="decorative" checked={isDecorative} onChange={(e) => setDecorative(e.target.checked)} /> Decorative
      </label>
    </>
  );
}

function AssetRow({ asset: a, busy, base, run }: { asset: ManagedAsset; busy: boolean; base: string; run: Run }) {
  return (
    <li className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid="managed-asset" data-role={a.role} data-option={a.optionLabel ?? ""}>
      <div className="flex flex-wrap items-start gap-3">
        {a.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={a.url} alt={a.alt} width={a.width} height={a.height} className="h-20 w-auto max-w-[10rem] rounded border border-[var(--color-border)] bg-white object-contain p-1" />
        ) : null}
        <div className="text-xs text-[var(--color-muted-foreground)]">
          <p className="font-semibold text-[var(--color-foreground)]">
            {a.role}
            {a.optionLabel ? ` ${a.optionLabel}` : ""}
            {a.listKey ? ` ${a.listKey}` : ""} · #{a.order}
          </p>
          <p>
            {a.width}×{a.height} · {(a.bytes / 1024).toFixed(0)} KiB · {a.sha256.slice(0, 12)}…
          </p>
        </div>
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          void run(
            () =>
              call(`${base}/assets`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  assetId: a.id,
                  alt: fd.get("alt") ?? "",
                  decorative: fd.get("decorative") === "on",
                  order: fd.get("order"),
                  caption: fd.get("caption") ?? "",
                  darkBacking: fd.get("darkBacking") === "on",
                }),
              }),
            "Image details saved."
          );
        }}
      >
        <AltFields alt={a.alt} decorative={a.alt === ""} />
        <input name="order" type="number" min={0} max={99} defaultValue={a.order} className={`${input} w-16`} aria-label="Order" />
        <input name="caption" defaultValue={a.caption ?? ""} placeholder="Caption (optional)" className={`${input} w-40`} />
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" name="darkBacking" defaultChecked={a.darkBacking} /> Light backing in dark mode
        </label>
        <Button type="submit" size="sm" variant="outline" disabled={busy}>
          Save
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            fd.set("replaceAssetId", a.id);
            fd.set("alt", a.alt);
            if (a.alt === "") fd.set("decorative", "true");
            void run(() => call(`${base}/assets`, { method: "POST", body: fd }), "Replaced with a new image (the old file is kept for past attempts).");
          }}
        >
          <input name="file" type="file" accept="image/png,image/jpeg,image/webp,image/avif" required className="text-xs" aria-label="Replacement image" />
          <Button type="submit" size="sm" variant="outline" disabled={busy}>
            Replace
          </Button>
        </form>
        <Button
          type="button"
          size="sm"
          variant="danger"
          disabled={busy}
          onClick={() =>
            void run(
              () => call(`${base}/assets`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assetId: a.id }) }),
              "Removed from this question (the file is kept for past attempts)."
            )
          }
        >
          Remove
        </Button>
      </div>
    </li>
  );
}

function UploadForm({ base, busy, run, optionLabels, listKeys }: { base: string; busy: boolean; run: Run; optionLabels: string[]; listKeys: string[] }) {
  const [role, setRole] = useState("QUESTION");
  return (
    <form
      data-testid="media-upload"
      className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const fd = new FormData(form);
        if (!fd.get("darkBacking")) fd.set("darkBacking", "false");
        void run(() => call(`${base}/assets`, { method: "POST", body: fd }), "Image attached.").then(() => form.reset());
      }}
    >
      <input name="file" type="file" accept="image/png,image/jpeg,image/webp,image/avif" required className="text-xs" aria-label="Image file" />
      <select name="role" value={role} onChange={(e) => setRole(e.target.value)} className={input} aria-label="Role">
        <option value="QUESTION">Question image</option>
        <option value="OPTION">Option image</option>
        <option value="EXPLANATION">Explanation image</option>
        {listKeys.length ? <option value="LIST_ITEM">List entry image</option> : null}
      </select>
      {role === "LIST_ITEM" ? (
        <select name="listKey" className={input} aria-label="List entry">
          {listKeys.map((k) => (
            <option key={k} value={k}>
              List {k.replace(":", " – ")}
            </option>
          ))}
        </select>
      ) : null}
      {role === "OPTION" ? (
        <select name="optionLabel" className={input} aria-label="Option">
          {optionLabels.map((l) => (
            <option key={l} value={l}>
              Option {l}
            </option>
          ))}
        </select>
      ) : null}
      <input name="order" type="number" min={0} max={99} placeholder="Order" className={`${input} w-20`} aria-label="Order" />
      <AltFields alt="" decorative={false} />
      <input name="caption" placeholder="Caption (optional)" className={`${input} w-40`} />
      <label className="flex items-center gap-1 text-xs">
        <input type="checkbox" name="darkBacking" defaultChecked /> Light backing in dark mode
      </label>
      <Button type="submit" size="sm" disabled={busy}>
        Upload
      </Button>
    </form>
  );
}
