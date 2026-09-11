import { Search } from "lucide-react";

export function SearchBar({
  action,
  placeholder = "Search…",
  defaultValue,
  children,
}: {
  action: string;
  placeholder?: string;
  defaultValue?: string;
  children?: React.ReactNode;
}) {
  return (
    <form action={action} method="GET" className="mb-5 flex flex-wrap items-center gap-3">
      <div className="relative min-w-0 flex-1 basis-64">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-placeholder" />
        <input
          type="search"
          name="q"
          placeholder={placeholder}
          defaultValue={defaultValue}
          className="h-10 w-full rounded-[9px] border border-border-strong bg-surface pr-3 pl-9 text-sm outline-none focus-visible:border-primary"
        />
      </div>
      {children}
      <button
        type="submit"
        className="rounded-[9px] bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground hover:bg-primary-hover"
      >
        Filter
      </button>
    </form>
  );
}
