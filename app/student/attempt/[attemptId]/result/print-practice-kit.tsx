import { Printer } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * Links always render when a resource exists — the actual download request
 * is checked server-side on every hit by app/api/student/test-resources/[id]
 * via lib/test-resources-access.ts#canAccessTestResource. A rendered link
 * here is not itself an unlock.
 */
export function PrintPracticeKit({
  paperResourceId,
  omrResourceId,
}: {
  paperResourceId: string | null;
  omrResourceId: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Printer className="h-4 w-4" aria-hidden /> Print Practice Kit
        </CardTitle>
        <CardDescription>Print the question paper and OMR sheet to practice like the real, paper-based exam.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {paperResourceId ? (
          <Button asChild size="sm" variant="outline">
            <a href={`/api/student/test-resources/${paperResourceId}`}>Download Question Paper</a>
          </Button>
        ) : null}
        {omrResourceId ? (
          <Button asChild size="sm" variant="outline">
            <a href={`/api/student/test-resources/${omrResourceId}`}>Download OMR Sheet</a>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
