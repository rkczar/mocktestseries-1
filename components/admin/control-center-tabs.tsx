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
 * Phase 3 of the admin panel consolidation. A nested tab set (e.g. Communications → Email's
 * Compose/Templates/…) passes its own `param` so it doesn't fight the outer `?tab=`.
 */
export function ControlCenterTabs({ tabs, defaultValue, param = "tab" }: { tabs: ControlCenterTab[]; defaultValue?: string; param?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const validValues = tabs.map((t) => t.value);
  const requested = searchParams.get(param);
  const active = requested && validValues.includes(requested) ? requested : (defaultValue ?? tabs[0]?.value);

  const handleChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set(param, value);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [param, pathname, router, searchParams]
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
