/**
 * Masking for identifiers kept in audit history after an account is deleted
 * (DeletionRequest snapshots). Enough for an admin to recognise a request,
 * not enough to recover the contact detail. Pure/dependency-free on purpose
 * so it can run in any runtime and be unit-checked with tsx.
 */

/** "ramesh.k@gmail.com" -> "ra***@gmail.com"; "r@x.in" -> "r***@x.in". */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const keep = local.length > 2 ? 2 : 1;
  return `${local.slice(0, keep)}***@${domain}`;
}

/**
 * "+919876543221" / "9876543221" -> "98******21". Country code is dropped so
 * the visible digits come from the national number; anything shorter than
 * 5 digits is fully masked.
 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, "");
  if (digits.length > 10) digits = digits.slice(-10);
  if (digits.length < 5) return "*".repeat(Math.max(digits.length, 3));
  return `${digits.slice(0, 2)}${"*".repeat(digits.length - 4)}${digits.slice(-2)}`;
}
