import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  connected = true,
  hint,
}: {
  label: string;
  value: string | number;
  connected?: boolean;
  /** Optional one-line definition/context under the value. */
  hint?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p
          className={cn(
            // Long single words (e.g. a test title in "Next Scheduled Test") must wrap inside a phone-width column.
            "text-2xl font-semibold [overflow-wrap:anywhere]",
            connected ? "text-[var(--color-foreground)]" : "text-[var(--color-muted-foreground)] text-base"
          )}
        >
          {connected ? value : "Configuration Required"}
        </p>
        {hint ? <p className="mt-1 text-[11px] text-[var(--color-muted-foreground)]">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}
