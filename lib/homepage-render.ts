import { prisma } from "@/lib/prisma";
import { LIVE_MOCK_TEST_WHERE } from "@/lib/mock-test-schedule";
import type { HomepageConfig, HomepageSection, Exam, PreviousYearPaper, TestSeries, MockTest } from "@prisma/client";
import {
  normalizeStatMetrics,
  normalizeUpcomingExams,
  normalizeHeroPanel,
  type StatMetric,
  type UpcomingExamConfig,
  type HeroPanelConfig,
} from "@/lib/homepage-field-codec";
import { getHomepageStatistics } from "@/lib/homepage-statistics";
import { BRAND_NAME } from "@/lib/brand";
import { getExamMockSeriesSummary, type ExamMockSeriesSummary } from "@/lib/mock-series";

export interface ResolvedStatValue {
  label: string;
  value: string;
  description?: string;
  icon?: string;
  badge?: string;
  link?: string;
  mode: StatMetric["mode"];
}

export interface ResolvedExamStats {
  mockTests: number;
  previousYearPapers: number;
  questionBank: number;
  aiExplanations: number;
}

export interface ResolvedHeroPanel {
  config: HeroPanelConfig;
  /** Real platform aggregates shown when the panel is in LIVE mode. */
  live: { questionsAnswered: number; mockTestsAttempted: number; aiExplanations: number; activeExams: number };
  /** Zero iff there is no live data to show yet. */
  liveCount: number;
}

export interface ResolvedFeaturedTest {
  id: string;
  title: string;
  durationMinutes: number;
  negativeMarking: number;
  questionCount: number;
  status: MockTest["status"];
  examId: string;
  examName: string;
  route: string;
}

export interface ResolvedUpcomingExam {
  exam: Exam;
  config: UpcomingExamConfig;
  daysLeft: number | null;
}

export interface ResolvedHomepage {
  seo: { title?: string; metaDescription?: string; canonicalUrl?: string; ogTitle?: string; ogDescription?: string };
  sections: {
    key: HomepageSection["key"];
    isEnabled: boolean;
    order: number;
    content: Record<string, unknown>;
    resolved: {
      exam?: Exam | null;
      examStats?: ResolvedExamStats | null;
      examRoute?: string | null;
      upcomingExams?: ResolvedUpcomingExam[];
      papers?: PreviousYearPaper[];
      paperExamId?: string | null;
      testSeries?: (TestSeries & { exam: { name: string } })[];
      featuredTests?: ResolvedFeaturedTest[];
      liveMockTestCount?: number;
      /** Canonical Mock Test Series (lib/mock-series.ts) — real counts, product price, landing URL. */
      mockSeries?: (ExamMockSeriesSummary & { examName: string }) | null;
      statValues?: ResolvedStatValue[];
      heroPanel?: ResolvedHeroPanel;
      copyrightLine?: string;
    };
  }[];
}

function resolveStatValue(metric: StatMetric, stats: Awaited<ReturnType<typeof getHomepageStatistics>>): string {
  if (metric.mode === "LIVE") {
    return metric.dynamicKey ? String(stats.values[metric.dynamicKey] ?? 0) : "0";
  }
  if (metric.mode === "DEMO") return metric.demoValue ?? "";
  return metric.manualValue ?? "";
}

