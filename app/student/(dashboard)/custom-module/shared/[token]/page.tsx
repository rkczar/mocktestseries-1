import { notFound } from "next/navigation";
import { HelpCircle, Clock, Share2 } from "lucide-react";
import { requireStudent } from "@/lib/student-session";
import { getCustomModuleByShareToken } from "@/lib/student-data";
import { startSharedCustomModuleAction } from "../../builder/actions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/student/back-button";

export const metadata = { title: "Shared Module — Mock Test Series.in" };

export default async function SharedCustomModulePage({ params }: { params: Promise<{ token: string }> }) {
  await requireStudent();
  const { token } = await params;
  const customModule = await getCustomModuleByShareToken(token);
  if (!customModule) notFound();

  return (
    <div className="flex flex-col gap-6">
      <BackButton href="/student/custom-module" />
      <div className="flex items-center gap-2">
        <Share2 className="h-5 w-5 text-[var(--color-primary)]" aria-hidden />
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Shared Module</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{customModule.title}</CardTitle>
          <CardDescription>{customModule.exam.name}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-4 text-sm text-[var(--color-muted-foreground)]">
            <span className="flex items-center gap-1.5">
              <HelpCircle className="h-4 w-4" aria-hidden /> {customModule._count.questions} questions
            </span>
            {customModule.durationMinutes ? (
              <span className="flex items-center gap-1.5">
                <Clock className="h-4 w-4" aria-hidden /> {customModule.durationMinutes} min
              </span>
            ) : null}
          </div>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Starting this creates your own independent attempt against the same fixed question set — your progress is
            never shared with whoever sent you this link.
          </p>
          <form action={startSharedCustomModuleAction.bind(null, token)}>
            <Button type="submit" size="lg" className="w-full">
              Start Module
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
