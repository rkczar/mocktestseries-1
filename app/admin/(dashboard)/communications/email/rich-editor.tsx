"use client";

import { useEffect, useRef, useState } from "react";
import { Bold, Italic, Underline, List, ListOrdered, Link2, Heading2, Eraser, Code } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { SelectNative } from "@/components/ui/select-native";

/**
 * Minimal rich-text editor for email bodies (contentEditable + the browser's
 * editing commands). Output is a convenience only: the server sanitizes
 * every body (lib/email/sanitize.ts) before saving and again before sending.
 * "HTML" switches to a source view for small fixes.
 */

const VARIABLES = ["studentName", "email", "studentId", "examName", "testName", "loginUrl", "dashboardUrl"];

type Command = { label: string; icon: React.ComponentType<{ className?: string }>; command: string; arg?: string };

const COMMANDS: Command[] = [
  { label: "Bold", icon: Bold, command: "bold" },
  { label: "Italic", icon: Italic, command: "italic" },
  { label: "Underline", icon: Underline, command: "underline" },
  { label: "Heading", icon: Heading2, command: "formatBlock", arg: "h3" },
  { label: "Bulleted list", icon: List, command: "insertUnorderedList" },
  { label: "Numbered list", icon: ListOrdered, command: "insertOrderedList" },
  { label: "Link", icon: Link2, command: "createLink" },
  { label: "Clear formatting", icon: Eraser, command: "removeFormat" },
];

export function RichEditor({ value, onChange, disabled }: { value: string; onChange: (html: string) => void; disabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState(false);

  // Sync external value changes (template switch, load draft) without
  // clobbering the caret while the admin types.
  useEffect(() => {
    const el = ref.current;
    if (el && !source && el.innerHTML !== value) el.innerHTML = value;
  }, [value, source]);

  function exec(command: string, arg?: string) {
    ref.current?.focus();
    document.execCommand(command, false, arg);
    if (ref.current) onChange(ref.current.innerHTML);
  }

  function runCommand(c: Command) {
    if (c.command !== "createLink") return exec(c.command, c.arg);
    const url = window.prompt("Link URL (https://…)");
    if (url && /^(https?:\/\/|mailto:|\/)/i.test(url.trim())) exec("createLink", url.trim());
  }

  return (
    <div className="rounded-md border border-[var(--color-border)]">
      <div className="flex flex-wrap items-center gap-1 border-b border-[var(--color-border)] p-1.5">
        {COMMANDS.map((c) => (
          <button
            key={c.label}
            type="button"
            title={c.label}
            aria-label={c.label}
            disabled={disabled || source}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runCommand(c)}
            className="rounded p-1.5 text-[var(--color-muted-foreground)] hover:bg-[color-mix(in_srgb,var(--color-foreground)_8%,transparent)] hover:text-[var(--color-foreground)] disabled:opacity-40"
          >
            <c.icon className="h-4 w-4" />
          </button>
        ))}
        <SelectNative
          aria-label="Insert variable"
          className="ml-1 h-8 w-auto text-xs"
          value=""
          disabled={disabled || source}
          onChange={(e) => {
            if (e.target.value) exec("insertText", `{{${e.target.value}}}`);
          }}
        >
          <option value="">Insert variable…</option>
          {VARIABLES.map((v) => (
            <option key={v} value={v}>{`{{${v}}}`}</option>
          ))}
        </SelectNative>
        <button
          type="button"
          onClick={() => setSource((s) => !s)}
          disabled={disabled}
          className={`ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs ${source ? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]" : "text-[var(--color-muted-foreground)]"}`}
        >
          <Code className="h-3.5 w-3.5" /> HTML
        </button>
      </div>
      {source ? (
        <Textarea value={value} onChange={(e) => onChange(e.target.value)} rows={12} className="rounded-none border-0 font-mono text-xs" disabled={disabled} />
      ) : (
        <div
          ref={ref}
          contentEditable={!disabled}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="Email body"
          onInput={(e) => onChange((e.target as HTMLDivElement).innerHTML)}
          className="prose-sm min-h-[200px] max-w-none p-3 text-sm text-[var(--color-foreground)] outline-none [&_a]:text-[var(--color-primary)] [&_a]:underline [&_h3]:text-base [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
        />
      )}
    </div>
  );
}
