import { prisma } from "@/lib/prisma";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { buildGraph, type DiagramEntry } from "@/lib/diagram-graph";
import { buildDiagramSource } from "@/lib/diagram-source";
import { scanGlobalNavLinks } from "@/lib/global-nav-links";
import { studentFlowNodeIds, adminFlowNodeIds, publicFlowNodeIds } from "@/lib/curated-flows";
import { getAuthProviderConfig } from "@/lib/auth-provider-config";
import { RegistryTable } from "./registry-table";
import { BrokenPagesTable } from "./broken-pages-table";
import { GraphView } from "./graph-view";

export const metadata = { title: "Website Diagram — Mock Test Series.in Admin" };

export default async function WebsiteDiagramPage() {
  const [dbEntries, authConfig] = await Promise.all([
    prisma.routeRegistryEntry.findMany({ orderBy: [{ module: "asc" }, { route: "asc" }] }),
    getAuthProviderConfig(),
  ]);

  const diagramEntries: DiagramEntry[] = dbEntries.map((e) => ({
    pageName: e.pageName,
    route: e.route,
    module: e.module,
    userType: e.userType,
    authRequired: e.authRequired,
    parentRoute: e.parentRoute,
    status: e.status,
  }));

  const { entries, connections } = buildDiagramSource(diagramEntries);
  const graph = buildGraph(entries, connections);
  const globalNavGroups = scanGlobalNavLinks();

  const flowErrors: string[] = [];
  if (!authConfig.google.enabled) flowErrors.push("Google Sign-In is OFF — configure it in API Management to clear this error.");
  if (!authConfig.msg91.enabled) flowErrors.push("Phone OTP/SMS is OFF — configure it in API Management to clear this error.");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Website Diagram</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          A live architecture inspector — every page, every real connection between them, what&apos;s broken, and
          what&apos;s disconnected. Routes and links are scanned from the actual codebase on every load, so a new
          page or link shows up here automatically.
        </p>
      </div>

      <Tabs defaultValue="overview">
        <TabsList className="h-auto flex-wrap gap-1">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="student">Student Flow</TabsTrigger>
          <TabsTrigger value="admin">Admin Flow</TabsTrigger>
          <TabsTrigger value="public">Public Flow</TabsTrigger>
          <TabsTrigger value="broken">Broken &amp; Disconnected</TabsTrigger>
          <TabsTrigger value="registry">Registry</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <GraphView graph={graph} variant="explorable" />
        </TabsContent>

        <TabsContent value="student">
          <GraphView
            graph={graph}
            variant="fixed"
            fixedNodeIds={studentFlowNodeIds()}
            flowErrors={flowErrors}
            caption="The canonical student journey — every step is a real, currently-connected page."
          />
        </TabsContent>

        <TabsContent value="admin">
          <GraphView
            graph={graph}
            variant="fixed"
            fixedNodeIds={adminFlowNodeIds()}
            caption="Admin Dashboard and the primary page of every sidebar section — derived from lib/admin-nav.ts."
          />
        </TabsContent>

        <TabsContent value="public">
          <GraphView
            graph={graph}
            variant="fixed"
            fixedNodeIds={publicFlowNodeIds(entries)}
            caption="Every public-facing page reachable from the homepage, plus student login."
          />
        </TabsContent>

        <TabsContent value="broken">
          <BrokenPagesTable nodes={graph.nodes} />
        </TabsContent>

        <TabsContent value="registry">
          <RegistryTable entries={entries} globalNavGroups={globalNavGroups} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
