"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SectionFieldDef, SectionMeta } from "@/lib/homepage-sections";
import {
  pairListToText,
  textToPairList,
  listToText,
  textToList,
  statisticsToText,
  textToStatistics,
} from "@/lib/homepage-field-codec";
import { updateSectionContentAction } from "./actions";

type RefOption = { id: string; name: string };

function isReferenceField(type: SectionFieldDef["type"]) {
  return type === "examSingle" || type === "examMulti" || type === "paperMulti" || type === "seriesMulti";
}

function TextAreaFieldEditor({
  field,
  value,
  onChange,
}: {
  field: SectionFieldDef;
  value: string;
  onChange: (v: string) => void;
}) {
  const isTextarea = field.type === "textarea" || field.type === "pairlist" || field.type === "list" || field.type === "statistics";
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={field.key}>{field.label}</Label>
      {isTextarea ? (
        <textarea
          id={field.key}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={field.type === "textarea" ? 3 : 4}
          className="w-full rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-foreground)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
        />
      ) : (
        <Input id={field.key} value={value} onChange={(e) => onChange(e.target.value)} type={field.type === "url" ? "url" : "text"} />
      )}
      {field.help ? <p className="text-xs text-[var(--color-muted-foreground)]">{field.help}</p> : null}
    </div>
  );
}

function ReferencePicker({
  field,
  options,
  selected,
  onChange,
}: {
  field: SectionFieldDef;
  options: RefOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const multi = field.type !== "examSingle";

  if (options.length === 0) {
    return (
      <div className="flex flex-col gap-1.5">
        <Label>{field.label}</Label>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Nothing available yet — create one under Manage Exams first.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label>{field.label}</Label>
      <div className="flex flex-col gap-1.5 rounded-[var(--radius-button)] border border-[var(--color-border)] p-2 max-h-40 overflow-y-auto">
        {options.map((opt) => {
          const checked = selected.includes(opt.id);
          return (
            <label key={opt.id} className="flex items-center gap-2 text-sm text-[var(--color-foreground)]">
              <input
                type={multi ? "checkbox" : "radio"}
                name={field.key}
                checked={checked}
                onChange={() => {
                  if (multi) {
                    onChange(checked ? selected.filter((id) => id !== opt.id) : [...selected, opt.id]);
                  } else {
                    onChange([opt.id]);
                  }
                }}
              />
              {opt.name}
            </label>
          );
        })}
      </div>
    </div>
  );
}

export function SectionContentForm({
  sectionId,
  meta,
  content,
  references,
  examOptions,
  paperOptions,
  seriesOptions,
}: {
  sectionId: string;
  meta: SectionMeta;
  content: Record<string, unknown>;
  references: Record<string, unknown>;
  examOptions: RefOption[];
  paperOptions: RefOption[];
  seriesOptions: RefOption[];
}) {
  const [textValues, setTextValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const field of meta.fields) {
      if (isReferenceField(field.type)) continue;
      const raw = content[field.key];
      if (field.type === "pairlist") init[field.key] = pairListToText(raw);
      else if (field.type === "list") init[field.key] = listToText(raw);
      else if (field.type === "statistics") init[field.key] = statisticsToText(raw);
      else init[field.key] = typeof raw === "string" ? raw : "";
    }
    return init;
  });

  const [refValues, setRefValues] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {};
    for (const field of meta.fields) {
      if (!isReferenceField(field.type)) continue;
      if (field.type === "examSingle") {
        const v = references.examId;
        init[field.key] = typeof v === "string" ? [v] : [];
      } else {
        const key = field.type === "examMulti" ? "examIds" : field.type === "paperMulti" ? "paperIds" : "testSeriesIds";
        const v = references[key];
        init[field.key] = Array.isArray(v) ? (v as string[]) : [];
      }
    }
    return init;
  });

  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    const newContent: Record<string, unknown> = { ...content };
    const newReferences: Record<string, unknown> = { ...references };

    for (const field of meta.fields) {
      if (field.type === "pairlist") newContent[field.key] = textToPairList(textValues[field.key] ?? "");
      else if (field.type === "list") newContent[field.key] = textToList(textValues[field.key] ?? "");
      else if (field.type === "statistics") newContent[field.key] = textToStatistics(textValues[field.key] ?? "");
      else if (field.type === "examSingle") newReferences.examId = refValues[field.key]?.[0];
      else if (field.type === "examMulti") newReferences.examIds = refValues[field.key] ?? [];
      else if (field.type === "paperMulti") newReferences.paperIds = refValues[field.key] ?? [];
      else if (field.type === "seriesMulti") newReferences.testSeriesIds = refValues[field.key] ?? [];
      else newContent[field.key] = textValues[field.key] ?? "";
    }

    startTransition(async () => {
      await updateSectionContentAction(sectionId, newContent, newReferences);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  };

  return (
    <div className="flex flex-col gap-4 border-t border-[var(--color-border)] pt-4">
      {meta.fields.map((field) => {
        if (field.type === "examSingle" || field.type === "examMulti") {
          return (
            <ReferencePicker
              key={field.key}
              field={field}
              options={examOptions}
              selected={refValues[field.key] ?? []}
              onChange={(ids) => setRefValues((s) => ({ ...s, [field.key]: ids }))}
            />
          );
        }
        if (field.type === "paperMulti") {
          return (
            <ReferencePicker
              key={field.key}
              field={field}
              options={paperOptions}
              selected={refValues[field.key] ?? []}
              onChange={(ids) => setRefValues((s) => ({ ...s, [field.key]: ids }))}
            />
          );
        }
        if (field.type === "seriesMulti") {
          return (
            <ReferencePicker
              key={field.key}
              field={field}
              options={seriesOptions}
              selected={refValues[field.key] ?? []}
              onChange={(ids) => setRefValues((s) => ({ ...s, [field.key]: ids }))}
            />
          );
        }
        return (
          <TextAreaFieldEditor
            key={field.key}
            field={field}
            value={textValues[field.key] ?? ""}
            onChange={(v) => setTextValues((s) => ({ ...s, [field.key]: v }))}
          />
        );
      })}

      <div className="flex items-center gap-3">
        <Button type="button" size="sm" disabled={pending} onClick={handleSave}>
          {pending ? "Saving…" : "Save Section"}
        </Button>
        {saved ? <span className="text-sm text-[var(--color-success)]">Saved to draft.</span> : null}
      </div>
    </div>
  );
}
