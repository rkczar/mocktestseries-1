import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, Clock, CreditCard, Info, LogIn, ShieldCheck } from "lucide-react";
import { safeJsonLd } from "@/lib/json-ld";
import { PublicPageShell } from "@/components/homepage/public-page-shell";
import { ExamBreadcrumbs } from "@/components/public-exam/breadcrumbs";
import { PriceTag } from "@/components/public-exam/mock-series-promo";
import { PlanComparison } from "@/components/payments/plan-comparison";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getSiteUrl } from "@/lib/site-url";
import { getSeoSettings, applyTitleTemplate } from "@/lib/seo-settings";
import { defaultSocialImage, socialMetadata } from "@/lib/social-metadata";
import { getStudentSession } from "@/lib/student-session";
import { formatIst } from "@/lib/ist-time";
import { mockSeriesPath } from "@/lib/mock-series";
import { getExamPyqInsights } from "@/lib/exam-pyq-insights";
import { examInsightPath, hasPyqAnalysis } from "@/lib/exam-pyq-analysis";
import { PLANS_AND_PRICING_PATH } from "@/lib/plans-path";
import { getPlanStates, getPublicPlanCatalog, type CatalogPlan, type PlanCatalog, type PlanState } from "@/lib/plans-catalog";

/**
 * Public Plans & Pricing (/plans-and-pricing). Every product, price, discount,
 * validity and benefit is read from Admin → Payments (lib/plans-catalog.ts).
 * Reads the student cookie for the per-plan buttons, so the response is
 * dynamic and `private, no-store` — a guest (and Googlebot) gets the same
 * full server-rendered price list without any student data.
 *
 * SEO target: the RUHS MO purchase / price cluster. The broad "RUHS MO mock
 * test series" head term stays with /exams/[slug]/mock-test-series.
 */

const SEO_TITLE = "RUHS MO 2026 Test Series Price & Plans";
const SEO_DESCRIPTION =
  "Compare RUHS MO 2026 test series plans: complete mock test series, single mock tests, previous year papers and subject-wise practice, with current prices.";
const H1 = "RUHS MO 2026 Test Series — Plans & Pricing";

export async function generateMetadata(): Promise<Metadata> {
  const [seo, siteUrl, catalog] = await Promise.all([getSeoSettings(), getSiteUrl(), getPublicPlanCatalog()]);
  const title = applyTitleTemplate(seo.titleTemplate, SEO_TITLE);
  const url = `${siteUrl}${PLANS_AND_PRICING_PATH}`;
  // No plans on sale = a thin page: keep it out of the index until there are.
  const indexable = seo.siteIndexable && catalog.planCount > 0;
  return {
    title,
    description: SEO_DESCRIPTION,
    alternates: { canonical: url },
    robots: indexable ? { index: true, follow: true } : { index: false, follow: true },
    ...socialMetadata({ title, description: SEO_DESCRIPTION, url, seo, image: defaultSocialImage(seo, siteUrl) }),
  };
}

const OPEN_LABEL: Record<CatalogPlan["productType"], string> = {
  EXAM_ACCESS: "Open Exam",
  TEST_SERIES: "View Series",
  PYQ_PACKAGE: "View Papers",
  GRAND_TEST: "Start Test",
  LIVE_TEST: "Start Test",
  MOCK_TEST: "Start Test",
};

function checkoutHref(plan: CatalogPlan) {
  return `/student/checkout/${encodeURIComponent(plan.code)}`;
}

function loginTo(href: string) {
  return `/login?callbackUrl=${encodeURIComponent(href)}`;
}

