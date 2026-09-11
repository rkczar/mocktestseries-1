import { Input } from "@/components/ui/input";

export function FormField({
  label,
  name,
  type = "text",
  autoComplete,
  required = true,
}: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13.5px] font-bold text-text-muted">{label}</span>
      <Input
        name={name}
        type={type}
        autoComplete={autoComplete}
        required={required}
        className="h-auto rounded-[9px] border-border-strong bg-background px-3.5 py-3 text-[15px] focus-visible:ring-primary/30"
      />
    </label>
  );
}
