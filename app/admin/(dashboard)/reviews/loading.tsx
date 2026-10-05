/** Admin → Reviews loading state (the layout and sidebar stay interactive). */
export default function Loading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading reviews">
      <div className="h-8 w-40 animate-pulse rounded bg-[var(--color-border)] motion-reduce:animate-none" />
      <div className="grid grid-cols-3 gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-[var(--radius-card)] bg-[var(--color-border)] motion-reduce:animate-none" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-[var(--radius-card)] bg-[var(--color-border)] motion-reduce:animate-none" />
    </div>
  );
}
