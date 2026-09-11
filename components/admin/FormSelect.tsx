export function FormSelect({
  label,
  name,
  defaultValue,
  options,
  required,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  options: { value: string; label: string }[];
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-bold text-text-muted">{label}</span>
      <select
        name={name}
        defaultValue={defaultValue}
        required={required}
        className="h-10 w-full rounded-[8px] border border-border-strong bg-surface px-3 text-sm outline-none focus-visible:border-primary"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}
