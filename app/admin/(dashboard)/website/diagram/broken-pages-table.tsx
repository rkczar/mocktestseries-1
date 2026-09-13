import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { DiagramNode } from "@/lib/diagram-graph";

function problemFor(node: DiagramNode): string {
  if (node.status === "BROKEN") return "Broken route — registered but no page.tsx found";
  if (node.status === "ORPHAN") return "Orphan — parent page no longer exists";
  if (node.status === "UNAUTHORIZED") return "Public route requires auth — misconfigured";
  if (node.isolated) return "Isolated — no incoming or outgoing links";
  if (node.noIncoming) return "No incoming links — only reachable by direct URL";
  return "—";
}

export function BrokenPagesTable({ nodes }: { nodes: DiagramNode[] }) {
  const problems = nodes.filter(
    (n) => n.status === "BROKEN" || n.status === "ORPHAN" || n.status === "UNAUTHORIZED" || n.isolated || n.noIncoming
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Broken &amp; disconnected pages</CardTitle>
        <CardDescription>
          Every page currently flagged broken, orphaned, or unreachable — computed live from the route registry and
          the actual link graph.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {problems.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--color-muted-foreground)]">
            Nothing to report — every page has at least one working incoming and outgoing connection.
          </p>
        ) : (
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                <th className="py-2 pr-4">Page</th>
                <th className="py-2 pr-4">Route</th>
                <th className="py-2 pr-4">Problem</th>
                <th className="py-2 pr-4">Incoming</th>
                <th className="py-2 pr-4">Outgoing</th>
              </tr>
            </thead>
            <tbody>
              {problems.map((node) => (
                <tr key={node.id} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">{node.pageName}</td>
                  <td className="py-2.5 pr-4 font-mono text-xs text-[var(--color-muted-foreground)]">{node.route}</td>
                  <td className="py-2.5 pr-4">
                    <Badge variant="error">{problemFor(node)}</Badge>
                  </td>
                  <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{node.incoming.length}</td>
                  <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{node.outgoing.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