/** Badge + buttons for one plan. Guests: Buy Now → login → checkout (Razorpay). */
function PlanActions({ plan, catalog, state, signedIn }: { plan: CatalogPlan; catalog: PlanCatalog; state?: PlanState; signedIn: boolean }) {
  const open = (
    <Button asChild variant="outline" className="w-full sm:w-auto">
      <Link href={signedIn ? plan.openHref : loginTo(plan.openHref)}>{OPEN_LABEL[plan.productType]}</Link>
    </Button>
  );
  const buy = (label: string) =>
    (state ? !state.purchasesPaused : catalog.purchasesOpen) ? (
      <Button asChild variant="primary" className="w-full sm:w-auto">
        <Link href={signedIn ? checkoutHref(plan) : loginTo(checkoutHref(plan))} aria-label={`${label}: ${plan.title}`}>
          {label}
        </Link>
      </Button>
    ) : (
      <p className="text-sm text-[var(--color-muted-foreground)]">Purchases are paused right now.</p>
    );

  if (!catalog.showPrices) {
    return (
      <div className="flex flex-col gap-2">
        <Badge variant="success" className="w-fit">Free right now</Badge>
        {open}
      </div>
    );
  }
  if (!signedIn || !state) return buy("Buy Now");

  switch (state.kind) {
    case "ACTIVE":
      return (
        <div className="flex flex-col gap-2">
          <Badge variant="success" className="w-fit">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Active Plan
          </Badge>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            {state.expiresAt ? `Valid till ${formatIst(state.expiresAt)}` : "Lifetime access"}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            {open}
            {state.renewSoon ? buy("Renew") : null}
          </div>
        </div>
      );
    case "COVERED":
      return (
        <div className="flex flex-col gap-2">
          <Badge variant="success" className="w-fit">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Already Enrolled
          </Badge>
          {state.coveredBy ? <p className="text-xs text-[var(--color-muted-foreground)]">Included in {state.coveredBy}</p> : null}
          {open}
        </div>
      );
    case "FREE":
      return (
        <div className="flex flex-col gap-2">
          <Badge variant="success" className="w-fit">Free for you</Badge>
          {open}
        </div>
      );
    case "EXPIRED":
      return (
        <div className="flex flex-col gap-2">
          <Badge variant="warning" className="w-fit">
            Expired{state.expiresAt ? ` ${formatIst(state.expiresAt)}` : ""}
          </Badge>
          {buy("Renew")}
        </div>
      );
    case "BUY":
      return buy("Buy Now");
    default:
      return <p className="text-sm text-[var(--color-muted-foreground)]">Not available right now.</p>;
  }
}

/** Rendered state, for tests and analytics: guest | free-mode | ACTIVE | COVERED | FREE | EXPIRED | BUY | UNAVAILABLE. */
function planStateKey({ catalog, state, signedIn }: { catalog: PlanCatalog; state?: PlanState; signedIn: boolean }) {
  if (!catalog.showPrices) return "free-mode";
  return signedIn && state ? state.kind : "guest";
}

