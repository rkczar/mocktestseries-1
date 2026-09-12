import { prisma } from "@/lib/prisma";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { buildGraph } from "@/lib/diagram-graph";
import { ROUTE_CONNECTIONS, STUDENT_JOURNEY_FLOW } from "@/lib/route-connections";
import { RegistryTable } from "./registry-table";
import { GraphView } from "./graph-view";

export const metadata = { title: "Website Diagram — Mock Test Series.in Admin" };

export default async function WebsiteDiagramPage() {
  const entries = await prisma.routeRegistryEntry.findMany({ orderBy: [{ module: "asc" }, { route: "asc" }] });
  const graph = buildGraph(entries, ROUTE_CONNECTIONS);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Website Diagram</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Visual map of every page and how it connects — where a page starts, where it goes, and whether the
          connection actually works.
        </p>
      </div>

      <Tabs defaultValue="wiring">
        <TabsList>
          <TabsTrigger value="wiring">Wiring</TabsTrigger>
          <TabsTrigger value="flow">Flow</TabsTrigger>
          <TabsTrigger value="registry">Registry</TabsTrigger>
        </TabsList>

        <TabsContent value="wiring">
          <GraphView graph={graph} mode="wiring" />
        </TabsContent>

        <TabsContent value="flow">
          <GraphView graph={graph} mode="flow" journeyOrder={STUDENT_JOURNEY_FLOW} />
        </TabsContent>

        <TabsContent value="registry">
          <RegistryTable entries={entries} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
