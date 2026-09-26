import "server-only";
import { prisma } from "@/lib/prisma";
import {
  STUDENT_DASHBOARD_BLOCKS,
  DEFAULT_STUDENT_DASHBOARD_LAYOUT,
  isStudentDashboardBlockId,
  type StudentDashboardLayout,
} from "@/lib/student-dashboard-blocks";

/**
 * Admin-managed Student Dashboard layout (Admin → Website → Student
 * Dashboard). Stored in the existing `Setting` key-value table and read per
 * request, so a saved change applies on the next dashboard load with no
 * rebuild or deploy.
 *
 * The layout only decides WHICH registered blocks render and in WHAT order.
 * Every block still loads its own data through the normal student-scoped,
 * access-checked queries, so the layout can never widen what a student sees.
 */

export const STUDENT_DASHBOARD_LAYOUT_KEY = "website.student_dashboard_layout";

/**
 * Normalizes any stored value to a complete, valid layout: unknown IDs are
 * dropped, duplicates collapse to the first, and blocks registered after the
 * layout was saved are inserted at their default position, visible.
 */
export function normalizeStudentDashboardLayout(raw: unknown): StudentDashboardLayout {
  const stored = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const out: StudentDashboardLayout = [];
  for (const entry of stored) {
    const id = (entry as { id?: unknown })?.id;
    if (!isStudentDashboardBlockId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, visible: (entry as { visible?: unknown }).visible !== false });
  }
  DEFAULT_STUDENT_DASHBOARD_LAYOUT.forEach((block, defaultIndex) => {
    if (seen.has(block.id)) return;
    // Insert after the nearest preceding default neighbour that is present.
    const before = DEFAULT_STUDENT_DASHBOARD_LAYOUT.slice(0, defaultIndex).map((b) => b.id).reverse();
    const anchor = before.map((id) => out.findIndex((b) => b.id === id)).find((i) => i >= 0);
    out.splice(anchor === undefined ? 0 : anchor + 1, 0, { id: block.id, visible: true });
    seen.add(block.id);
  });
  return out;
}

export async function getStudentDashboardLayout(): Promise<StudentDashboardLayout> {
  const row = await prisma.setting.findUnique({ where: { key: STUDENT_DASHBOARD_LAYOUT_KEY } });
  return normalizeStudentDashboardLayout(row?.value);
}

/** Strict validation for a layout submitted by the admin UI: every registered block exactly once. */
export function parseSubmittedLayout(raw: unknown): StudentDashboardLayout | null {
  if (!Array.isArray(raw) || raw.length !== STUDENT_DASHBOARD_BLOCKS.length) return null;
  const ids = new Set<string>();
  const out: StudentDashboardLayout = [];
  for (const entry of raw) {
    const id = (entry as { id?: unknown })?.id;
    const visible = (entry as { visible?: unknown })?.visible;
    if (!isStudentDashboardBlockId(id) || ids.has(id) || typeof visible !== "boolean") return null;
    ids.add(id);
    out.push({ id, visible });
  }
  return out;
}

export async function saveStudentDashboardLayout(layout: StudentDashboardLayout) {
  await prisma.setting.upsert({
    where: { key: STUDENT_DASHBOARD_LAYOUT_KEY },
    create: { key: STUDENT_DASHBOARD_LAYOUT_KEY, value: layout },
    update: { value: layout },
  });
}

export async function resetStudentDashboardLayout() {
  await prisma.setting.deleteMany({ where: { key: STUDENT_DASHBOARD_LAYOUT_KEY } });
}
