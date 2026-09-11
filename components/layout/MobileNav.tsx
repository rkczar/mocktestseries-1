"use client";

import { Menu } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import type { CtaButtonDTO } from "@/lib/content/types";

import { NAV_ITEMS } from "./nav-items";

export function MobileNav({ registerCta }: { registerCta: CtaButtonDTO }) {
  return (
    <Sheet>
      <SheetTrigger
        render={
          <Button variant="ghost" size="icon" aria-label="Open menu" className="lg:hidden" />
        }
      >
        <Menu className="size-5" />
      </SheetTrigger>
      <SheetContent side="right" className="gap-0 p-0">
        <SheetHeader className="border-b border-border p-5">
          <SheetTitle className="font-display text-lg text-text-heading">Menu</SheetTitle>
        </SheetHeader>
        <nav className="flex flex-col gap-1 p-3">
          {NAV_ITEMS.map((item) => (
            <SheetClose
              key={item.href}
              nativeButton={false}
              render={
                <Link
                  href={item.href}
                  className="rounded-lg px-3 py-3 text-[15px] font-medium text-text-muted hover:bg-accent hover:text-primary"
                />
              }
            >
              {item.label}
            </SheetClose>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2 border-t border-border p-4">
          <SheetClose
            nativeButton={false}
            render={
              <Link
                href="/student/login"
                className="rounded-[9px] border border-border-strong px-4 py-2.5 text-center text-[14.5px] font-bold text-primary hover:bg-accent"
              />
            }
          >
            Login
          </SheetClose>
          <SheetClose
            nativeButton={false}
            render={
              <Link
                href={registerCta.href}
                className="rounded-[9px] bg-primary px-4 py-2.5 text-center text-[14.5px] font-bold text-primary-foreground hover:bg-primary-hover"
              />
            }
          >
            {registerCta.label}
          </SheetClose>
        </div>
      </SheetContent>
    </Sheet>
  );
}
