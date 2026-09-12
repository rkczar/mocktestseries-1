import {
  HelpCircle,
  Sparkles,
  GraduationCap,
  ClipboardList,
  BookOpen,
  Users,
  UserCheck,
  FileText,
  Brain,
  Award,
  CheckCircle2,
  Database,
  TrendingUp,
  Layers,
  BarChart3,
  type LucideIcon,
} from "lucide-react";

/**
 * Curated icon set for homepage statistic/marketing cards — a fixed lookup
 * table rather than a free-text icon name, so an admin can only ever pick a
 * real, rendered icon (Section 2/3 of the spec).
 */
export const HOMEPAGE_STAT_ICONS: Record<string, LucideIcon> = {
  helpCircle: HelpCircle,
  sparkles: Sparkles,
  graduationCap: GraduationCap,
  clipboardList: ClipboardList,
  bookOpen: BookOpen,
  users: Users,
  userCheck: UserCheck,
  fileText: FileText,
  brain: Brain,
  award: Award,
  checkCircle: CheckCircle2,
  database: Database,
  trendingUp: TrendingUp,
  layers: Layers,
  barChart: BarChart3,
};

export const DEFAULT_STAT_ICON = "barChart";

export function getStatIcon(icon?: string): LucideIcon {
  return (icon && HOMEPAGE_STAT_ICONS[icon]) || HOMEPAGE_STAT_ICONS[DEFAULT_STAT_ICON];
}
