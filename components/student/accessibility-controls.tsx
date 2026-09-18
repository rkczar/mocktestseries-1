import { ThemeToggle } from "@/components/theme/theme-toggle";
import { TextSizeControl } from "@/components/theme/text-size-control";
import { cn } from "@/lib/utils";

/**
 * Theme + Text Size, for Student pages outside the (dashboard) header
 * (Test Instructions, Result, Review) that would otherwise have no way to
 * reach these accessibility preferences.
 */
export function AccessibilityControls({ className }: { className?: string }) {
  return (
    <div className={cn("flex shrink-0 items-center gap-2", className)}>
      <ThemeToggle />
      <TextSizeControl />
    </div>
  );
}
