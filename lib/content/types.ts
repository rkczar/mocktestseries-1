export type CtaButtonDTO = {
  label: string;
  href: string;
  variant: "primary" | "secondary" | "accent" | "ghost";
};

export type AnnouncementDTO = {
  tag: string | null;
  message: string;
  linkLabel: string | null;
  linkHref: string | null;
};

export type FeaturedExamDTO = {
  slug: string;
  title: string;
  description: string;
  status: "ACTIVE" | "COMING_SOON" | "ARCHIVED";
  metaChips: string[];
};

export type TestSeriesCardDTO = {
  slug: string;
  kind: "FULL_MOCK" | "PREVIOUS_YEAR" | "SUBJECT_WISE";
  title: string;
  description: string;
  metaLabel: string | null;
};

export type UpcomingExamDTO = {
  id: string;
  title: string;
  subtitle: string | null;
  dateLabel: string | null;
  examDate: Date | null;
  status: string;
  statusTone: "success" | "accent" | "neutral";
  actionLabel: string | null;
  actionHref: string | null;
};

export type HomepageSectionVisibility = Record<string, boolean>;

export type HomepageContentDTO = {
  heroEyebrow: string;
  heroHeading: string;
  heroDescription: string;
  finalCtaHeading: string;
  finalCtaBody: string;
  finalCtaNote: string | null;
  sectionVisibility: HomepageSectionVisibility;
  ctaButtons: Record<string, CtaButtonDTO>;
  announcement: AnnouncementDTO | null;
  featuredExams: FeaturedExamDTO[];
  popularTestSeries: TestSeriesCardDTO[];
  upcomingExams: UpcomingExamDTO[];
};
