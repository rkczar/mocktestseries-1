import { Input } from "@/components/ui/input";

export function FormField({
  label,
  name,
  type = "text",
  defaultValue,
  required,
  placeholder,
  step,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string | number;
  required?: boolean;
  placeholder?: string;
  step?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-bold text-text-muted">{label}</span>
      <Input
        name={name}
        type={type}
        defaultValue={defaultValue}
        required={required}
        placeholder={placeholder}
        step={step}
        className="h-auto rounded-[8px] border-border-strong bg-surface px-3 py-2.5 text-sm focus-visible:ring-primary/30"
      />
    </label>
  );
}
