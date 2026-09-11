import Link from "next/link";

export function Pagination({
  page,
  totalPages,
  basePath,
  searchParams,
}: {
  page: number;
  totalPages: number;
  basePath: string;
  searchParams: Record<string, string | undefined>;
}) {
  if (totalPages <= 1) return null;

  const hrefFor = (p: number) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams)) {
      if (value && key !== "page") params.set(key, value);
    }
    params.set("page", String(p));
    return `${basePath}?${params.toString()}`;
  };

  return (
    <div className="mt-5 flex items-center justify-between text-sm">
      <span className="text-text-faint">
        Page {page} of {totalPages}
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link
            href={hrefFor(page - 1)}
            className="rounded-[8px] border border-border-strong px-3 py-1.5 font-bold text-primary hover:bg-accent"
          >
            Previous
          </Link>
        ) : (
          <span className="rounded-[8px] border border-border px-3 py-1.5 font-bold text-text-placeholder">
            Previous
          </span>
        )}
        {page < totalPages ? (
          <Link
            href={hrefFor(page + 1)}
            className="rounded-[8px] border border-border-strong px-3 py-1.5 font-bold text-primary hover:bg-accent"
          >
            Next
          </Link>
        ) : (
          <span className="rounded-[8px] border border-border px-3 py-1.5 font-bold text-text-placeholder">
            Next
          </span>
        )}
      </div>
    </div>
  );
}
