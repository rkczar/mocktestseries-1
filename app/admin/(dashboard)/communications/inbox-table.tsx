import Link from "next/link";
import type { CommunicationType } from "@prisma/client";
import { listCommunications } from "@/lib/communications";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { CommunicationStatusSelect } from "./status-select";

const INTEREST_LABEL: Record<string, string> = {
  TEACHER: "Teacher / Educator",
  TEST_SERIES_CREATOR: "Test Series Creator / Contributor",
  IT_SUPPORT: "IT / Technical Support",
  CONTENT_CONTRIBUTOR: "Content / Question Contributor",
  OTHER: "Other",
};

function formatDate(d: Date): string {
  return d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

export async function InboxTable({ type, title, description }: { type?: CommunicationType; title: string; description: string }) {
  const rows = await listCommunications({ type });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          {description} · {rows.length} shown
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">Nothing here yet.</p>
        ) : (
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-xs uppercase tracking-wide text-[var(--color-muted-foreground)]">
                <th className="py-2 pr-4 font-medium">Reference</th>
                <th className="py-2 pr-4 font-medium">Type</th>
                <th className="py-2 pr-4 font-medium">Name / Contact</th>
                <th className="py-2 pr-4 font-medium">Subject / Interest</th>
                <th className="py-2 pr-4 font-medium">Message</th>
                <th className="py-2 pr-4 font-medium">Created</th>
                <th className="py-2 pr-4 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-[var(--color-border)] align-top last:border-0">
                  <td className="py-2.5 pr-4">
                    <Link href={`/admin/communications/${r.id}`} className="font-mono text-xs text-[var(--color-primary)] hover:underline">
                      {r.referenceId}
                    </Link>
                  </td>
                  <td className="py-2.5 pr-4 text-xs">{r.type === "CONTACT" ? "Contact" : "Grow With Us"}</td>
                  <td className="py-2.5 pr-4">
                    <p className="text-[var(--color-foreground)]">{r.name}</p>
                    <p className="text-xs text-[var(--color-muted-foreground)]">{r.email}</p>
                    {r.phone ? <p className="text-xs text-[var(--color-muted-foreground)]">{r.phone}</p> : null}
                  </td>
                  <td className="py-2.5 pr-4 max-w-[160px]">
                    {r.subject ?? (r.interestType ? (INTEREST_LABEL[r.interestType] ?? r.interestType) : "—")}
                  </td>
                  <td className="max-w-xs py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                    {r.message.length > 80 ? `${r.message.slice(0, 80)}…` : r.message}
                  </td>
                  <td className="py-2.5 pr-4 whitespace-nowrap text-xs text-[var(--color-muted-foreground)]">{formatDate(r.createdAt)}</td>
                  <td className="py-2.5 pr-4">
                    <CommunicationStatusSelect id={r.id} status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
