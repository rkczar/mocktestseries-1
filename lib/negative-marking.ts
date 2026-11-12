/** "1/3" for a one-third deduction (stored as 1/3 for exact scoring); every other value prints exactly as before. */
export function formatNegativeMarking(n: number): string {
  if (Math.abs(n - 1 / 3) < 1e-9) return "1/3";
  if (Math.abs(n - 2 / 3) < 1e-9) return "2/3";
  return String(n);
}
