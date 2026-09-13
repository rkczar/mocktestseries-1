import { ShieldAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export function RestrictedCard({ title }: { title: string }) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{title}</h1>
      </div>
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <ShieldAlert className="h-8 w-8 text-[var(--color-error)]" aria-hidden />
          <p className="text-base font-medium text-[var(--color-foreground)]">Access Restricted</p>
          <p className="max-w-sm text-sm text-[var(--color-muted-foreground)]">
            This section is limited to Master Admin. Ask a Master Admin for access if you believe this is a mistake.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
