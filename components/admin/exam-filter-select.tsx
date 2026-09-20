"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SelectNative } from "@/components/ui/select-native";

/**
 * Shared "Select Exam" (or any single-param) filter control for the Exams
 * Control Center's Subjects/Topics/Previous Year Papers tabs — updates one
 * query param via router.replace, preserving every other param (including
 * `?tab=`), and optionally clears a dependent param (e.g. `subjectId` when
 * the Exam changes) so a stale child selection never survives a parent
 * filter change.
 */
export function ExamFilterSelect({
  options,
  paramName,
  value,
  clearParams = [],
  placeholder = "— Select Exam —",
  allowAll = false,
  allLabel = "All Exams",
  disabled = false,
  className,
}: {
  options: { id: string; name: string }[];
  paramName: string;
  value?: string;
  clearParams?: string[];
  placeholder?: string;
  allowAll?: boolean;
  allLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const handleChange = (next: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set(paramName, next);
    else params.delete(paramName);
    clearParams.forEach((p) => params.delete(p));
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <SelectNative value={value ?? ""} onChange={(e) => handleChange(e.target.value)} disabled={disabled} className={className}>
      {allowAll ? <option value="">{allLabel}</option> : <option value="">{placeholder}</option>}
      {options.map((opt) => (
        <option key={opt.id} value={opt.id}>
          {opt.name}
        </option>
      ))}
    </SelectNative>
  );
}
