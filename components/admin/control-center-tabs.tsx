"use client";

import { useCallback, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

export interface ControlCenterTab {
  value: string;
  label: string;
  content: ReactNode;
}

/**
 * Shared tab shell for every Control Center module page. Active tab lives in the `?tab=`
 * query param (via router.replace, no scroll reset) so every tab stays deep-linkable and
 * survives a refresh — used by the Storage/System module and every consolidated module in
 * Phase 3 of the admin panel consolidation.
 */
export function ControlCenterTabs({ tabs, defaultValue }: { tabs: ControlCenterTab[]; defaultValue?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const validValues = tabs.map((t) => t.value);
  const requested = searchParams.get("tab");
  const active = requested && validValues.includes(requested) ? requested : (defaultValue ?? tabs[0]?.value);

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
      <TabsList className="h-auto flex-wrap justify-start">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.value} value={tab.value}>
          {tab.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
