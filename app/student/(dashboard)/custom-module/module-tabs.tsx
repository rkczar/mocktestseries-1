"use client";

import { useCallback, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

/**
 * Two-tab shell for /student/custom-module (Section 8): "Build Test" is the
 * default so opening Custom Module no longer requires an extra click through
 * a "Build Your Own" landing step, and "My Modules" keeps everything that
 * used to be the whole page (curated-by-Admin + the student's own modules)
 * one click away, never removed. Active tab lives in `?tab=` so it survives
 * a refresh and stays deep-linkable, same pattern as the Admin Control
 * Center tabs.
 */
export function CustomModuleTabs({ buildContent, myModulesContent }: { buildContent: ReactNode; myModulesContent: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const requested = searchParams.get("tab");
  const active = requested === "my-modules" ? "my-modules" : "build";

  const handleChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("tab", value);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  return (
    <Tabs value={active} onValueChange={handleChange}>
      <TabsList>
        <TabsTrigger value="build">Build Test</TabsTrigger>
        <TabsTrigger value="my-modules">My Modules</TabsTrigger>
      </TabsList>
      <TabsContent value="build">{buildContent}</TabsContent>
      <TabsContent value="my-modules">{myModulesContent}</TabsContent>
    </Tabs>
  );
}
