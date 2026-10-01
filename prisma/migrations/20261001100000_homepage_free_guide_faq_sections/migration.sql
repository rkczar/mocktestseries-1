-- Homepage SEO / free-first redesign: three new admin-managed homepage
-- sections. Additive enum values only — no existing row changes.
ALTER TYPE "HomepageSectionKey" ADD VALUE IF NOT EXISTS 'FREE_START';
ALTER TYPE "HomepageSectionKey" ADD VALUE IF NOT EXISTS 'EXAM_GUIDE';
ALTER TYPE "HomepageSectionKey" ADD VALUE IF NOT EXISTS 'FAQ';
