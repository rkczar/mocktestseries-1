import { ClipboardCheck } from "lucide-react";
import Link from "next/link";

import { cn } from "@/lib/utils";

export function Logo({ size = "md" }: { size?: "sm" | "md" }) {
  const box = size === "md" ? "size-[34px] rounded-[9px]" : "size-[30px] rounded-lg";
  const icon = size === "md" ? "size-[18px]" : "size-4";
  const text = size === "md" ? "text-[20px]" : "text-[17.5px]";

  return (
    <Link href="/" className="flex flex-none items-center gap-2.5">
      <span className={cn("flex flex-none items-center justify-center bg-primary", box)}>
        <ClipboardCheck className={cn("text-primary-foreground", icon)} strokeWidth={2.2} />
      </span>
      <span className={cn("font-display font-bold tracking-[-.01em] whitespace-nowrap text-primary", text)}>
        MockTestSeries<span className="text-brand-accent">.in</span>
      </span>
    </Link>
  );
}
