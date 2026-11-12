import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublicExamBySlug } from "@/lib/exam-public";
import { getSiteUrl } from "@/lib/site-url";
import { displayExamName } from "@/lib/exam-display";
import { examPageMetadata } from "@/lib/exam-seo";
import { examShortName } from "@/lib/exam-editorial-facts";
import { hasImportantTopicsPage } from "@/lib/exam-editorial-pages";
import { getImportantTopics, IMPORTANT_TOPICS_MIN } from "@/lib/exam-important-topics";
import { EditorialExamPage } from "@/components/public-exam/editorial-page";

/** Most-asked topics in an exam's previous papers. Only for opted-in exams (RUHS MO's stays on hold) with enough data. */
async function load(slug: string) {
  const exam = await getPublicExamBySlug(slug);
  if (!exam || !hasImportantTopicsPage(exam.code)) return null;
  const topics = await getImportantTopics(exam.id);
  return topics.length >= IMPORTANT_TOPICS_MIN ? { exam, topics } : null;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const data = await load((await params).slug);
  if (!data) return {};
  const short = examShortName(data.exam.code, displayExamName(data.exam.name));
  return examPageMetadata({
    exam: data.exam,
    path: `/exams/${data.exam.publicSlug}/important-topics`,
    title: `${short} Important Topics from Previous Papers`,
    description: `${short}: the ${data.topics.length} topics asked most often in the previous year papers, with the number of questions per paper. Counted from the papers, not a forecast.`,
  });
}

export default async function ImportantTopicsPage({ params }: { params: Promise<{ slug: string }> }) {
  const data = await load((await params).slug);
  if (!data) notFound();
  const name = displayExamName(data.exam.name);
  const years = [...new Set(data.topics.flatMap((t) => t.byYear.map((y) => y.year)))].sort();
  return (
    <EditorialExamPage
      siteUrl={await getSiteUrl()}
      examName={name}
      slug={data.exam.publicSlug!}
      crumb="Important Topics"
      page={{
        title: `${examShortName(data.exam.code, name)} Important Topics`,
        intro: `The topics asked most often in the ${years.join(" and ")} previous year papers, counted from our classified question bank. Two papers are a small sample: use this to prioritise revision, not to skip any part of the official syllabus.`,
        blocks: [],
        sources: [],
        checkedOn: new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" }),
      }}
    >
      <section className="max-w-4xl overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
              <th className="py-2 pr-3">Topic</th>
              <th className="py-2 pr-3">Subject</th>
              {years.map((y) => (
                <th key={y} className="py-2 pr-3 text-right">
                  {y}
                </th>
              ))}
              <th className="py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {data.topics.map((t) => (
              <tr key={t.topicId} className="border-b border-[var(--color-border)]">
                <td className="py-2 pr-3 font-medium text-[var(--color-foreground)]">{t.topic}</td>
                <td className="py-2 pr-3 text-[var(--color-muted-foreground)]">{t.subject ?? "—"}</td>
                {years.map((y) => (
                  <td key={y} className="py-2 pr-3 text-right">
                    {t.byYear.find((b) => b.year === y)?.count ?? 0}
                  </td>
                ))}
                <td className="py-2 text-right font-semibold">{t.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </EditorialExamPage>
  );
}