function PlanCard({ plan, ...rest }: { plan: CatalogPlan; catalog: PlanCatalog; state?: PlanState; signedIn: boolean }) {
  return (
    <Card id={`plan-${plan.code}`} className="flex scroll-mt-24 flex-col">
      <CardContent className="flex flex-1 flex-col gap-4 p-5 sm:p-6">
        <div className="flex flex-col gap-2">
          <h4 className="text-lg font-semibold text-[var(--color-foreground)]">{plan.title}</h4>
          {plan.description ? <p className="text-sm text-[var(--color-muted-foreground)]">{plan.description}</p> : null}
        </div>
        {rest.catalog.showPrices ? <PriceTag price={plan.price} size="lg" /> : null}
        <p className="flex items-center gap-1.5 text-sm text-[var(--color-muted-foreground)]">
          <Clock className="h-4 w-4" aria-hidden /> {plan.accessDuration}
        </p>
        {plan.benefits.length > 0 ? (
          <ul className="flex flex-col gap-1.5 text-sm text-[var(--color-foreground)]">
            {plan.benefits.map((b) => (
              <li key={b.key} className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-success)]" aria-hidden />
                <span>
                  {b.feature}
                  {b.paid.state === "text" && b.paid.text ? <span className="text-[var(--color-muted-foreground)]">: {b.paid.text}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-auto" data-plan-state={planStateKey(rest)}>
          <PlanActions plan={plan} {...rest} />
        </div>
      </CardContent>
    </Card>
  );
}

/** Compact row for single tests: there can be many, and they share one validity / benefit set. */
function PlanRowItem({ plan, ...rest }: { plan: CatalogPlan; catalog: PlanCatalog; state?: PlanState; signedIn: boolean }) {
  return (
    <li id={`plan-${plan.code}`} className="flex scroll-mt-24 flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <h4 className="font-medium text-[var(--color-foreground)]">{plan.title}</h4>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          {plan.durationMinutes ? `${plan.durationMinutes} minutes · ` : ""}
          {plan.accessDuration}
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:items-end" data-plan-state={planStateKey(rest)}>
        {rest.catalog.showPrices ? <PriceTag price={plan.price} /> : null}
        <PlanActions plan={plan} {...rest} />
      </div>
    </li>
  );
}

function catalogJsonLd(catalog: PlanCatalog, pageUrl: string, siteUrl: string, siteName: string) {
  const offers = catalog.showPrices
    ? catalog.groups.flatMap((g) =>
        g.categories.flatMap((c) =>
          c.plans.map((p) => ({
            "@type": "Offer",
            name: p.title,
            category: `${g.exam.name} · ${c.label}`,
            url: `${pageUrl}#plan-${p.code}`,
            price: (p.price.pricePaise / 100).toFixed(2),
            priceCurrency: p.price.currency,
            availability: catalog.purchasesOpen ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
            ...(p.price.saleEndsAt ? { priceValidUntil: p.price.saleEndsAt.toISOString().slice(0, 10) } : {}),
            itemOffered: { "@type": "Service", name: p.title, serviceType: c.label, provider: { "@type": "Organization", name: siteName, url: siteUrl } },
          }))
        )
      )
    : [];
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: H1,
    description: SEO_DESCRIPTION,
    url: pageUrl,
    inLanguage: "en-IN",
    isPartOf: { "@type": "WebSite", name: siteName, url: `${siteUrl}/` },
    ...(offers.length > 0
      ? { mainEntity: { "@type": "OfferCatalog", name: "Plans & Pricing", numberOfItems: offers.length, itemListElement: offers } }
      : {}),
  };
}

export default async function PlansAndPricingPage() {
  const now = new Date();
  const [catalog, siteUrl, seo, session] = await Promise.all([getPublicPlanCatalog(now), getSiteUrl(), getSeoSettings(), getStudentSession()]);
  const studentId = session?.user?.studentId ? (session.user.id ?? null) : null;
  const states = studentId && catalog.showPrices ? await getPlanStates(studentId, catalog, now) : new Map<string, PlanState>();
  const signedIn = Boolean(studentId);
  const pageUrl = `${siteUrl}${PLANS_AND_PRICING_PATH}`;

  // Content links point at the first exam that has a public page.
  const lead = catalog.groups.find((g) => g.exam.publicSlug);
  const leadSlug = lead?.exam.publicSlug ?? null;
  const leadHasAnalysis = lead ? hasPyqAnalysis(await getExamPyqInsights(lead.exam.id)) : false;
  const allPlans = catalog.groups.flatMap((g) => g.categories.flatMap((c) => c.plans));
  const validities = [...new Set(allPlans.map((p) => p.accessDuration))];
  const has = (key: string) => catalog.groups.some((g) => g.categories.some((c) => c.key === key));
  const freeMocks = lead?.comparison?.freeMocks ?? 0;
  const aiRow = lead?.comparison?.rows.find((r) => /\bAI\b/.test(r.feature) && r.paid.state !== "cross");

  const faqs: { q: string; a: React.ReactNode }[] = [
    {
      q: "How long does my access last?",
      a: validities.length
        ? `Every plan shows its validity on its card. The plans on sale today come with: ${validities.join(", ")}. Access starts when your payment is confirmed.`
        : "Every plan shows its validity on its card. Access starts when your payment is confirmed.",
    },
    ...(freeMocks > 0
      ? [{ q: "Can I try a mock test before buying?", a: `Yes. ${freeMocks} mock ${freeMocks === 1 ? "test is" : "tests are"} free to attempt after you sign in, so you can try the test interface and explanations first.` }]
      : []),
    ...(has("test-series") && has("single-mocks")
      ? [{ q: "If I buy the complete test series, do I also need single mock tests?", a: "No. The complete test series unlocks every mock test in that series, so single mock tests from the same series are shown as already included and are not offered for purchase again." }]
      : []),
    {
      q: "What happens when my plan expires?",
      a: "The paid tests in that plan lock again until you renew. You can renew from this page or from checkout, which shows the new expiry date before you pay.",
    },
    {
      q: "How do I pay, and can I use a coupon?",
      a: "Log in, choose a plan and pay securely through Razorpay at checkout. If you have a coupon code, apply it at checkout to see the final price before paying.",
    },
    {
      q: "Can I get a refund?",
      a: (
        <>
          Refunds follow our{" "}
          <Link href="/refund-policy" className="font-medium text-[var(--color-primary)] underline-offset-4 hover:underline">
            Refund &amp; Cancellation Policy
          </Link>
          . For anything else,{" "}
          <Link href="/contact" className="font-medium text-[var(--color-primary)] underline-offset-4 hover:underline">
            contact us
          </Link>
          .
        </>
      ),
    },
  ];

  const linkCls = "font-medium text-[var(--color-primary)] underline-offset-4 hover:underline";

  return (
    <PublicPageShell studentSignedIn={signedIn}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(catalogJsonLd(catalog, pageUrl, siteUrl, seo.siteName)) }} />
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        <ExamBreadcrumbs baseUrl={siteUrl} crumbs={[{ label: "Home", href: "/" }, { label: "Plans & Pricing" }]} />

        <header className="mt-4 max-w-3xl">
          <h1 className="text-3xl font-semibold text-[var(--color-foreground)] sm:text-4xl">{H1}</h1>
          <p className="mt-3 text-[var(--color-muted-foreground)]">
            Choose how you prepare for the Rajasthan Medical Officer exam: the complete mock test series, or single mock tests when you only need a
            few. Every plan below shows its current price, validity and what it unlocks, so you can compare before you pay.
          </p>
        </header>

        {!catalog.showPrices ? (
          <p className="mt-6 flex items-start gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-foreground)]">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> Everything is free right now. Sign in to start practising.
          </p>
        ) : !catalog.purchasesOpen ? (
          <p className="mt-6 flex items-start gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-foreground)]">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> New purchases are paused for a short while. Existing plans keep working.
          </p>
        ) : null}

        {catalog.groups.length === 0 ? (
          <Card className="mt-10">
            <CardContent className="py-10 text-center text-sm text-[var(--color-muted-foreground)]">
              No plans are on sale right now. Free mock tests and previous year papers are still available after you sign in.
            </CardContent>
          </Card>
        ) : (
          catalog.groups.map((g) => (
            <section key={g.exam.id} aria-labelledby={`exam-${g.exam.id}`} className="mt-12">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                <h2 id={`exam-${g.exam.id}`} className="text-2xl font-semibold text-[var(--color-foreground)]">
                  {g.exam.name} Plans
                </h2>
                {g.exam.publicSlug ? (
                  <Link href={`/exams/${g.exam.publicSlug}`} className={`text-sm ${linkCls}`}>
                    {g.exam.name} exam overview
                  </Link>
                ) : null}
              </div>

              {g.categories.map((c) => (
                <div key={c.key} className="mt-6">
                  <h3 className="text-lg font-semibold text-[var(--color-foreground)]">{c.label}</h3>
                  {c.key === "single-mocks" ? (
                    <ul className="mt-3 divide-y divide-[var(--color-border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)]">
                      {c.plans.map((p) => (
                        <PlanRowItem key={p.id} plan={p} catalog={catalog} state={states.get(p.id)} signedIn={signedIn} />
                      ))}
                    </ul>
                  ) : (
                    <div className="mt-3 grid gap-4 md:grid-cols-2">
                      {c.plans.map((p) => (
                        <PlanCard key={p.id} plan={p} catalog={catalog} state={states.get(p.id)} signedIn={signedIn} />
                      ))}
                    </div>
                  )}
                </div>
              ))}

              {catalog.showPrices && g.comparison && g.comparison.rows.length > 0 ? (
                <div className="mt-8">
                  <h3 className="text-lg font-semibold text-[var(--color-foreground)]">Free vs Complete Series</h3>
                  <PlanComparison rows={g.comparison.rows} className="mt-3" />
                </div>
              ) : null}
            </section>
          ))
        )}

        {leadSlug ? (
          <section aria-labelledby="included" className="mt-14">
            <h2 id="included" className="text-2xl font-semibold text-[var(--color-foreground)]">What you can practise</h2>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Card>
                <CardContent className="flex flex-col gap-2 p-5">
                  <h3 className="font-semibold text-[var(--color-foreground)]">Mock tests and test series</h3>
                  <p className="text-sm text-[var(--color-muted-foreground)]">
                    Full-length, timed mock tests on the exam pattern, released on a published schedule.{" "}
                    <Link href={mockSeriesPath(leadSlug)} className={linkCls}>See the mock test schedule</Link>.
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="flex flex-col gap-2 p-5">
                  <h3 className="font-semibold text-[var(--color-foreground)]">Previous year papers</h3>
                  <p className="text-sm text-[var(--color-muted-foreground)]">
                    Attempt past papers as timed tests and review every answer.{" "}
                    <Link href={`/exams/${leadSlug}/previous-year-papers`} className={linkCls}>Browse previous year papers</Link>.
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="flex flex-col gap-2 p-5">
                  <h3 className="font-semibold text-[var(--color-foreground)]">Subject-wise practice</h3>
                  <p className="text-sm text-[var(--color-muted-foreground)]">
                    Practise one subject or topic at a time from the question bank.{" "}
                    <Link href={`/exams/${leadSlug}/question-bank`} className={linkCls}>Explore the question bank</Link>
                    {leadHasAnalysis ? (
                      <>
                        {" "}or check the <Link href={examInsightPath(leadSlug, "weightage")} className={linkCls}>subject-wise weightage</Link>
                      </>
                    ) : null}
                    .
                  </p>
                </CardContent>
              </Card>
              {aiRow ? (
                <Card>
                  <CardContent className="flex flex-col gap-2 p-5">
                    <h3 className="font-semibold text-[var(--color-foreground)]">AI explanations</h3>
                    <p className="text-sm text-[var(--color-muted-foreground)]">
                      {aiRow.feature}
                      {aiRow.paid.state === "text" && aiRow.paid.text ? ` (Complete Series: ${aiRow.paid.text})` : ""}. Ask AI explains why an answer
                      is right or wrong after you attempt a question.
                    </p>
                  </CardContent>
                </Card>
              ) : null}
            </div>
            {leadHasAnalysis ? (
              <p className="mt-4 text-sm text-[var(--color-muted-foreground)]">
                Planning your preparation? Read the <Link href={examInsightPath(leadSlug, "strategy")} className={linkCls}>preparation strategy</Link> built
                from previous year paper analysis.
              </p>
            ) : null}
          </section>
        ) : null}

        <section aria-labelledby="how-to-buy" className="mt-14 grid gap-8 md:grid-cols-2">
          <div>
            <h2 id="how-to-buy" className="text-2xl font-semibold text-[var(--color-foreground)]">How to buy</h2>
            <ol className="mt-4 flex flex-col gap-3 text-sm text-[var(--color-foreground)]">
              <li className="flex gap-3">
                <LogIn className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-primary)]" aria-hidden />
                <span>Log in or create your free account. You can view every price here without logging in.</span>
              </li>
              <li className="flex gap-3">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-primary)]" aria-hidden />
                <span>Choose a plan and select Buy Now. Checkout shows the final price, including any coupon.</span>
              </li>
              <li className="flex gap-3">
                <CreditCard className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-primary)]" aria-hidden />
                <span>Pay securely through Razorpay. Your plan is added to your account as soon as the payment is confirmed.</span>
              </li>
            </ol>
          </div>
          <div>
            <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Already have a plan?</h2>
            <p className="mt-4 flex gap-3 text-sm text-[var(--color-foreground)]">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-success)]" aria-hidden />
              <span>
                When you are logged in, plans you own show <strong>Active Plan</strong> with their expiry date, and tests already included in a
                plan you own show <strong>Already Enrolled</strong>. You are never offered a second purchase for access you already have. Expired
                plans show <strong>Renew</strong>.
              </span>
            </p>
          </div>
        </section>

        <section aria-labelledby="faq" className="mt-14 max-w-3xl">
          <h2 id="faq" className="text-2xl font-semibold text-[var(--color-foreground)]">Frequently asked questions</h2>
          <div className="mt-4 divide-y divide-[var(--color-border)] rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)]">
            {faqs.map((f) => (
              <details key={f.q} className="group p-4">
                <summary className="cursor-pointer list-none font-medium text-[var(--color-foreground)] marker:hidden">
                  <h3 className="inline text-base">{f.q}</h3>
                </summary>
                <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">{f.a}</p>
              </details>
            ))}
          </div>
        </section>
      </div>
    </PublicPageShell>
  );
}