async function resolveExamStats(examId: string): Promise<ResolvedExamStats> {
  const [exam, aiExplanations] = await Promise.all([
    prisma.exam.findUnique({
      where: { id: examId },
      include: {
        _count: {
          select: {
            mockTests: { where: { status: "PUBLISHED" } },
            previousYearPapers: { where: { isActive: true } },
            questions: { where: { status: "PUBLISHED" } },
          },
        },
      },
    }),
    prisma.aIExplanation.count({ where: { question: { examId } } }),
  ]);

  return {
    mockTests: exam?._count.mockTests ?? 0,
    previousYearPapers: exam?._count.previousYearPapers ?? 0,
    questionBank: exam?._count.questions ?? 0,
    aiExplanations,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysUntil(date: Date): number {
  return Math.ceil((date.getTime() - Date.now()) / DAY_MS);
}

export async function resolveHomepage(config: HomepageConfig & { sections: HomepageSection[] }): Promise<ResolvedHomepage> {
  // Single shared live-stats snapshot for every section that needs platform
  // totals (statistics cards, hero panel LIVE mode, hero supporting stats).
  const platformStats = getHomepageStatistics();
  const liveMockTestCountPromise = prisma.mockTest.count({ where: LIVE_MOCK_TEST_WHERE });
  // One lazily-resolved canonical series per exam, shared by every section
  // that promotes it (Featured Exam, Mock Test Promotion, Test Series).
  const seriesByExam = new Map<string, Promise<(ExamMockSeriesSummary & { examName: string }) | null>>();
  const seriesFor = (examId: string) => {
    if (!seriesByExam.has(examId)) {
      seriesByExam.set(
        examId,
        prisma.exam.findUnique({ where: { id: examId } }).then(async (exam) => {
          if (!exam || !exam.isActive) return null;
          const summary = await getExamMockSeriesSummary(exam);
          return summary.mockSeries ? { ...summary, examName: exam.name } : null;
        })
      );
    }
    return seriesByExam.get(examId)!;
  };
  // Default promoted series when a section has no exam reference: the
  // featured exam's, else the first public exam that has a published series.
  const featuredExamRef = config.sections.find((s) => s.key === "FEATURED_EXAM")?.references as Record<string, unknown> | null;
  const primarySeries = async () => {
    if (typeof featuredExamRef?.examId === "string") {
      const hit = await seriesFor(featuredExamRef.examId);
      if (hit) return hit;
    }
    const first = await prisma.testSeries.findFirst({
      where: { status: "PUBLISHED", exam: { isActive: true, publicPageEnabled: true } },
      orderBy: [{ exam: { order: "asc" } }, { order: "asc" }, { createdAt: "asc" }],
      select: { examId: true },
    });
    return first ? seriesFor(first.examId) : null;
  };

  const sections = await Promise.all(
    config.sections
      .sort((a, b) => a.order - b.order)
      .map(async (section) => {
        const content = section.content as Record<string, unknown>;
        const references = (section.references as Record<string, unknown>) ?? {};
        const resolved: ResolvedHomepage["sections"][number]["resolved"] = {};

        if (section.key === "FEATURED_EXAM" && typeof references.examId === "string") {
          const exam = await prisma.exam.findUnique({ where: { id: references.examId } });
          resolved.exam = exam && exam.isActive ? exam : null;
          if (resolved.exam) {
            resolved.examStats = await resolveExamStats(resolved.exam.id);
            // Prefer the public landing page once an exam has one — it's the
            // right destination for an anonymous homepage visitor. Exams
            // without a built/enabled public page (e.g. not yet launched)
            // fall back to the student workspace, same as before.
            resolved.examRoute =
              resolved.exam.publicPageEnabled && resolved.exam.publicSlug
                ? `/exams/${resolved.exam.publicSlug}`
                : `/student/exams/${resolved.exam.id}`;
            resolved.mockSeries = await seriesFor(resolved.exam.id);
          }
        }

        if (section.key === "HERO") {
          const panel = normalizeHeroPanel(content.panel);
          let live = { questionsAnswered: 0, mockTestsAttempted: 0, aiExplanations: 0, activeExams: 0 };
          if (panel.mode === "LIVE") {
            live = {
              questionsAnswered: (await platformStats).values.questionsAnswered,
              mockTestsAttempted: (await platformStats).values.mockTestsAttempted,
              aiExplanations: (await platformStats).values.aiExplanations,
              activeExams: (await platformStats).values.examsActive,
            };
          }
          const liveCount = Object.values(live).reduce((sum, n) => sum + (n || 0), 0);
          resolved.heroPanel = { config: panel, live, liveCount };

          // Supporting statistics under the headline (real numbers only).
          const stats = await platformStats;
          const heroStatValues: ResolvedStatValue[] = [
            {
              label: "Published Tests",
              value: String((await liveMockTestCountPromise)),
              mode: "LIVE",
            },
            { label: "Questions", value: String(stats.values.questionBank), mode: "LIVE" },
            { label: "Active Exams", value: String(stats.values.examsActive), mode: "LIVE" },
          ];
          resolved.statValues = heroStatValues.filter((s) => s.value !== "0");
        }

        if (section.key === "MOCK_TEST_PROMOTION") {
          resolved.liveMockTestCount = await liveMockTestCountPromise;
          resolved.mockSeries = await primarySeries();
        }

        if (section.key === "UPCOMING_EXAMS") {
          const configs = normalizeUpcomingExams(content.exams, references.examIds).filter((c) => c.enabled);
          if (configs.length > 0) {
            const exams = await prisma.exam.findMany({
              where: { id: { in: configs.map((c) => c.examId) }, isActive: true },
            });
            const examById = new Map(exams.map((e) => [e.id, e]));
            resolved.upcomingExams = configs
              .map((config) => {
                const exam = examById.get(config.examId);
                return exam ? { exam, config, daysLeft: exam.upcomingDate ? daysUntil(exam.upcomingDate) : null } : null;
              })
              .filter((entry): entry is ResolvedUpcomingExam => entry !== null);
          }
        }

        if (section.key === "PREVIOUS_YEAR_PAPERS") {
          const explicitIds = Array.isArray(references.paperIds) ? (references.paperIds as string[]) : [];
          const examId = typeof references.examId === "string" ? references.examId : undefined;
          const maxCardsRaw = typeof content.maxCards === "string" ? content.maxCards.trim() : "";
          const maxCards = Number.isFinite(Number(maxCardsRaw)) && Number(maxCardsRaw) > 0 ? Number(maxCardsRaw) : undefined;

          if (explicitIds.length > 0) {
            resolved.papers = await prisma.previousYearPaper.findMany({
              where: { id: { in: explicitIds }, isActive: true },
              orderBy: { year: "desc" },
            });
          } else if (examId) {
            resolved.papers = await prisma.previousYearPaper.findMany({
              where: { examId, isActive: true },
              orderBy: [{ year: "desc" }, { order: "asc" }],
              take: maxCards,
            });
          }
          resolved.paperExamId = examId ?? null;
        }

        if (section.key === "TEST_SERIES") {
          resolved.mockSeries = await primarySeries();
        }

        if (section.key === "TEST_SERIES" && Array.isArray(references.testSeriesIds)) {
          resolved.testSeries = await prisma.testSeries.findMany({
            where: { id: { in: references.testSeriesIds as string[] }, isActive: true, status: "PUBLISHED" },
            orderBy: { order: "asc" },
            include: { exam: { select: { name: true } } },
          });
        }

        if (section.key === "TEST_SERIES") {
          const explicitTestIds = Array.isArray(references.featuredTestIds) ? (references.featuredTestIds as string[]) : [];
          const showLiveTests = content.showLiveTests !== false;
          const maxTestsRaw = typeof content.maxTests === "string" ? content.maxTests.trim() : "";
          const maxTests = Number.isFinite(Number(maxTestsRaw)) && Number(maxTestsRaw) > 0 ? Number(maxTestsRaw) : 6;

          const rows: { mockTest: MockTest; questionCount: number; examName: string }[] = [];
          if (showLiveTests) {
            const baseQuery = {
              where: LIVE_MOCK_TEST_WHERE,
              include: { _count: { select: { questions: true } }, exam: { select: { id: true, name: true } } },
              orderBy: { createdAt: "desc" as const },
              take: Math.max(maxTests, explicitTestIds.length),
            };
            if (explicitTestIds.length > 0) {
              const explicit = await prisma.mockTest.findMany({ ...baseQuery, where: { id: { in: explicitTestIds }, ...LIVE_MOCK_TEST_WHERE } });
              const byId = new Map(explicit.map((t) => [t.id, t]));
              explicitTestIds.forEach((id) => {
                const t = byId.get(id);
                if (t) rows.push({ mockTest: t, questionCount: t._count.questions, examName: t.exam.name });
              });
              // Top up with the newest tests if fewer explicit ones exist than the limit.
              const remaining = maxTests - rows.length;
              if (remaining > 0) {
                const extra = await prisma.mockTest.findMany({
                  where: { ...LIVE_MOCK_TEST_WHERE, id: { notIn: explicitTestIds } },
                  include: { _count: { select: { questions: true } }, exam: { select: { id: true, name: true } } },
                  orderBy: { createdAt: "desc" },
                  take: remaining,
                });
                extra.forEach((t) => rows.push({ mockTest: t, questionCount: t._count.questions, examName: t.exam.name }));
              }
            } else {
              const auto = await prisma.mockTest.findMany({ ...baseQuery, take: maxTests });
              auto.forEach((t) => rows.push({ mockTest: t, questionCount: t._count.questions, examName: t.exam.name }));
            }
          }

          resolved.featuredTests = rows.map(({ mockTest, questionCount, examName }) => ({
            id: mockTest.id,
            title: mockTest.title,
            durationMinutes: mockTest.durationMinutes,
            negativeMarking: mockTest.negativeMarking,
            questionCount,
            status: mockTest.status,
            examId: mockTest.examId,
            examName,
            route: `/student/exams/${mockTest.examId}`,
          }));
        }

        if (section.key === "STATISTICS" && Array.isArray(content.metrics)) {
          const stats = await platformStats;
          const hideZeroLive = content.hideZeroLive === true;
          const metrics = normalizeStatMetrics(content.metrics).filter((m) => m.enabled);
          resolved.statValues = metrics.map((m) => ({
            label: m.label,
            value: resolveStatValue(m, stats),
            description: m.description,
            icon: m.icon,
            badge: m.badge,
            link: m.link,
            mode: m.mode,
          }));
          if (hideZeroLive) {
            resolved.statValues = resolved.statValues.filter((v) => !(v.mode === "LIVE" && v.value === "0"));
          }
        }

        if (section.key === "FOOTER") {
          const year = new Date().getFullYear();
          const override = typeof content.copyrightOverride === "string" ? content.copyrightOverride : "";
          resolved.copyrightLine = override || `© ${year} ${BRAND_NAME}`;
        }

        return { key: section.key, isEnabled: section.isEnabled, order: section.order, content, resolved };
      })
  );

  return { seo: (config.seo as ResolvedHomepage["seo"]) ?? {}, sections };
}