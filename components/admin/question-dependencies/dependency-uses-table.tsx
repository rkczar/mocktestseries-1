import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { DependencyUse } from "@/lib/question-dependencies";

export const KIND_LABEL: Record<DependencyUse["kind"], string> = {
  MOCK_TEST: "Mock Test",
  CUSTOM_MODULE: "Custom Module",
  GRAND_TEST: "Grand Test",
  LIVE_TEST: "Live Test",
};

function hrefFor(u: DependencyUse): string | null {
  if (u.kind === "MOCK_TEST") return `/admin/tests/mock/${u.id}`;
  if (u.kind === "CUSTOM_MODULE" && !u.studentOwned) return `/admin/custom-modules/${u.id}`;
  return null;
}

/** Where one question is used: test / module, its status and the question's position in it. */
export function DependencyUsesTable({ uses }: { uses: DependencyUse[] }) {
  if (uses.length === 0) {
    return <p className="text-sm text-[var(--color-muted-foreground)]">Not used in any Mock Test, Custom Module, Grand or Live Test.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
            <th className="py-2 pr-4">Type</th>
            <th className="py-2 pr-4">Name</th>
            <th className="py-2 pr-4">Status</th>
            <th className="py-2 pr-4">Position</th>
          </tr>
        </thead>
        <tbody>
          {uses.map((u) => {
            const href = hrefFor(u);
            return (
              <tr key={`${u.kind}:${u.id}:${u.position}`} className="border-b border-[var(--color-border)] last:border-0">
                <td className="py-2 pr-4 text-[var(--color-muted-foreground)]">
                  {KIND_LABEL[u.kind]}
                  {u.studentOwned ? <Badge className="ml-1">student</Badge> : null}
                </td>
                <td className="py-2 pr-4 text-[var(--color-foreground)]">
                  {href ? (
                    <Link href={href} className="text-[var(--color-primary)] hover:underline">
                      {u.title}
                    </Link>
                  ) : (
                    u.title
                  )}
                </td>
                <td className="py-2 pr-4 text-[var(--color-muted-foreground)]">{u.status}</td>
                <td className="py-2 pr-4 font-mono text-xs">Q{u.position}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
