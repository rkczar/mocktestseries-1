/**
 * Student-facing lock label for a denied AccessResult status. Client-safe and
 * pure. "Complete Access required" is only true for PAYMENT_REQUIRED —
 * NOT_AVAILABLE means no current plan unlocks the test (e.g. a PAID mock
 * outside every product's series), so buying Complete Access wouldn't help.
 */
export function accessLockLabel(status: string): string {
  if (status === "EXPIRED") return "Access expired";
  if (status === "NOT_AVAILABLE") return "Not in any current plan";
  return "Complete Access required";
}
