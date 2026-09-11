import { cn } from "@/lib/utils";

export function Container({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  // w-full + min-w-0: every page's <body> is a column flex container (see app/layout.tsx), and
  // a flex item with auto cross-axis margins (mx-auto, for centering under max-w) opts out of
  // the default stretch sizing — without an explicit width it shrink-wraps to its widest
  // descendant's content instead of the viewport, dragging the whole page into horizontal
  // overflow the moment any descendant (e.g. a min-w-[…] scrollable table) needs more room.
  return <div className={cn("mx-auto w-full min-w-0 max-w-[1200px] px-6", className)}>{children}</div>;
}
