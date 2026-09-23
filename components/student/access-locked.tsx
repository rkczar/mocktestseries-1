import Link from "next/link";
import { Lock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { accessDeniedMessage, type AccessResult } from "@/lib/payments/access";

/**
 * Shown instead of any question payload when the entitlement engine denies
 * access. Links only to server-priced checkout pages — never carries a price.
 */
export function AccessLocked({ access, backHref = "/student/dashboard" }: { access: AccessResult; backHref?: string }) {
  const cta = access.status === "EXPIRED" ? "Renew Access" : "Unlock Now";
  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-lg flex-col justify-center px-4 py-10">
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
          <Lock className="h-8 w-8 text-[var(--color-primary)]" aria-hidden />
          <p className="text-base font-semibold text-[var(--color-foreground)]">
            {access.status === "EXPIRED" ? "Access expired" : "Premium content"}
          </p>
          <p className="text-sm text-[var(--color-muted-foreground)]">{accessDeniedMessage(access)}</p>
          {!access.purchasesPaused && access.products.length > 0 ? (
            <div className="flex w-full flex-col gap-2">
              {access.products.map((p) => (
                <Button key={p.id} asChild>
                  <Link href={`/student/checkout/${encodeURIComponent(p.code)}`}>
                    {cta} — {p.name}
                  </Link>
                </Button>
              ))}
            </div>
          ) : null}
          <Button asChild variant="outline">
            <Link href={backHref}>Back</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
