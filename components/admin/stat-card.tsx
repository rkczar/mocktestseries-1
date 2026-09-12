import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  connected = true,
}: {
  label: string;
  value: string | number;
  connected?: boolean;
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
            "text-2xl font-semibold",
            connected ? "text-[var(--color-foreground)]" : "text-[var(--color-muted-foreground)] text-base"
          )}
        >
          {connected ? value : "Configuration Required"}
        </p>
      </CardContent>
    </Card>
  );
}
