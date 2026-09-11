import { Textarea } from "@/components/ui/textarea";

export function FormTextarea({
  label,
  name,
  defaultValue,
  required,
  rows = 3,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  required?: boolean;
  rows?: number;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-bold text-text-muted">{label}</span>
      <Textarea
        name={name}
        defaultValue={defaultValue}
        required={required}
        rows={rows}
        className="rounded-[8px] border-border-strong bg-surface px-3 py-2.5 text-sm focus-visible:ring-primary/30"
      />
    </label>
  );
}
