import { Construction } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export function StubPage({ title, phase }: { title: string; phase: string }) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{title}</h1>
      </div>
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <Construction className="h-8 w-8 text-[var(--color-warning)]" aria-hidden />
          <p className="text-base font-medium text-[var(--color-foreground)]">Configuration Required</p>
          <p className="max-w-sm text-sm text-[var(--color-muted-foreground)]">
            {title} is not connected yet. This module is scheduled for {phase} and will appear here once built.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
