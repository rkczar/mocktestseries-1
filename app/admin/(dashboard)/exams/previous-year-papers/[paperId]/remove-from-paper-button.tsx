import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * "Remove From Paper" used to unlink a question from its paper while leaving it
 * PUBLISHED in every test that reused it. It is now Retire / Replace
 * (docs/QUESTION-RETIREMENT.md): the dependency view, then one preview and one
 * confirmation that retires the question everywhere.
 */
export function RetireReplaceLink({ questionId, retired }: { questionId: string; retired: boolean }) {
  return (
    <Button asChild size="compact" variant="ghost">
      <Link href={`/admin/questions/${questionId}/replace`}>{retired ? "View retirement" : "Retire / Replace"}</Link>
    </Button>
  );
}
