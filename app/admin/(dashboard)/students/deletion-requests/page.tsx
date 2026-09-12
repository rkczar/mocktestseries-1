import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DeletionActions } from "./deletion-actions";

export const metadata = { title: "Deletion Requests — Mock Test Series.in Admin" };

export default async function DeletionRequestsPage() {
  const requests = await prisma.deletionRequest.findMany({
    orderBy: { requestedAt: "desc" },
    include: { student: true },
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Deletion Requests</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Approving a request anonymizes the student&apos;s personal information and keeps attempt records for
          retention. Rejecting leaves the account untouched.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Requests</CardTitle>
          <CardDescription>{requests.length} total</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {requests.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No deletion requests.</p>
          ) : (
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Student</th>
                  <th className="py-2 pr-4">Reason</th>
                  <th className="py-2 pr-4">Requested</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2.5 pr-4 text-[var(--color-foreground)]">
                      {r.student.name}
                      <br />
                      <span className="font-mono text-xs text-[var(--color-muted-foreground)]">{r.student.studentId}</span>
                    </td>
                    <td className="max-w-xs py-2.5 pr-4 text-[var(--color-muted-foreground)]">{r.reason || "—"}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{r.requestedAt.toLocaleString()}</td>
                    <td className="py-2.5 pr-4">
                      <Badge variant={r.status === "PENDING" ? "warning" : r.status === "APPROVED" ? "error" : "neutral"}>
                        {r.status}
                      </Badge>
                    </td>
                    <td className="py-2.5 pr-4">{r.status === "PENDING" ? <DeletionActions requestId={r.id} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
