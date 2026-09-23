import Link from "next/link";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { paywallHref, type AccessResult } from "@/lib/payments/access";

/**
 * Renders the normal Start form when the student has access, otherwise a
 * Premium badge + Unlock/Renew link. Display only — the start action and
 * lib/test-attempt.ts re-check entitlement server-side regardless.
 */
export function StartOrUnlock({ access, action, label = "Start" }: { access: AccessResult; action: () => Promise<void>; label?: string }) {
  if (access.allowed) {
    return (
      <form action={action}>
        <Button type="submit" size="sm">
          {label}
        </Button>
      </form>
    );
  }
  const canBuy = access.status !== "NOT_AVAILABLE" && !access.purchasesPaused;
  return (
    <div className="flex items-center gap-2">
      <Badge variant="warning">
        <Lock className="h-3 w-3" aria-hidden /> {access.status === "EXPIRED" ? "Expired" : "Premium"}
      </Badge>
      {canBuy ? (
        <Button asChild size="sm">
          <Link href={paywallHref(access)}>{access.status === "EXPIRED" ? "Renew" : "Unlock"}</Link>
        </Button>
      ) : (
        <Button size="sm" disabled>
          Not available
        </Button>
      )}
    </div>
  );
}
